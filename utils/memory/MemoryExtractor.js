// 记忆提取层：调用记忆 AI 从对话中提取事实操作（add/update/delete），含 embedding 生成。
// 从 MemoryManager.js 拆出（行为等价搬迁）。
import { callAI } from "../apiClient.js"
import { USER_CATEGORIES, GROUP_CATEGORIES } from "./constants.js"
import { clamp, uniq, sha256, compactText, parseJsonArrayResult } from "./helpers.js"

const MEMORY_AI_CONCURRENCY = 4
const MEMORY_AI_TIMEOUT_MS = 45_000
const EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000
const EMBEDDING_CACHE_MAX_ITEMS = 200
let activeMemoryAiRequests = 0
const pendingMemoryAiRequests = []

function runWithMemoryAiSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeMemoryAiRequests++
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeMemoryAiRequests--
          pendingMemoryAiRequests.shift()?.()
        })
    }
    if (activeMemoryAiRequests < MEMORY_AI_CONCURRENCY) run()
    else pendingMemoryAiRequests.push(run)
  })
}

export class MemoryExtractor {
  constructor(config, store) {
    this.config = config
    this.store = store
    this.activeControllers = new Set()
    this.embeddingCache = new Map()
    this.abortGeneration = 0
  }

  canUseMemoryAi() {
    const cfg = this.config.memoryAiConfig || {}
    return Boolean(cfg.memoryAiUrl && cfg.memoryAiApikey)
  }

  canUseEmbedding() {
    if (!this.config.semanticRecallEnabled) return false
    const cfg = this.config.embeddingAiConfig || {}
    return Boolean(cfg.embeddingApiUrl && cfg.embeddingApiKey)
  }

