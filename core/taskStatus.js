// 工具任务状态：记录"某条消息是否已被工具处理过"，注入模型上下文防止重复处理。
// 内存 Map + redis 双层缓存。
// 以 mixin 形式挂到插件原型上，this 指向插件实例（依赖 this.TASK_STATUS_PREFIX、this.config）。

const taskStatusCache = new Map()

export const taskStatusMethods = {
  getTaskStatusCacheKey(groupId, messageId) {
    return `${groupId}:${messageId}`
  }
,
  getTaskStatusRedisKey(groupId, messageId) {
    return `${this.TASK_STATUS_PREFIX}${groupId}:${messageId}`
  }
,
  getTaskStatusTtlSeconds() {
    return Math.max(60, Math.floor((this.config.groupChatMemoryDays || 1) * 24 * 60 * 60))
  }
,
  async saveTaskStatus({ groupId, userId, messageId, status, toolName = "", error = "" }) {
    if (!groupId || !messageId || !status) return

    const record = {
      groupId: String(groupId),
      userId: userId ? String(userId) : "",
      messageId: String(messageId),
      status,
      toolName,
      error: error ? String(error).slice(0, 120) : "",
      updatedAt: Date.now()
    }
    const cacheKey = this.getTaskStatusCacheKey(groupId, messageId)
    taskStatusCache.set(cacheKey, record)

    try {
      await redis.set(this.getTaskStatusRedisKey(groupId, messageId), JSON.stringify(record), {
        EX: this.getTaskStatusTtlSeconds()
      })
    } catch (error) {
      logger.warn(`[任务状态] 写入失败：${error.message}`)
    }
  }
,
  async getTaskStatus(groupId, messageId) {
    if (!groupId || !messageId) return null

    const cacheKey = this.getTaskStatusCacheKey(groupId, messageId)
    if (taskStatusCache.has(cacheKey)) return taskStatusCache.get(cacheKey)

    try {
      const raw = await redis.get(this.getTaskStatusRedisKey(groupId, messageId))
      if (!raw) return null
      const record = JSON.parse(raw)
      taskStatusCache.set(cacheKey, record)
      return record
    } catch (error) {
      logger.warn(`[任务状态] 读取失败：${error.message}`)
      return null
    }
  }
,
  async clearTaskStatus(groupId, messageId) {
    if (!groupId || !messageId) return
    taskStatusCache.delete(this.getTaskStatusCacheKey(groupId, messageId))
    try {
      await redis.del(this.getTaskStatusRedisKey(groupId, messageId))
    } catch (error) {
      logger.warn(`[任务状态] 清理失败：${error.message}`)
    }
  }
,
  formatTaskStatusForPrompt(status) {
    if (!status?.status) return ""
    const toolName = status.toolName || "未知工具"
    if (status.status === "processing") {
      return "[任务状态: 这条消息已进入处理流程，机器人正在判断是否需要调用工具，禁止把这条历史消息当作当前新任务重复处理]"
    }
    if (status.status === "tool_running") {
      return `[任务状态: 工具调用中，工具 ${toolName} 正在处理这条消息，禁止重复调用工具处理它]`
    }
    if (status.status === "tool_success") {
      return `[任务状态: 工具已完成，工具 ${toolName} 已处理这条消息，禁止再次调用工具处理它]`
    }
    if (status.status === "tool_failed") {
      const reason = status.error ? `，失败原因: ${status.error}` : ""
      return `[任务状态: 工具调用失败，工具 ${toolName} 处理失败${reason}，除非当前用户明确要求重试，否则禁止替历史消息再次调用工具]`
    }
    return ""
  }
}
