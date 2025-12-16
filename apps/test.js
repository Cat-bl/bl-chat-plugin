import { JinyanTool } from "../functions/functions_tools/JinyanTool.js"
import { FreeSearchTool } from "../functions/functions_tools/SearchInformationTool.js"
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
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { MessageManager } from "../utils/MessageManager.js"
import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"
import { TotalTokens } from "../functions/tools/CalculateToken.js"
import { mcpManager } from "../utils/MCPClient.js"
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import { randomUUID } from "crypto"
import pLimit from "p-limit"
import schedule from 'node-schedule'

const _path = process.cwd()

// 表情包配置
const EMOJI_CONFIG = {
  enabled: true,                // 是否启用表情包回复功能（false时完全禁用）
  baseProbability: 0.20,        // 基础触发概率（冷却结束后无惩罚时的基准概率）
  cooldownTime: 30000,          // 冷却时间（毫秒），30秒内再次触发概率会衰减
  maxProbability: 0.30,         // 概率上限（防止概率值无限增长）
  minDelay: 500,                // 表情包发送的最小延迟（毫秒）
  maxDelay: 500                 // 表情包发送的最大延迟（毫秒）
}

const sessionStates = new Map()
const roleMap = { owner: "owner", admin: "admin", member: "member" }

// 模块级变量（文件加载时只执行一次）
let pluginInitialized = false
let sharedState = null

function initializeSharedState(config) {
  if (sharedState) return sharedState
  sharedState = {
    messageManager: new MessageManager({
      privateMaxMessages: 100,
      groupMaxMessages: config.groupMaxMessages,
      messageMaxLength: 200,
      cacheExpireDays: config.groupChatMemoryDays
    }),
    toolInstances: {
      jinyanTool: new JinyanTool(),
      freeSearchTool: new FreeSearchTool(),
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
      bananaTool: new BananaTool()
    },
    sessionMap: new Map()
  }

  sharedState.functions = Object.values(sharedState.toolInstances).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))

  sharedState.functionMap = new Map(sharedState.functions.map(func => [func.name, func]))

  return sharedState
}

