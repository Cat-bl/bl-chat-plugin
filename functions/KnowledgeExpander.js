import { access, appendFile, readFile } from "fs/promises"
import crypto from "crypto"

class KnowledgeExpander {
  constructor({ apiKey, apiUrl, dbPath = "./knowledge-db.ndjson", model = "text-embedding-3-small" }) {
    this.dbPath = dbPath
    this.model = model
    this.apiKey = apiKey
    this.apiUrl = apiUrl
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

  hashText(text) {
    return crypto.createHash("sha256").update(String(text).trim()).digest("hex")
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
      globalThis.logger?.warn?.(`[KnowledgeExpander] 跳过无效的 ndjson 第 ${index + 1} 行：${error.message}`)
      return null
    }
  }

  async loadKnowledgeDB() {
    if (!(await this.fileExists(this.dbPath))) {
      console.log((`[KnowledgeExpander] 未找到知识库文件：${this.dbPath}`))
      return []
    }

    const data = await readFile(this.dbPath, "utf-8")
    return data
      .split("\n")
      .map((line, index) => this.parseKnowledgeLine(line.trim(), index))
      .filter(Boolean)
  }

  async appendKnowledgeItems(items) {
    if (!items.length) return
    const lines = items.map(item => JSON.stringify(item)).join("\n") + "\n"
    await appendFile(this.dbPath, lines, "utf-8")
  }

  async expandSingle(text) {
    try {
      const normalizedText = String(text || "").trim()
      if (!normalizedText) return false

      const res = await this.getEmbedding(normalizedText)
      const embedding = res.data?.[0]?.embedding
      if (!Array.isArray(embedding)) return false

      await this.appendKnowledgeItems([{
        text: normalizedText,
        hash: this.hashText(normalizedText),
        embedding
      }])
      return true
    } catch (error) {
      console.error(("[KnowledgeExpander] embedding 生成失败:"), error.message)
      return false
    }
  }

  async expand(knowledgeTexts) {
    const incomingTexts = (Array.isArray(knowledgeTexts) ? knowledgeTexts : [knowledgeTexts])
      .map(text => String(text || "").trim())
      .filter(Boolean)

    if (!incomingTexts.length) {
      return { added: 0, total: 0, success: false }
    }

    const db = await this.loadKnowledgeDB()
    const existingHashes = new Set(db.map(item => item.hash || this.hashText(item.text)))
    const seenHashes = new Set(existingHashes)
    const newTexts = []

    for (const text of incomingTexts) {
      const hash = this.hashText(text)
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      newTexts.push(text)
    }

    if (newTexts.length === 0) {
      console.log(("[KnowledgeExpander] 所有知识都已存在"))
      return { added: 0, total: incomingTexts.length, success: true }
    }

    console.log((`[KnowledgeExpander] 正在写入 ${newTexts.length} 条知识到 ${this.dbPath}`))

    try {
      const res = await this.getEmbedding(newTexts)
      const embeddings = res.data?.map(d => d.embedding) || []
      const items = newTexts
        .map((text, index) => ({
          text,
          hash: this.hashText(text),
          embedding: embeddings[index]
        }))
        .filter(item => Array.isArray(item.embedding))

      await this.appendKnowledgeItems(items)

      console.log((`[KnowledgeExpander] 已新增 ${items.length} 条，跳过 ${incomingTexts.length - items.length} 条`))
      return {
        added: items.length,
        total: incomingTexts.length,
        success: items.length > 0
      }
    } catch (error) {
      console.error(("[KnowledgeExpander] 批量 embedding 失败:"), error.message)
      console.log(("[KnowledgeExpander] 回退为逐条生成 embedding"))

      let successCount = 0
      for (const text of newTexts) {
        const success = await this.expandSingle(text)
        if (success) successCount++
      }

      return {
        added: successCount,
        total: incomingTexts.length,
        success: successCount > 0
      }
    }
  }
}

export default KnowledgeExpander
