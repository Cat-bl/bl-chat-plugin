// 记忆检索层：关键词相关度 + 时间衰减打分，可选 embedding 语义召回。
// 从 MemoryManager.js 拆出（行为等价搬迁）。
import { now, clamp, keywordSet, cosineSimilarity, isSimilarContent } from "./helpers.js"

export class MemoryRetriever {
  constructor(config, store, extractor) {
    this.config = config
    this.store = store
    this.extractor = extractor
  }

  keywordRelevance(query, content) {
    if (!query) return 0.45
    const q = keywordSet(query)
    const c = keywordSet(content)
    if (!q.size || !c.size) return isSimilarContent(query, content) ? 0.8 : 0

    let hit = 0
    for (const token of q) {
      if (c.has(token)) hit++
    }
    return clamp(hit / q.size, 0, 1)
  }

  recencyScore(fact) {
    const reference = fact.lastUsed || fact.updatedAt || fact.createdAt || now()
    const age = Math.max(0, now() - reference)
    const window = this.config.memoryDecayDays * 24 * 60 * 60 * 1000
    return clamp(1 - age / window, 0, 1)
  }

  async retrieve({ groupId, userId = null, scope = "user", query = "", limit = 10 }) {
    const meta = await this.store.getMeta(scope, groupId, userId)
    if (meta.disabled || limit <= 0) return { meta, facts: [] }

    const facts = await this.store.getFacts(meta, false)
    let queryEmbedding = null

    if (this.config.semanticRecallEnabled && query && this.extractor.canUseEmbedding()) {
      const result = await this.extractor.createEmbedding(query)
      queryEmbedding = result.embedding
    }

    let scored = facts.map(fact => {
      const embeddingIsCurrent = fact.embeddingHash &&
        fact.embeddingHash === this.extractor.embeddingHashFor(fact.content)
      const semantic = queryEmbedding && embeddingIsCurrent && fact.embedding
        ? cosineSimilarity(queryEmbedding, fact.embedding)
        : null
      const relevance = semantic ?? this.keywordRelevance(query, fact.content)
      const recency = this.recencyScore(fact)
      const score =
        fact.importance * 0.45 +
        relevance * 0.35 +
        recency * 0.15 +
        fact.confidence * 0.05

      return { ...fact, relevance, recency, score }
    })

    if (queryEmbedding) {
      scored = scored
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, this.config.semanticRecallTopK)
    }
    scored.sort((a, b) => b.score - a.score)
    const selected = scored.slice(0, limit)

    return { meta, facts: selected }
  }
}
