import { JinyanTool } from "../functions/functions_tools/JinyanTool.js"
import { EmotionManager } from "../utils/EmotionManager.js"
import { MemoryManager } from "../utils/MemoryManager.js"
import { ExpressionLearner } from "../utils/ExpressionLearner.js"
import { SearchInformationTool } from "../functions/functions_tools/SearchInformationTool.js"
import { SearchVideoTool } from "../functions/functions_tools/SearchVideoTool.js"
import { SearchMusicTool } from "../functions/functions_tools/SearchMusicTool.js"
import { EmojiSearchTool } from "../functions/functions_tools/EmojiSearchTool.js"
import { BingImageSearchTool } from "../functions/functions_tools/BingImageSearchTool.js"
import { GoogleImageAnalysisTool } from "../functions/functions_tools/GoogleAnalysisTool.js"
import { ChatHistoryTool } from "../functions/functions_tools/ChatHistoryTool.js"
import { PokeTool } from "../functions/functions_tools/PokeTool.js"
import { LikeTool } from "../functions/functions_tools/LikeTool.js"
import { AiMindMapTool } from "../functions/functions_tools/AiMindMapTool.js"
import { GoogleImageEditTool } from "../functions/functions_tools/GoogleImageEditTool.js"
import { WebParserTool } from "../functions/functions_tools/webParserTool.js"
import { GitHubRepoTool } from "../functions/functions_tools/GithubTool.js"
import { VideoAnalysisTool } from "../functions/functions_tools/VideoAnalysisTool.js"
import { QQZoneTool } from "../functions/functions_tools/QQZoneTool.js"
import { ChangeCardTool } from "../functions/functions_tools/ChangeCardTool.js"
import { VoiceTool } from "../functions/functions_tools/VoiceTool.js"
import { BananaTool } from "../functions/functions_tools/BananaTool.js"
import { ReactionTool } from "../functions/functions_tools/ReactionTool.js"
import { MemberInfoTool } from "../functions/functions_tools/MemberInfoTool.js"
import { RecallTool } from "../functions/functions_tools/RecallTool.js"
import { GrabRedBagTool } from "../functions/functions_tools/GrabRedBagTool.js"
import { ReminderTool, checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { MessageManager } from "../utils/MessageManager.js"
import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"
import { TotalTokens } from "../functions/tools/CalculateToken.js"
import { mcpManager } from "../utils/MCPClient.js"
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
import { getRedBagType, isExclusiveForUser } from "../utils/redBagUtils.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import { randomUUID } from "crypto"
import pLimit from "p-limit"
import schedule from 'node-schedule'

const _path = process.cwd()

// 表情包配置
const EMOJI_CONFIG = {
  enabled: true, // 是否启用表情包回复功能
  baseProbability: 0.10, // 基础触发概率
  maxProbability: 0.20, // 最大触发概率
  cooldownTime: 30000, // 冷却时间（毫秒），30秒内再次触发概率会衰减
  minDelay: 500, // 表情包发送的最小延迟（毫秒）
  maxDelay: 500 // 表情包发送的最大延迟（毫秒）
}

// 自动抢红包配置
const RED_BAG_CONFIG = {
  enabled: true, // 是否启用自动抢红包
  minProbability: 0.3, // 最小触发概率
  maxProbability: 0.8, // 最大触发概率
  cooldownTime: 60000 // 冷却时间（毫秒），同一个群60秒内不重复触发
}

const redBagCooldowns = new Map() // 红包冷却记录: key: groupId, value: lastGrabTime

const sessionStates = new Map()
const activeConversations = new Map() // 会话追踪: key: `${groupId}_${userId}`, value: { lastActiveTime, chatHistory: [], timer: null }
const trackingThrottle = new Map() // 节流: key: `${groupId}_${userId}`, value: lastCallTime
const pendingJudgments = [] // 批量判断队列
let batchTimer = null // 批量处理定时器
const roleMap = { owner: "owner", admin: "admin", member: "member" }

let pluginInitialized = false
let sharedState = null

function initializeSharedState(config) {
  if (sharedState) return sharedState
  sharedState = {
    messageManager: new MessageManager({
      privateMaxMessages: 100,
      groupMaxMessages: config.groupMaxMessages,
      messageMaxLength: 9999,
      cacheExpireDays: config.groupChatMemoryDays
    }),
    // 情感系统
    emotionManager: new EmotionManager(config.emotionSystem || {}),
    // 长期记忆
    memoryManager: new MemoryManager({
      maxFactsPerUser: config.memorySystem?.maxFactsPerUser || 100,
      importanceThreshold: config.memorySystem?.importanceThreshold || 0.5,
      memoryDecayDays: config.memorySystem?.memoryDecayDays || 7,
      memoryAiConfig: config.memoryAiConfig || null
    }),
    // 表达学习
    expressionLearner: new ExpressionLearner({
      ...config.expressionLearning || {},
      memoryAiConfig: config.memoryAiConfig || null
    }),
    toolInstances: {
      jinyanTool: new JinyanTool(),
      searchInformationTool: new SearchInformationTool(),
      searchVideoTool: new SearchVideoTool(),
      searchMusicTool: new SearchMusicTool(),
      emojiSearchTool: new EmojiSearchTool(),
      bingImageSearchTool: new BingImageSearchTool(),
      googleImageAnalysisTool: new GoogleImageAnalysisTool(),
      pokeTool: new PokeTool(),
      likeTool: new LikeTool(),
      chatHistoryTool: new ChatHistoryTool(),
      aiMindMapTool: new AiMindMapTool(),
      webParserTool: new WebParserTool(),
      googleImageEditTool: new GoogleImageEditTool(),
      githubRepoTool: new GitHubRepoTool(),
      videoAnalysisTool: new VideoAnalysisTool(),
      qqZoneTool: new QQZoneTool(),
      changeCardTool: new ChangeCardTool(),
      voiceTool: new VoiceTool(),
      bananaTool: new BananaTool(),
      reactionTool: new ReactionTool(),
      memberInfoTool: new MemberInfoTool(),
      recallTool: new RecallTool(),
      grabRedBagTool: new GrabRedBagTool(),
      reminderTool: new ReminderTool()
    },
    sessionMap: new Map()
  }

  sharedState.functions = Object.values(sharedState.toolInstances).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))

  sharedState.functionMap = new Map(sharedState.functions.map(func => [func.name, func]))

  // 如果启用了 searchMusicTool，初始化音乐 cookie 刷新定时任务
  if (config.oneapi_tools?.includes('searchMusicTool')) {
    initMusicCookieRefresh(sharedState.toolInstances.searchMusicTool, config)
  }

  return sharedState
}