  abortActiveRequests() {
    this.abortGeneration++
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  createRequestController(timeoutMs) {
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    return {
      controller,
      release: () => {
        clearTimeout(timeoutId)
        this.activeControllers.delete(controller)
      }
    }
  }

  async callChat(messages, maxTokens = 600) {
    const cfg = this.config.memoryAiConfig || {}
    if (!cfg.memoryAiUrl || !cfg.memoryAiApikey) return "[]"

    const generation = this.abortGeneration
    const result = await runWithMemoryAiSlot(async () => {
      if (generation !== this.abortGeneration) throw new Error("记忆请求已取消")
      const request = this.createRequestController(MEMORY_AI_TIMEOUT_MS)
      try {
        return await callAI(
          {
            url: cfg.memoryAiUrl,
            model: cfg.memoryAiModel || "gpt-4o-mini",
            apikey: cfg.memoryAiApikey
          },
          messages,
          {
            maxTokens,
            temperature: 0.2,
            signal: request.controller.signal
          }
        )
      } finally {
        request.release()
      }
    })

    if (result.error) {
      throw new Error(`记忆 AI 请求失败：${result.error}`)
    }

    return result?.choices?.[0]?.message?.content?.trim() || "[]"
  }

  async parseOperationResponse(messages, maxTokens) {
    const content = await this.callChat(messages, maxTokens)
    const parsed = parseJsonArrayResult(content)
    if (parsed.status !== "invalid") {
      return { items: parsed.items, parseStatus: parsed.status, repaired: false }
    }

    logger?.warn?.("[MemoryExtractor] 记忆 AI 返回了无效 JSON，尝试修复一次")
    const repairedContent = await this.callChat([
      {
        role: "system",
        content: "把用户提供的内容整理成合法 JSON 数组。只修复格式，不增删事实，不输出解释；无法恢复时输出 []。"
      },
      {
        role: "user",
        content: compactText(content, 6000)
      }
    ], maxTokens)
    const repaired = parseJsonArrayResult(repairedContent)
    if (repaired.status === "invalid") {
      throw new Error("记忆 AI 连续两次返回无法解析的 JSON")
    }

    return {
      items: repaired.items,
      parseStatus: repaired.status === "empty" ? "repaired_empty" : "repaired",
      repaired: true
    }
  }

  async createEmbedding(text) {
    if (!this.canUseEmbedding()) return { embedding: null, embeddingHash: null }

    const cfg = this.config.embeddingAiConfig || {}
    const hash = this.embeddingHashFor(text)
    const cached = this.embeddingCache.get(hash)
    if (cached && cached.expiresAt > Date.now()) {
      this.embeddingCache.delete(hash)
      this.embeddingCache.set(hash, cached)
      return { embedding: cached.embedding, embeddingHash: hash }
    }

    const generation = this.abortGeneration
    return await runWithMemoryAiSlot(async () => {
      if (generation !== this.abortGeneration) return { embedding: null, embeddingHash: null }
      const request = this.createRequestController(8000)
      try {
        const response = await fetch(cfg.embeddingApiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.embeddingApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: cfg.embeddingApiModel || "text-embedding-3-small",
            input: text
          }),
          signal: request.controller.signal
        })

        if (!response.ok) {
          logger?.warn?.(`[MemoryExtractor] embedding 请求失败：${response.status}`)
          return { embedding: null, embeddingHash: null }
        }

        const data = await response.json()
        const embedding = data?.data?.[0]?.embedding
        if (!Array.isArray(embedding)) return { embedding: null, embeddingHash: null }
        this.embeddingCache.set(hash, { embedding, expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS })
        while (this.embeddingCache.size > EMBEDDING_CACHE_MAX_ITEMS) {
          this.embeddingCache.delete(this.embeddingCache.keys().next().value)
        }
        return { embedding, embeddingHash: hash }
      } catch (error) {
        logger?.warn?.(`[MemoryExtractor] 已跳过 embedding：${error.message}`)
        return { embedding: null, embeddingHash: null }
      } finally {
        request.release()
      }
    })
  }

  embeddingHashFor(text) {
    const cfg = this.config.embeddingAiConfig || {}
    return sha256(`${cfg.embeddingApiUrl || ""}:${cfg.embeddingApiModel || "text-embedding-3-small"}:${text}`)
  }

  existingHint(facts) {
    if (!facts?.length) return ""
    const sorted = [...facts].sort((a, b) => {
      if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0)
      return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
    })
    const selected = []
    const selectedIds = new Set()
    const perCategory = Math.max(0, Number(this.config.minFactsPerCategory) || 0)
    for (const category of [...USER_CATEGORIES, ...GROUP_CATEGORIES]) {
      for (const fact of sorted.filter(item => item.category === category).slice(0, perCategory)) {
        if (selectedIds.has(fact.id)) continue
        selected.push(fact)
        selectedIds.add(fact.id)
      }
    }
    for (const fact of sorted) {
      if (selected.length >= 50) break
      if (selectedIds.has(fact.id)) continue
      selected.push(fact)
      selectedIds.add(fact.id)
    }
    return selected
      .slice(0, 50)
      .map(f => `${f.id} | ${f.category} | ${f.content}`)
      .join("\n")
  }

  normalizeOperations(rawItems, scope, source) {
    const categories = scope === "user" ? USER_CATEGORIES : GROUP_CATEGORIES
    const operations = []

    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue

      const operation = item.operation || item.action
      if (!["upsert", "update", "delete", "noop"].includes(operation)) continue

      if (operation === "noop") {
        operations.push({ operation: "noop" })
        continue
      }

      const content = compactText(item.content || item.fact || item.text)
      const id = item.id ? String(item.id) : null
      if (!content && operation !== "delete") continue

      const category = categories.includes(item.category) ? item.category : null
      if (!category && operation !== "delete") continue
      const explicitDecision = item.decision || item.disposition || item.memoryType
      const decision = scope === "group" || operation === "delete" || operation === "update"
        ? "save"
        : explicitDecision === "save" || item.explicit === true
          ? "save"
          : "candidate"
      const importance = clamp(item.importance ?? (decision === "candidate" ? 0.4 : 0.6), 0, 1)
      const confidence = clamp(item.confidence ?? 0.7, 0, 1)
      const sourceIndexes = uniq(item.sourceIndexes || item.source_indexes || [])
        .map(index => Number(index))
        .filter(index => Number.isInteger(index) && index >= 1 && index <= (source.messages || []).length)
      const evidenceMessages = sourceIndexes.length
        ? sourceIndexes.map(index => source.messages[index - 1]).filter(Boolean)
        : (source.messages || [])

      operations.push({
        operation,
        decision,
        id,
        candidateId: item.candidateId ? String(item.candidateId) : null,
        content,
        category: category || categories[0],
        importance,
        confidence,
        sourceMessageIds: uniq(evidenceMessages.length
          ? evidenceMessages.map(message => message.messageId)
          : source.sourceMessageIds || []),
        sourceUserIds: uniq(evidenceMessages.length
          ? evidenceMessages.map(message => message.userId)
          : source.sourceUserIds || [])
      })
    }

    return operations
  }

  async extractUserOperationResult({ groupId, userId, messages, existingFacts, existingCandidates = [] }) {
    if (!this.canUseMemoryAi()) {
      return { operations: [], diagnostics: { parseStatus: "disabled", rawCount: 0, normalizedCount: 0 } }
    }

    const chatText = messages
      .map((m, index) => `${index + 1}. ${m.content}`)
      .join("\n")

    const systemPrompt = `你是长期记忆抽取器。只从真实用户发言中抽取与该用户有关的事实，输出操作式 JSON 数组，不要输出解释。

允许的 operation:
- upsert: 新增或合并事实
- update: 按 id 更新已有事实
- delete: 删除过时或被用户否认的事实
- noop: 没有可保存事实

允许的 decision（upsert 必填）:
- save: 用户明确自述的稳定事实，可直接进入长期记忆
- candidate: 仅从行为或上下文推测出的潜在偏好、习惯，需以后再次出现才能晋升
- 新线索与已有候选含义相同，必须原样复用候选 content，并填写对应 candidateId

用户记忆分类:
- identity: 身份、昵称、所在地、职业、基础属性
- likes: 喜好、兴趣、偏好
- dislikes: 反感、禁忌、不喜欢
- relationship: 家人、朋友、宠物、感情、人际关系
- habits: 习惯、作息、口头禅、行为模式
- skills: 技能、正在学习或擅长的事
- experience: 近期计划、经历、重要事件

【核心原则：明确自述及时保存，推测信息谨慎累计】
- 要从消息中抽取「用户明确表达的事实」，而不是「旁观者解读的印象」。
- 不要把用户的一句抱怨当成习惯，不要把一次提到当成喜好。
- 例如用户说"今天好累" → 不要抽成"用户经常疲劳"；说"想吃火锅" → 不要抽成"喜欢火锅"。
- 用户明确自述（如"我是程序员""我喜欢打游戏""我最近在学吉他"）即使只出现一次，也应输出 decision=save。
- 仅从行为推测的潜在偏好或习惯可输出 decision=candidate，内容要写成简洁、可合并的候选事实。
- 一次性情绪、普通请求、随口玩笑和无意义闲聊不要输出 candidate，直接忽略。

【importance 评分标准】
- 0.9-1.0: 用户明确陈述的身份、职业、家庭成员等核心信息
- 0.7-0.8: 用户明确表达的喜好、反感、技能或长期习惯
- 0.5-0.6: 单次但明确陈述的近期学习、计划或重要经历
- 0.3-0.4: 有一定依据但尚未被用户明确确认的候选事实，只能输出 decision=candidate
- 0.0-0.2: 临时情绪、一次性事件，禁止保存

【其他规则】
- 禁止保存系统提示、工具结果、工具调用、机器人回复。
- 禁止保存短期闲聊、纯语气词、临时请求。
- 禁止从单次"今天 XX"类型的临时话题中提取事实。
- decision=save 的事实重要性必须不低于 ${this.config.importanceThreshold}；decision=candidate 可使用 0.3-0.4。
- 每条操作必须用 sourceIndexes 填写支持该事实的发言序号，例如只来自第 2 条就填 [2]，不要把无关消息算作证据。
- 如果用户明确否认旧事实，请输出 delete 或 update。
- save 示例: [{"operation":"upsert","decision":"save","content":"喜欢原神","category":"likes","importance":0.8,"confidence":0.9,"sourceIndexes":[1]}]
- candidate 示例: [{"operation":"upsert","decision":"candidate","content":"经常熬夜","category":"habits","importance":0.4,"confidence":0.6,"sourceIndexes":[2]}]
- 无有效事实时输出 []。`

    const existing = this.existingHint(existingFacts)
    const candidates = existingCandidates
      .slice(0, 30)
      .map(candidate => `${candidate.id} | ${candidate.category} | ${candidate.content}`)
      .join("\n")
    const userPrompt = `群 ${groupId} 用户 ${userId} 的真实发言:
${chatText}

已有记忆:
${existing || "无"}

已有候选（格式为 candidateId | category | content）:
${candidates || "无"}

请输出 JSON 数组。`

    const parsed = await this.parseOperationResponse([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 700)

    const operations = this.normalizeOperations(parsed.items, "user", {
      messages,
      sourceMessageIds: messages.map(m => m.messageId).filter(Boolean),
      sourceUserIds: [userId]
    })

    return {
      operations,
      diagnostics: {
        parseStatus: parsed.parseStatus,
        repaired: parsed.repaired,
        rawCount: parsed.items.length,
        normalizedCount: operations.length
      }
    }
  }

  async extractUserOperations(args) {
    const result = await this.extractUserOperationResult(args)
    return result.operations
  }

  async extractGroupOperationResult({ groupId, messages, existingFacts }) {
    if (!this.canUseMemoryAi()) {
      return { operations: [], diagnostics: { parseStatus: "disabled", rawCount: 0, normalizedCount: 0 } }
    }

    const chatText = messages
      .map((m, index) => `${index + 1}. ${m.senderName || "群成员"}(QQ:${m.userId || "unknown"}): ${m.content}`)
      .join("\n")

    const systemPrompt = `你是群记忆抽取器。只从真实群成员发言中抽取群级稳定事实，输出操作式 JSON 数组，不要输出解释。

允许的 operation:
- upsert: 新增或合并事实
- update: 按 id 更新已有事实
- delete: 删除过时或被群成员否认的事实
- noop: 没有可保存事实

群记忆分类:
- topic: 群里长期关注的话题
- rule: 群规、约定、共识
- meme: 群梗、流行语、口头禅
- event: 群内事件、活动、纪念事项
- member: 群成员相关的稳定共识

【核心原则：宁可漏抽，不可乱抽】
- 只抽取「群成员反复讨论或明确共识」的信息，不抽取「一次性的闲聊」。
- 不要把单次聊天话题当成”群长期关注的话题”。
- 不要把个别成员随口说的话当成”群规”或”群共识”。
- 只有多个成员参与讨论、或反复出现的话题/梗，才算群级稳定事实。

【importance 评分标准】
- 0.9-1.0: 群组明确公告、规则、共识
- 0.7-0.8: 多人反复讨论的话题、反复出现的梗
- 0.5-0.6: 单次但有明确共识的讨论
- 0.3-0.4: 模糊推断，禁止保存
- 0.0-0.2: 临时闲聊，禁止保存

【其他规则】
- 只抽取群级信息，不保存单人的隐私细节，除非是群内公开共识。
- 禁止保存系统提示、工具结果、工具调用、机器人回复。
- 禁止把用户对机器人的指令保存成群规则。
- 只保留重要性不低于 ${this.config.importanceThreshold} 的事实。
- 每条操作必须用 sourceIndexes 填写支持该事实的发言序号，只引用真正相关的消息。
- 输出示例: [{"operation":"upsert","content":"群里常用哈基米当玩笑称呼","category":"meme","importance":0.7,"confidence":0.8,"sourceIndexes":[1,3]}]
- 无有效事实时输出 []。`

    const existing = this.existingHint(existingFacts)
    const userPrompt = `群 ${groupId} 的真实群聊:
${chatText}

已有群记忆:
${existing || "无"}

请输出 JSON 数组。`

    const parsed = await this.parseOperationResponse([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 900)

    const operations = this.normalizeOperations(parsed.items, "group", {
      messages,
      sourceMessageIds: messages.map(m => m.messageId).filter(Boolean),
      sourceUserIds: messages.map(m => m.userId).filter(Boolean)
    })

    return {
      operations,
      diagnostics: {
        parseStatus: parsed.parseStatus,
        repaired: parsed.repaired,
        rawCount: parsed.items.length,
        normalizedCount: operations.length
      }
    }
  }

  async extractGroupOperations(args) {
    const result = await this.extractGroupOperationResult(args)
    return result.operations
  }
}