export class ExamplePlugin extends plugin {
  constructor() {
    super({
      name: "全局方案-test",
      dsc: "全局方案测试版",
      event: "message",
      priority: 2000,
      rule: [
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },  // 重载MCP
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" }, // 列出MCP工具
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    // 初始化配置（轻量级，可以每次执行）
    this.initConfig()

    // 获取或创建共享状态（只会初始化一次）
    const state = initializeSharedState(this.config)

    // 绑定到实例
    this.messageManager = state.messageManager
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.sessionMap = state.sessionMap
    this.REDIS_KEY_PREFIX = 'ytbot:messages:'

    this.initTools()
    this.initMessageHistory()

    // 一次性初始化
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

    // 获取本地工具
    const localTools = this.getToolsByName(toolConfig[provider] || this.config.openai_tools)

    // 获取 MCP 工具（如果已加载）
    const mcpTools = mcpManager.getAllTools() || []

    // 合并工具列表
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
    schedule.scheduleJob('0 0 * * *', async () => {
      try {
        logger.info('开始执行消息历史记录清理定时任务')
        await this.clearAllMessages()
        logger.info('消息历史记录清理完成')
      } catch (error) {
        logger.error(`定时清理消息历史记录失败: ${error}`)
      }
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

  initConfig() {
    const defaultConfig = {
      pluginSettings: {
        enabled: false,
        groupHistory: true,
        UseTools: true,
        replyChance: 0.015,
        ConcurrentLimit: 5,
        triggerPrefixes: ["芙宁娜", "芙芙"],
        excludeMessageTypes: ["file", "video"],
        allowedGroups: [782312429],
        enableGroupWhitelist: true,
        whitelistRejectMsg: "本群未开启此功能哦~",
        groupMaxMessages: 100,
        groupChatMemoryDays: 1,
        maxToolRounds: 5,
        providers: "oneapi",
        systemContent: `你是QQ群里一个叫"${Bot.nickname}"的普通群友...`,
        ForcedAvatarMode: true,
        ForceformatMessage: false,
        OpenAiUrl: "https://ai.hybgzs.com/v1/chat/completions",
        OpenAiModel: "gemini-2.5-flash",
        OpenAiApikey: "sk-xxx",
        OneApiUrl: "https://ai.hybgzs.com",
        OneApiModel: "gemini-2.5-pro",
        OneApiKey: ["cpk_xxx"],
        openai_tool_choice: "auto",
        oneapi_tools: ["likeTool", "pokeTool", "googleImageAnalysisTool", "aiMindMapTool", "bananaTool", "bingImageSearchTool", "changeCardTool", "githubRepoTool", "googleImageEditTool", "jinyanTool", "qqZoneTool", "freeSearchTool", "searchMusicTool", "searchVideoTool", "videoAnalysisTool", "voiceTool", "webParserTool"],
        githubToken: ""
      }
    }

    const configPath = path.join(process.cwd(), "plugins/test-plugin/config/message.yaml")

    try {
      if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, "utf8"))
        const merged = this.mergeConfig(defaultConfig, config)
        if (JSON.stringify(config) !== JSON.stringify(merged)) {
          fs.writeFileSync(configPath, YAML.stringify(merged))
        }
        this.config = merged.pluginSettings
      } else {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, YAML.stringify(defaultConfig))
        this.config = defaultConfig.pluginSettings
      }
    } catch (err) {
      logger.error(`[群管工具] 加载配置文件失败: ${err}`)
      this.config = defaultConfig.pluginSettings
    }
  }

  mergeConfig(defaults, user) {
    const merged = { ...defaults }
    for (const key in defaults) {
      if (typeof defaults[key] === "object" && !Array.isArray(defaults[key])) {
        merged[key] = this.mergeConfig(defaults[key], user?.[key] || {})
      } else {
        merged[key] = user?.[key] ?? defaults[key]
      }
    }
    return merged
  }

  checkGroupPermission(e) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  // 消息历史操作
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

  // 辅助方法
  formatTime() {
    const now = new Date()
    const pad = n => String(n).padStart(2, "0")
    return `[${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
  }

  async buildMessageContent(sender, msg, images, atQq = [], group) {
    const senderRole = roleMap[sender.role] || "member"
    const senderInfo = `${sender.card || sender.nickname}(qq号: ${sender.user_id})[群身份: ${senderRole}]`

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

    const content = []
    if (msg) content.push(`在群里说: ${msg}`)
    if (images?.length) {
      content.push(`发送了${images.length === 1 ? "一张" : images.length + " 张"}图片${images.map(img => `\n![图片](${img})`).join("")}`)
    }

    return `${this.formatTime()} ${senderInfo}: ${atContent}${content.join("，")}`
  }

  getProvider() {
    return this.config?.providers?.toLowerCase()
  }

  getModel() {
    const models = {
      oneapi: this.config.OneApiModel
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

    // 只有当 tools 有内容且 toolChoice 不是 "none" 时才添加工具
    if (this.config.UseTools && tools?.length && toolChoice !== "none") {
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
    const pattern = /\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/
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

  // 主处理方法
  async handleRandomReply(e) {
    if (!this.config.enabled || !this.checkGroupPermission(e) || this.isCommand(e) || !e.group_id) {
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (this.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    const hasTrigger = await this.checkTriggers(e)
    if (!hasTrigger && Math.random() > this.config.replyChance) return false

    return await this.handleTool(e)
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
    const limit = pLimit(this.config.ConcurrentLimit || 5)

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

      // 获取成员信息
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

      const userContent = await limit(() => this.buildMessageContent(e.sender, args, images, atQq, e.group))

      const getHighLevelMembers = async group => {
        if (!group) return ""
        const members = await group.getMemberMap()
        return Array.from(members.values())
          .filter(m => ["admin", "owner"].includes(m.role))
          .map(m => `${m.nickname}(QQ号: ${m.user_id})[群身份: ${roleMap[m.role]}]`)
          .join("\n")
      }

      // 初始化MCP工具systemPrompt
      const mcpPrompts = mcpManager.getMCPSystemPrompts({
        messageType: e.message_type,
        groupId: e.group_id,
        message: e.msg
      })

      const systemContent = `
【认知系统初始化】
${this.config.systemContent}

【核心身份原则】 
1. 实时数据
   ${JSON.stringify({
        group_info: { administrators: await limit(() => getHighLevelMembers(e.group)) },
        environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
      }, null, 2)}

2.【消息格式】
   [MM-DD HH:MM:SS] 昵称(QQ号: xxx)[群身份: xxx]: 在群里说: {message}
3.【艾特、@格式】
   @+qq号,例如@32174，@xxxxx

${mcpPrompts}

|* 工具使用隐藏规则：
   | 1⃣ 严禁在回复中显示工具调用代码或函数名称
   | 2⃣ 工具执行后，以自然对话方式呈现结果，如同人类完成了该任务
    **绝对禁止**在任何回复中显示**工具调用代码、函数名称或任何内部执行细节**。这包括但不限于：
    *   \`print(...)\`、\`tool_name(...)\` 等类似编程语言的语法。
    *   \`[tool_code]\`、\` <tool_code> \` 等任何形式的工具代码块标记。
   | 3⃣ 示例转换:
   |   ✅ 正确: "八重神子的全身像已经画好啦，按照你要求的侧面视角做的，感觉还挺好看的~"
   |   ❌ 错误示例 (绝对不允许):**
        *   \`[tool_code]\`
        *   \`print(pokeTool(user_qq_number=1390963734))\`
        *   \`print(pokeTool(user_qq_number=1390963734))\`
        *   "我正在运行 \`pokeTool\` 函数..."

【群聊消息记录】
`
      // 获取历史记录
      if (this.config.groupHistory) {
        const chatHistory = await limit(() =>
          this.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id))

        if (chatHistory?.length) {
          const memberMap = await limit(() => e.bot.pickGroup(groupId).getMemberMap())
          groupUserMessages = await Promise.all(
            chatHistory.reverse().map(async msg => ({
              role: msg.sender.user_id === Bot.uin ? "assistant" : "user",
              content: `[${msg.time}] ${msg.sender.nickname}(QQ号:${msg.sender.user_id})[群身份: ${roleMap[msg.sender.role] || "member"}]: ${msg.content}`
            }))
          )
        }
      }

      groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
      groupUserMessages.unshift({ role: "system", content: systemContent })
      groupUserMessages.push({ role: "user", content: userContent })
      session.userContent = userContent
      groupUserMessages = this.trimMessageHistory(groupUserMessages)
      groupUserMessages = this.filterChatByQQ(groupUserMessages, e.user_id)
      session.groupUserMessages = this.formatMessages(groupUserMessages, e)

      // 确定工具选择
      let toolChoice = "auto"
      if (videos?.length >= 1) {
        session.tools = this.getToolsByName(["videoAnalysisTool"])
        if (session.tools?.length) toolChoice = { type: "function", function: { name: "videoAnalysisTool" } }
      }

      if (this.config.ForcedAvatarMode && msg?.includes("头像编辑")) {
        session.tools = this.getToolsByName(["googleImageEditTool"])
        if (session.tools?.length) toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
        session.groupUserMessages.at(-1).content += `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640)]`
      }

      if (msg?.includes("导图") || msg?.includes("思维导图")) {
        session.tools = this.getToolsByName(["aiMindMapTool"])
        if (session.tools?.length) toolChoice = { type: "function", function: { name: "aiMindMapTool" } }
      }

      // 获取bot角色
      const botMemberMap = await limit(() => e.bot.pickGroup(groupId).getMemberMap())
      const botRole = roleMap[botMemberMap.get(Bot.uin)?.role] || "member"
      session.toolContent = await limit(() =>
        this.buildMessageContent({ nickname: Bot.nickname, user_id: Bot.uin, role: botRole }, "", [], [], e.group))

      // API请求
      const requestData = this.buildRequestData(session.groupUserMessages, session.tools, toolChoice)
      let response = await this.retryRequest(limit, requestData, session.toolContent)

      if (!response?.choices?.[0]) {
        this.clearSession(sessionId)
        return true
      }

      const message = response.choices[0].message || {}

      // 处理工具调用
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

  formatMessages(messages, e) {
    if (!messages?.length) return messages

    const systemMsgs = messages.filter(m => m.role === "system")
    const lastUser = messages[messages.length - 1]?.role === "user" ? [messages[messages.length - 1]] : []
    const middle = messages.slice(systemMsgs.length, messages.length - lastUser.length)

    const formatted = middle.map(m => m.content).join("\n")

    return [
      ...systemMsgs,
      formatted ? { role: "user", content: `当前QQ群[${e.group_id}]的群聊历史记录：\n${formatted}` } : null,
      { role: "assistant", content: "【系统提示】: 收到，我会根据历史记录和最新消息回复，需要时调用工具" },
      ...lastUser
    ].filter(Boolean)
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
   * 处理工具调用 - 统一处理本地工具和MCP工具
   */
  /**
   * 处理工具调用 - 支持多轮工具调用
   */
  async processToolCalls(message, e, session, groupUserMessages, atQq, senderRole, targetRole, limit) {
    const MAX_TOOL_ROUNDS = this.config.maxToolRounds // 最大工具调用轮数，防止无限循环
    let currentMessage = message
    let currentMessages = [...groupUserMessages]
    let round = 0

    while (currentMessage.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
      round++
      logger.info(`[工具调用] 第 ${round} 轮，共 ${currentMessage.tool_calls.length} 个工具`)

      const executedTools = new Map()
      const validResults = []

      // 执行当前轮次的所有工具
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

        // 本地工具参数处理
        if (isLocalTool) {
          // if (["jinyanTool", "pokeTool"].includes(toolName) && atQq.length) {
          //   params.target = atQq.length === 1 ? String(atQq[0]) : atQq.map(String)
          // }
          if (toolName === "jinyanTool") {
            if (senderRole) params.senderRole = senderRole
            if (targetRole) params.targetRole = targetRole
          }
        }

        try {
          logger.info(`[工具调用] ${isMCPTool ? "MCP" : "本地"} - ${toolName}: ${JSON.stringify(params)}`)

          let result
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

          if (result) {
            validResults.push({
              toolCall,
              toolName,
              result: typeof result === "string" ? result : JSON.stringify(result)
            })
          }
        } catch (error) {
          logger.error(`[工具执行失败] ${toolName}:`, error)
          validResults.push({ toolCall, toolName, result: `执行出错: ${error.message}` })
        }
      }

      if (validResults.length === 0) break

      session.toolName = validResults[validResults.length - 1]?.toolName

      // 构建消息
      const cleanedMessages = round === 1
        ? removeToolPromptsFromMessages(currentMessages)
        : currentMessages

      currentMessages = [
        ...cleanedMessages,
        {
          role: "assistant",
          content: null,
          tool_calls: validResults.map(r => r.toolCall)
        },
        ...validResults.map(({ toolCall, toolName, result }) => ({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: result
        }))
      ]

      // 请求下一轮（带工具，允许继续调用）
      const nextRequest = this.buildRequestData(currentMessages, session.tools, "auto")
      const nextResponse = await this.retryRequest(limit, nextRequest, session.toolContent, 1, session.toolName)

      if (!nextResponse?.choices?.[0]?.message) break

      currentMessage = nextResponse.choices[0].message

      // 如果没有新的工具调用，输出文本回复
      if (!currentMessage.tool_calls?.length && currentMessage.content) {
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

    // 如果达到最大轮数或没有内容，强制获取文本回复
    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`[工具调用] 达到最大轮数 ${MAX_TOOL_ROUNDS}，强制结束`)
    }

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
      // 检查是否为MCP工具（通过工具名称字符串判断）
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        const realName = mcpManager.getRealToolName(tool)
        const mcpResult = await limit(() => mcpManager.executeTool(realName, params))

        // 处理MCP返回结果
        if (mcpResult?.content && Array.isArray(mcpResult.content)) {
          return mcpResult.content.map(c => c.text || JSON.stringify(c)).join("\n")
        }
        return mcpResult
      }

      // 本地工具执行
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
    await limit(() => this.sendSegmentedMessage(e, output))

    try {
      await limit(() => this.messageManager.recordMessage({
        message_type: e.message_type,
        group_id: e.group_id,
        time: Math.floor(Date.now() / 1000),
        message: [{ type: "text", text: content }],
        source: "send",
        self_id: Bot.uin,
        sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      }))
    } catch (error) {
      logger.error("[MessageRecord] 记录Bot消息失败：", error)
    }

    messages.push({ role: "assistant", content })
    session.groupUserMessages = this.trimMessageHistory(messages)
    await limit(() => this.saveGroupUserMessages(e.group_id, e.user_id, messages))
  }

