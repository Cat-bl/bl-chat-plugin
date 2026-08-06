// redis 事实存储层：作用域 key 规划、meta/fact CRUD、容量裁剪、旧版数据迁移。
// 从 MemoryManager.js 拆出（行为等价搬迁）。
import { randomUUID } from "crypto"
import {
  USER_CATEGORIES,
  GROUP_CATEGORIES,
  LEGACY_MEMORY_ROLLBACK_DAYS,
  DELETED_MEMORY_RETENTION_DAYS,
  MAX_DELETED_FACTS_PER_SCOPE,
  USER_CANDIDATE_TTL_DAYS,
  MAX_USER_CANDIDATES
} from "./constants.js"
import { now, clamp, uniq, sha256, safeJsonParse, compactText, containsToolFeedback } from "./helpers.js"

export class MemoryStore {
  constructor(config) {
    this.config = config
    this.legacyPrefix = "ytbot:memory:"
    this.v2Prefix = "ytbot:memory:v2:"
  }

  userScopeId(groupId, userId) {
    return `${groupId}:${userId}`
  }

  groupScopeId(groupId) {
    return `${groupId}`
  }

  legacyUserKey(groupId, userId) {
    return `${this.legacyPrefix}${groupId}:${userId}`
  }

  legacyGroupKey(groupId) {
    return `${this.legacyPrefix}group:${groupId}`
  }

  metaKey(scope, groupId, userId = null) {
    if (scope === "user") {
      return `${this.v2Prefix}user:${groupId}:${userId}:meta`
    }
    return `${this.v2Prefix}group:${groupId}:meta`
  }

  factKey(scope, scopeId, factId) {
    return `${this.v2Prefix}fact:${scope}:${scopeId}:${factId}`
  }

  userCandidateKey(groupId, userId) {
    return `${this.v2Prefix}candidate:user:${groupId}:${userId}`
  }

  async setRaw(key, value, ttlSeconds = null) {
    if (ttlSeconds) {
      try {
        await redis.set(key, value, { EX: ttlSeconds })
        if (typeof redis.expire === "function") await redis.expire(key, ttlSeconds)
        return
      } catch {
        try {
          await redis.set(key, value, "EX", ttlSeconds)
          return
        } catch {
          // Some Redis adapters only support set(key, value).
        }
      }
    }
    await redis.set(key, value)
  }

  async setJson(key, value, ttlSeconds = null) {
    await this.setRaw(key, JSON.stringify(value), ttlSeconds)
  }

  async getJson(key, fallback = null) {
    const raw = await redis.get(key)
    if (!raw) return fallback
    return safeJsonParse(raw, fallback)
  }

