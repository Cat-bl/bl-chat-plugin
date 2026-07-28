// 工具执行链 mixin：tool_calls 去重解析、单次工具执行（本地/MCP 分发、dedupe 防重复、
// 任务状态上报）、结果序列化、assistant 工具消息规范化与请求重试。
// 从 apps/chat.js 拆出（行为等价搬迁），经 Object.assign 挂到 ChatPlugin.prototype，this 即插件实例。
import { YTapi } from "../utils/apiClient.js"
import { mcpManager } from "../utils/MCPClient.js"
import { parseToolConfigEntry } from "./toolConfig.js"
import { isToolResultError } from "./toolResult.js"

// 同一用户同一 dedupe 工具"上一次未完成则跳过新调用"的运行态；模块级跨实例共享
const activeDedupeToolRuns = new Map()

export const toolExecutorMethods = {
  getToolRunKey(groupId, userId, toolName) {
    return `${groupId}:${userId}:${toolName}`
  },

  isDedupeTool(toolName) {
    return this.dedupeToolNames?.has(toolName)
  },

  syncDedupeToolConfig(toolNames = this.config.oneapi_tools || []) {
    this.dedupeToolNames = new Set(
      (Array.isArray(toolNames) ? toolNames : [])
        .map(item => parseToolConfigEntry(item))
        .filter(item => item.name && item.dedupe)
        .map(item => item.name)
    )
  },

  async retryRequest(requestData, toolContent, retries = 1, toolName) {
    while (retries >= 0) {
      try {
        const response = await YTapi(requestData, this.config, toolContent, toolName)
        if (response) return response
      } catch (error) {
        logger.error(`API请求失败(${retries}):`, error)
      }
      retries--
    }
    return null
  },

  /**
   * 执行工具 - 统一处理本地工具和MCP工具
   */
  normalizeAssistantToolMessage(message) {
    const normalized = {
      role: "assistant",
      content: message.content || "",
      tool_calls: (message.tool_calls || []).map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type || "function",
        function: {
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments || "{}"
        }
      }))
    }

    if (message.reasoning_content) {
      normalized.reasoning_content = message.reasoning_content
    }

    return normalized
  },

  serializeToolResult(result) {
    if (typeof result === "string") return result

    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .map(item => item.type === "text" ? item.text : JSON.stringify(item))
        .join("\n")
    }

    return JSON.stringify(result ?? "")
  },

  async runToolCall(toolCall, e, session, senderRole) {
    const { type, function: funcData } = toolCall
    if (type !== "function" || !funcData?.name) return null

    const toolName = funcData.name
    const isMCPTool = mcpManager.isMCPTool(toolName)
    const isLocalTool = !isMCPTool && this.toolInstances[toolName]
    const isValidTool = session.tools?.some(t => t.function?.name === toolName)

    if (!isValidTool || (!isMCPTool && !isLocalTool)) {
      return {
        toolCall,
        toolName,
        result: `error: tool ${toolName} is not available in this session`,
        _executed: false
      }
    }

    let params
    try {
      params = JSON.parse(funcData.arguments || "{}")
    } catch (error) {
      return {
        toolCall,
        toolName,
        result: `error: invalid JSON arguments: ${error.message}`,
        _executed: true
      }
    }

    if (toolName === "jinyanTool" && senderRole) {
      params.senderRole = senderRole
    }
    if (toolName === "changeCardTool" && senderRole) {
      params.senderRole = senderRole
    }

    const dedupeEnabled = this.isDedupeTool(toolName)
    const task = session.taskContext || {}
    const toolRunKey = dedupeEnabled ? this.getToolRunKey(e.group_id, e.user_id, toolName) : ""
    const toolRunValue = {
      groupId: e.group_id,
      userId: e.user_id,
      messageId: task.messageId || e.message_id || null,
      toolName,
      startedAt: Date.now()
    }

    if (dedupeEnabled) {
      if (activeDedupeToolRuns.has(toolRunKey)) {
        return {
          toolCall,
          toolName,
          result: `工具 ${toolName} 正在处理同一用户的上一条请求，已跳过重复调用`,
          _executed: false
        }
      }

      activeDedupeToolRuns.set(toolRunKey, toolRunValue)
      session.taskDedupeToolTouched = true
      if (toolRunValue.messageId) {
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_running",
          toolName
        })
      }
    }

    try {
      logger.info(`[工具调用] ${isMCPTool ? "MCP" : "本地"} ${toolName}: ${JSON.stringify(params)}`)
      const rawResult = isMCPTool
        ? await this.executeTool(toolName, params, e)
        : await this.executeTool(this.toolInstances[toolName], params, e)
      // 本地工具 func 可返回 this.terminal(result) 标记本次为终态（成功后不再请求 LLM 续话）
      const isTerminal = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult) && rawResult.terminal === true
      const result = this.serializeToolResult(isTerminal ? rawResult.result : rawResult)
      if (dedupeEnabled && toolRunValue.messageId) {
        const failed = isToolResultError(result)
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: failed ? "tool_failed" : "tool_success",
          toolName,
          error: failed ? result : ""
        })
      }
      const finalResult = result?.trim() ? result : `工具 ${toolName} 执行成功`
      if (toolName !== "waitTool" && !isToolResultError(finalResult)) {
        try { e._conversationProducedOutput = true } catch {}
      }
      return {
        toolCall,
        toolName,
        result: finalResult,
        _executed: true,
        _terminal: isTerminal
      }
    } catch (error) {
      if (dedupeEnabled && toolRunValue.messageId) {
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_failed",
          toolName,
          error: error.message
        })
      }
      logger.error(`[工具调用] ${toolName} 执行失败:`, error)
      return {
        toolCall,
        toolName,
        result: `error: ${error.message}`,
        _executed: true
      }
    } finally {
      if (dedupeEnabled && activeDedupeToolRuns.get(toolRunKey) === toolRunValue) {
        activeDedupeToolRuns.delete(toolRunKey)
      }
    }
  },

  dedupeToolCalls(toolCalls = []) {
    const seen = new Set()
    return toolCalls.filter(toolCall => {
      const key = `${toolCall.function?.name}:${toolCall.function?.arguments || "{}"}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  },

  async processToolCalls(message, e, session, groupUserMessages, atQq, senderRole) {
    const MAX_TOOL_ROUNDS = this.config.maxToolRounds || 5
    let currentMessage = message
    let currentMessages = [...groupUserMessages]
    let round = 0
    const allToolResults = []

    while (currentMessage.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
      round++
      const toolCalls = this.dedupeToolCalls(currentMessage.tool_calls)
      logger.info(`[工具调用] 第 ${round} 轮，共 ${toolCalls.length} 个工具`)

      currentMessages.push(this.normalizeAssistantToolMessage({
        ...currentMessage,
        tool_calls: toolCalls
      }))

      const validResults = (await Promise.all(
        toolCalls.map(toolCall => this.runToolCall(toolCall, e, session, senderRole))
      )).filter(Boolean)

      if (validResults.length === 0) break

      allToolResults.push(...validResults)
      session.toolName = validResults[validResults.length - 1]?.toolName

      // 批量写工具调用历史（同一条用户消息的多工具会聚合到同一条 record）
      const recordedItems = validResults
        .filter(r => r._executed)
        .map(r => ({ toolName: r.toolName, result: r.result }))
      if (recordedItems.length) {
        this.recordToolHistoryBatch({
          groupId: e.group_id,
          messageId: e.message_id || null,
          items: recordedItems
        }).catch(err => logger?.warn?.(`[工具历史] 批量记录失败：${err.message}`))
      }

      currentMessages.push(...validResults.map(({ toolCall, toolName, result }) => ({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: result
      })))

      if (validResults.every(r => r._terminal && typeof r.result === 'string' && !r.result.startsWith('error:'))) {
        logger.info(`[工具调用] 本轮全部为终态工具(${validResults.map(r => r.toolName).join(',')})且执行成功，跳过最终文本回复`)
        session.toolResults = allToolResults
        return
      }

      const nextRequest = this.buildRequestData(currentMessages, session.tools, "auto")
      const nextResponse = await this.retryRequest(nextRequest, session.toolContent, 1, session.toolName)
      const nextMessage = nextResponse?.choices?.[0]?.message
      if (!nextMessage) break

      currentMessage = nextMessage
      if (!currentMessage.tool_calls?.length && currentMessage.content) {
        session.toolResults = allToolResults
        await this.handleTextResponse(
          currentMessage.content,
          e,
          session,
          currentMessages,
          session.toolName
        )
        return
      }
    }

    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`[工具调用] 已达到最大轮数：${MAX_TOOL_ROUNDS}`)
    }

    session.toolResults = allToolResults
    const finalRequest = this.buildRequestData(currentMessages, [], "none")
    const finalResponse = await this.retryRequest(finalRequest, session.toolContent, 1, session.toolName)

    if (finalResponse?.choices?.[0]?.message?.content) {
      await this.handleTextResponse(
        finalResponse.choices[0].message.content,
        e,
        session,
        currentMessages,
        session.toolName
      )
    }
  },

  async executeTool(tool, params, e) {
    // 不做自动重试：戳一戳/禁言/送礼等工具有副作用，盲目重试可能重复执行；
    // 失败信息会以 error 结果回传给模型，由模型决定后续动作。
    if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
      return await mcpManager.executeToolByAlias(tool, params)
    }

    if (tool && typeof tool.execute === "function") {
      return await tool.execute(params, e)
    }

    return null
  },
}