// 初始化音乐 cookie 定时刷新
function initMusicCookieRefresh(searchMusicTool, config) {
  if (!searchMusicTool) return

  const { qqMusicToken } = config || {}
  if (!qqMusicToken) {
    logger.info('[SearchMusicTool] 未配置 qqMusicToken，跳过 cookie 刷新初始化')
    return
  }

  // 设置 cookie
  searchMusicTool.musicCookies.qqmusic = qqMusicToken

  // 立即执行一次刷新检查
  searchMusicTool.updateQQMusicCk().then(() => {
    logger.info('[SearchMusicTool] 初始化时 cookie 刷新检查完成')
  }).catch(err => {
    logger.error('[SearchMusicTool] 初始化时 cookie 刷新失败:', err)
  })

  // 每10分钟定时刷新
  schedule.scheduleJob('*/10 * * * *', async () => {
    try {
      // 重新从配置读取最新的 token
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml')
      const currentConfig = YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings
      if (currentConfig?.qqMusicToken) {
        searchMusicTool.musicCookies.qqmusic = currentConfig.qqMusicToken
      }
      // 强制触发刷新检查（重置 updateTime 使其立即检查）
      searchMusicTool.updateTime = 0
      await searchMusicTool.updateQQMusicCk()
    } catch (err) {
      logger.error('[SearchMusicTool] 定时刷新 cookie 失败:', err)
    }
  })

  logger.info('[SearchMusicTool] cookie 定时刷新任务已启动（每10分钟）')
}

