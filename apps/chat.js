import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { mcpManager } from "../utils/MCPClient.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { scanRedisKeys, deleteRedisKeys } from "../utils/redisScan.js"
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import { randomUUID } from "crypto"
import schedule from 'node-schedule'
import { parseToolConfigEntry } from "../core/toolConfig.js"
import { isToolResultError } from "../core/toolResult.js"
import { buildChatSystemPrompt } from "../core/prompts.js"
import { initializeSharedState, getSharedState, refreshLocalTools, applyToolRegistrySnapshot } from "../core/sharedState.js"
import { delay } from "../core/asyncUtils.js"
import { configManagerMethods } from "../core/configManager.js"
import { taskStatusMethods } from "../core/taskStatus.js"
import { toolHistoryMethods } from "../core/toolHistory.js"
import { tryAutoGrabRedBag } from "../core/redBag.js"
import { messageBuilderMethods, roleMap } from "../core/messageBuilder.js"
import { conversationTrackerMethods, activeConversations, trackingThrottle } from "../core/conversationTracker.js"
import { replySenderMethods } from "../core/replySender.js"

const _path = process.cwd()


const activeDedupeToolRuns = new Map()

// 群级并发计数：groupId -> 处理中的对话数。达到 concurrentLimit 时新消息直接不触发（不排队）。
// 必须放模块级：Yunzai 每条消息都会 new 一个插件实例，实例属性跨消息不共享。
const activeGroupChatCounts = new Map()

let pluginInitialized = false
let mcpInitPromise = null