  async sendSegmentedMessage(e, output, quoteChance = 0.4) {
    try {
      // 随机决定是否引用回复（默认40%概率）
      const shouldQuote = Math.random() < quoteChance
      const { result, hasAt, atQQList } = await this.convertAtInString(output, e.group)

      if (e.group) {
        output = result || output
      }

      const { total_tokens } = await TotalTokens(output)

      if (total_tokens <= 10) {
        if (hasAt) {
          return await e.reply([...atQQList.map(qq => segment.at(qq)), ' ', output])
        } else {
          return await e.reply(output, shouldQuote)
        }
      }

      const segments = this.splitMessage(output)
      for (let i = 0; i < segments.length; i++) {
        if (segments[i]?.trim()) {
          // 只在第一段消息时引用，避免多段都引用
          const quote = shouldQuote && i === 0
          if (hasAt && i === 0) {
            await e.reply([...atQQList.map(qq => segment.at(qq)), ' ', segments[i].trim()])
          } else {
            await e.reply(segments[i].trim(), quote)
          }

          if (i < segments.length - 1) {
            const delay = Math.min(1000 + segments[i].length * 5 + Math.random() * 500, 3000)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
    } catch (error) {
      console.error("分段发送错误:", error)
      await e.reply(output)
    }
  }

  splitMessage(text) {
    const punctuations = ["。", "！", "？", "；", "!", "?", ";", "\n"]
    const cqCodes = [], emojis = []
    let processed = text

    // 保护CQ码和emoji
    processed = processed.replace(/\[CQ:[^\]]+\]/g, m => { cqCodes.push(m); return `{{CQ${cqCodes.length - 1}}}` })
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
    let output = content.replace(/\\n/g, "\n")

    // 清理模式
    const patterns = [
      /\[图片\]/g,
      /[\s\S]*在群里说[:：]\s*/g,
      /\[\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*.*?[:：]\s*/g,
      /```[\s\S]*?```/g
    ]

    for (const p of patterns) output = output.replace(p, "").trim()

    // 提取消息内容
    const match = /\[群身份: .+?\][:：]\s*(.*)/i.exec(output)
    if (match) output = match[1]
    output = output.replace(/^[说說][:：]\s*/, "")

    output = ThinkingProcessor.removeThinking(output)
    output = output.replace(/!?\[(.*?)\]\((.*?)\)/g, "$1\n- $2")

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
      const configDir = path.join(process.cwd(), "plugins/test-plugin/config")
      const configPath = path.join(configDir, "mcp-servers.yaml")
      const defaultConfigPath = path.join(configDir, "mcp-servers-default.yaml")

      // 如果配置文件不存在
      if (!fs.existsSync(configPath)) {
        // 检查默认模板是否存在
        if (fs.existsSync(defaultConfigPath)) {
          logger.info("[MCP] 未找到MCP配置文件，正在从默认模板创建...")
          this.createDefaultMCPConfig(configPath)
          logger.info("[MCP] 已创建MCP配置文件: " + configPath)
          logger.info("[MCP] 请根据需要修改配置并启用相应的MCP服务器")
        } else {
          logger.warn("[MCP] 未找到MCP配置文件和默认模板")
          logger.warn("[MCP] 请创建配置文件: " + configPath)
          logger.warn("[MCP] 或创建默认模板: " + defaultConfigPath)
          return
        }
      }

      const mcpConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))

      // // 如果 basic-memory 服务器启用，自动创建数据目录
      // if (mcpConfig.servers['basic-memory']?.enabled) {
      //   const memoryDataDir = mcpConfig.servers['basic-memory'].env?.BASIC_MEMORY_DATA_DIR
      //   if (memoryDataDir) {
      //     const dirPath = path.isAbsolute(memoryDataDir)
      //       ? memoryDataDir
      //       : path.join(process.cwd(), memoryDataDir)

      //     // 创建目录（如果不存在）
      //     if (!fs.existsSync(dirPath)) {
      //       fs.mkdirSync(dirPath, { recursive: true })
      //       logger.info(`[MCP] 已创建 记忆 数据目录: ${dirPath}`)
      //     }
      //   }
      // }

      if (!mcpConfig?.servers) {
        logger.info("[MCP] MCP配置为空")
        return
      }

      // 检查是否有启用的服务器
      const enabledServers = Object.entries(mcpConfig.servers).filter(([_, config]) => config.enabled)

      if (enabledServers.length === 0) {
        logger.info("[MCP] 没有启用的MCP服务器")
        return
      }

      // 连接所有启用的服务器
      for (const [serverName, config] of enabledServers) {
        await mcpManager.connectServer(serverName, config)
      }

      // 更新工具列表（合并本地工具和MCP工具）
      this.updateToolsList()

      logger.info(`[MCP] 初始化完成，共加载 ${mcpManager.tools.size} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 初始化失败:", error)
    }
  }

  /**
 * 创建默认MCP配置文件（从默认模板复制）
 * @param {string} configPath - 配置文件路径
 */
  createDefaultMCPConfig(configPath) {
    const configDir = path.dirname(configPath)
    const defaultConfigPath = path.join(configDir, "mcp-servers-default.yaml")

    // 确保目录存在
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // 检查默认配置文件是否存在
    if (fs.existsSync(defaultConfigPath)) {
      // 复制默认配置文件
      fs.copyFileSync(defaultConfigPath, configPath)
      logger.info(`[MCP] 已从默认模板创建配置文件: ${configPath}`)
    } else {
      // 默认配置文件不存在，创建空配置
      const emptyConfig = `# MCP (Model Context Protocol) 服务器配置
# 默认模板文件 mcp-servers-default.yaml 不存在
# 请手动创建配置或从示例中复制

servers: {}
`
      fs.writeFileSync(configPath, emptyConfig, "utf8")
      logger.warn(`[MCP] 默认模板文件不存在: ${defaultConfigPath}`)
      logger.warn(`[MCP] 已创建空配置文件，请手动配置或创建默认模板`)
    }
  }

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList() {
    // 获取本地工具
    const localTools = this.getToolsByName(this.config.oneapi_tools || [])

    // 获取MCP工具
    const mcpTools = mcpManager.getAllTools() || []

    // 合并工具列表
    this.tools = [...localTools, ...mcpTools]

    // 更新session中的工具
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
      // 断开所有连接
      await mcpManager.disconnectAll()

      // 重新初始化
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