export class ExamplePlugin extends plugin {
  constructor() {
    super({
      name: "全局方案-test",
      dsc: "全局方案测试版",
      event: "message",
      priority: 2001,
      rule: [
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" },
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    this.initConfig()
    EMOJI_CONFIG.enabled = this.config?.emojiEnabled || false
    const state = initializeSharedState(this.config)

    this.messageManager = state.messageManager
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.sessionMap = state.sessionMap
    this.emotionManager = state.emotionManager
    this.memoryManager = state.memoryManager
    this.expressionLearner = state.expressionLearner
    this.REDIS_KEY_PREFIX = 'ytbot:messages:'

    this.initTools()
    this.initMessageHistory()

    if (!pluginInitialized) {
      pluginInitialized = true
      this.initMCP()
      this.initScheduledTasks()
    }
  }

  initTools() {
    const provider = this.config.providers.toLowerCase()
    const toolConfig = {
      oneapi: this.config.oneapi_tools
    }

    const localTools = this.getToolsByName(toolConfig[provider] || this.config.openai_tools)
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
   * 启动/重置用户独立的会话追踪定时器
   * @param {string} conversationKey - 会话key
   * @param {object} newData - 要更新的数据 { chatHistory, lastActiveTime }
   */
  setTrackingWithTimer(conversationKey, newData = {}) {
    const timeout = (this.config.conversationTrackingTimeout || 2) * 60000
    const activeConv = activeConversations.get(conversationKey)

    // 清除旧定时器
    if (activeConv?.timer) {
      clearTimeout(activeConv.timer)
    }

    // 创建新定时器
    const timer = setTimeout(() => {
      const conv = activeConversations.get(conversationKey)
      // 确保清除的是同一个定时器（防止竞态）
      if (conv?.timer === timer) {
        activeConversations.delete(conversationKey)
        trackingThrottle.delete(conversationKey)
        logger.info(`[会话追踪] ${conversationKey} 超时，已清除`)
      }
    }, timeout)

    // 原子操作：创建定时器后立即存储
    activeConversations.set(conversationKey, {
      lastActiveTime: Date.now(),
      chatHistory: activeConv?.chatHistory || [],
      ...newData,
      timer
    })
  }

  async clearAllMessages() {
    const keys = await redis.keys(`${this.REDIS_KEY_PREFIX}*`)
    if (keys?.length) {
      await redis.del(...keys)
      logger.info(`已清除${keys.length}条消息历史记录`)
    }
  }

  getToolsByName(toolNames) {
    if (!toolNames || !Array.isArray(toolNames)) return []

    return toolNames
      .map(name => {
        const func = this.functionMap.get(name)
        if (!func) {
          console.warn(`Tool "${name}" not found.`)
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

  ensureConfigFiles() {
    const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
    const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")

    const configFiles = ["message.yaml", "mcp-servers.yaml"]

    if (!fs.existsSync(configDefaultDir)) {
      logger.error(`[配置] 默认配置目录不存在: ${configDefaultDir}`)
      logger.error(`[配置] 请确保 config_default 目录存在并包含默认配置文件`)
      return false
    }

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
      logger.info(`[配置] 已创建配置目录: ${configDir}`)
    }

    for (const fileName of configFiles) {
      const configPath = path.join(configDir, fileName)
      const defaultPath = path.join(configDefaultDir, fileName)

      if (!fs.existsSync(configPath)) {
        if (fs.existsSync(defaultPath)) {
          fs.copyFileSync(defaultPath, configPath)
          logger.info(`[配置] 已从 config_default 复制配置文件: ${fileName}`)
        } else {
          logger.error(`[配置] 默认配置文件不存在: ${defaultPath}`)
        }
      }
    }

    return true
  }

  initConfig() {
    this.ensureConfigFiles()

    const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
    const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")
    const configPath = path.join(configDir, "message.yaml")
    const defaultConfigPath = path.join(configDefaultDir, "message.yaml")

    try {
      if (!fs.existsSync(defaultConfigPath)) {
        logger.error(`[配置] 默认配置文件不存在: ${defaultConfigPath}`)
        logger.error(`[配置] 请在 config_default 目录下创建 message.yaml 文件`)
        this.config = {}
        return
      }

      const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))

      if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, "utf8"))
        const merged = this.mergeConfig(defaultConfig, config)

        if (JSON.stringify(config) !== JSON.stringify(merged)) {
          fs.writeFileSync(configPath, YAML.stringify(merged))
          logger.info(`[配置] 配置文件已更新，合并了新增字段`)
        }
        this.config = merged.pluginSettings
      } else {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, YAML.stringify(defaultConfig))
        logger.info(`[配置] 已从默认配置创建: ${configPath}`)
        this.config = defaultConfig.pluginSettings
      }
    } catch (err) {
      logger.error(`[配置] 加载配置文件失败: ${err}`)
      this.config = {}
    }
  }

  mergeConfig(defaults, user) {
    const merged = { ...defaults }
    for (const key in defaults) {
      if (typeof defaults[key] === "object" && !Array.isArray(defaults[key]) && defaults[key] !== null) {
        // 嵌套对象递归合并
        merged[key] = this.mergeConfig(defaults[key], user?.[key] || {})
      } else if (user && key in user) {
        // 用户配置中存在该字段，使用用户的值（即使是空值）
        merged[key] = user[key]
      }
      // 用户配置中不存在该字段，保留默认值（merged 已经有了）
    }
    return merged
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

  formatTime() {
    const now = new Date()
    const pad = n => String(n).padStart(2, "0")
    return `[${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
  }

  async buildMessageContent(sender, msg, images, atQq = [], group, e = null) {
    const senderRole = roleMap[sender.role] || "member"
    const messageId = e?.message_id ? `[消息ID:${e.message_id}]` : ''
    const senderInfo = `${sender.card || sender.nickname}(qq号: ${sender.user_id})[群身份: ${senderRole}]${messageId}`

    let atContent = ""
    if (atQq.length > 0 && group) {
      const memberMap = await group.getMemberMap()
      const atUsers = atQq.map(qq => {
        const info = memberMap.get(Number(qq))
        if (!info) return `未知用户(qq号: ${qq})`
        return `${info.card || info.nickname}(qq号: ${qq})[群身份: ${roleMap[info.role] || "member"}]`
      })
      atContent = `艾特了 ${atUsers.join("、")}，`
    }

    let quoteContent = ""
    if (e?.getReply) {
      try {
        const reply = await e.getReply()
        if (reply) {
          const quotedSender = reply.sender
          let quotedMsg = ""
          if (reply.message && Array.isArray(reply.message)) {
            quotedMsg = reply.message
              .filter(m => m.type === "text")
              .map(m => m.text)
              .join("")
              .trim()
          } else if (typeof reply.raw_message === "string") {
            quotedMsg = reply.raw_message
          }

          const quotedImages = reply.message?.filter(m => m.type === "image") || []
          const hasQuotedImage = quotedImages.length > 0

          if (quotedSender) {
            let quotedRole = "member"
            let quotedNickname = quotedSender.nickname || quotedSender.card || "未知用户"

            if (group) {
              try {
                const memberMap = await group.getMemberMap()
                const quotedMemberInfo = memberMap.get(Number(quotedSender.user_id))
                if (quotedMemberInfo) {
                  quotedRole = roleMap[quotedMemberInfo.role] || "member"
                  quotedNickname = quotedMemberInfo.card || quotedMemberInfo.nickname || quotedNickname
                }
              } catch (err) {
              }
            }

            const quotedSenderInfo = `${quotedNickname}(qq号: ${quotedSender.user_id})[群身份: ${quotedRole}]`
            const quotedMessageId = reply.message_id ? `[消息ID:${reply.message_id}]` : ''

            let quotedDescription = ""
            if (quotedMsg && hasQuotedImage) {
              quotedDescription = `"${quotedMsg}" 以及${quotedImages.length}张图片`
            } else if (quotedMsg) {
              quotedDescription = `"${quotedMsg}"`
            } else if (hasQuotedImage) {
              quotedDescription = `${quotedImages.length}张图片`
            } else {
              quotedDescription = "一条消息"
            }

            quoteContent = `引用了 ${quotedSenderInfo}${quotedMessageId} 的消息: ${quotedDescription}，`
          }
        }
      } catch (error) {
        console.error("获取引用消息失败:", error)
      }
    }

    const content = []
    if (msg) content.push(`在群里说: ${msg}`)
    if (images?.length) {
      content.push(`发送了${images.length === 1 ? "一张" : images.length + " 张"}图片${images.map(img => `\n![图片](${img})`).join("")}`)
    }

    return `${this.formatTime()} ${senderInfo}: ${quoteContent}${atContent}${content.join("，")}`
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

  async checkTriggers(e) {
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

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(userMessage, chatHistory = []) {
    try {
      const botName = this.config.botName || Bot.nickname || '机器人'

      // 构建对话历史文本
      const historyText = chatHistory.length > 0
        ? chatHistory.map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        : '(无历史记录)'

      const response = await fetch(this.config.trackAiConfig.trackAiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"，QQ号${Bot.uin}。

根据对话历史，判断用户新消息是否在继续跟机器人对话。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续（机器人说"中午好"→用户问"吃什么"）
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群

你只回复 true 或 false，不要输出其他内容。
`
            },
            {
              role: "user",
              content: `【近期对话记录】\n${historyText}\n\n【用户新消息】\n${userMessage}\n\n这条新消息是在跟机器人说话吗？`
            }
          ]
        })
      })

      if (!response.ok) return false // 请求失败时默认不触发

      const data = await response.json()
      const answer = data?.choices?.[0]?.message?.content?.toLowerCase()?.trim()
      // logger.error(answer, historyText, userMessage, 8888)
      return answer === 'true' || answer?.includes('true')
    } catch (error) {
      logger.error('[会话追踪] AI判断失败:', error)
      return false // 出错时默认不触发
    }
  }

  /**
   * 加入批量判断队列
   */
  addToBatchJudgment(conversationKey, userMessage, chatHistory, e) {
    return new Promise(resolve => {
      pendingJudgments.push({ conversationKey, userMessage, chatHistory, e, resolve })

      if (!batchTimer) {
        const batchDelay = (this.config.batchJudgmentDelay || 3) * 1000
        batchTimer = setTimeout(() => this.processBatchJudgments(), batchDelay)
      }
    })
  }

  /**
   * 处理批量判断队列
   */
  async processBatchJudgments() {
    batchTimer = null
    if (pendingJudgments.length === 0) return

    const batch = pendingJudgments.splice(0)

    if (batch.length === 1) {
      const result = await this.isUserTalkingToBot(batch[0].userMessage, batch[0].chatHistory)
      batch[0].resolve(result)
      return
    }

    try {
      const results = await this.batchIsUserTalkingToBot(batch)
      batch.forEach((item, i) => item.resolve(results[i] || false))
    } catch (error) {
      logger.error('[批量判断] 失败:', error)
      batch.forEach(item => item.resolve(false))
    }
  }

  /**
   * 批量判断多条消息是否在跟机器人对话
   */
  async batchIsUserTalkingToBot(batch) {
    try {
      const botName = this.config.botName || Bot.nickname || '机器人'

      // 为每条消息生成唯一标识
      const batchWithIds = batch.map((item, i) => ({
        ...item,
        id: `MSG_${i + 1}_${item.e?.user_id || 'unknown'}`
      }))

      const messagesText = batchWithIds.map(item => {
        const recentHistory = (item.chatHistory || []).slice(-3).map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        const userName = item.e?.sender?.card || item.e?.sender?.nickname || '未知用户'
        return `【${item.id}】用户: ${userName}(QQ:${item.e?.user_id})
对话历史:
${recentHistory || '(无)'}
新消息: ${item.userMessage}
---`
      }).join('\n\n')

      const response = await fetch(this.config.trackAiConfig.trackAiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"。

每条消息来自不同用户，有独立的对话历史，请分别独立判断。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群
- 无对话历史且消息内容与机器人无关

返回JSON对象，key为消息ID，value为判断结果。
示例: {"MSG_1_12345": true, "MSG_2_67890": false}
只返回JSON对象，不要其他内容。`
            },
            {
              role: "user",
              content: `分别判断以下${batchWithIds.length}条来自不同用户的消息:\n\n${messagesText}\n\n返回JSON对象:`
            }
          ]
        })
      })

      if (!response.ok) {
        logger.error('[批量判断] API请求失败')
        return this.fallbackToSingleJudgment(batch)
      }

      const data = await response.json()
      let content = data?.choices?.[0]?.message?.content?.trim() || '{}'

      // 提取JSON对象
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const resultsMap = JSON.parse(content)
      logger.info(`[批量判断] ${batch.length}条消息，结果: ${JSON.stringify(resultsMap)}`)

      // 按ID映射回结果数组
      const results = batchWithIds.map(item => {
        const result = resultsMap[item.id]
        if (result === undefined) {
          logger.warn(`[批量判断] 缺少ID ${item.id} 的结果，回退单独判断`)
          return null // 标记需要单独判断
        }
        return result === true || result === 'true'
      })

      // 检查是否有需要单独判断的
      const needsFallback = results.some(r => r === null)
      if (needsFallback) {
        return this.fallbackToSingleJudgment(batch, results)
      }

      return results
    } catch (error) {
      logger.error('[批量判断] 解析失败:', error)
      return this.fallbackToSingleJudgment(batch)
    }
  }

  /**
   * 回退到单独判断
   */
  async fallbackToSingleJudgment(batch, partialResults = null) {
    logger.info(`[批量判断] 回退到单独判断，共${batch.length}条`)
    const results = []
    for (let i = 0; i < batch.length; i++) {
      if (partialResults && partialResults[i] !== null) {
        results.push(partialResults[i])
      } else {
        const result = await this.isUserTalkingToBot(batch[i].userMessage, batch[i].chatHistory)
        results.push(result)
      }
    }
    return results
  }

  async handleRandomReply(e) {
    if (!this.config.enabled || !this.checkGroupPermission(e) || this.isCommand(e) || !e.group_id) {
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (this.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    // 检测红包消息并随机触发抢红包
    const walletSeg = e.message?.find(m => m.type == 'wallet')
    if (walletSeg && RED_BAG_CONFIG.enabled && this.config.oneapi_tools?.includes('grabRedBagTool')) {
      const wallet = walletSeg.data || walletSeg
      const redBagType = getRedBagType(wallet)
      const botId = e.bot?.uin || Bot.uin

      // 专属红包：判断是否给机器人
      if (redBagType.type === 'exclusive') {
        if (!isExclusiveForUser(wallet, botId)) {
          logger.info(`[自动抢红包] 专属红包不是给机器人的，跳过`)
          return false
        }
        // 专属红包给机器人，直接触发
        logger.info(`[自动抢红包] 检测到给机器人的专属红包，直接触发抢红包`)
        e.forceGrabRedBag = true
        return await this.handleTool(e)
      }

      const now = Date.now()
      const lastGrabTime = redBagCooldowns.get(e.group_id) || 0

      // 检查冷却时间
      if (now - lastGrabTime >= RED_BAG_CONFIG.cooldownTime) {
        // 随机概率
        const probability = RED_BAG_CONFIG.minProbability +
          Math.random() * (RED_BAG_CONFIG.maxProbability - RED_BAG_CONFIG.minProbability)

        if (Math.random() < probability) {
          redBagCooldowns.set(e.group_id, now)
          logger.info(`[自动抢红包] 检测到${redBagType.name}，触发概率 ${(probability * 100).toFixed(1)}%，执行抢红包`)
          e.forceGrabRedBag = true // 标记强制抢红包
          return await this.handleTool(e)
        } else {
          logger.info(`[自动抢红包] 检测到${redBagType.name}，未命中概率 ${(probability * 100).toFixed(1)}%，跳过`)
        }
      }
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
    
    const { group_id: groupId, user_id: userId, msg } = e
    const sessionId = randomUUID()
    e.sessionId = sessionId
    const session = this.getOrCreateSession(sessionId, this.tools)
    const limit = pLimit(this.config.concurrentLimit || 5)

    let groupUserMessages = session.groupUserMessages

    try {
      const args = msg?.replace(/^#tool\s*/, "").trim() || ""
      const atQq = e.message.filter(m => m.type === "at" && m.qq !== Bot.uin).map(m => m.qq)
      const images = await limit(() => TakeImages(e))

      let videos = []
      if (e.getReply) {
        const rsp = await e.getReply()
        videos = rsp?.message?.filter(m => m.type === "video") || []
      }

      const memberInfo = await limit(async () => {
        try {
          return await e.bot.pickGroup(groupId).pickMember(e.sender.user_id).info
        } catch { return {} }
      })
      const senderRole = roleMap[memberInfo?.role] || "member"

      let targetRole = "member"
      if (atQq.length > 0) {
        await limit(async () => {
          try {
            const memberMap = await e.bot.pickGroup(groupId).getMemberMap()
            targetRole = roleMap[memberMap.get(Number(atQq[0]))?.role] || "member"
          } catch { }
        })
      }

      const userContent = await limit(() => this.buildMessageContent(e.sender, args, images, atQq, e.group, e))

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
        ? await limit(() => this.emotionManager.getEmotionPromptForGroup(groupId))
        : ''
      const memoryPrompt = this.config.memorySystem?.enabled
        ? await limit(() => this.memoryManager.getMemoryPromptForUser(groupId, userId))
        : ''
      const expressionPrompt = this.config.expressionLearning?.enabled
        ? await limit(() => this.expressionLearner.getExpressionPromptForGroup(groupId))
        : ''

      // 构建增强系统提示
      const enhancedPrompts = [emotionPrompt, memoryPrompt, expressionPrompt].filter(Boolean).join('\n')

      const systemContent = `
【认知系统初始化】
${this.config.systemContent}

【核心身份原则】

实时数据
${JSON.stringify({
        group_info: { administrators: await limit(() => getHighLevelMembers(e.group)) },
        environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
      }, null, 2)}
2.【消息格式】
[MM-DD HH:MM:SS] 昵称(QQ号: xxx)[群身份: xxx]: 在群里说: {message}
3.【艾特、@格式】
@+qq号,例如@32174，@xxxxx

${enhancedPrompts ? `【角色状态】\n${enhancedPrompts}\n` : ''}【工具调用】
你是一个只负责调用工具的模型，你只负责判断当前需不需要调用工具，你不用考虑文本回复内容。

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
❌ 错误: "[12-24 12:42:25] 哈基米(QQ号: 3012184357)[群身份: admin]: 在群里说: 想听啥？"
❌ 错误: "[时间] 昵称(QQ号: xxx)[群身份: xxx]: 内容"
✅ 正确: "想听啥？"
✅ 正确: "中午好呀~"
消息记录格式仅用于你理解上下文，回复时只输出纯内容！

【群聊消息记录】
`
      // 获取历史记录
      if (this.config.groupHistory) {
        const chatHistory = await limit(() =>
          this.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id))

        if (chatHistory?.length) {
          const memberMap = await limit(() => e.bot.pickGroup(groupId).getMemberMap())

          // 使用 message_id 过滤当前消息
          const currentMessageId = e.message_id

          groupUserMessages = chatHistory
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
              content: `[${msg.time}] ${msg.sender.nickname}(QQ号:${msg.sender.user_id})[群身份: ${roleMap[msg.sender.role] || "member"}]${msg.message_id ? `[消息ID:${msg.message_id}]` : ''}: ${msg.content}`
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

      const botMemberMap = await limit(() => e.bot.pickGroup(groupId).getMemberMap())
      const botRole = roleMap[botMemberMap.get(Bot.uin)?.role] || "member"
      session.toolContent = await limit(() =>
        this.buildMessageContent({ nickname: Bot.nickname, user_id: Bot.uin, role: botRole }, "", [], [], e.group))

      const requestData = this.buildRequestData(session.groupUserMessages, session.tools, toolChoice)
      let response = await this.retryRequest(limit, requestData, session.toolContent)

      if (!response?.choices?.[0]) {
        this.clearSession(sessionId)
        return true
      }

      const message = response.choices[0].message || {}

      if (message.tool_calls?.length) {
        await this.processToolCalls(message, e, session, session.groupUserMessages, atQq, senderRole, targetRole, limit)
      } else if (message.content) {
        await this.handleTextResponse(message.content, e, session, session.groupUserMessages, limit)
      }

      this.sendEmojiWithProbability(e)
      this.clearSession(sessionId)
      return true

    } catch (error) {
      console.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
      this.clearSession(sessionId)
      this.sendEmojiWithProbability(e)
      return true
    }
  }

  formatMessages(messages, e, currentUserContent = null) {
    if (!messages?.length) return messages

    const systemMsgs = messages.filter(m => m.role === "system")
    const lastUser = messages[messages.length - 1]?.role === "user" ? [messages[messages.length - 1]] : []
    let middle = messages.slice(systemMsgs.length, messages.length - lastUser.length)

    // 格式化中间消息
    const formattedLines = []

    // 用于临时存储工具调用结果
    let pendingToolResults = []

    for (let i = 0; i < middle.length; i++) {
      const msg = middle[i]

      if (msg.role === "user" && msg.content) {
        if (!msg.content.startsWith("【系统提示】")) {
          formattedLines.push(msg.content)
        }
      } else if (msg.role === "tool") {
        // 处理工具调用结果
        const toolContent = msg.content || ''
        const toolName = msg.name || '未知工具'

        // 确保内容不为空
        if (toolContent && toolContent.trim() !== '') {
          const toolResult = toolContent.length > this.messageManager.MESSAGE_MAX_LENGTH
            ? toolContent.substring(0, this.messageManager.MESSAGE_MAX_LENGTH) + "...(结果已截断)"
            : toolContent
          pendingToolResults.push(`此处为调用工具的结果，不计算到聊天记录中：[调用工具:${toolName}] 调用结果:${toolResult}`)
        }
      } else if (msg.role === "assistant" && msg.content) {
        if (!msg.content.startsWith("【系统提示】")) {
          // 先添加工具调用结果
          if (pendingToolResults.length > 0) {
            formattedLines.push(...pendingToolResults)
            pendingToolResults = []
          }
          // 再添加 Bot 回复
          const assistantContent = msg.content.length > 200
            ? msg.content.substring(0, 200) + "..."
            : msg.content
          formattedLines.push(`[Bot回复]: ${assistantContent}`)
        }
      }
    }

    // 处理剩余的工具结果
    if (pendingToolResults.length > 0) {
      formattedLines.push(...pendingToolResults)
    }

    const formatted = formattedLines.join("\n")

    return [
      ...systemMsgs,
      formatted ? { role: "user", content: `当前QQ群[${e.group_id}]的群聊历史记录：\n${formatted}` } : null,
      { role: "assistant", content: "【系统提示】: 收到，我会根据历史记录和最新消息回复，需要时调用工具" },
      ...lastUser
    ].filter(Boolean)
  }

  /**
   * 格式化工具返回结果（截断过长内容）
   */
  formatToolResult(content, toolName) {
    if (!content) return "执行完成"
    let result = typeof content === "string" ? content : JSON.stringify(content)
    const maxLength = {
      searchInformationTool: 500,
      webParserTool: 500,
      chatHistoryTool: 800,
      default: 300
    }

    const limit = maxLength[toolName] || maxLength.default

    if (result.length > limit) {
      result = result.substring(0, limit) + "...(内容已截断)"
    }

    if (result.includes("成功")) {
      return "✓ " + result
    } else if (result.includes("失败") || result.includes("错误")) {
      return "✗ " + result
    }

    return result
  }

  async retryRequest(limit, requestData, toolContent, retries = 1, toolName) {
    while (retries >= 0) {
      try {
        const response = await limit(() => YTapi(requestData, this.config, toolContent, toolName))
        if (response) return response
      } catch (error) {
        console.error(`API请求失败(${retries}):`, error)
      }
      retries--
    }
    return null
  }

  /**
   * 处理工具调用 - 支持多轮工具调用
   */
  async processToolCalls(message, e, session, groupUserMessages, atQq, senderRole, targetRole, limit) {
    const MAX_TOOL_ROUNDS = this.config.maxToolRounds
    let currentMessage = message
    let currentMessages = [...groupUserMessages]
    let round = 0

    // 用于收集所有轮次的工具调用结果
    const allToolResults = []

    while (currentMessage.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
      round++
      logger.info(`[工具调用] 第 ${round} 轮，共 ${currentMessage.tool_calls.length} 个工具`)

      const executedTools = new Map()
      const validResults = []

      for (const toolCall of currentMessage.tool_calls) {
        const { id, type, function: funcData } = toolCall
        if (type !== "function") continue

        const toolName = funcData.name
        const isMCPTool = mcpManager.isMCPTool(toolName)
        const isLocalTool = !isMCPTool && this.toolInstances[toolName]
        const isValidTool = session.tools?.some(t => t.function?.name === toolName)

        if (!isValidTool && !isMCPTool) continue

        const toolKey = `${toolName}-${funcData.arguments}`
        if (executedTools.has(toolKey)) continue
        executedTools.set(toolKey, true)

        let params
        try {
          params = JSON.parse(funcData.arguments || "{}")
        } catch {
          continue
        }

        if (isLocalTool) {
          if (toolName === "jinyanTool") {
            if (senderRole) params.senderRole = senderRole
            if (targetRole) params.targetRole = targetRole
          }
        }

        // 在 try 块外部声明 result
        let result = null

        try {
          logger.info(`[工具调用] ${isMCPTool ? "MCP" : "本地"} - ${toolName}: ${JSON.stringify(params)}`)

          if (isMCPTool) {
            const realToolName = mcpManager.getRealToolName(toolName)
            const mcpResult = await limit(() => mcpManager.executeTool(realToolName, params))
            if (mcpResult?.content && Array.isArray(mcpResult.content)) {
              result = mcpResult.content.map(item => item.type === "text" ? item.text : JSON.stringify(item)).join("\n")
            } else {
              result = typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult)
            }
          } else if (isLocalTool) {
            result = await this.executeTool(this.toolInstances[toolName], params, e, limit)
          }

          // 确保 result 是字符串
          if (result !== null && result !== undefined) {
            const resultStr = typeof result === "string" ? result : JSON.stringify(result)

            // 只有当结果不为空时才添加
            if (resultStr && resultStr.trim() !== '') {
              validResults.push({
                toolCall,
                toolName,
                result: resultStr
              })
              logger.info(`[工具调用] ${toolName} 执行成功，结果长度: ${resultStr.length}`)
            } else {
              logger.warn(`[工具调用] ${toolName} 返回空结果`)
              validResults.push({
                toolCall,
                toolName,
                result: `工具 ${toolName} 执行完成`
              })
            }
          } else {
            logger.warn(`[工具调用] ${toolName} 返回 null/undefined`)
            validResults.push({
              toolCall,
              toolName,
              result: `工具 ${toolName} 执行完成`
            })
          }
        } catch (error) {
          logger.error(`[工具执行失败] ${toolName}:`, error)
          validResults.push({
            toolCall,
            toolName,
            result: `执行出错: ${error.message}`
          })
        }
      }

      if (validResults.length === 0) break

      // 收集所有工具调用结果
      allToolResults.push(...validResults)
      logger.info(`[工具调用] 本轮收集 ${validResults.length} 个结果，总计 ${allToolResults.length} 个`)

      session.toolName = validResults[validResults.length - 1]?.toolName

      const cleanedMessages = currentMessages

      currentMessages = [
        ...cleanedMessages,
        ...validResults.map(({ toolCall, toolName, result }) => ({
          role: "assistant",
          // tool_call_id: toolCall.id,
          // name: toolName,
          content: `工具${toolName}调用的结果${result}`
        })),
        {
          role: "user",
          content: "【系统提示】: 工具已全部执行完成，请直接用自然口语回复用户结果，你只负责自然口语对话没有调用工具的功能。禁止输出任何代码格式如print()、tool_name()、|*...*|等。"
        }
      ]

      const nextRequest = this.buildRequestData(currentMessages, session.tools, "auto")
      const nextResponse = await this.retryRequest(limit, nextRequest, session.toolContent, 1, session.toolName)

      if (!nextResponse?.choices?.[0]?.message) break

      currentMessage = nextResponse.choices[0].message

      if (!currentMessage.tool_calls?.length && currentMessage.content) {
        // 保存工具调用结果到 session
        session.toolResults = allToolResults
        logger.info(`[工具调用] 保存 ${allToolResults.length} 个工具结果到 session`)

        await this.handleTextResponse(
          currentMessage.content,
          e,
          session,
          currentMessages,
          limit,
          session.toolName
        )
        return
      }
    }

    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`[工具调用] 达到最大轮数 ${MAX_TOOL_ROUNDS}，强制结束`)
    }

    // 保存工具调用结果到 session
    session.toolResults = allToolResults
    logger.info(`[工具调用] 最终保存 ${allToolResults.length} 个工具结果到 session`)

    const finalRequest = this.buildRequestData(currentMessages, [], "none")
    const finalResponse = await this.retryRequest(limit, finalRequest, session.toolContent, 1, session.toolName)

    if (finalResponse?.choices?.[0]?.message?.content) {
      await this.handleTextResponse(
        finalResponse.choices[0].message.content,
        e,
        session,
        currentMessages,
        limit,
        session.toolName
      )
    }
  }

  /**
   * 执行工具 - 统一处理本地工具和MCP工具
   */
  async executeTool(tool, params, e, limit, isRetry = false) {
    try {
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        const realName = mcpManager.getRealToolName(tool)
        const mcpResult = await limit(() => mcpManager.executeTool(realName, params))

        if (mcpResult?.content && Array.isArray(mcpResult.content)) {
          return mcpResult.content.map(c => c.text || JSON.stringify(c)).join("\n")
        }
        return mcpResult
      }

      if (tool && typeof tool.execute === "function") {
        return await limit(() => tool.execute(params, e))
      }

      return null
    } catch (error) {
      if (!isRetry) {
        return this.executeTool(tool, params, e, limit, true)
      }
      throw error
    }
  }

  async handleTextResponse(content, e, session, messages, limit, toolName) {
    const output = await this.processToolSpecificMessage(content, toolName)
    const botMessageId = await limit(() => this.sendSegmentedMessage(e, output))

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
        const botMsg = `${this.formatTime()} ${this.config.botName || Bot.nickname}(QQ号:${Bot.uin})[群身份: member]: 在群里说: ${content.substring(0, 200)}`
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

          await limit(() => this.messageManager.recordMessage({
            message_type: e.message_type,
            group_id: e.group_id,
            time: now + i,
            message: [{ type: "text", text: toolMessage }],
            source: "tool",
            self_id: Bot.uin,
            sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
          }))
        }
      }

      // 2. 再记录 Bot 的回复
      await limit(() => this.messageManager.recordMessage({
        message_type: e.message_type,
        group_id: e.group_id,
        message_id: botMessageId,
        time: now + (session.toolResults?.length || 0) + 1,
        message: [{ type: "text", text: content }],
        source: "send",
        self_id: Bot.uin,
        sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      }))
    } catch (error) {
      logger.error("[MessageRecord] 记录消息失败：", error)
    }

    // 保存到 messages 数组
    if (session.toolResults?.length) {
      for (const { toolCall, toolName: tName, result } of session.toolResults) {
        if (result && result.trim() !== '') {
          messages.push({
            role: "tool",
            tool_call_id: toolCall?.id || randomUUID(),
            name: tName,
            content: result
          })
        }
      }
    }

    messages.push({ role: "assistant", content })
    session.groupUserMessages = this.trimMessageHistory(messages)
    await limit(() => this.saveGroupUserMessages(e.group_id, e.user_id, messages))

    // 更新情感、记忆、表达学习（异步，不阻塞）
    // 使用 e.msg 纯消息内容，而不是格式化的 userContent
    this.updateEnhancedSystems(e, e.msg || '', content).catch(err => {
      logger.error('[增强系统] 更新失败:', err)
    })
  }

  /**
   * 异步更新情感系统、长期记忆、表达学习
   */
  async updateEnhancedSystems(e, userMessage, botReply) {
    const { group_id: groupId, user_id: userId } = e

    // 1. 更新情感系统
    if (this.config.emotionSystem?.enabled) {
      const isAtBot = e.message?.some(m => m.type === 'at' && m.qq === Bot.uin)
      await this.emotionManager.updateEmotionFromMessage(groupId, userMessage, isAtBot)
    }

    // 2. 提取并保存长期记忆（后台异步）
    if (this.config.memorySystem?.enabled && this.config.memoryAiConfig) {
      // 不 await，让它在后台执行
      this.memoryManager.extractAndSaveMemories(groupId, userId, userMessage, botReply)
    }

    // 3. 更新表达学习
    if (this.config.expressionLearning?.enabled) {
      await this.expressionLearner.updateGroupExpressions(groupId, userMessage)
    }
  }

  async sendSegmentedMessage(e, output, quoteChance = 0.5) {
    try {
      const shouldQuote = Math.random() < quoteChance
      const { result, hasAt, atQQList } = await this.convertAtInString(output, e.group)

      if (e.group) {
        output = result || output
      }

      const { total_tokens } = await TotalTokens(output)
      let lastMessageId = null

      if (total_tokens <= 10) {
        let res
        if (hasAt) {
          res = await e.reply([...atQQList.map(qq => segment.at(qq)), ' ', output])
        } else {
          res = await e.reply(output, shouldQuote)
        }
        lastMessageId = res?.message_id
        return lastMessageId
      }

      const segments = this.splitMessage(output)
      for (let i = 0; i < segments.length; i++) {
        if (segments[i]?.trim()) {
          const quote = shouldQuote && i === 0
          let res
          if (hasAt && i === 0) {
            res = await e.reply([...atQQList.map(qq => segment.at(qq)), ' ', segments[i].trim()])
          } else {
            res = await e.reply(segments[i].trim(), quote)
          }
          lastMessageId = res?.message_id

          if (i < segments.length - 1) {
            const delay = Math.min(1000 + segments[i].length * 5 + Math.random() * 500, 3000)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      return lastMessageId
    } catch (error) {
      console.error("分段发送错误:", error)
      const res = await e.reply(output)
      return res?.message_id
    }
  }

  splitMessage(text) {
    const punctuations = ["。", "！", "？", "；", "!", "?", ";", "\n"]
    const cqCodes = [], emojis = []
    let processed = text

    processed = processed.replace(/$$CQ:[^$$]+$$/g, m => { cqCodes.push(m); return `{{CQ${cqCodes.length - 1}}}` })
    processed = processed.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, m => { emojis.push(m); return `{{E${emojis.length - 1}}}` })
    processed = processed.replace(/\.{3,}|…+/g, "{{...}}")

    const idealLen = processed.length <= 300
      ? processed.length
      : Math.ceil(processed.length / Math.min(Math.ceil(processed.length / 300), 5))
    const points = []
    let last = 0

    for (let i = 0; i < processed.length; i++) {
      if (punctuations.includes(processed[i]) && i - last + 1 >= idealLen * 0.7) {
        points.push(i + 1)
        last = i + 1
      }
    }

    const segments = []
    let start = 0
    for (const p of points) {
      if (p > start) { segments.push(processed.slice(start, p)); start = p }
    }
    if (start < processed.length) segments.push(processed.slice(start))

    return segments.map(s =>
      s.replace(/{{\.\.\.}}/g, "...")
        .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[i])
        .replace(/{{E(\d+)}}/g, (_, i) => emojis[i])
        .trim()
    )
  }

  async convertAtInString(content, group) {
    if (!group) return { result: content, hasAt: false, atQQList: [] }

    const members = await group.getMemberMap()
    const atQQList = []
    let result = content

    const matches = content.matchAll(/@([^\s]+)/g)
    for (const match of matches) {
      const member = this.findMember(match[1], members)
      if (member) {
        result = result.replace(match[0], "")
        atQQList.push(member.qq)
      }
    }

    return { result, hasAt: atQQList.length > 0, atQQList }
  }

  findMember(target, members) {
    if (/^\d+$/.test(target)) {
      const member = members.get(Number(target))
      if (member) return { qq: Number(target), info: member }
    }

    const search = target.toLowerCase()
    for (const [qq, info] of members) {
      if ([info.card, info.nickname].some(n => n?.toLowerCase().includes(search))) {
        return { qq, info }
      }
    }
    return null
  }

  processToolSpecificMessage(content, toolName) {
    let output = content.replace(/\n/g, "\n")

    // 过滤消息记录格式（多行全局匹配）
    // 匹配如: "[01-27 16:12:51] 哈基米(QQ号: 2127498644)[群身份: member]: 以后注意点。"
    // 或: "[16:11:11] 哈基米(QQ号: xxx)[群身份: xxx]: 在群里说: xxx"
    // 或: "[MM-DD HH:MM:SS] 迈(QQ号: xxx)[群身份: xxx]: xxx"（AI输出的模板格式）
    output = output.replace(/\[(?:[A-Z]{2}-[A-Z]{2}\s+[A-Z]{2}:[A-Z]{2}:[A-Z]{2}|\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})\]\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\][:：]\s*(?:艾特了\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\])?\s*(?:在群里说[:：]\s*)?[^\n]*/gi, '')

    // 清理模式
    const patterns = [
      /$$图片$$/g,
      /[\s\S]在群里说[:：]\s/g,
      /\[(?:\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\]\s*.?[:：]\s/g,
      /[\s\S]*?/g
    ]

    for (const p of patterns) output = output.replace(p, "").trim()
    // 提取消息内容
    const match = /$$群身份: .+?$$[:：]\s*(.)/i.exec(output)
    if (match) output = match[1]
    output = output.replace(/^[说說][:：]\s/, "")

    output = ThinkingProcessor.removeThinking(output)
    output = output.replace(/!?$$(.*?)$$(.∗?)(.∗?)/g, "$1\n- $2")
    // 清理多余空行
    output = output.replace(/\n{3,}/g, '\n').trim()
    return output.trim()
  }

  getSessionState(e) {
    const id = e.group_id || e.user_id
    if (!sessionStates.has(id)) {
      sessionStates.set(id, { lastEmojiTime: 0, consecutiveCount: 0 })
    }
    return sessionStates.get(id)
  }

  async sendEmojiWithProbability(e) {
    if (!EMOJI_CONFIG.enabled) return

    const state = this.getSessionState(e)
    const now = Date.now()
    const timeFactor = Math.min(1, (now - state.lastEmojiTime) / EMOJI_CONFIG.cooldownTime)
    const penaltyFactor = Math.pow(0.7, Math.min(3, state.consecutiveCount))
    const probability = Math.min(EMOJI_CONFIG.baseProbability * timeFactor * penaltyFactor, EMOJI_CONFIG.maxProbability)

    if (Math.random() < probability) {
      try {
        state.consecutiveCount = 0
        state.lastEmojiTime = now

        const { data: memeList = [] } = await Bot.sendApi('fetch_custom_face', { count: 500 })
        if (memeList.length) {
          const delay = Math.floor(Math.random() * (EMOJI_CONFIG.maxDelay - EMOJI_CONFIG.minDelay + 1)) + EMOJI_CONFIG.minDelay
          setTimeout(() => e.reply(segment.image(memeList[Math.floor(Math.random() * memeList.length)])), delay)
        }
      } catch (error) {
        console.error('表情包发送失败:', error)
      }
    } else {
      state.consecutiveCount = Math.min(state.consecutiveCount + 1, 10)
    }
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

      const mcpConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))

      if (!mcpConfig?.servers) {
        logger.info("[MCP] MCP配置为空或无服务器配置")
        return
      }

      const enabledServers = Object.entries(mcpConfig.servers).filter(([_, config]) => config.enabled)

      if (enabledServers.length === 0) {
        logger.info("[MCP] 没有启用的MCP服务器")
        return
      }

      for (const [serverName, config] of enabledServers) {
        await mcpManager.connectServer(serverName, config)
      }

      this.updateToolsList()

      logger.info(`[MCP] 初始化完成，共加载 ${mcpManager.tools.size} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 初始化失败:", error)
    }
  }

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList() {
    const localTools = this.getToolsByName(this.config.oneapi_tools || [])
    const mcpTools = mcpManager.getAllTools() || []

    this.tools = [...localTools, ...mcpTools]

    for (const [sessionId, session] of this.sessionMap) {
      session.tools = this.tools
    }

    logger.info(`[工具] 本地工具: ${localTools.length}, MCP工具: ${mcpTools.length}`)
  }

  /**
   * 重载MCP配置（管理员命令）
   */
  async reloadMCP(e) {
    if (!e.isMaster) {
      await e.reply("只有主人才能执行此操作")
      return true
    }

    await e.reply("正在重载MCP配置...")

    try {
      await mcpManager.disconnectAll()
      await this.initMCP()

      const toolCount = mcpManager.tools?.size || 0
      await e.reply(`MCP重载完成，当前加载 ${toolCount} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 重载失败:", error)
      await e.reply(`MCP重载失败: ${error.message}`)
    }

    return true
  }

  /**
   * 列出所有MCP工具
   */
  async listMCPTools(e) {
    const tools = mcpManager.getAllTools() || []

    if (tools.length === 0) {
      await e.reply("当前没有加载任何MCP工具")
      return true
    }

    let msg = "【MCP工具列表】\n"
    for (const tool of tools) {
      msg += `\n📌 ${tool.function?.name || "未知"}\n   ${tool.function?.description || "无描述"}\n`
    }

    await e.reply(msg)
    return true
  }
}
