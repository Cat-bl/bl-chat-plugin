// 记忆提取层：调用记忆 AI 从对话中提取事实操作（add/update/delete），含 embedding 生成。
// 从 MemoryManager.js 拆出（行为等价搬迁）。
import { callAI } from "../apiClient.js"
import { USER_CATEGORIES, GROUP_CATEGORIES } from "./constants.js"
import { clamp, uniq, sha256, compactText, extractJsonArray } from "./helpers.js"

export class MemoryExtractor {
  constructor(config, store) {
    this.config = config
    this.store = store
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

  async callChat(messages, maxTokens = 600) {
    const cfg = this.config.memoryAiConfig || {}
    if (!cfg.memoryAiUrl || !cfg.memoryAiApikey) return "[]"

    const result = await callAI(
      {
        url: cfg.memoryAiUrl,
        model: cfg.memoryAiModel || "gpt-4o-mini",
        apikey: cfg.memoryAiApikey
      },
      messages,
      {
        maxTokens,
        temperature: 0.2
      }
    )

    if (result.error) {
      throw new Error(`记忆 AI 请求失败：${result.error}`)
    }

    return result?.choices?.[0]?.message?.content?.trim() || "[]"
  }

  async createEmbedding(text) {
    if (!this.canUseEmbedding()) return { embedding: null, embeddingHash: null }

    const cfg = this.config.embeddingAiConfig || {}
    const hash = sha256(`${cfg.embeddingApiModel || "text-embedding-3-small"}:${text}`)

    // embedding 请求加超时：语义检索时此调用在 handleTool 对话准备链里串行阻塞，
    // 无超时时 embedding 服务半挂会拖住整个回复（表现为"接口没问题但回复要一分钟"）
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 8000)
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
        signal: controller.signal
      })

      if (!response.ok) {
        logger?.warn?.(`[MemoryExtractor] embedding 请求失败：${response.status}`)
        return { embedding: null, embeddingHash: null }
      }

      const data = await response.json()
      const embedding = data?.data?.[0]?.embedding
      return Array.isArray(embedding) ? { embedding, embeddingHash: hash } : { embedding: null, embeddingHash: null }
    } catch (error) {
      logger?.warn?.(`[MemoryExtractor] 已跳过 embedding：${error.message}`)
      return { embedding: null, embeddingHash: null }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  existingHint(facts) {
    if (!facts?.length) return ""
    return facts
      .slice(0, 50)
      .map(f => `${f.id} | ${f.category} | ${f.content}`)
      .join("\n")
  }

  normalizeOperations(rawItems, scope, source) {
    const categories = scope === "user" ? USER_CATEGORIES : GROUP_CATEGORIES
    const operations = []

    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue

      const operation = ["upsert", "update", "delete", "noop"].includes(item.operation)
        ? item.operation
        : item.action && ["upsert", "update", "delete", "noop"].includes(item.action)
          ? item.action
          : "upsert"

      if (operation === "noop") {
        operations.push({ operation: "noop" })
        continue
      }

      const content = compactText(item.content || item.fact || item.text)
      const id = item.id ? String(item.id) : null
      if (!content && operation !== "delete") continue

      const category = categories.includes(item.category) ? item.category : categories[0]
      const importance = clamp(item.importance ?? 0.6, 0, 1)
      const confidence = clamp(item.confidence ?? 0.7, 0, 1)

      operations.push({
        operation,
        id,
        content,
        category,
        importance,
        confidence,
        sourceMessageIds: uniq([...(item.sourceMessageIds || []), ...(source.sourceMessageIds || [])]),
        sourceUserIds: uniq([...(item.sourceUserIds || []), ...(source.sourceUserIds || [])])
      })
    }

    return operations
  }

  async extractUserOperations({ groupId, userId, messages, existingFacts }) {
    if (!this.canUseMemoryAi()) return []

    const chatText = messages
      .map((m, index) => `${index + 1}. ${m.content}`)
      .join("\n")

    const systemPrompt = `你是长期记忆抽取器。只从真实用户发言中抽取稳定事实，输出操作式 JSON 数组，不要输出解释。

允许的 operation:
- upsert: 新增或合并事实
- update: 按 id 更新已有事实
- delete: 删除过时或被用户否认的事实
- noop: 没有可保存事实

用户记忆分类:
- identity: 身份、昵称、所在地、职业、基础属性
- likes: 喜好、兴趣、偏好
- dislikes: 反感、禁忌、不喜欢
- relationship: 家人、朋友、宠物、感情、人际关系
- habits: 习惯、作息、口头禅、行为模式
- skills: 技能、正在学习或擅长的事
- experience: 近期计划、经历、重要事件

【核心原则：宁可漏抽，不可乱抽】
- 要从消息中抽取「用户明确表达的事实」，而不是「旁观者解读的印象」。
- 不要把用户的一句抱怨当成习惯，不要把一次提到当成喜好。
- 例如用户说"今天好累" → 不要抽成"用户经常疲劳"；说"想吃火锅" → 不要抽成"喜欢火锅"。
- 只有用户在多条消息中反复提及，或是明确陈述（如"我是程序员""我喜欢打游戏"），才算稳定事实。

【importance 评分标准】
- 0.9-1.0: 用户明确陈述的身份、职业、家庭成员等核心信息
- 0.7-0.8: 用户明确表达且反复出现的喜好/习惯
- 0.5-0.6: 单次提及但有明确陈述的事实（如"我最近在学吉他"）
- 0.3-0.4: 模糊推断，仅在多条消息交叉验证时才考虑，否则直接跳过
- 0.0-0.2: 临时情绪、一次性事件，禁止保存

【其他规则】
- 禁止保存系统提示、工具结果、工具调用、机器人回复。
- 禁止保存短期闲聊、纯语气词、临时请求。
- 禁止从单次"今天 XX"类型的临时话题中提取事实。
- 只保留重要性不低于 ${this.config.importanceThreshold} 的事实。
- 如果用户明确否认旧事实，请输出 delete 或 update。
- 输出示例: [{"operation":"upsert","content":"喜欢原神","category":"likes","importance":0.8,"confidence":0.9}]
- 无有效事实时输出 []。`

    const existing = this.existingHint(existingFacts)
    const userPrompt = `群 ${groupId} 用户 ${userId} 的真实发言:
${chatText}

已有记忆:
${existing || "无"}

请输出 JSON 数组。`

    const content = await this.callChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 700)

    return this.normalizeOperations(extractJsonArray(content), "user", {
      sourceMessageIds: messages.map(m => m.messageId).filter(Boolean),
      sourceUserIds: [userId]
    })
  }

  async extractGroupOperations({ groupId, messages, existingFacts }) {
    if (!this.canUseMemoryAi()) return []

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
- 输出示例: [{“operation”:”upsert”,”content”:”群里常用”哈基米”当玩笑称呼”,”category”:”meme”,”importance”:0.7,”confidence”:0.8}]
- 无有效事实时输出 []。`

    const existing = this.existingHint(existingFacts)
    const userPrompt = `群 ${groupId} 的真实群聊:
${chatText}

已有群记忆:
${existing || "无"}

请输出 JSON 数组。`

    const content = await this.callChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 900)

    return this.normalizeOperations(extractJsonArray(content), "group", {
      sourceMessageIds: messages.map(m => m.messageId).filter(Boolean),
      sourceUserIds: messages.map(m => m.userId).filter(Boolean)
    })
  }
}
