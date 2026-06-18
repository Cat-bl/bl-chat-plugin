// 工具调用历史：按群保留最近 N 条用户消息触发的工具调用聚合记录，
// 注入到 system prompt 让模型形成跨对话的事件认知。
// 同一条用户消息触发的多个工具（无论一轮并行还是多轮串行）聚合成一条 record。
// 内存 Map + redis 双层缓存，与 taskStatus 同构。
// 以 mixin 形式挂到插件原型上，this 指向插件实例（依赖 this.config）。

const TOOL_HISTORY_PREFIX = "ytbot:tool_history:"
const toolHistoryCache = new Map()

// 终态工具中只有 textImageTool 值得作为执行历史；waitTool / sendLocalEmojiTool 价值低且会刷屏
const TOOL_HISTORY_SKIP_TOOL_NAMES = new Set(["waitTool", "sendLocalEmojiTool"])

// 不复用 chat.js 的 isToolResultError —— 后者用中文模糊匹配会误判（结果里出现"错误/失败"两字就被判败）。
// 这里只识别约定俗成的 "error: " 前缀和显式 "error" JSON 字段。
function isFailureResult(text) {
  if (typeof text !== "string") return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^error[:：]/i.test(trimmed)) return true
  if (/"error"\s*:/.test(trimmed)) return true
  return false
}

function truncateResult(text, max) {
  const s = typeof text === "string" ? text : String(text ?? "")
  if (!s) return ""
  return s.length > max ? s.slice(0, max) + "...(已截断)" : s
}

// 老格式 record（每工具一条，无 tools 字段）兼容到新格式（每消息一条，tools 数组）
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null
  if (Array.isArray(raw.tools)) return raw
  if (raw.toolName) {
    return {
      messageId: raw.messageId || "",
      tools: [{
        toolName: raw.toolName,
        success: raw.success !== false,
        result: raw.result || ""
      }],
      time: raw.time || Date.now()
    }
  }
  return null
}

export const toolHistoryMethods = {
  isToolHistoryEnabled() {
    return this.config?.toolHistorySystem?.enabled !== false
  }
,
  getToolHistoryConfig() {
    const c = this.config?.toolHistorySystem || {}
    return {
      maxItems: Math.max(1, Math.min(50, Number(c.maxItems) || 10)),
      maxResultLength: Math.max(20, Math.min(2000, Number(c.maxResultLength) || 150)),
      ttlSeconds: Math.max(60, Math.floor((Number(c.ttlDays) || 7) * 24 * 60 * 60))
    }
  }
,
  getToolHistoryRedisKey(groupId) {
    return `${TOOL_HISTORY_PREFIX}${groupId}`
  }
,
  shouldSkipToolHistory(toolName) {
    return TOOL_HISTORY_SKIP_TOOL_NAMES.has(toolName)
  }
,
  async loadToolHistory(groupId) {
    if (!groupId) return []
    const key = String(groupId)
    if (toolHistoryCache.has(key)) return toolHistoryCache.get(key)

    try {
      const raw = await redis.get(this.getToolHistoryRedisKey(groupId))
      if (!raw) {
        toolHistoryCache.set(key, [])
        return []
      }
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean) : []
      toolHistoryCache.set(key, arr)
      return arr
    } catch (error) {
      logger?.warn?.(`[工具历史] 读取失败：${error.message}`)
      return []
    }
  }
,
  /**
   * 批量记录一条用户消息触发的工具结果。
   * - 同 messageId 命中列表头：追加 tools 到现有 record
   * - 否则：新建 record 推到列表头
   * @param {Object} param0
   * @param {string|number} param0.groupId
   * @param {string|number|null} param0.messageId
   * @param {Array<{toolName:string, result:string}>} param0.items
   */
  async recordToolHistoryBatch({ groupId, messageId, items }) {
    if (!this.isToolHistoryEnabled()) return
    if (!groupId) return
    if (!Array.isArray(items) || !items.length) return

    const { maxItems, maxResultLength, ttlSeconds } = this.getToolHistoryConfig()
    const subItems = items
      .filter(it => it && it.toolName && !this.shouldSkipToolHistory(it.toolName))
      .map(it => ({
        toolName: it.toolName,
        success: !isFailureResult(it.result),
        result: truncateResult(it.result, maxResultLength)
      }))
    if (!subItems.length) return

    const key = String(groupId)
    const prev = await this.loadToolHistory(groupId)
    const head = prev[0]
    const incomingId = messageId ? String(messageId) : ""

    let list
    if (incomingId && head?.messageId && head.messageId === incomingId) {
      // 同一条用户消息：追加到头部 record 的 tools
      const merged = {
        ...head,
        tools: [...(head.tools || []), ...subItems],
        time: Date.now()
      }
      list = [merged, ...prev.slice(1)]
    } else {
      // 新一条用户消息
      const record = {
        messageId: incomingId,
        tools: subItems,
        time: Date.now()
      }
      list = [record, ...prev].slice(0, maxItems)
    }

    toolHistoryCache.set(key, list)

    try {
      await redis.set(
        this.getToolHistoryRedisKey(groupId),
        JSON.stringify(list),
        { EX: ttlSeconds }
      )
    } catch (error) {
      logger?.warn?.(`[工具历史] 写入失败：${error.message}`)
    }
  }
,
  async getToolHistoryPromptForGroup(groupId) {
    if (!this.isToolHistoryEnabled()) return ""
    if (!groupId) return ""
    const list = await this.loadToolHistory(groupId)
    if (!list.length) return ""

    const lines = list.map(record => {
      const idTag = record.messageId ? `[消息ID:${record.messageId}] ` : ""
      const tools = Array.isArray(record.tools) ? record.tools : []
      if (tools.length === 1) {
        const t = tools[0]
        const flag = t.success ? "✓" : "✗"
        const result = t.result ? ` → ${t.result}` : ""
        return `- ${idTag}${t.toolName} ${flag}${result}`
      }
      const sub = tools.map(t => {
        const flag = t.success ? "✓" : "✗"
        const result = t.result ? ` → ${t.result}` : ""
        return `  · ${t.toolName} ${flag}${result}`
      }).join("\n")
      return `- ${idTag}(${tools.length}个工具)\n${sub}`
    })
    return `【工具调用历史】（最近${list.length}条，按时间倒序，仅供你回忆做过的事，不要据此重复调用工具）\n${lines.join("\n")}`
  }
}
