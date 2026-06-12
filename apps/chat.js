import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { mcpManager } from "../utils/MCPClient.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import { randomUUID } from "crypto"
import schedule from 'node-schedule'
import { parseToolConfigEntry } from "../core/toolConfig.js"
import { initializeSharedState, getSharedState, refreshLocalTools, applyToolRegistrySnapshot } from "../core/sharedState.js"
import { delay, getOrCreateGroupLimiter } from "../core/asyncUtils.js"
import { configManagerMethods } from "../core/configManager.js"
import { taskStatusMethods } from "../core/taskStatus.js"
import { tryAutoGrabRedBag } from "../core/redBag.js"
import { messageBuilderMethods, roleMap } from "../core/messageBuilder.js"
import { conversationTrackerMethods, activeConversations, trackingThrottle } from "../core/conversationTracker.js"
import { replySenderMethods } from "../core/replySender.js"

const _path = process.cwd()


// 终态工具：本轮调用后不再请求 LLM 续话（工具的执行结果本身即为最终输出）
const TERMINAL_TOOL_NAMES = new Set(['sendLocalEmojiTool', 'waitTool'])

const activeDedupeToolRuns = new Map()

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

    this.initConfig()
    const state = initializeSharedState(this.config)

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
    this._groupLimiters = new Map()

    this.localToolsReady = false
    this.tools = []
    this.initMessageHistory()
    mcpManager.setToolsChangedCallback(() => this.updateToolsList())
    this.localToolsReadyPromise = this.refreshLocalToolRegistry({ force: true }).catch(error => {
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

    if (!fs.existsSync(this.messageHistoriesDir)) {
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

  async scanRedisKeys(pattern) {
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
          const [nextCursor, batch = []] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200)
          cursor = String(nextCursor)
          keys.push(...batch)
        } while (cursor !== "0")
        return keys
      }
    } catch (error) {
      logger.warn(`[Redis] SCAN 扫描失败，回退使用 KEYS：${pattern}，原因：${error.message}`)
    }

    return await redis.keys(pattern)
  }

  async deleteRedisKeys(keys = []) {
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200).filter(Boolean)
      if (chunk.length) {
        await redis.del(...chunk)
      }
    }
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

  isToolResultError(result) {
    const text = typeof result === "string" ? result : JSON.stringify(result || "")
    return /^error[:：]/i.test(text.trim()) || /"error"\s*:/.test(text) || /失败|错误|失敗|錯誤/.test(text)
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
          if (warnMissing) console.warn(`未找到工具 "${name}"`)
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
      console.error(`获取消息历史失败:`, error)
      return []
    }
  }

  async saveGroupUserMessages(groupId, userId, messages) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      saveData(redisKey, filePath, messages),
      fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8")
    ]).catch(err => console.error(`保存消息历史失败:`, err))
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

      const hasAt = Array.isArray(e.message) &&
        e.message.some(msg => msg?.type == "at" && msg?.qq == Bot.uin)

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

    // 在追踪期内，判断是否在继续对话
    if (this.config.conversationTrackingEnabled && activeConv) {
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
    const groupLimiter = getOrCreateGroupLimiter(this._groupLimiters, groupId, this.config.concurrentLimit || 5)

    let groupUserMessages = session.groupUserMessages

    return await groupLimiter(async () => {
      try {
        const args = msg?.replace(/^#tool\s*/, "").trim() || ""
        const atQq = e.message.filter(m => m.type === "at" && m.qq !== Bot.uin).map(m => m.qq)
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

        // 获取情感、记忆、表达学习的 prompt
        const emotionPrompt = this.config.emotionSystem?.enabled
          ? await this.emotionManager.getEmotionPromptForGroup(groupId)
          : ''
        const memoryPrompt = this.config.memorySystem?.enabled
          ? await this.memoryManager.getMemoryPromptForUser(groupId, userId, e.msg || "")
          : ''
        const groupMemoryPrompt = this.config.memorySystem?.enabled && groupId
          ? await this.memoryManager.getGroupMemoryPrompt(groupId, e.msg || "")
          : ''
        const expressionPrompt = this.config.expressionLearning?.enabled
          ? await this.expressionLearner.getExpressionPromptForGroup(groupId)
          : ''

        // 知识库检索
        let knowledgePrompt = ''
        if (this.knowledgeSearcher && e.msg) {
          try {
            const result = await this.knowledgeSearcher.search(e.msg)
            if (result?.knowledgeContext) {
              knowledgePrompt = `【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\n${result.knowledgeContext}`
            }
          } catch (err) {
            logger.error(`[知识库] 检索失败: ${err.message}`)
          }
        }

        // 对方画像注入（昵称 + 最近发言；长期记忆已由 memoryPrompt 覆盖，避免重复）
        let personProfilePrompt = ''
        if (this.config.personProfileInjection?.enabled && groupId && userId) {
          try {
            personProfilePrompt = await personProfileInjector.build(groupId, userId, e)
          } catch (err) {
            logger.error(`[画像注入] 失败: ${err.message}`)
          }
        }

        // 构建增强系统提示
        const groupContext = await this.getCurrentGroupContext(e)
        const enhancedPrompts = [emotionPrompt, memoryPrompt, groupMemoryPrompt, expressionPrompt, knowledgePrompt, personProfilePrompt].filter(Boolean).join('\n')

        const systemContent = `
【认知系统初始化】
${this.config.systemContent}

【核心身份原则】

实时数据
${JSON.stringify({
          group_info: {
            group_id: groupContext.groupId,
            group_name: groupContext.groupName,
            group_notice: groupContext.groupNotice,
            administrators: await getHighLevelMembers(e.group)
          },
          environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
        }, null, 2)}
2.【消息格式】
[YYYY-MM-DD HH:MM:SS] 昵称(qq号: xxx)[群身份: xxx]: 在群里说: {message}
引用消息时格式为: [回复 昵称的消息: "原文内容"] @被艾特的人 在群里说: {message}
3.【艾特、@格式】
@+qq号,例如@32174，@xxxxx

${enhancedPrompts ? `【角色状态】\n${enhancedPrompts}\n` : ''}【工具调用】
你是一个只负责调用工具的模型，你只负责判断当前需不需要调用工具，你不用考虑文本回复内容。

【工具调用优先级 - 最高原则】
当用户消息（或其引用的消息）含有"明确的任务请求"时，**必须优先调用对应工具拿到真实信息**，不允许用人设里的"懒/嘴硬/装看不见/敷衍/拒绝执行"等方式回避。
- 出现以下信号视为"明确请求"：看下/看看/帮我看/分析/解读/识别/评价/讲讲/总结/搜/查/找/翻译/解释/算一下/画一下/生成/试试... 等明确动词
- 引用消息含有图片/视频/语音/文件 + 用户在文字里要求处理 → 强制调对应工具
- 用户@bot 并发出问题/请求 → 不能用"我不想看""我缺这点流量吗""自己来"等方式回避真实任务
- 闲聊/水群/玩梗/情绪共鸣场景 → 此时才允许人设里的"懒/嘴硬/装看不见"
判断原则：先看"用户是不是要我做事"——是 → 调工具；不是（纯水群/闲聊）→ 看人设决定要不要回。

${mcpPrompts}
【工具使用隐藏规则】
1⃣ 严禁在回复中显示工具调用代码或函数名称
2⃣ 工具执行后，以自然对话方式呈现结果，如同人类完成了该任务
绝对禁止在任何回复中显示工具调用代码、函数名称或任何内部执行细节。这包括但不限于：
* \`print(...)\`、\`tool_name(...)\` 等类似编程语言的语法。
* \`[tool_code]\`、\` <tool_code> \` 等任何形式的工具代码块标记。
3⃣ 示例转换:
✅ 正确: "八重神子的全身像已经画好啦，按照你要求的侧面视角做的，感觉还挺好看的~"
❌ 错误示例 (绝对不允许):**
* \`[tool_code]\`
* \`print(pokeTool(user_qq_number=1390963734))\`
* \`print(pokeTool(user_qq_number=1390963734))\`
* "我正在运行 \`pokeTool\` 函数..."

【回复格式规则 - 极其重要】
你的回复必须是纯文本内容，绝对禁止模仿消息记录的格式！
❌ 错误: "[2025-12-24 12:42:25] 哈基米(qq号: 3012184357)[群身份: admin]: 在群里说: 想听啥？"
❌ 错误: "[时间] 昵称(qq号: xxx)[群身份: xxx]: 内容"
✅ 正确: "想听啥？"
✅ 正确: "中午好呀~"
消息记录格式仅用于你理解上下文，回复时只输出纯内容！

【群聊消息记录】
`
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

        const botMemberMap = await e.bot.pickGroup(groupId).getMemberMap()
        const botRole = roleMap[botMemberMap.get(Bot.uin)?.role] || "member"
        session.toolContent = await this.buildMessageContent({ nickname: Bot.nickname, user_id: Bot.uin, role: botRole }, "", [], [], e.group)

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
        console.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
        this.clearSession(sessionId)
        return true
      } finally {
        await this.finishConversationTask(taskContext, session)
        if (e.group_id) this.recordReplyLatency(e.group_id, Date.now() - handleToolStartAt)
      }
    })
  }



  async retryRequest(requestData, toolContent, retries = 1, toolName) {
    while (retries >= 0) {
      try {
        const response = await YTapi(requestData, this.config, toolContent, toolName)
        if (response) return response
      } catch (error) {
        console.error(`API请求失败(${retries}):`, error)
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
        result: `error: tool ${toolName} is not available in this session`
      }
    }

    let params
    try {
      params = JSON.parse(funcData.arguments || "{}")
    } catch (error) {
      return {
        toolCall,
        toolName,
        result: `error: invalid JSON arguments: ${error.message}`
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
          result: `工具 ${toolName} 正在处理同一用户的上一条请求，已跳过重复调用`
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
      const result = this.serializeToolResult(rawResult)
      if (dedupeEnabled && toolRunValue.messageId) {
        const failed = this.isToolResultError(result)
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: failed ? "tool_failed" : "tool_success",
          toolName,
          error: failed ? result : ""
        })
      }
      return {
        toolCall,
        toolName,
        result: result?.trim() ? result : `工具 ${toolName} 执行成功`
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
        result: `error: ${error.message}`
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

      currentMessages.push(...validResults.map(({ toolCall, toolName, result }) => ({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: result
      })))

      if (validResults.every(r => TERMINAL_TOOL_NAMES.has(r.toolName) && typeof r.result === 'string' && !r.result.startsWith('error:'))) {
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

  async executeTool(tool, params, e, isRetry = false) {
    try {
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        return await mcpManager.executeToolByAlias(tool, params)
      }

      if (tool && typeof tool.execute === "function") {
        return await tool.execute(params, e)
      }

      return null
    } catch (error) {
      if (!isRetry) {
        return this.executeTool(tool, params, e, true)
      }
      throw error
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
      // 1. 先记录工具调用结果（如果有）
      if (session.toolResults?.length) {
        for (let i = 0; i < session.toolResults.length; i++) {
          const { toolCall, toolName: tName, result } = session.toolResults[i]

          // 严格检查 result
          const resultStr = String(result || '').trim()
          if (!resultStr || resultStr === 'undefined' || resultStr === 'null') {
            logger.warn(`[工具记录] 工具 ${tName} 的结果无效，跳过`)
            continue
          }

          const formattedResult = resultStr.length > 500
            ? resultStr.substring(0, 500) + "...(已截断)"
            : resultStr

          const toolMessage = `此处为调用工具的结果，不计算到聊天记录中：[调用工具:${tName}] 调用结果:${formattedResult}`

          logger.info(`[工具记录] 准备记录: ${toolMessage.substring(0, 100)}...`)

          await this.messageManager.recordMessage({
            message_type: e.message_type,
            group_id: e.group_id,
            time: now + i,
            message: [{ type: "text", text: toolMessage }],
            source: "tool",
            self_id: Bot.uin,
            sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
          })
        }
      }

      // 2. 再记录 Bot 的回复
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
          content: `${msg.sender?.nickname || '未知'}(QQ:${msg.sender?.user_id}): ${msg.content}`
        }))
        this.memoryManager.extractAndSaveGroupMemories(groupId, chatHistory)
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
  messageBuilderMethods,
  conversationTrackerMethods,
  replySenderMethods
)
