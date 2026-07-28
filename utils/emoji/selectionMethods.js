// 表情包选取 mixin：embedding 语义召回、近期排除、频控、按使用次数加权抽样。
// 从 EmojiPackManager.js 拆出（行为等价搬迁），经 Object.assign 挂到 EmojiPackManager.prototype，this 即 manager 实例。
import { logWarn } from "./log.js"

export const selectionMethods = {
  async getEmbedding(input) {
    const cfg = this.embeddingAiConfig
    if (!cfg?.embeddingApiUrl || !cfg?.embeddingApiKey || cfg.embeddingApiKey.includes("sk-xxx")) {
      throw new Error("embeddingAiConfig 未配置")
    }
    const response = await fetch(cfg.embeddingApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.embeddingApiKey}` },
      body: JSON.stringify({ model: cfg.embeddingApiModel || "text-embedding-3-small", input })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`embedding API ${response.status}: ${text.slice(0, 120)}`)
    }
    const json = await response.json()
    return json.data?.[0]?.embedding || null
  },

  cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  },

  getRecentExclusions(groupId) {
    if (!groupId) return { hashes: new Set(), tags: new Set() }
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    const picks = this.recentPicksByGroup.get(String(groupId)) || []
    const fresh = picks.filter(p => p.at >= cutoff)
    if (fresh.length !== picks.length) {
      if (fresh.length) this.recentPicksByGroup.set(String(groupId), fresh)
      else this.recentPicksByGroup.delete(String(groupId))
    }
    const hashes = new Set(fresh.map(p => p.hash))
    const tags = new Set()
    for (const p of fresh) for (const t of (p.tags || [])) tags.add(String(t).toLowerCase())
    return { hashes, tags }
  },

  recordPick(groupId, hash, tags) {
    if (!groupId || !hash) return
    const key = String(groupId)
    const list = this.recentPicksByGroup.get(key) || []
    list.push({ hash, tags: Array.isArray(tags) ? tags.slice() : [], at: Date.now() })
    const max = Number(this.config.avoidRecentCount) || 20
    while (list.length > max) list.shift()
    this.recentPicksByGroup.set(key, list)
    // 顺手清理过期群条目
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    for (const [gid, picks] of this.recentPicksByGroup) {
      const fresh = picks.filter(p => p.at >= cutoff)
      if (!fresh.length) this.recentPicksByGroup.delete(gid)
      else if (fresh.length !== picks.length) this.recentPicksByGroup.set(gid, fresh)
    }
  },

  checkRateLimit(groupId) {
    if (this.config.rateLimitEnabled === false) return { allowed: true }
    if (!groupId) return { allowed: true }
    const max = Number(this.config.rateLimitMaxPerWindow) || 0
    if (max <= 0) return { allowed: true }
    const windowMinutes = Number(this.config.rateLimitWindowMinutes) || 5
    const windowMs = windowMinutes * 60 * 1000
    const cutoff = Date.now() - windowMs
    const key = String(groupId)
    const all = this.recentSendsByGroup.get(key) || []
    const fresh = all.filter(t => t >= cutoff)
    if (fresh.length !== all.length) {
      if (fresh.length) this.recentSendsByGroup.set(key, fresh)
      else this.recentSendsByGroup.delete(key)
    }
    return fresh.length >= max
      ? { allowed: false, count: fresh.length, max, windowMinutes }
      : { allowed: true, count: fresh.length, max, windowMinutes }
  },

  recordSend(groupId) {
    if (!groupId) return
    const key = String(groupId)
    const list = this.recentSendsByGroup.get(key) || []
    list.push(Date.now())
    this.recentSendsByGroup.set(key, list)
    // 顺手清过期群
    const windowMs = (Number(this.config.rateLimitWindowMinutes) || 5) * 60 * 1000
    const cutoff = Date.now() - windowMs
    for (const [gid, ts] of this.recentSendsByGroup) {
      const fresh = ts.filter(t => t >= cutoff)
      if (!fresh.length) this.recentSendsByGroup.delete(gid)
      else if (fresh.length !== ts.length) this.recentSendsByGroup.set(gid, fresh)
    }
  },

  /**
   * 三层加权抽样：
   * 1) 硬相关性门 —— 只保留与 top score 差距 < 0.1 且 >= 0.6 的候选；候选 <2 时放宽到 top3
   * 2) 长程冷却 —— 按 lastUsedAt 分档（<30min 0.2 / <60min 0.5 / <180min 0.8 / 其他 1.0）打折权重
   * 3) 加权 —— score³ × min(1.5, usageFactor)，让 score 主导，避免冷图碾压热图
   * candidates: [{ item, score }]，score 在 [0,1]
   */
  weightedSampleByUsage(candidates) {
    if (!candidates?.length) return null

    const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0))
    const topScore = sorted[0].score || 0
    const eligibleMin = Math.max(0.6, topScore - 0.1)
    const eligible = sorted.filter(c => (c.score || 0) >= eligibleMin)
    const pool = eligible.length >= 2 ? eligible : sorted.slice(0, Math.min(3, sorted.length))

    const now = Date.now()
    const cooldownPenalty = (lastUsedAt) => {
      if (!lastUsedAt) return 1
      const t = new Date(lastUsedAt).getTime()
      if (!Number.isFinite(t)) return 1
      const ageMin = (now - t) / 60000
      if (ageMin < 30) return 0.2
      if (ageMin < 60) return 0.5
      if (ageMin < 180) return 0.8
      return 1
    }

    const weights = pool.map(({ item, score }) => {
      const usedCount = item.usedCount || 0
      const usageFactor = Math.min(1.5, (1 / (usedCount + 1)) * (usedCount === 0 ? 2 : 1))
      const baseScore = Math.max(0.01, Number(score) || 0.01)
      return Math.pow(baseScore, 3) * usageFactor * cooldownPenalty(item.lastUsedAt)
    })
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) return pool[0]
    let r = Math.random() * total
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]
      if (r <= 0) return pool[i]
    }
    return pool[pool.length - 1]
  },

  async selectEmoji(query, options = {}) {
    this.refreshConfig()
    const allItems = await this.loadItems()
    const usableAll = allItems.filter(i => !i.isBanned)
    if (!usableAll.length) return { item: null, strategy: "empty" }

    // avoidRecent：只按 hash 排除（不再按 tag —— tag 不准且容易把池清空）
    let items = usableAll
    if (this.config.avoidRecentEnabled !== false && options.groupId) {
      const { hashes: recentHashes } = this.getRecentExclusions(options.groupId)
      if (recentHashes.size) {
        const filtered = usableAll.filter(item => !recentHashes.has(item.hash))
        if (filtered.length) items = filtered
        // 排除后为空（极少见）才退回 usableAll
      }
    }

    const q = String(query || "").trim()
    const useEmbed = this.config.useEmbedding !== false
    const hasEmbedCfg = !!(this.embeddingAiConfig?.embeddingApiUrl
      && this.embeddingAiConfig?.embeddingApiKey
      && !String(this.embeddingAiConfig.embeddingApiKey).includes("sk-xxx"))
    const embeddedItems = items.filter(i => Array.isArray(i.embedding) && i.embedding.length)

    // L1: embedding 召回（基于 LLM 识别的 description）
    if (q && useEmbed && hasEmbedCfg && embeddedItems.length) {
      try {
        const qEmbed = await this.getEmbedding(q)
        if (Array.isArray(qEmbed)) {
          const threshold = Number(this.config.embeddingThreshold) || 0.55
          const topK = Number(this.config.selectionTopK) || 5
          const ranked = embeddedItems
            .map(item => ({ item, score: this.cosineSimilarity(qEmbed, item.embedding) }))
            .filter(r => r.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
          if (ranked.length) {
            const picked = this.weightedSampleByUsage(ranked)
            return { item: picked.item, strategy: "embedding" }
          }
        }
      } catch (err) {
        logWarn(`embedding 选图失败，降级到全库兜底: ${err.message}`)
      }
    }

    // L2 兜底：embedding 没结果（或未配置）时，全库走加权抽样
    // 给所有图相同的 0.7 分（高于 weightedSampleByUsage 的 0.6 硬门）
    // 让所有候选通过相关性门，由 usageFactor + cooldownPenalty 主导多样性
    const fallback = items.map(item => ({ item, score: 0.7 }))
    const picked = this.weightedSampleByUsage(fallback)
    return { item: picked.item, strategy: "fallback_random" }
  },
}
