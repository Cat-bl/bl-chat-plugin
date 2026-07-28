import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { mcpManager } from "../utils/MCPClient.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { scanRedisKeys, deleteRedisKeys } from "../utils/redisScan.js"
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import schedule from 'node-schedule'
import { parseToolConfigEntry } from "../core/toolConfig.js"
import { buildChatSystemPrompt } from "../core/prompts.js"
import { initializeSharedState, getSharedState, refreshLocalTools, applyToolRegistrySnapshot } from "../core/sharedState.js"
import { configManagerMethods } from "../core/configManager.js"
import { taskStatusMethods } from "../core/taskStatus.js"
import { toolHistoryMethods } from "../core/toolHistory.js"
import { tryAutoGrabRedBag } from "../core/redBag.js"
import { messageBuilderMethods, roleMap } from "../core/messageBuilder.js"
import { conversationTrackerMethods, activeConversations, trackingThrottle } from "../core/conversationTracker.js"
import { replySenderMethods } from "../core/replySender.js"
import { toolExecutorMethods } from "../core/toolExecutor.js"
import { sessionHistoryMethods } from "../core/sessionHistory.js"
import { mcpLifecycleMethods, startMcpInit } from "../core/mcpLifecycle.js"

const _path = process.cwd()


// 群级并发计数：groupId -> 处理中的对话数。达到 concurrentLimit 时新消息直接不触发（不排队）。
// 必须放模块级：Yunzai 每条消息都会 new 一个插件实例，实例属性跨消息不共享。
const activeGroupChatCounts = new Map()

let pluginInitialized = false

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
      startMcpInit(this)
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
            await e.bot.pickGroup(groupId).getMemberMap()

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

}

Object.assign(
  ChatPlugin.prototype,
  configManagerMethods,
  taskStatusMethods,
  toolHistoryMethods,
  messageBuilderMethods,
  conversationTrackerMethods,
  replySenderMethods,
  toolExecutorMethods,
  sessionHistoryMethods,
  mcpLifecycleMethods
)
