import { access, readFile, stat } from "fs/promises"

class KnowledgeSearcher {
  constructor({
    apiKey,
    apiUrl,
    dbPath = "./knowledge-db.ndjson",
    model = "text-embedding-3-small",
    topN = 4,
    threshold = 0.6,
    keywordCandidateLimit = 200
  }) {
    this.dbPath = dbPath
    this.topN = topN
    this.threshold = threshold
    this.model = model
    this.apiKey = apiKey
    this.apiUrl = apiUrl
    this.keywordCandidateLimit = keywordCandidateLimit
    this.cache = {
      mtimeMs: 0,
      items: [],
      loaded: false
    }
  }

  async getEmbedding(input) {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: this.model, input })
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(`Embedding API 请求失败：${response.status} ${errorText}`)
    }

    return await response.json()
  }

  async fileExists(filepath) {
    try {
      await access(filepath)
      return true
    } catch {
      return false
    }
  }

  parseKnowledgeLine(line, index) {
    if (!line) return null

    try {
      const item = JSON.parse(line)
      if (!item?.text || !Array.isArray(item.embedding)) return null
      return item
    } catch (error) {
      globalThis.logger?.warn?.(`[KnowledgeSearcher] 跳过无效的 ndjson 第 ${index + 1} 行：${error.message}`)
      return null
    }
  }

  async loadKnowledgeDB() {
    if (!(await this.fileExists(this.dbPath))) {
      console.log((`[KnowledgeSearcher] 未找到知识库文件：${this.dbPath}`))
      this.cache = { mtimeMs: 0, items: [], loaded: true }
      return []
    }

    const fileStat = await stat(this.dbPath)
    if (this.cache.loaded && this.cache.mtimeMs === fileStat.mtimeMs) {
      return this.cache.items
    }

    const data = await readFile(this.dbPath, "utf-8")
    const items = data
      .split("\n")
      .map((line, index) => this.parseKnowledgeLine(line.trim(), index))
      .filter(Boolean)

    this.cache = {
      mtimeMs: fileStat.mtimeMs,
      items,
      loaded: true
    }

    return items
  }

  cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
      return 0
    }

    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i]
      normA += vecA[i] * vecA[i]
      normB += vecB[i] * vecB[i]
    }

    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
  }

  tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) || []
  }

  keywordScore(question, text) {
    const questionTokens = this.tokenize(question)
    if (!questionTokens.length) return 0

    const haystack = String(text || "").toLowerCase()
    return questionTokens.reduce((score, token) => {
      if (haystack.includes(token)) return score + Math.min(token.length, 8)
      return score
    }, 0)
  }

  selectCandidates(db, question) {
    if (db.length <= this.keywordCandidateLimit * 2) return db

    const ranked = db
      .map(item => ({
        ...item,
        _keywordScore: this.keywordScore(question, item.text)
      }))
      .filter(item => item._keywordScore > 0)
      .sort((a, b) => b._keywordScore - a._keywordScore)
      .slice(0, this.keywordCandidateLimit)

    const minCandidateCount = Math.min(20, Math.ceil(this.keywordCandidateLimit / 4))
    return ranked.length >= minCandidateCount ? ranked : db
  }

  rankMatches(db, questionEmbedding, question) {
    return this.selectCandidates(db, question)
      .map(item => ({
        text: item.text,
        score: this.cosineSimilarity(questionEmbedding, item.embedding)
      }))
      .filter(item => item.score >= this.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topN)
  }

  buildKnowledgeContext(matches) {
    return matches
      .map((item, index) => `Knowledge ${index + 1} (${(item.score * 100).toFixed(2)}%): ${item.text}`)
      .join("\n")
  }

  buildCOTChain(userQuestion, knowledgeContext) {
    return {
      knowledgeContext,
      userQuestion
    }
  }

  async search(userQuestion) {
    const db = await this.loadKnowledgeDB()
    if (db.length === 0) {
      console.log((`[KnowledgeSearcher] 知识库为空：${this.dbPath}`))
      return null
    }

    const res = await this.getEmbedding(userQuestion)
    const questionEmbedding = res.data?.[0]?.embedding
    const matches = this.rankMatches(db, questionEmbedding, userQuestion)

    if (matches.length === 0) {
      console.log(("[KnowledgeSearcher] 没有匹配到知识"))
      return null
    }

    const knowledgeContext = this.buildKnowledgeContext(matches)
    return this.buildCOTChain(userQuestion, knowledgeContext)
  }

  async batchSearch(userQuestions = []) {
    const db = await this.loadKnowledgeDB()
    if (db.length === 0) {
      console.log((`[KnowledgeSearcher] 知识库为空：${this.dbPath}`))
      return userQuestions.map(() => null)
    }

    const res = await this.getEmbedding(userQuestions)
    const questionEmbeddings = res.data?.map(d => d.embedding) || []

    return userQuestions.map((question, index) => {
      const matches = this.rankMatches(db, questionEmbeddings[index], question)
      if (matches.length === 0) return null

      const knowledgeContext = this.buildKnowledgeContext(matches)
      return this.buildCOTChain(question, knowledgeContext)
    })
  }
}

export default KnowledgeSearcher