  async scanKeys(pattern) {
    try {
      if (typeof redis.scanIterator === "function") {
        const keys = []
        for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          if (Array.isArray(key)) keys.push(...key)
          else keys.push(key)
        }
        return keys
      }

      if (typeof redis.scan === "function") {
        const keys = []
        let cursor = "0"
        do {
          const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200)
          const nextCursor = Array.isArray(result) ? result[0] : result?.cursor
          const batch = Array.isArray(result) ? result[1] : result?.keys
          cursor = String(nextCursor || "0")
          keys.push(...(batch || []))
        } while (cursor !== "0")
        return keys
      }
    } catch (error) {
      logger?.warn?.(`[MemoryStore] SCAN 扫描失败，回退使用 KEYS：${pattern}，原因：${error.message}`)
    }

    if (typeof redis.keys === "function") {
      return await redis.keys(pattern)
    }
    return []
  }

  async deleteKeys(keys = []) {
    await Promise.all(uniq(keys).map(key => redis.del(key)))
  }

  createMeta(scope, groupId, userId = null) {
    const timestamp = now()
    const meta = {
      scope,
      groupId: String(groupId),
      userId: userId === null || userId === undefined ? null : String(userId),
      factIds: [],
      deletedFactIds: [],
      disabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      failureCount: 0,
      nextRetryAt: 0,
      migratedFromLegacyAt: null
    }

    if (scope === "user") {
      meta.relationshipScore = 0.5
      meta.nickname = null
    }

    return meta
  }

  normalizeMeta(meta, scope, groupId, userId = null) {
    const fallback = this.createMeta(scope, groupId, userId)
    const merged = { ...fallback, ...(meta || {}) }
    merged.scope = scope
    merged.groupId = String(groupId)
    merged.userId = userId === null || userId === undefined ? null : String(userId)
    merged.factIds = uniq(Array.isArray(merged.factIds) ? merged.factIds : [])
    merged.deletedFactIds = uniq(Array.isArray(merged.deletedFactIds) ? merged.deletedFactIds : [])
    merged.disabled = Boolean(merged.disabled)
    merged.updatedAt = Number(merged.updatedAt) || now()
    merged.createdAt = Number(merged.createdAt) || merged.updatedAt
    merged.lastAttemptAt = Number(merged.lastAttemptAt) || 0
    merged.lastSuccessAt = Number(merged.lastSuccessAt) || 0
    merged.failureCount = Number(merged.failureCount) || 0
    merged.nextRetryAt = Number(merged.nextRetryAt) || 0

    if (scope === "user") {
      merged.relationshipScore = clamp(merged.relationshipScore, 0, 1)
      merged.nickname = merged.nickname || null
    }

    return merged
  }

  async getMeta(scope, groupId, userId = null) {
    if (scope === "user") return await this.getUserMeta(groupId, userId)
    return await this.getGroupMeta(groupId)
  }

  async getUserMeta(groupId, userId) {
    const key = this.metaKey("user", groupId, userId)
    const data = await this.getJson(key)
    if (data) return this.normalizeMeta(data, "user", groupId, userId)

    const migrated = await this.migrateLegacyUserMemoryIfNeeded(groupId, userId)
    if (migrated) return migrated

    return this.createMeta("user", groupId, userId)
  }

  async getGroupMeta(groupId) {
    const key = this.metaKey("group", groupId)
    const data = await this.getJson(key)
    if (data) return this.normalizeMeta(data, "group", groupId)

    const migrated = await this.migrateLegacyGroupMemoryIfNeeded(groupId)
    if (migrated) return migrated

    return this.createMeta("group", groupId)
  }

  async saveMeta(meta) {
    meta.updatedAt = now()
    await this.setJson(this.metaKey(meta.scope, meta.groupId, meta.userId), meta)
  }

  normalizeFact(fact, scope, groupId, userId = null) {
    const timestamp = now()
    const scopeId = scope === "user" ? this.userScopeId(groupId, userId) : this.groupScopeId(groupId)
    return {
      id: String(fact?.id || randomUUID()),
      scope,
      scopeId,
      groupId: String(groupId),
      userId: userId === null || userId === undefined ? null : String(userId),
      content: compactText(fact?.content),
      category: this.normalizeCategory(scope, fact?.category),
      importance: clamp(fact?.importance ?? 0.6, 0, 1),
      confidence: clamp(fact?.confidence ?? 0.7, 0, 1),
      sourceMessageIds: uniq(fact?.sourceMessageIds || []),
      sourceUserIds: uniq(fact?.sourceUserIds || []),
      createdAt: Number(fact?.createdAt) || timestamp,
      updatedAt: Number(fact?.updatedAt) || timestamp,
      lastUsed: Number(fact?.lastUsed) || 0,
      status: fact?.status === "deleted" ? "deleted" : "active",
      embeddingHash: fact?.embeddingHash || null,
      embedding: Array.isArray(fact?.embedding) ? fact.embedding : null
    }
  }

  normalizeCategory(scope, category) {
    const allowed = scope === "user" ? USER_CATEGORIES : GROUP_CATEGORIES
    return allowed.includes(category) ? category : allowed[0]
  }

  async getFact(scope, scopeId, factId) {
    return await this.getJson(this.factKey(scope, scopeId, factId))
  }

  async getFactForMeta(meta, factId) {
    const scopeId = meta.scope === "user"
      ? this.userScopeId(meta.groupId, meta.userId)
      : this.groupScopeId(meta.groupId)
    const fact = await this.getFact(meta.scope, scopeId, factId)
    return fact ? this.normalizeFact(fact, meta.scope, meta.groupId, meta.userId) : null
  }

  async getFacts(meta, includeDeleted = false) {
    const factIds = includeDeleted
      ? uniq([...(meta.factIds || []), ...(meta.deletedFactIds || [])])
      : (meta.factIds || [])
    const factResults = await Promise.all(factIds.map(factId => this.getFactForMeta(meta, factId)))
    const facts = []
    for (const fact of factResults) {
      if (!fact) continue
      if (!includeDeleted && fact.status !== "active") continue
      if (!fact.content || containsToolFeedback(fact.content)) continue
      facts.push(fact)
    }
    return facts
  }

  async saveFact(fact) {
    const normalized = this.normalizeFact(fact, fact.scope, fact.groupId, fact.userId)
    if (!normalized.content) return null

    const meta = await this.getMeta(normalized.scope, normalized.groupId, normalized.userId)
    if (!meta.factIds.includes(normalized.id)) {
      meta.factIds.push(normalized.id)
    }
    meta.deletedFactIds = (meta.deletedFactIds || []).filter(id => id !== normalized.id)

    normalized.updatedAt = now()
    const scopeId = normalized.scope === "user"
      ? this.userScopeId(normalized.groupId, normalized.userId)
      : this.groupScopeId(normalized.groupId)

    await this.setJson(this.factKey(normalized.scope, scopeId, normalized.id), normalized)
    await this.trimFacts(meta)
    await this.saveMeta(meta)
    return normalized
  }

  normalizeUserCandidate(candidate, groupId, userId) {
    const timestamp = now()
    return {
      id: String(candidate?.id || randomUUID()),
      groupId: String(groupId),
      userId: String(userId),
      content: compactText(candidate?.content),
      category: this.normalizeCategory("user", candidate?.category),
      importance: clamp(candidate?.importance ?? 0.4, 0, 1),
      confidence: clamp(candidate?.confidence ?? 0.5, 0, 1),
      evidenceKeys: uniq(candidate?.evidenceKeys || []),
      sourceMessageIds: uniq(candidate?.sourceMessageIds || []),
      firstSeenAt: Number(candidate?.firstSeenAt) || timestamp,
      lastSeenAt: Number(candidate?.lastSeenAt) || timestamp
    }
  }

  async getUserCandidates(groupId, userId) {
    const raw = await this.getJson(this.userCandidateKey(groupId, userId), [])
    const cutoff = now() - USER_CANDIDATE_TTL_DAYS * 24 * 60 * 60 * 1000
    return (Array.isArray(raw) ? raw : [])
      .map(candidate => this.normalizeUserCandidate(candidate, groupId, userId))
      .filter(candidate => candidate.content && candidate.lastSeenAt >= cutoff)
  }

  async saveUserCandidates(groupId, userId, candidates = []) {
    const normalized = candidates
      .map(candidate => this.normalizeUserCandidate(candidate, groupId, userId))
      .filter(candidate => candidate.content)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_USER_CANDIDATES)

    const key = this.userCandidateKey(groupId, userId)
    if (!normalized.length) {
      await redis.del(key)
      return []
    }

    const ttlSeconds = USER_CANDIDATE_TTL_DAYS * 24 * 60 * 60
    await this.setJson(key, normalized, ttlSeconds)
    return normalized
  }

  async clearUserCandidates(groupId, userId) {
    await redis.del(this.userCandidateKey(groupId, userId))
  }

  async deleteFact(meta, factId) {
    const fact = await this.getFactForMeta(meta, factId)
    meta.factIds = meta.factIds.filter(id => id !== factId)

    if (fact) {
      fact.status = "deleted"
      fact.updatedAt = now()
      const scopeId = fact.scope === "user"
        ? this.userScopeId(fact.groupId, fact.userId)
        : this.groupScopeId(fact.groupId)
      const ttlSeconds = DELETED_MEMORY_RETENTION_DAYS * 24 * 60 * 60
      await this.setJson(this.factKey(fact.scope, scopeId, fact.id), fact, ttlSeconds)
      meta.deletedFactIds = uniq([...(meta.deletedFactIds || []), fact.id])
    } else {
      meta.deletedFactIds = (meta.deletedFactIds || []).filter(id => id !== factId)
    }

    if (meta.deletedFactIds.length > MAX_DELETED_FACTS_PER_SCOPE) {
      const expiredIds = meta.deletedFactIds.slice(0, meta.deletedFactIds.length - MAX_DELETED_FACTS_PER_SCOPE)
      const scopeId = meta.scope === "user"
        ? this.userScopeId(meta.groupId, meta.userId)
        : this.groupScopeId(meta.groupId)
      await this.deleteKeys(expiredIds.map(id => this.factKey(meta.scope, scopeId, id)))
      meta.deletedFactIds = meta.deletedFactIds.slice(-MAX_DELETED_FACTS_PER_SCOPE)
    }

    await this.saveMeta(meta)

    return Boolean(fact)
  }

  async trimFacts(meta) {
    const maxFacts = meta.scope === "user" ? this.config.maxFactsPerUser : this.config.maxFactsPerGroup
    if ((meta.factIds || []).length <= maxFacts) return

    const facts = await this.getFacts(meta, false)
    const activeIds = new Set(facts.map(fact => fact.id))
    meta.factIds = meta.factIds.filter(id => activeIds.has(id))
    if (meta.factIds.length <= maxFacts) return

    facts.sort((a, b) => {
      if (a.importance !== b.importance) return a.importance - b.importance
      return (a.lastUsed || a.updatedAt) - (b.lastUsed || b.updatedAt)
    })

    const removeCount = Math.max(0, meta.factIds.length - maxFacts)
    const removeIds = new Set(facts.slice(0, removeCount).map(f => f.id))
    meta.factIds = meta.factIds.filter(id => !removeIds.has(id))

    const scopeId = meta.scope === "user"
      ? this.userScopeId(meta.groupId, meta.userId)
      : this.groupScopeId(meta.groupId)
    await this.deleteKeys([...removeIds].map(id => this.factKey(meta.scope, scopeId, id)))
  }

  factFromLegacy(raw, scope, groupId, userId, category) {
    const data = typeof raw === "string" ? { content: raw } : raw || {}
    const content = compactText(data.content || data.text || data.value || data.fact)
    if (!content || containsToolFeedback(content)) return null

    return this.normalizeFact({
      id: data.id || sha256(`legacy:${scope}:${groupId}:${userId || ""}:${category}:${content}`),
      scope,
      groupId,
      userId,
      content,
      category,
      importance: data.importance ?? 0.6,
      confidence: data.confidence ?? 0.7,
      sourceMessageIds: data.sourceMessageIds || [],
      sourceUserIds: data.sourceUserIds || [],
      createdAt: data.createdAt || data.created_at || data.time || now(),
      updatedAt: data.updatedAt || data.lastUpdate || now(),
      lastUsed: data.lastUsed || 0,
      status: "active"
    }, scope, groupId, userId)
  }

  collectLegacyFacts(legacy, scope, groupId, userId = null) {
    const categories = scope === "user" ? USER_CATEGORIES : GROUP_CATEGORIES
    const facts = []

    for (const category of categories) {
      const values = legacy?.categorizedFacts?.[category]
      if (Array.isArray(values)) {
        for (const item of values) {
          const fact = this.factFromLegacy(item, scope, groupId, userId, category)
          if (fact) facts.push(fact)
        }
      }
    }

    if (scope === "user" && Array.isArray(legacy?.facts)) {
      for (const item of legacy.facts) {
        const fact = this.factFromLegacy(item, scope, groupId, userId, "identity")
        if (fact) facts.push(fact)
      }
    }

    if (scope === "user" && legacy?.preferences) {
      for (const item of legacy.preferences.likes || []) {
        const fact = this.factFromLegacy(item, scope, groupId, userId, "likes")
        if (fact) facts.push(fact)
      }
      for (const item of legacy.preferences.dislikes || []) {
        const fact = this.factFromLegacy(item, scope, groupId, userId, "dislikes")
        if (fact) facts.push(fact)
      }
    }

    return facts.filter(fact => fact.importance >= this.config.importanceThreshold)
  }

  async migrateLegacyUserMemoryIfNeeded(groupId, userId) {
    const legacyKey = this.legacyUserKey(groupId, userId)
    const raw = await redis.get(legacyKey)
    if (!raw) return null

    const legacy = safeJsonParse(raw)
    if (!legacy || typeof legacy !== "object") return null

    const meta = this.createMeta("user", groupId, userId)
    meta.relationshipScore = clamp(legacy.relationshipScore ?? legacy.relationship ?? 0.5, 0, 1)
    meta.nickname = legacy.nickname || null
    meta.migratedFromLegacyAt = now()

    const facts = this.collectLegacyFacts(legacy, "user", groupId, userId)
    for (const fact of facts) {
      meta.factIds.push(fact.id)
      const scopeId = this.userScopeId(groupId, userId)
      await this.setJson(this.factKey("user", scopeId, fact.id), fact)
    }

    await this.saveMeta(meta)
    await this.keepLegacyKeyForRollback(legacyKey, raw)
    logger?.info?.(`[MemoryStore] 已迁移旧版用户记忆 group=${groupId} user=${userId} 事实数=${facts.length}`)
    return meta
  }

  async migrateLegacyGroupMemoryIfNeeded(groupId) {
    const legacyKey = this.legacyGroupKey(groupId)
    const raw = await redis.get(legacyKey)
    if (!raw) return null

    const legacy = safeJsonParse(raw)
    if (!legacy || typeof legacy !== "object") return null

    const meta = this.createMeta("group", groupId)
    meta.migratedFromLegacyAt = now()

    const facts = this.collectLegacyFacts(legacy, "group", groupId)
    for (const fact of facts) {
      meta.factIds.push(fact.id)
      const scopeId = this.groupScopeId(groupId)
      await this.setJson(this.factKey("group", scopeId, fact.id), fact)
    }

    await this.saveMeta(meta)
    await this.keepLegacyKeyForRollback(legacyKey, raw)
    logger?.info?.(`[MemoryStore] 已迁移旧版群记忆 group=${groupId} 事实数=${facts.length}`)
    return meta
  }

  async keepLegacyKeyForRollback(key, raw) {
    const ttlSeconds = LEGACY_MEMORY_ROLLBACK_DAYS * 24 * 60 * 60
    await this.setRaw(key, raw, ttlSeconds)
  }

  async clearScope(scope, groupId, userId = null) {
    const meta = await this.getMeta(scope, groupId, userId)
    const scopeId = scope === "user" ? this.userScopeId(groupId, userId) : this.groupScopeId(groupId)
    const indexedFactKeys = uniq([...(meta.factIds || []), ...(meta.deletedFactIds || [])])
      .map(id => this.factKey(scope, scopeId, id))
    const scannedFactKeys = await this.scanKeys(this.factKey(scope, scopeId, "*"))
    const factKeys = uniq([...indexedFactKeys, ...scannedFactKeys])
    await this.deleteKeys(factKeys)
    await redis.del(this.metaKey(scope, groupId, userId))

    if (scope === "user") {
      await redis.del(this.legacyUserKey(groupId, userId))
      await this.clearUserCandidates(groupId, userId)
    } else {
      await redis.del(this.legacyGroupKey(groupId))
    }

    return factKeys.length
  }

  async setDisabled(scope, groupId, userId, disabled) {
    const meta = await this.getMeta(scope, groupId, userId)
    meta.disabled = Boolean(disabled)
    await this.saveMeta(meta)
    return meta
  }
}