export class ChatPlugin extends plugin {
  constructor() {
    super({
      name: "全局方案-test",
      dsc: "全局方案测试版",
      event: "message",
      priority: 9999,
      rule: [
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    // 配置发生全量重载（首启/mtime 变化/chokidar 丢事件后的兜底）时刷新共享子系统，
    // 否则直接复用进程级单例（Yunzai 每条消息都会实例化本类）
    const configReloaded = this.initConfig()
    const state = (!configReloaded && getSharedState()) || initializeSharedState(this.config)

    this.messageManager = state.messageManager
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.sessionMap = state.sessionMap
    this.emotionManager = state.emotionManager
    this.memoryManager = state.memoryManager
    this.expressionLearner = state.expressionLearner
    this.knowledgeSearcher = state.knowledgeSearcher
    this.REDIS_KEY_PREFIX = 'ytbot:messages:'
    this.TASK_STATUS_PREFIX = 'ytbot:tool_task_status:'
    this.dedupeToolNames = new Set()

    this.localToolsReady = false
    this.tools = []
    this.initMessageHistory()
    mcpManager.setToolsChangedCallback(() => this.updateToolsList())
    // 不加 force：注册器内部有 5s 节流 + 并发去重，首次启动时会与 sharedState 的强制加载合并；
    // 之前每条消息都强制重扫 custom_tools 目录，纯属浪费
    this.localToolsReadyPromise = this.refreshLocalToolRegistry({ silent: true }).catch(error => {
      logger.error("[LocalToolRegistry] 启动加载本地工具失败:", error)
      this.localToolsReady = true
      this.initTools()
      return null
    })

    if (!pluginInitialized) {
      pluginInitialized = true
      mcpInitPromise = this.initMCP()
      this.initScheduledTasks()
      this.startActiveChatLruScanner()
    }

    pluginBridge.instance = this
  }


  async refreshLocalToolRegistry(options = {}) {
    const state = await refreshLocalTools(getSharedState(), options)
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.localToolsReady = true
    this.updateToolsList({ silent: options.silent === true })
    return state
  }

  initTools() {
    const sharedState = getSharedState()
    applyToolRegistrySnapshot(sharedState)
    this.toolInstances = sharedState.toolInstances
    this.functions = sharedState.functions
    this.functionMap = sharedState.functionMap

    const provider = this.config.providers.toLowerCase()
    const toolConfig = {
      oneapi: this.config.oneapi_tools
    }

    this.syncDedupeToolConfig(this.config.oneapi_tools || [])
    const localTools = this.getToolsByName(toolConfig[provider] || this.config.openai_tools, {
      warnMissing: this.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []
    this.tools = [...localTools, ...mcpTools]
  }

  initMessageHistory() {
    this.messageHistoriesRedisKey = "group_user_message_history"
    this.messageHistoriesDir = path.join(process.cwd(), "data/AItools/user_history")
    this.MAX_HISTORY = this.config.groupMaxMessages || 100

    // 目录只需保证一次；pluginInitialized 在首个实例构造完成后置 true
    if (!pluginInitialized && !fs.existsSync(this.messageHistoriesDir)) {
      fs.mkdirSync(this.messageHistoriesDir, { recursive: true })
    }
  }

  initScheduledTasks() {
    // 每天0点清理消息历史记录
    schedule.scheduleJob('0 0 * * *', async () => {
      try {
        logger.info('开始执行消息历史记录清理定时任务')
        await this.clearAllMessages()
        logger.info('消息历史记录清理完成')
      } catch (error) {
        logger.error(`定时清理消息历史记录失败: ${error}`)
      }
    })

    // 每秒检查待触发的提醒
    schedule.scheduleJob('* * * * * *', async () => {
      try {
        await checkPendingReminders(this.toolInstances)
      } catch (error) {
        logger.error(`[定时提醒] 检查失败: ${error}`)
      }
    })

    logger.info('[定时任务] 提醒检查任务已启动（每秒）')
  }





  /**
   * 外部插件主动触发：注入 intent 到群历史 + 强制下一轮 Gate continue
   * @param {string|number} groupId
   * @param {string} intent 主动想说的话题/意图
   * @param {object} opts { source: '插件名', anchorE: 可选锚点 e }
   */
  async enqueueProactiveTask(groupId, intent, opts = {}) {
    if (!groupId || !intent) return { ok: false, error: 'missing_params' }
    const anchor = opts.anchorE
    if (!anchor) {
      logger.warn(`[Proactive] group=${groupId} 缺少锚点 e，无法触发；intent="${String(intent).slice(0, 40)}"`)
      return { ok: false, error: 'missing_anchor' }
    }
    if (String(anchor.group_id) !== String(groupId)) {
      logger.warn(`[Proactive] anchor.group_id(${anchor.group_id}) 与传入 groupId(${groupId}) 不匹配，拒绝触发`)
      return { ok: false, error: 'anchor_group_mismatch' }
    }
    if (!this.checkGroupPermission(anchor)) {
      return { ok: false, error: 'not_whitelisted' }
    }
    if (await this.isMutedInGroup(anchor)) {
      return { ok: false, error: 'muted' }
    }

    logger.info(`[Proactive] group=${groupId} source=${opts.source || 'unknown'} intent="${String(intent).slice(0, 40)}"`)
    try {
      const wrapped = Object.create(anchor)
      wrapped.msg = `[系统主动触发 来自 ${opts.source || '插件'}] ${intent}`
      wrapped._smartOriginKey = `${groupId}:proactive:${randomUUID()}`
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode === 'smart') {
        const state = this.getSmartState(groupId)
        state.forceContinue = true
        wrapped._proactiveReply = true
        setImmediate(() => this.handleRandomReplySmart(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      } else {
        // strict 模式没有 Gate，直接走 handleTool（绕过 @/前缀破冰）
        setImmediate(() => this.handleTool(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  // 保留实例方法签名（pluginBridge 对外暴露本实例），实现委托给 utils/redisScan.js 共享版
  async scanRedisKeys(pattern) {
    return scanRedisKeys(pattern, "Redis")
  }

  async deleteRedisKeys(keys = []) {
    return deleteRedisKeys(keys)
  }

  async clearAllMessages() {
    const keys = await this.scanRedisKeys(`${this.REDIS_KEY_PREFIX}*`)
    if (keys?.length) {
      await this.deleteRedisKeys(keys)
      logger.info(`已清除${keys.length}条消息历史记录`)
    }
  }

  getToolRunKey(groupId, userId, toolName) {
    return `${groupId}:${userId}:${toolName}`
  }

  async beginConversationTask(e) {
    const groupId = e.group_id
    const userId = e.user_id
    if (!groupId || !userId) return { groupId, userId, messageId: e.message_id || null }

    const task = {
      groupId,
      userId,
      messageId: e.message_id || null,
      startedAt: Date.now()
    }

    if (task.messageId) {
      await this.saveTaskStatus({
        groupId,
        userId,
        messageId: task.messageId,
        status: "processing"
      })
    }

    return task
  }

  async finishConversationTask(task, session) {
    if (!task?.groupId || !task?.userId) return

    if (!task.messageId || session?.taskDedupeToolTouched) return

    const status = await this.getTaskStatus(task.groupId, task.messageId)
    if (!status || status.status === "processing") {
      await this.clearTaskStatus(task.groupId, task.messageId)
    }
  }

  isDedupeTool(toolName) {
    return this.dedupeToolNames?.has(toolName)
  }

  /**
   * 群对话并发是否已达上限（concurrentLimit）。
   * 供 handleTool 之前的路径（会话追踪判定 / smart Gate）提前让步，
   * 避免先消耗一次判定 API、最后又被 handleTool 的并发检查丢弃。
   */
  isGroupChatAtCapacity(groupId) {
    if (!groupId) return false
    const { active, limit } = this.getGroupChatConcurrency(groupId)
    return active >= limit
  }

  /**
   * 取群当前并发占用情况，供日志统一输出。
   */
  getGroupChatConcurrency(groupId) {
    const limit = Math.max(1, Number(this.config.concurrentLimit) || 5)
    return { active: activeGroupChatCounts.get(groupId) || 0, limit }
  }

  syncDedupeToolConfig(toolNames = this.config.oneapi_tools || []) {
    this.dedupeToolNames = new Set(
      (Array.isArray(toolNames) ? toolNames : [])
        .map(item => parseToolConfigEntry(item))
        .filter(item => item.name && item.dedupe)
        .map(item => item.name)
    )
  }

  getToolsByName(toolNames, options = {}) {
    if (!toolNames || !Array.isArray(toolNames)) return []
    const warnMissing = options.warnMissing !== false

    return toolNames
      .map(item => {
        const { name } = parseToolConfigEntry(item)
        if (name === 'sendLocalEmojiTool' && !this.config?.emojiSystem?.enabled) {
          return null
        }
        if (name === 'waitTool') {
          const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
          if (mode !== 'smart' || !this.config?.smartTrigger?.waitToolEnabled) return null
        }
        const func = this.functionMap.get(name)
        if (!func) {
          if (warnMissing) logger.warn(`未找到工具 "${name}"`)
          return null
        }
        return {
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: {
              type: "object",
              properties: func.parameters.properties,
              required: func.parameters.required || []
            }
          }
        }
      })
      .filter(Boolean)
  }

  getToolsDescriptionString() {
    if (!this.tools?.length) return "当前没有可用的工具。"

    const localDesc = this.tools
      ?.filter(t => !mcpManager.isMCPTool(t.function?.name))
      .map(t => `${t.function.name}: ${t.function.description}`)
      .join("\n") || ""

    const mcpDesc = mcpManager.getToolsDescription ? mcpManager.getToolsDescription() : ""

    const parts = []
    if (localDesc) parts.push("【本地工具】\n" + localDesc)
    if (mcpDesc) parts.push("【MCP工具】\n" + mcpDesc)

    return parts.length ? parts.join("\n\n") : "当前没有可用的工具。"
  }

  checkGroupPermission(e) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  async getGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)

    try {
      const redisData = await loadData(redisKey, null)
      if (redisData) return redisData

      const fileData = await fs.promises.readFile(filePath, "utf-8").catch(() => null)
      if (fileData) {
        const parsed = JSON.parse(fileData)
        await saveData(redisKey, filePath, parsed)
        return parsed
      }
      return []
    } catch (error) {
      logger.error(`获取消息历史失败:`, error)
      return []
    }
  }

  async saveGroupUserMessages(groupId, userId, messages) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    // 串行写：saveData 在 redis 挂掉时会降级写同一个文件，并发写会导致 JSON 交错损坏
    try {
      await saveData(redisKey, filePath, messages)
      await fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8")
    } catch (err) {
      logger.error(`保存消息历史失败:`, err)
    }
  }

  async clearGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      redis.del(redisKey),
      fs.promises.unlink(filePath).catch(() => { })
    ])
  }

  async resetGroupUserMessages(groupId, userId) {
    await this.clearGroupUserMessages(groupId, userId)
    await this.saveGroupUserMessages(groupId, userId, [])
  }


  getProvider() {
    return this.config?.providers?.toLowerCase()
  }

  getModel() {
    const models = {
      oneapi: this.config.chatAiConfig.chatApiModel
    }
    return models[this.getProvider()]
  }

  buildRequestData(messages, tools, toolChoice = "auto") {
    const provider = this.getProvider()
    const data = {
      model: this.getModel(),
      messages,
      temperature: 0.7,
      top_p: 0.9
    }

    if (this.config.useTools && tools?.length && toolChoice !== "none") {
      data.tools = tools
      data.tool_choice = toolChoice
    }
    return data
  }

  checkTriggers(e) {
    try {
      const hasMessage = e.msg && typeof e.msg === "string" &&
        this.config.triggerPrefixes.some(p => p && e.msg.toLowerCase().includes(p.toLowerCase()))

      // 用 e.self_id / e.bot.uin（收到消息的账号）做 @ 检测；
      // TRSS 多账号下 Bot.uin 是数组，`qq == Bot.uin` 永远不成立会导致 @bot 检测失效
      const selfId = e?.self_id ?? e?.bot?.uin ?? (typeof Bot !== "undefined" ? Bot.uin : "")
      const hasAt = Array.isArray(e.message) &&
        e.message.some(msg => msg?.type == "at" && String(msg?.qq) === String(selfId))

      return hasMessage || hasAt
    } catch {
      return false
    }
  }

  isCommand(e) {
    return e.msg?.startsWith("#")
  }

  filterChatByQQ(chatArray, qqNumber) {
    const pattern = /\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/
    const lastIndex = chatArray.reduce((last, curr, i) =>
      curr.content?.includes(`(qq号: ${qqNumber})`) && pattern.test(curr.content) ? i : last, -1)
    return lastIndex === -1 ? chatArray : chatArray.slice(0, lastIndex + 1)
  }

  getOrCreateSession(sessionId, tools) {
    if (!this.sessionMap.has(sessionId)) {
      this.sessionMap.set(sessionId, { tools, groupUserMessages: [] })
    }
    return this.sessionMap.get(sessionId)
  }

  clearSession(sessionId) {
    this.sessionMap.delete(sessionId)
  }

  trimMessageHistory(messages) {
    const nonSystem = messages.filter(m => m.role !== "system")
    if (nonSystem.length <= this.MAX_HISTORY) return messages

    const system = messages.filter(m => m.role === "system")
    return [...system, ...nonSystem.slice(-this.MAX_HISTORY)]
  }


  async handleRandomReply(e) {
    if (!this.config.enabled || !this.checkGroupPermission(e) || this.isCommand(e) || !e.group_id) {
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (this.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    // 禁言检测：bot 在该群被禁言（个人/全员）时不触发任何回复，避免发送失败 + 表情/red 包等也无意义
    if (await this.isMutedInGroup(e)) return false

    // 静默收集消息用于表达学习（不管是否触发AI对话）
    if (this.config.expressionLearning?.enabled && e.msg) {
      this.expressionLearner.updateGroupExpressions(e.group_id, e.msg).catch(() => {})
    }

    // 检测红包消息并随机触发抢红包（两种模式都生效）
    const redBagResult = await tryAutoGrabRedBag(e, this)
    if (redBagResult) return redBagResult.value

    // smart 模式分发
    const triggerMode = String(this.config.chatTriggerMode || 'strict').toLowerCase()
    if (triggerMode === 'smart') {
      return await this.handleRandomReplySmart(e)
    }


    const hasTrigger = await this.checkTriggers(e)

    // 会话追踪逻辑
    const conversationKey = `${e.group_id}_${e.user_id}`
    const activeConv = activeConversations.get(conversationKey)

    // 如果明确触发（@或前缀），直接触发并更新追踪
    if (hasTrigger) {
      if (this.config.conversationTrackingEnabled) {
        this.setTrackingWithTimer(conversationKey)
      }
      return await this.handleTool(e)
    }

    // 群复读跟读（复读功能两种模式都生效，配置沿用 smartTrigger.repeat*）：
    // 先收集消息进检测窗口，非 @/前缀触发时命中复读潮就直接跟发原文
    this.collectRepeatMessage(e)
    if (await this.tryJoinGroupRepeat(e)) {
      return true
    }

    // 在追踪期内，判断是否在继续对话
    if (this.config.conversationTrackingEnabled && activeConv) {
      // 登记本条消息序号：连发时后一条会拿到更大序号，使前一条的回复去抖检测到"还有新消息"而让步
      const arrivalSeq = this.markTrackingArrival(conversationKey)

      // 群并发已满时提前让步，避免白白消耗一次"是否在跟 bot 对话"的判定 API
      if (this.isGroupChatAtCapacity(e.group_id)) {
        const { active, limit } = this.getGroupChatConcurrency(e.group_id)
        logger.info(`[并发限制][strict-追踪] 群${e.group_id} 已有 ${active}/${limit} 条对话在处理，跳过本次接续判定（非API异常，现有对话处理完后下条消息自动恢复）。msg="${String(e.msg || '').slice(0, 30)}"`)
        return false
      }
      // 节流检查
      const throttleKey = conversationKey
      const lastCallTime = trackingThrottle.get(throttleKey) || 0
      const throttleInterval = (this.config.conversationTrackingThrottle || 3) * 1000

      if (Date.now() - lastCallTime < throttleInterval) {
        // 节流期内，直接返回不触发
        return false
      }

      // 更新节流时间
      trackingThrottle.set(throttleKey, Date.now())

      // 构建完整格式的用户消息
      const senderRole = roleMap[e.sender?.role] || "member"
      const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
      const userMessageFormatted = `${this.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${e.msg || ''}`

      // 使用批量判断队列
      const isTalking = await this.addToBatchJudgment(conversationKey, userMessageFormatted, activeConv.chatHistory || [], e)

      if (isTalking) {
        // 回复去抖：用户还在连发时让步，只由最后一条触发一次回复（handleTool 自带群历史，能看到连发的全部消息）
        if (!(await this.applyTrackingReplyDebounce(conversationKey, arrivalSeq))) {
          return false
        }
        // 去抖等待期间并发可能被占满，重新检查一次
        if (this.isGroupChatAtCapacity(e.group_id)) {
          const { active, limit } = this.getGroupChatConcurrency(e.group_id)
          logger.info(`[并发限制][strict-追踪] 群${e.group_id} 去抖后并发已满 ${active}/${limit}，跳过本条`)
          return false
        }
        // 重置定时器
        this.setTrackingWithTimer(conversationKey)
        return await this.handleTool(e)
      }
      // 判断不是在跟机器人对话，直接返回不触发
      return false
    }

    // 未在追踪期内，不触发
    return false
  }

  async handleTool(e) {
    if (!this.config.enabled || !e.group_id) {
      if (!e.group_id) await e.reply("该命令只能在群聊中使用。")
      return false
    }

    // 群级并发上限（concurrentLimit）：同群达到上限时，新消息直接不触发（不排队）
    const concurrentLimit = Math.max(1, Number(this.config.concurrentLimit) || 5)
    const activeChats = activeGroupChatCounts.get(e.group_id) || 0
    if (activeChats >= concurrentLimit) {
      logger.info(`[并发限制][handleTool] 群${e.group_id} 已有 ${activeChats}/${concurrentLimit} 条对话在处理，本条消息不触发对话（非API异常，现有对话处理完后下条消息自动恢复）。msg="${String(e.msg || '').slice(0, 30)}"`)
      return false
    }
    activeGroupChatCounts.set(e.group_id, activeChats + 1)
    try { e._conversationProducedOutput = false } catch {}

    try {
      if (this.localToolsReadyPromise) await this.localToolsReadyPromise
      await this.refreshLocalToolRegistry({ silent: true })
      await this.waitForMCPReady()

      const taskContext = await this.beginConversationTask(e)
      const handleToolStartAt = Date.now()

      const { group_id: groupId, user_id: userId, msg } = e
      const sessionId = randomUUID()
      e.sessionId = sessionId
      const session = this.getOrCreateSession(sessionId, this.tools)
      session.taskContext = taskContext

      let groupUserMessages = session.groupUserMessages

      try {
        const args = msg?.replace(/^#tool\s*/, "").trim() || ""
        // 同 checkTriggers：TRSS 多账号下 Bot.uin 是数组，须用 e.self_id 做字符串比较，
        // 否则 bot 自己的 @ 会漏进 atQq
        const selfIdForAt = e?.self_id ?? e?.bot?.uin ?? Bot.uin
        const atQq = e.message.filter(m => m.type === "at" && String(m.qq) !== String(selfIdForAt)).map(m => m.qq)
        const images = await TakeImages(e)

        let videos = []
        if (e.getReply) {
          const rsp = await e.getReply()
          videos = rsp?.message?.filter(m => m.type === "video") || []
        }

        const memberInfo = await (async () => {
          try {
            return await e.bot.pickGroup(groupId).pickMember(e.sender.user_id).info
          } catch { return {} }
        })()
        const senderRole = roleMap[e.sender?.role] || roleMap[memberInfo?.role] || "member"

        const userContent = await this.buildMessageContent(e.sender, args, images, atQq, e.group, e)

        const getHighLevelMembers = async group => {
          if (!group) return ""
          const members = await group.getMemberMap()
          return Array.from(members.values())
            .filter(m => ["admin", "owner"].includes(m.role))
            .map(m => `${m.nickname}(QQ号: ${m.user_id})[群身份: ${roleMap[m.role]}]`)
            .join("\n")
        }

        const mcpPrompts = mcpManager.getMCPSystemPrompts({
          messageType: e.message_type,
          groupId: e.group_id,
          message: e.msg
        })

        // 情感/记忆/表达学习/知识库/画像/群上下文 这几个 prompt 互相独立，并行构建。
        // 原来是逐个 await 串行，多个含 embedding/RPC 的慢调用会累加，是 @ 回复慢的主因之一。
        const [
          emotionPrompt,
          memoryPrompt,
          groupMemoryPrompt,
          expressionPrompt,
          knowledgePrompt,
          personProfilePrompt,
          groupContext
        ] = await Promise.all([
          this.config.emotionSystem?.enabled
            ? this.emotionManager.getEmotionPromptForGroup(groupId).catch(err => { logger.error(`[情感] 获取失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.memorySystem?.enabled
            ? this.memoryManager.getMemoryPromptForUser(groupId, userId, e.msg || "").catch(err => { logger.error(`[记忆] 用户检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.memorySystem?.enabled && groupId
            ? this.memoryManager.getGroupMemoryPrompt(groupId, e.msg || "").catch(err => { logger.error(`[记忆] 群检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.expressionLearning?.enabled
            ? this.expressionLearner.getExpressionPromptForGroup(groupId).catch(err => { logger.error(`[表达学习] 获取失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          (this.knowledgeSearcher && e.msg)
            ? this.knowledgeSearcher.search(e.msg)
                .then(result => result?.knowledgeContext
                  ? `【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\n${result.knowledgeContext}`
                  : '')
                .catch(err => { logger.error(`[知识库] 检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          (this.config.personProfileInjection?.enabled && groupId && userId)
            ? personProfileInjector.build(groupId, userId, e).catch(err => { logger.error(`[画像注入] 失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.getCurrentGroupContext(e).catch(err => { logger.error(`[群上下文] 获取失败: ${err.message}`); return { groupId: String(groupId || ''), groupName: '', groupNotice: '' } })
        ])

        // 构建增强系统提示
        const enhancedPrompts = [emotionPrompt, memoryPrompt, groupMemoryPrompt, expressionPrompt, knowledgePrompt, personProfilePrompt].filter(Boolean).join('\n')
        const toolHistoryPrompt = await this.getToolHistoryPromptForGroup(groupId)

        // 获取机器人在当前群的真实身份信息(群名片可能被 changeCardTool 改过)
        let botCardInGroup = Bot.nickname || "机器人"
        let botRoleInGroup = "member"

        try {
          const botMemberInfo = await e.group?.pickMember?.(Bot.uin)?.getInfo?.()
          logger.debug(`[身份信息] Bot.uin=${Bot.uin}, botMemberInfo=`, JSON.stringify(botMemberInfo))

          if (botMemberInfo) {
            botCardInGroup = (botMemberInfo.card && botMemberInfo.card.trim()) || botMemberInfo.nickname || Bot.nickname || "机器人"
            botRoleInGroup = roleMap[botMemberInfo.role] || "member"
          }
        } catch (err) {
          logger.warn(`[身份信息] 获取失败, 使用降级方案: ${err.message}`)
        }

        logger.debug(`[身份信息] 最终群名片=${botCardInGroup}, 群身份=${botRoleInGroup}`)

        const administrators = await getHighLevelMembers(e.group)
        const systemContent = buildChatSystemPrompt({
          systemContent: this.config.systemContent,
          botCardInGroup,
          botUin: Bot.uin,
          botRoleInGroup,
          groupContext,
          administrators,
          localTime: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
          enhancedPrompts,
          mcpPrompts,
          toolHistoryPrompt
        })
        // 获取历史记录
        if (this.config.groupHistory) {
          const chatHistory = await this.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id)

          if (chatHistory?.length) {
            const memberMap = await e.bot.pickGroup(groupId).getMemberMap()

            // 使用 message_id 过滤当前消息
            const currentMessageId = e.message_id

            groupUserMessages = await Promise.all(chatHistory
              .reverse()
              .filter(msg => {
                // 直接用 message_id 判断，过滤掉当前消息
                if (msg.message_id === currentMessageId) {
                  logger.debug(`[历史去重] 过滤当前消息: message_id=${msg.message_id}`)
                  return false
                }
                return true
              })
              .map(msg => ({
                role: msg.sender.user_id === Bot.uin ? "assistant" : "user",
                messageId: msg.message_id,
                content: `[${msg.time}] ${msg.sender.nickname}(QQ号:${msg.sender.user_id})[群身份: ${roleMap[msg.sender.role] || "member"}]${msg.message_id ? `[消息ID:${msg.message_id}]` : ''}: ${msg.content}`
              }))
            )
            groupUserMessages = await Promise.all(groupUserMessages.map(async msg => {
              const taskStatus = msg.messageId ? await this.getTaskStatus(groupId, msg.messageId) : null
              const statusText = this.formatTaskStatusForPrompt(taskStatus)
              return statusText ? { ...msg, content: `${msg.content}\n${statusText}` } : msg
            }))
          }
        }

        groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
        groupUserMessages.unshift({ role: "system", content: systemContent })
        groupUserMessages.push({ role: "user", content: userContent })
        session.userContent = userContent
        groupUserMessages = this.trimMessageHistory(groupUserMessages)
        groupUserMessages = this.filterChatByQQ(groupUserMessages, e.user_id)
        session.groupUserMessages = this.formatMessages(groupUserMessages, e, userContent)

        let toolChoice = "auto"
        if (videos?.length >= 1) {
          session.tools = this.getToolsByName(["videoAnalysisTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "videoAnalysisTool" } }
        }

        if (this.config.forcedAvatarMode && msg?.includes("头像编辑")) {
          session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
          session.groupUserMessages.at(-1).content += `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640)]`
        }

        if (msg?.includes("导图") || msg?.includes("思维导图")) {
          session.tools = this.getToolsByName(["aiMindMapTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "aiMindMapTool" } }
        }

        // 强制抢红包模式
        if (e.forceGrabRedBag) {
          session.tools = this.getToolsByName(["grabRedBagTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "grabRedBagTool" } }
        }

        session.toolContent = await this.buildMessageContent({ nickname: botCardInGroup, user_id: Bot.uin, role: botRoleInGroup }, "", [], [], e.group)

        const requestData = this.buildRequestData(session.groupUserMessages, session.tools, toolChoice)
        let response = await this.retryRequest(requestData, session.toolContent)

        if (!response?.choices?.[0]) {
          this.clearSession(sessionId)
          return true
        }

        const message = response.choices[0].message || {}

        if (message.tool_calls?.length) {
          await this.processToolCalls(message, e, session, session.groupUserMessages, atQq, senderRole)
        } else if (message.content) {
          await this.handleTextResponse(message.content, e, session, session.groupUserMessages)
        }

        this.clearSession(sessionId)
        return true

      } catch (error) {
        logger.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
        this.clearSession(sessionId)
        return true
      } finally {
        await this.finishConversationTask(taskContext, session)
        if (e.group_id) this.recordReplyLatency(e.group_id, Date.now() - handleToolStartAt)
      }
    } finally {
      const remaining = (activeGroupChatCounts.get(e.group_id) || 1) - 1
      if (remaining <= 0) activeGroupChatCounts.delete(e.group_id)
      else activeGroupChatCounts.set(e.group_id, remaining)
      logger.debug(`[并发限制] 群${e.group_id} 对话处理完成，释放名额，剩余 ${remaining}/${concurrentLimit}`)
    }
  }



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
  }

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
  }

  serializeToolResult(result) {
    if (typeof result === "string") return result

    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .map(item => item.type === "text" ? item.text : JSON.stringify(item))
        .join("\n")
    }

    return JSON.stringify(result ?? "")
  }

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
  }

  dedupeToolCalls(toolCalls = []) {
    const seen = new Set()
    return toolCalls.filter(toolCall => {
      const key = `${toolCall.function?.name}:${toolCall.function?.arguments || "{}"}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

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
  }

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
  }

  async handleTextResponse(content, e, session, messages, toolName) {
    const output = await this.processToolSpecificMessage(content, toolName)
    if (!output) {
      logger.warn("[最终回复清理] 模型回复只包含伪工具格式，已跳过发送")
      return
    }
    const shouldUseTextImage = this.shouldUseTextImageForFinalReply({
      content,
      output,
      session,
      toolName,
      e
    })
    const botMessageId = shouldUseTextImage
      ? await this.sendFinalReplyAsTextImage(e, output)
      : await this.sendSegmentedMessage(e, output)
    try { e._conversationProducedOutput = true } catch {}

    // 更新会话追踪中的对话历史
    if (this.config.conversationTrackingEnabled && e.group_id && e.user_id) {
      const conversationKey = `${e.group_id}_${e.user_id}`
      const activeConv = activeConversations.get(conversationKey)
      if (activeConv) {
        // 获取当前对话历史
        let chatHistory = activeConv.chatHistory || []

        // 添加用户消息
        const senderRole = roleMap[e.sender?.role] || "member"
        const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
        const userMsg = `${this.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${(session.userContent || e.msg || '').substring(0, 200)}`
        chatHistory.push({ role: 'user', content: userMsg })

        // 添加机器人回复
        const botMsg = `${this.formatTime()} ${Bot.nickname}(qq号:${Bot.uin})[群身份: member]: 在群里说: ${output.substring(0, 200)}`
        chatHistory.push({ role: 'bot', content: botMsg })

        // 只保留最近10条
        if (chatHistory.length > 10) {
          chatHistory = chatHistory.slice(-10)
        }

        // 重置定时器并更新数据
        this.setTrackingWithTimer(conversationKey, { chatHistory })
      }
    }

    const now = Math.floor(Date.now() / 1000)

    try {
      // 1. 不再记录工具结果到持久化历史(避免暴露内部格式)
      // 工具结果只在当前轮次上下文中存在,下次加载历史时不会出现

      // 2. 记录 Bot 的最终回复
      await this.messageManager.recordMessage({
        message_type: e.message_type,
        group_id: e.group_id,
        message_id: botMessageId,
        time: now + (session.toolResults?.length || 0) + 1,
        message: [{ type: "text", text: output }],
        source: "send",
        self_id: Bot.uin,
        sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      })
    } catch (error) {
      logger.error("[MessageRecord] 记录消息失败：", error)
    }

    // 保存到 messages 数组
    if (session.toolResults?.length) {
      const existingToolResultIds = new Set(
        messages
          .filter(msg => msg.role === "tool" && msg.tool_call_id)
          .map(msg => msg.tool_call_id)
      )
      for (const { toolCall, toolName: tName, result } of session.toolResults) {
        if (result && result.trim() !== '') {
          const toolCallId = toolCall?.id || randomUUID()
          if (existingToolResultIds.has(toolCallId)) continue
          existingToolResultIds.add(toolCallId)
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: tName,
            content: result
          })
        }
      }
    }

    messages.push({ role: "assistant", content: output })
    session.groupUserMessages = this.trimMessageHistory(messages)
    await this.saveGroupUserMessages(e.group_id, e.user_id, messages)

    // 更新情感、记忆、表达学习（异步，不阻塞）
    // 使用 e.msg 纯消息内容，而不是格式化的 userContent
    this.updateEnhancedSystems(e, e.msg || '', output).catch(err => {
      logger.error('[增强系统] 更新失败:', err)
    })
  }

  /**
   * 异步更新情感系统、长期记忆
   */
  async updateEnhancedSystems(e, userMessage, botReply) {
    const { group_id: groupId, user_id: userId } = e
    let emotionState = null

    // 1. 更新情感系统
    if (this.config.emotionSystem?.enabled) {
      const isAtBot = e.message?.some(m => m.type === 'at' && m.qq === Bot.uin)
      emotionState = await this.emotionManager.updateEmotionFromMessage(groupId, userMessage, isAtBot)
    }

    // 2. 提取并保存长期记忆（后台异步）
    if (this.config.memorySystem?.enabled) {
      // 不 await，让它在后台执行
      this.memoryManager.extractAndSaveMemories(groupId, userId, userMessage, botReply, {
        source: "user",
        messageId: e.message_id,
        senderName: e.sender?.card || e.sender?.nickname
      }).catch(err => {
        logger.error('[MemoryManager] 用户记忆提取异常:', err)
      })
      const latestEmotionEvent = emotionState?.recentEvents?.[0]
      if (latestEmotionEvent && Number.isFinite(latestEmotionEvent.delta)) {
        const relationDelta = Math.max(-0.03, Math.min(0.03, latestEmotionEvent.delta * 0.2))
        if (relationDelta !== 0) {
          this.memoryManager.updateRelationship(groupId, userId, relationDelta).catch(err => {
            logger.error('[MemoryManager] 根据情绪更新关系分失败:', err)
          })
        }
      }
      // 提取群全局记忆（传入聊天记录）
      if (groupId) {
        const history = await this.messageManager.getMessages('group', groupId)
        const chatHistory = (history || []).slice(0, 40).map(msg => ({
          role: msg.sender?.user_id === Bot.uin ? 'assistant' : 'user',
          source: msg.source || (msg.sender?.user_id === Bot.uin ? "send" : "user"),
          userId: msg.sender?.user_id,
          user_id: msg.sender?.user_id,
          senderName: msg.sender?.nickname || msg.sender?.card || '群成员',
          content: msg.content
        }))
        this.memoryManager.extractAndSaveGroupMemories(groupId, chatHistory).catch(err => {
          logger.error('[MemoryManager] 群记忆提取异常:', err)
        })
      }
    }

    // 表达学习已移至 handleRandomReply 静默收集，不在此处调用
  }






  /**
   * 初始化MCP服务器连接
   */
  async initMCP() {
    try {
      const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
      const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")
      const configPath = path.join(configDir, "mcp-servers.yaml")
      const defaultConfigPath = path.join(configDefaultDir, "mcp-servers.yaml")

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      if (!fs.existsSync(configPath)) {
        if (fs.existsSync(defaultConfigPath)) {
          fs.copyFileSync(defaultConfigPath, configPath)
          logger.info(`[MCP] 已从 config_default 复制配置文件: mcp-servers.yaml`)
          logger.info(`[MCP] 请根据需要修改配置并启用相应的MCP服务器`)
        } else {
          logger.warn(`[MCP] 默认配置文件不存在: ${defaultConfigPath}`)
          logger.warn(`[MCP] 请在 config_default 目录下创建 mcp-servers.yaml 文件`)
          return
        }
      }

      if (!fs.existsSync(configPath)) {
        logger.info("[MCP] MCP配置文件不存在，跳过初始化")
        return
      }

      let mcpConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))
      if (fs.existsSync(defaultConfigPath)) {
        const defaultMcpConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
        const mergedMcpConfig = this.mergeMCPConfig(defaultMcpConfig, mcpConfig || {})
        if (JSON.stringify(mcpConfig || {}) !== JSON.stringify(mergedMcpConfig)) {
          fs.writeFileSync(configPath, YAML.stringify(mergedMcpConfig))
          logger.info("[MCP] 已自动补齐 mcp-servers.yaml 新增默认配置项")
        }
        mcpConfig = mergedMcpConfig
      }
      mcpManager.configure(mcpConfig?.settings || {})

      if (!mcpConfig?.servers) {
        logger.info("[MCP] MCP配置为空或无服务器配置")
        this.updateToolsList()
        return
      }

      for (const [serverName, config] of Object.entries(mcpConfig.servers)) {
        mcpManager.rememberServerConfig(serverName, config)
      }

      const enabledServers = Object.entries(mcpConfig.servers).filter(([_, config]) => config.enabled)

      if (enabledServers.length === 0) {
        logger.info("[MCP] 没有启用的MCP服务器")
        this.updateToolsList()
        return
      }

      for (const [serverName, config] of enabledServers) {
        await mcpManager.connectServer(serverName, config)
      }

      this.updateToolsList()

      logger.info(`[MCP] 初始化完成，共加载 ${mcpManager.aliases?.size || mcpManager.tools.size} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 初始化失败:", error)
    }
  }

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList(options = {}) {
    this.syncDedupeToolConfig(this.config.oneapi_tools || [])
    const localTools = this.getToolsByName(this.config.oneapi_tools || [], {
      warnMissing: this.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []

    this.tools = [...localTools, ...mcpTools]

    for (const [sessionId, session] of this.sessionMap) {
      session.tools = this.tools
    }

  }

  async waitForMCPReady(timeoutMs = 5000) {
    if (!mcpInitPromise) return
    try {
      await Promise.race([
        mcpInitPromise,
        delay(timeoutMs).then(() => "timeout")
      ])
      this.updateToolsList()
    } catch (error) {
      logger.warn(`[MCP] 等待初始化完成失败: ${error.message}`)
    }
  }

  /**
   * 重新发起 MCP 初始化并更新 waitForMCPReady 等待的同一个 promise。
   * 供 apps/mcp.js 的 #mcp 重载命令通过 pluginBridge 调用。
   */
  reloadMCPConnections() {
    mcpInitPromise = this.initMCP()
    return mcpInitPromise
  }

}

Object.assign(
  ChatPlugin.prototype,
  configManagerMethods,
  taskStatusMethods,
  toolHistoryMethods,
  messageBuilderMethods,
  conversationTrackerMethods,
  replySenderMethods
)
