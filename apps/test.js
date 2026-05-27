import { EmotionManager } from "../utils/EmotionManager.js"
import { MemoryManager } from "../utils/MemoryManager.js"
import { ExpressionLearner } from "../utils/ExpressionLearner.js"
import KnowledgeSearcher from "../functions/KnowledgeSearcher.js"
import KnowledgeExpander from "../functions/KnowledgeExpander.js"
import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { MessageManager } from "../utils/MessageManager.js"
import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"
import { TotalTokens } from "../functions/tools/CalculateToken.js"
import { mcpManager } from "../utils/MCPClient.js"
import { localToolRegistry } from "../utils/LocalToolRegistry.js"
import { getRedBagType, isExclusiveForUser } from "../utils/redBagUtils.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import common from "../../../lib/common/common.js"
import chokidar from "chokidar"
import { randomUUID } from "crypto"
import pLimit from "p-limit"
import schedule from 'node-schedule'

const _path = process.cwd()

// 自动抢红包配置
const RED_BAG_CONFIG = {
  enabled: true, // 是否启用自动抢红包
  minProbability: 0.3, // 最小触发概率
  maxProbability: 0.8, // 最大触发概率
  cooldownTime: 60000 // 冷却时间（毫秒），同一个群60秒内不重复触发
}

const redBagCooldowns = new Map() // 红包冷却记录: key: groupId, value: lastGrabTime

// 终态工具：本轮调用后不再请求 LLM 续话（工具的执行结果本身即为最终输出）
const TERMINAL_TOOL_NAMES = new Set(['sendLocalEmojiTool', 'waitTool'])

const activeDedupeToolRuns = new Map()
const taskStatusCache = new Map()
const activeConversations = new Map() // 会话追踪: key: `${groupId}_${userId}`, value: { lastActiveTime, chatHistory: [], timer: null }
const trackingThrottle = new Map() // 节流: key: `${groupId}_${userId}`, value: lastCallTime
const pendingJudgments = [] // 批量判断队列
let batchTimer = null // 批量处理定时器
// smart 模式：每群独立的频率状态，进程内 Map，重启清零
const trackingChatStates = new Map() // groupId -> { pendingCount, lastMsgAt, replyLatencies: [{at, ms}], forceContinue, forceGateCheck, lastGateNoActionAt, inFlight, waitTimers: Map<userKey, timeoutId> }
// 群最后一条新消息到达时间戳，用于"准备回复前 debounce 看有没有新消息"（仅 smart 模式 set/读）
const lastIncomingMsgAt = new Map() // groupId -> ts
// 群连续被新消息打断的累计计数（达到上限后下一轮强制走完不再让步）
const consecutiveInterrupts = new Map() // groupId -> count
// 禁言状态短期缓存：避免每条群消息都查一次 ws RPC pickMember.getInfo()
const mutedStatusCache = new Map() // groupId -> { isMuted, at }
const MUTED_CACHE_TTL_MS = 30000
const groupContextCache = new Map()
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000
let activeChatLruTimer = null // 全局 24h LRU 扫描定时器，进程内单例
const roleMap = { owner: "owner", admin: "admin", member: "member" }
const PSEUDO_TOOL_MARKERS = [
  "tool", "tools", "tool_call", "toolcall", "function", "function_call", "functioncall", "func", "call", "voice", "audio", "tts", "image", "img",
  "video", "file", "send", "reply", "search", "google", "mcp", "banana", "reminder",
  "poke", "like", "music", "weather", "map", "draw", "generate", "edit",
  "工具", "工具调用", "函数", "函数调用", "调用", "语音", "音频", "图片", "图像", "视频", "文件", "发送",
  "回复", "搜索", "生图", "画图", "修图", "提醒", "戳", "点赞", "点歌", "天气", "地图"
]
const PSEUDO_TOOL_MARKER_SET = new Set(PSEUDO_TOOL_MARKERS.map(item => item.toLowerCase()))
const PSEUDO_TOOL_TEXT_KEYS = ["text", "content", "message", "reply", "spoken_text", "speech", "voice"]

function isPseudoToolMarker(marker = "") {
  const normalized = String(marker || "")
    .trim()
    .replace(/tool$/i, "")
    .replace(/工具$/, "")
    .toLowerCase()
  return PSEUDO_TOOL_MARKER_SET.has(normalized) || PSEUDO_TOOL_MARKER_SET.has(`${normalized}tool`)
}

// ─── 拟人化对话相关：本地预筛辅助常量与函数 ────────────────────────────
// 中文停用词（提取关键词时跳过这些）
const CHAT_STOPWORDS = new Set([
  "的", "了", "是", "也", "就", "都", "吧", "吗", "呢", "啊", "么", "哦", "呀", "嘛", "哈",
  "这", "那", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "觉得", "感觉", "可能", "应该", "不", "没", "有", "在", "和", "与", "或", "但", "而",
  "什么", "怎么", "怎样", "如何", "哪里", "哪个", "为什么", "因为", "所以",
  "一个", "一些", "这个", "那个", "这样", "那样", "这里", "那里",
  "可以", "不能", "需要", "想要", "知道", "听说", "看到"
])
// 反馈词（用户消息开头或主体如果是这些，认为是在回应 bot）
const FEEDBACK_WORDS = [
  "嗯", "对", "不对", "真的", "真的吗", "是吗", "是的", "确实", "对哦", "也是",
  "好的", "好吧", "可以", "可以的", "不可以", "不是", "没错", "没", "我也", "我觉得", "我感觉",
  "那", "那你", "那我", "你说", "你这", "你这么说",
  "啊？", "啊", "诶", "诶？", "哦", "哦？", "哈哈", "哈"
]
// 问句尾字（消息末尾包含这些算问句）
const QUESTION_TAIL_CHARS = ["?", "？", "吗", "呢", "啊", "么", "嘛"]

/**
 * 从一段文本提取关键词（给 R2 关键词命中识别用）。
 * 简单实现：按中英标点切分，取长度 ≥2 的非停用词词块，去重，最多 maxCount 个。
 */
function extractChatKeywords(text, maxCount = 5) {
  if (!text || typeof text !== "string") return []
  // 去除 CQ 码、@ 字段等噪声
  const cleaned = text
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
  // 按非中英文数字字符切分
  const tokens = cleaned.split(/[^一-龥A-Za-z0-9]+/).filter(Boolean)
  const seen = new Set()
  const result = []
  for (const tok of tokens) {
    const t = tok.trim()
    if (t.length < 2) continue
    if (CHAT_STOPWORDS.has(t)) continue
    // 对中文长词额外拆分 2-3 字滑动窗口（避免长句一个 token 没法匹配）
    if (/^[一-龥]+$/.test(t) && t.length >= 4) {
      // 取 2-gram 前缀作为辅助关键词
      for (let i = 0; i <= t.length - 2 && result.length < maxCount; i++) {
        const gram = t.slice(i, i + 2)
        if (CHAT_STOPWORDS.has(gram)) continue
        if (seen.has(gram)) continue
        seen.add(gram)
        result.push(gram)
      }
    } else {
      if (seen.has(t)) continue
      seen.add(t)
      result.push(t)
    }
    if (result.length >= maxCount) break
  }
  return result.slice(0, maxCount)
}

/**
 * 判断消息是否是问句（含 ? / ？ 或末尾 5 字含问句尾字）
 */
function isQuestionMessage(text) {
  if (!text || typeof text !== "string") return false
  if (/[?？]/.test(text)) return true
  const tail = text.slice(-5)
  for (const ch of QUESTION_TAIL_CHARS) {
    if (tail.includes(ch)) return true
  }
  return false
}

/**
 * 判断消息是否以反馈词开头或主体由反馈词构成
 */
function isFeedbackMessage(text) {
  if (!text || typeof text !== "string") return false
  const t = text.trim()
  if (!t) return false
  // 整条就是反馈词
  if (FEEDBACK_WORDS.includes(t)) return true
  // 开头是反馈词（后接标点或空格）
  for (const w of FEEDBACK_WORDS) {
    if (t.startsWith(w)) {
      const next = t.charAt(w.length)
      if (!next || /[\s,，。.!！?？~～]/.test(next)) return true
    }
  }
  return false
}
// ─── 拟人化对话辅助函数结束 ────────────────────────────────────────────

function extractReadableTextFromObject(value) {
  if (!value || typeof value !== "object") return ""
  for (const key of PSEUDO_TOOL_TEXT_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim()
  }
  for (const key of ["arguments", "args", "params", "input"]) {
    const nested = extractReadableTextFromObject(value[key])
    if (nested) return nested
  }
  return ""
}

function extractReadableTextFromPseudoCall(args = "") {
  const rawArgs = String(args || "").trim()
  if (!rawArgs) return ""

  const quotedOnly = rawArgs.match(/^["'`]([\s\S]*?)["'`]$/)
  if (quotedOnly) return quotedOnly[1].trim()

  const textArg = rawArgs.match(/(?:^|[,{\s])(?:text|content|message|reply|spoken_text|speech|voice)\s*[:=]\s*["'`]([\s\S]*?)["'`](?:[,}\s]|$)/i)
  if (textArg) return textArg[1].trim()

  const jsonLike = rawArgs.match(/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
  if (jsonLike) {
    try {
      const parsed = JSON.parse(jsonLike[1])
      return extractReadableTextFromObject(parsed)
    } catch {}
  }

  return ""
}

function sanitizePseudoToolLine(line) {
  const rawLine = String(line || "")
  let current = rawLine.trim()
  if (!current) return ""

  current = current
    .replace(/^\|?\*+\s*/, "")
    .replace(/\s*\*+\|?$/, "")
    .trim()

  const wrappedTag = current.match(/^<\s*([a-zA-Z_][\w-]*|工具|函数|调用)[^>]*>([\s\S]*?)<\/\s*\1\s*>$/i)
  if (wrappedTag && isPseudoToolMarker(wrappedTag[1])) {
    return sanitizePseudoToolLine(wrappedTag[2])
  }

  const bracketWithColon = current.match(/^[\[【]\s*([^:：\]】\s]{1,32})\s*[:：]\s*([\s\S]*?)[\]】]$/)
  if (bracketWithColon && isPseudoToolMarker(bracketWithColon[1])) {
    return sanitizePseudoToolLine(bracketWithColon[2])
  }

  const bracketPrefix = current.match(/^[\[【]\s*([^\]】\s]{1,32})\s*[\]】]\s*([\s\S]*)$/)
  if (bracketPrefix && isPseudoToolMarker(bracketPrefix[1])) {
    return sanitizePseudoToolLine(bracketPrefix[2])
  }

  const labelPrefix = current.match(/^([A-Za-z_][\w-]*|工具|函数|调用|工具调用|函数调用)\s*[:：]\s*([\s\S]*)$/i)
  if (labelPrefix && isPseudoToolMarker(labelPrefix[1])) {
    return sanitizePseudoToolLine(labelPrefix[2])
  }

  try {
    const parsed = JSON.parse(current)
    const hasToolShape = parsed && typeof parsed === "object" &&
      (parsed.tool || parsed.tool_name || parsed.name || parsed.function || parsed.arguments || parsed.args)
    if (hasToolShape) {
      const readable = extractReadableTextFromObject(parsed)
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  } catch {}

  const functionCall = current.match(/^([A-Za-z_][\w.-]{0,80})\s*\(([\s\S]*)\)$/)
  if (functionCall) {
    const functionName = functionCall[1]
    const lowerName = functionName.toLowerCase()
    const looksLikeToolCall =
      lowerName === "print" ||
      lowerName === "console.log" ||
      lowerName.startsWith("mcp_") ||
      lowerName.includes("tool") ||
      lowerName.endsWith("tool") ||
      PSEUDO_TOOL_MARKER_SET.has(lowerName) ||
      isPseudoToolMarker(functionName)

    if (looksLikeToolCall) {
      const readable = extractReadableTextFromPseudoCall(functionCall[2])
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  }

  return rawLine
}

function sanitizeFinalReplyText(content) {
  let output = String(content || "").replace(/\r\n/g, "\n").trim()
  if (!output) return ""

  output = ThinkingProcessor.removeThinking(output).trim()
  output = output.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/g, "$1").trim()
  output = output.replace(/^\s*`([^`]+)`\s*$/g, "$1").trim()

  const lines = output.split("\n")
  const sanitizedLines = lines
    .map(line => sanitizePseudoToolLine(line))
    .filter(line => line !== null && String(line).trim() !== "")

  return sanitizedLines.join("\n").replace(/\n{3,}/g, "\n").trim()
}

let pluginInitialized = false
let sharedState = null
let configWatcher = null
let mcpInitPromise = null

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseToolConfigEntry(entry) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1],
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}

function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

function isCodeOrMarkdownRequest(text = "") {
  const content = String(text || "").toLowerCase()
  return /写.*(代码|算法|函数|脚本|程序|markdown|md|文档)|给.*(代码|示例代码|算法|markdown|md文档)|实现.*(算法|函数|代码|脚本|程序)|生成.*(代码|markdown|md文档|文档)|编写.*(代码|markdown|md|文档)|代码给我|md文档|markdown文档|代码截图/.test(content)
}

function looksLikeCodeOrMarkdown(text = "") {
  const content = String(text || "")
  if (/```[\s\S]*```/.test(content)) return true
  if (/^\s{0,3}#{1,4}\s+\S/m.test(content) && content.split(/\r?\n/).length >= 3) return true
  if (/^\s*\|.+\|\s*$/m.test(content) && /^\s*\|[-:\s|]+\|\s*$/m.test(content)) return true

  const lines = content.split(/\r?\n/)
  const nonEmptyLines = lines.filter(line => line.trim())
  if (nonEmptyLines.length < 3) return false

  const codeLineCount = nonEmptyLines.filter(line =>
    /^\s*(def|class|for|if|elif|else|while|return|import|from|print|break|continue|const|let|var|function|class|export|switch|try|catch|public|private|static|package|func|fn)\b/.test(line) ||
    /^\s{2,}\S/.test(line) ||
    /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(line) ||
    /[{}();]/.test(line)
  ).length

  return codeLineCount >= 2
}

function applyToolRegistrySnapshot(state, snapshot = localToolRegistry.getSnapshot()) {
  state.toolInstances = snapshot.toolInstances
  state.functions = snapshot.functions
  state.functionMap = snapshot.functionMap
  state.customToolCount = snapshot.customToolCount || 0
  state.builtInToolCount = snapshot.builtInToolCount || 0
  return state
}

async function refreshLocalTools(state, options = {}) {
  const snapshot = await localToolRegistry.reload(options)
  return applyToolRegistrySnapshot(state, snapshot)
}

function buildMemoryConfig(config) {
  const memorySystem = config.memorySystem || {}
  return {
    ...memorySystem,
    memoryAiConfig: config.memoryAiConfig || null,
    embeddingAiConfig: config.embeddingAiConfig || null,
    groupExtractMinIntervalMinutes:
      memorySystem.groupExtractMinIntervalMinutes ?? memorySystem.groupExtractMinInterval ?? 10
  }
}

function initializeSharedState(config) {
  if (sharedState) {
    // 热更新：直接覆盖各 Manager 的 config，无需 Manager 侧改动
    sharedState.messageManager.groupMaxMessages = config.groupMaxMessages || 100
    sharedState.messageManager.cacheExpireDays = config.groupChatMemoryDays
    Object.assign(sharedState.emotionManager.config, {
      decayRate: config.emotionSystem?.decayRate || 0.02,
      eventWeights: {
        ...sharedState.emotionManager.config.eventWeights,
        ...config.emotionSystem?.eventWeights
      }
    })
    sharedState.memoryManager.updateConfig(buildMemoryConfig(config))
    Object.assign(sharedState.expressionLearner.config, {
      ...config.expressionLearning || {},
      memoryAiConfig: config.memoryAiConfig || null
    })
    // 知识库热更新
    if (config.knowledgeSystem?.enabled && !sharedState.knowledgeSearcher) {
      sharedState.knowledgeSearcher = new KnowledgeSearcher({
        apiKey: config.embeddingAiConfig?.embeddingApiKey,
        apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
        dbPath: path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson'),
        model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
        topN: config.knowledgeSystem?.topN || 4,
        threshold: config.knowledgeSystem?.threshold || 0.6
      })
    } else if (config.knowledgeSystem?.enabled && sharedState.knowledgeSearcher) {
      sharedState.knowledgeSearcher.apiKey = config.embeddingAiConfig?.embeddingApiKey
      sharedState.knowledgeSearcher.apiUrl = config.embeddingAiConfig?.embeddingApiUrl
      sharedState.knowledgeSearcher.model = config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small'
      sharedState.knowledgeSearcher.topN = config.knowledgeSystem?.topN || 4
      sharedState.knowledgeSearcher.threshold = config.knowledgeSystem?.threshold || 0.6
    } else if (!config.knowledgeSystem?.enabled) {
      sharedState.knowledgeSearcher = null
    }
    refreshLocalTools(sharedState, { force: true }).catch(error => {
      logger.error('[LocalToolRegistry] 热更新工具失败:', error)
    })
    return applyToolRegistrySnapshot(sharedState)
  }
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
    memoryManager: new MemoryManager(buildMemoryConfig(config)),
    // 表达学习
    expressionLearner: new ExpressionLearner({
      ...config.expressionLearning || {},
      memoryAiConfig: config.memoryAiConfig || null
    }),
    // 知识库检索
    knowledgeSearcher: config.knowledgeSystem?.enabled
      ? new KnowledgeSearcher({
          apiKey: config.embeddingAiConfig?.embeddingApiKey,
          apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
          dbPath: path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson'),
          model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
          topN: config.knowledgeSystem?.topN || 4,
          threshold: config.knowledgeSystem?.threshold || 0.6
        })
      : null,
    sessionMap: new Map()
  }

  applyToolRegistrySnapshot(sharedState)
  refreshLocalTools(sharedState, { force: true }).catch(error => {
    logger.error('[LocalToolRegistry] 初始化自定义工具失败:', error)
  })

  pluginBridge.sharedState = sharedState

  // 知识库自动导入：首次启动时如果 ndjson 不存在，从 database_default 导入
  if (config.knowledgeSystem?.enabled && sharedState.knowledgeSearcher) {
    const dbPath = path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson')
    const defaultTxt = path.join(_path, 'plugins/bl-chat-plugin/database_default/knowledge-base.txt')
    if (!fs.existsSync(dbPath) && fs.existsSync(defaultTxt)) {
      const dbDir = path.dirname(dbPath)
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
      logger.info('[知识库] 首次启动，正在从默认知识库导入...')
      const expander = new KnowledgeExpander({
        apiKey: config.embeddingAiConfig?.embeddingApiKey,
        apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
        dbPath,
        model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small'
      })
      const texts = fs.readFileSync(defaultTxt, 'utf8').split('\n').filter(Boolean)
      const batchSize = 50
      ;(async () => {
        let totalAdded = 0
        let totalSkipped = 0
        const totalBatches = Math.ceil(texts.length / batchSize)
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize)
          const batchNum = Math.floor(i / batchSize) + 1
          try {
            const result = await expander.expand(batch)
            totalAdded += result.added
            totalSkipped += batch.length - result.added
            logger.info(`[知识库] [${batchNum}/${totalBatches}] 新增 ${result.added} 条，跳过重复 ${batch.length - result.added} 条`)
          } catch (err) {
            logger.error(`[知识库] [${batchNum}/${totalBatches}] 导入失败: ${err.message}`)
          }
          if (i + batchSize < texts.length) await new Promise(r => setTimeout(r, 1000))
        }
        logger.info(`[知识库] 自动导入完成，共导入 ${totalAdded} 条，跳过重复 ${totalSkipped} 条`)
      })()
    }
  }

  // 如果启用了 searchMusicTool，初始化音乐 cookie 刷新定时任务
  if (toolConfigHasName(config.oneapi_tools, 'searchMusicTool')) {
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
      priority: 9999,
      rule: [
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "^#记忆状态$", fnc: "memoryStatus" },
        { reg: "^#我的记忆$", fnc: "listMyMemory" },
        { reg: "^#群记忆$", fnc: "listGroupMemory" },
        { reg: "^#搜索记忆\\s+[\\s\\S]+$", fnc: "searchMemory" },
        { reg: "^#删除记忆\\s+\\S+$", fnc: "deleteMemory" },
        { reg: "^#清空我的记忆$", fnc: "clearMyMemory" },
        { reg: "^#清空群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#禁用我的记忆$", fnc: "disableMyMemory" },
        { reg: "^#启用我的记忆$", fnc: "enableMyMemory" },
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" },
        { reg: "^#mcp\\s+状态", fnc: "mcpStatus" },
        { reg: "^#mcp\\s+测试\\s+\\S+", fnc: "testMCPTool" },
        { reg: "^#清除群记忆$", fnc: "clearGroupMemory" },
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

  /**
   * 启动 trackingChatStates 的 TTL 扫描器（进程内单例）：每 1 小时扫一次，
   * 把 lastMsgAt 超过 activeChatTtlHours 的群从内存状态淘汰，连同 waitTimers 一并清掉。
   */
  startActiveChatLruScanner() {
    if (activeChatLruTimer) return
    const intervalMs = 60 * 60 * 1000
    activeChatLruTimer = setInterval(() => {
      try {
        const ttlHours = Number(this.config?.smartTrigger?.activeChatTtlHours) || 24
        const cutoff = Date.now() - ttlHours * 3600 * 1000
        let removed = 0
        for (const [gid, st] of trackingChatStates) {
          if ((st.lastMsgAt || 0) < cutoff) {
            if (st.waitTimers) for (const t of st.waitTimers.values()) clearTimeout(t)
            if (st.deferredTimer) clearTimeout(st.deferredTimer)
            trackingChatStates.delete(gid)
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
            mutedStatusCache.delete(gid)
            removed += 1
          }
        }
        // 兜底：清掉孤儿条目（不应该出现，但防御性编程）
        for (const [gid, ts] of lastIncomingMsgAt) {
          if (!trackingChatStates.has(gid) && ts < cutoff) {
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
          }
        }
        // 禁言缓存独立 TTL（30 秒就过期了，但万一某个群冷下来缓存条目永远留着也不好）
        const mutedCutoff = Date.now() - MUTED_CACHE_TTL_MS * 10
        for (const [gid, item] of mutedStatusCache) {
          if (item.at < mutedCutoff) mutedStatusCache.delete(gid)
        }
        if (removed > 0) logger.info(`[ActiveChatLRU] 淘汰 ${removed} 个 ${ttlHours}h 未活跃群，当前活跃 ${trackingChatStates.size}`)
      } catch (err) {
        logger.error('[ActiveChatLRU] 扫描失败:', err)
      }
    }, intervalMs)
    activeChatLruTimer.unref?.()
  }

  async refreshLocalToolRegistry(options = {}) {
    const state = await refreshLocalTools(sharedState, options)
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.localToolsReady = true
    this.updateToolsList({ silent: options.silent === true })
    return state
  }

  initTools() {
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

  async callOneBotApi(e, action, params = {}) {
    const bot = e?.bot
      || (typeof Bot !== "undefined" ? Bot : null)
      || (typeof globalThis.bot !== "undefined" ? globalThis.bot : null)
      || (typeof globalThis.Bot !== "undefined" ? globalThis.Bot : null)

    if (!bot?.sendApi) throw new Error("找不到 OneBot API 调用接口")
    return await bot.sendApi(action, params)
  }

  normalizeGroupContextText(value, maxLength = 800) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxLength)
  }

  pickNoticeText(value) {
    if (!value) return ""
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(item => this.pickNoticeText(item)).filter(Boolean).join("")
    if (typeof value !== "object") return ""

    for (const key of ["content", "text", "msg", "message", "notice", "title", "data"]) {
      const text = this.pickNoticeText(value[key])
      if (text) return text
    }
    return ""
  }

  extractGroupNoticeText(response) {
    const payload = response?.data ?? response
    const notices = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.notices)
        ? payload.notices
        : Array.isArray(payload?.notice)
          ? payload.notice
          : [payload].filter(Boolean)

    const sorted = notices.slice().sort((a, b) => {
      const getTime = item => Number(item?.publish_time || item?.time || item?.create_time || item?.updated_at || 0)
      return getTime(b) - getTime(a)
    })

    for (const notice of sorted) {
      const text = this.normalizeGroupContextText(this.pickNoticeText(notice), 800)
      if (text) return text
    }
    return ""
  }

  async getCurrentGroupContext(e) {
    const groupId = String(e?.group_id || "")
    if (!groupId) return { groupId: "", groupName: "", groupNotice: "" }

    const groupName = this.normalizeGroupContextText(
      e?.group_name || e?.group?.name || e?.group?.info?.group_name || e?.group?.info?.name,
      120
    )

    const cached = groupContextCache.get(groupId)
    if (cached && Date.now() - cached.at < GROUP_CONTEXT_CACHE_TTL_MS) {
      return { ...cached.data, groupName }
    }

    let groupNotice = ""
    for (const action of ["get_group_notice", "_get_group_notice"]) {
      try {
        const noticeRes = await this.callOneBotApi(e, action, { group_id: Number(groupId) })
        groupNotice = this.extractGroupNoticeText(noticeRes)
        if (groupNotice) break
      } catch (error) {
        logger.debug?.(`[群上下文] ${action} 获取群公告失败 group=${groupId}: ${error.message}`)
      }
    }

    const data = { groupId, groupName, groupNotice }
    groupContextCache.set(groupId, { at: Date.now(), data })
    return data
  }

  shouldUseTextImageForFinalReply({ content, output, session, toolName, e }) {
    if (toolName === "textImageTool") return false
    if (!toolConfigHasName(this.config.oneapi_tools, "textImageTool")) return false
    if (!this.toolInstances?.textImageTool?.execute) return false

    const userText = `${session?.userContent || ""}\n${e?.msg || ""}`
    const userAskedForCodeOrMarkdown = isCodeOrMarkdownRequest(userText)
    const replyLooksLikeCodeOrMarkdown = looksLikeCodeOrMarkdown(content) || looksLikeCodeOrMarkdown(output)

    return replyLooksLikeCodeOrMarkdown || (userAskedForCodeOrMarkdown && String(output || "").trim().length > 30)
  }

  async sendFinalReplyAsTextImage(e, output, limit) {
    const tool = this.toolInstances?.textImageTool
    try {
      const result = await limit(() => tool.execute({ text: output }, e))
      if (typeof result === "string" && result.trim().startsWith("error:")) {
        throw new Error(result)
      }
      logger.info("[textImageTool] 最终回复已转为图片发送")
      return null
    } catch (error) {
      logger.warn(`[textImageTool] 最终回复转图失败，回退为普通文本: ${error.message}`)
      return await limit(() => this.sendSegmentedMessage(e, output))
    }
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

  /**
   * 解析对话焦点状态（FOCUS / FADING / COLD），含自动衰减。每次入口都该调一次。
   * 长时间无消息时一次性衰减到位（focus 经过 fading 直到 cold），避免误判为"刚进入 fading"。
   */
  resolveConversationPhase(state) {
    const now = Date.now()
    const smartCfg = this.config.smartTrigger || {}
    const fadingDurationMs = Number(smartCfg.fadingDurationMs) || 90000

    // 自动衰减：一次入口可能跨越多个 phase，循环到稳定状态
    while (state.phaseUntil && now > state.phaseUntil) {
      if (state.conversationPhase === 'focus') {
        state.conversationPhase = 'fading'
        // 从 focus 结束的那一刻起算 fading 持续时间
        const fadingStart = state.phaseUntil
        state.phaseUntil = fadingStart + fadingDurationMs
        state.consecutiveNoAction = 0
        if (now > state.phaseUntil) continue   // fading 也已过期，继续衰减到 cold
        break
      }
      if (state.conversationPhase === 'fading') {
        state.conversationPhase = 'cold'
        state.phaseUntil = 0
        state.focusReplyCount = 0
        state.consecutiveNoAction = 0
        break
      }
      // 已经是 cold，phaseUntil 不应该为 0 以外的值；保险起见清掉
      state.phaseUntil = 0
      break
    }
    return state.conversationPhase || 'cold'
  }

  /**
   * 本地预筛：免 LLM 决定明显该回 / 不该回 / 高优先级走 Gate。
   * 返回 { kind, reason }，kind 取值：
   *   'force_continue' - @bot / 触发关键词命中（外层已有 inevitableAtReply 处理，这里主要识别"引用 bot 消息"）
   *   'addressed_other' - 消息 @ 了非 bot
   *   'empty_content' - 纯表情/图片/转账，无文本
   *   'bot_self_echo' - bot 自己发的消息
   *   'continuation_strong' - 命中 R1/R2/R3/R4 任一，应走 Gate
   *   'regular' - 默认
   */
  prefilterMessage(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    try {
      // bot 自己发的消息（防自激励）
      const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
      if (botId && String(e?.user_id) === String(botId)) {
        return { kind: 'bot_self_echo', reason: 'sender_is_self' }
      }
      // @ 别人（且不是 @ bot）→ 跳过
      if (smartCfg.skipWhenAddressedOther !== false && Array.isArray(e?.message)) {
        const atSegs = e.message.filter(m => m?.type === 'at')
        if (atSegs.length > 0) {
          const atSelf = atSegs.some(m => String(m?.qq) === String(botId))
          if (!atSelf) {
            return { kind: 'addressed_other', reason: 'at_other_user' }
          }
        }
      }
      // 空文本（纯表情/图片/转账）→ 跳过
      if (smartCfg.skipWhenEmptyText !== false) {
        const rawText = (typeof e?.msg === 'string' ? e.msg : '').trim()
        if (!rawText) {
          return { kind: 'empty_content', reason: 'no_text' }
        }
      }

      // 以下为 continuation_strong 识别（必须距 bot 上次发言不远）
      const text = String(e?.msg || '')
      const sinceLastBotReply = state.lastBotReplyAt ? Date.now() - state.lastBotReplyAt : Infinity
      const quickResponseMs = Number(smartCfg.quickResponseMs) || 30000
      const lookbackMs = Number(smartCfg.continuationLookbackMs) || 180000

      // R1：秒回反应（30s 内任何消息都视为接续）
      if (sinceLastBotReply <= quickResponseMs) {
        return { kind: 'continuation_strong', reason: 'R1_quick_response' }
      }
      // R2/R3/R4 共同前提：在 lookback 窗口内
      if (sinceLastBotReply <= lookbackMs) {
        // R2 关键词匹配
        if (smartCfg.continuationKeywordMatch !== false && Array.isArray(state.lastBotReplyKeywords)) {
          for (const kw of state.lastBotReplyKeywords) {
            if (kw && text.includes(kw)) {
              return { kind: 'continuation_strong', reason: `R2_keyword:${kw}` }
            }
          }
        }
        // R3 问句
        if (smartCfg.continuationQuestionMatch !== false && isQuestionMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R3_question' }
        }
        // R4 反馈词
        if (smartCfg.continuationFeedbackMatch !== false && isFeedbackMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R4_feedback' }
        }
      }
      return { kind: 'regular', reason: '' }
    } catch (err) {
      logger.warn(`[Prefilter] 异常，按 regular 处理：${err.message}`)
      return { kind: 'regular', reason: 'exception' }
    }
  }

  /**
   * 计算群最近 5 分钟消息数（含 bot 自己的回复，用于 Gate prompt 活跃度信号）。
   * 仅做粗略统计：state.recentIncomingTimestamps 滑动窗口。
   */
  computeGroupMsgRate5min(state) {
    if (!Array.isArray(state?.recentIncomingTimestamps)) return 0
    const cutoff = Date.now() - 300000
    state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(t => t > cutoff)
    return state.recentIncomingTimestamps.length
  }

  /**
   * Bot 速率硬上限检查（防刷屏最终防线）。
   * 返回 true=可以继续回复，false=已超上限不该回复（force 路径请勿调用本函数）
   */
  applyRateLimitGuard(state, groupId) {
    const smartCfg = this.config.smartTrigger || {}
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[RateLimit] group=${groupId} 10min 已回复 ${state.recentReplyTimestamps.length}/${maxPer10Min} 次，强制 no_action`)
      state.conversationPhase = 'fading'
      state.phaseUntil = Date.now() + (Number(smartCfg.rateLimitCooldownMs) || 300000)
      return false
    }
    state.recentReplyTimestamps.push(Date.now())
    return true
  }

  /**
   * 冷群空窗 deferred timer：仅 phase=cold 时排，按 (threshold-currentEquiv)*avgMs 估算延迟，
   * 到点合成 _smartWaitRerun 事件再跑一轮 Gate。
   * 注意：本函数通常在 inFlight=true 时（主流程 try 块内）被调用，因此**不要**用 inFlight 守卫；
   * 真正的并发保护放在 setTimeout 回调里（callback 触发时再检查 inFlight）。
   */
  scheduleDeferredGateCheck(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    if (smartCfg.deferredGateEnabled === false) return
    if (!e?.group_id) return
    if (state.conversationPhase !== 'cold') return

    if (state.deferredTimer) clearTimeout(state.deferredTimer)

    const talkValue = this.resolveTalkValue(e.group_id)
    const threshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
    const avgMs = this.computeAvgReplyLatency(state) || Number(smartCfg.avgLatencyDefaultMs) || 60000
    const idleMs = Math.max(0, Date.now() - (state.lastMsgAt || Date.now()))
    const currentEquiv = (state.pendingCount || 0) + idleMs / avgMs
    const remaining = Math.max(0, threshold - currentEquiv)

    const minMs = Number(smartCfg.minDeferredMs) || 120000
    const maxMs = Number(smartCfg.maxDeferredMs) || 900000
    const delayMs = Math.max(minMs, Math.min(maxMs, Math.ceil(remaining * avgMs)))

    const groupId = e.group_id
    state.deferredTimer = setTimeout(async () => {
      state.deferredTimer = null
      try {
        const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
        if (mode !== 'smart') return
        if (!this.checkGroupPermission(e)) return
        if (await this.isMutedInGroup(e)) return
        if (state.inFlight) return
        state.forceGateCheck = true
        const wrapped = Object.create(e)
        wrapped._smartWaitRerun = true
        wrapped._deferredReason = 'cold_idle'
        logger.info(`[DeferredGate] group=${groupId} fired delay=${delayMs}ms`)
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error('[DeferredGate] 失败:', err)
      }
    }, delayMs)
    state.deferredTimer.unref?.()
  }

  /**
   * 执行参与复读：直接 e.reply(原文) 跳过 Gate / handleTool（规避 LLM 改写），
   * 仍占用速率配额，但不升 FOCUS（复读不算正常对话参与）。
   * rate limit 已满时返回 false 不复读。
   */
  async joinRepeat(e, state, text) {
    const smartCfg = this.config.smartTrigger || {}
    const groupId = e.group_id
    // 复用速率检查（避免和正常回复一起把 bot 刷成复读机）
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[Repeat] group=${groupId} rate limit 已满 (${state.recentReplyTimestamps.length}/${maxPer10Min}) 放弃复读`)
      return false
    }
    logger.info(`[Repeat] group=${groupId} 参与复读 text="${text.slice(0, 30)}"`)
    // 先发再写 state：避免 e.reply 抛错时 cooldown / rate limit / lastBotReplyAt 等被脏写
    try {
      await e.reply(text)
    } catch (err) {
      logger.error('[Repeat] 发送失败:', err)
      return false
    }
    // 发送成功才提交状态变更
    state.recentReplyTimestamps.push(Date.now())
    state.lastRepeatJoinAt = Date.now()
    state.lastBotReplyAt = Date.now()
    state.lastBotReplyKeywords = extractChatKeywords(text, Number(smartCfg.continuationKeywordMaxCount) || 5)
    state.pendingCount = 0
    // 清瞬态标志：复读路径跳过了 continue/wait/no_action 分支，需要显式清掉以免污染下一条消息
    state.forceContinue = false
    state.forceGateCheck = false
    state.lastGateNoActionAt = 0
    return true
  }

  /**
   * 复读检测：看最近 N 条群消息，若至少 minCount 个不同用户发了和当前 e.msg 完全相同的内容，
   * 按 repeatJoinProbability 概率决定 bot 是否参与复读。返回要复读的文本，否则 null。
   * 命中时不走 Gate / handleTool，直接 e.reply 原文，规避 LLM 改写。
   */
  detectGroupRepeat(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    if (smartCfg.repeatJoinEnabled === false) return null

    const text = String(e?.msg || '').trim()
    if (!text) return null
    const maxLen = Number(smartCfg.repeatMaxTextLength) || 30
    if (text.length > maxLen) return null

    const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
    const currentUserId = String(e?.user_id || '')
    const window = Math.max(2, Number(smartCfg.repeatDetectionWindow) || 5)
    const recent = (state.recentMessages || []).slice(-window)
    // 统计窗口内（不含当前消息）发过相同文本的不同用户数
    const distinctUsers = new Set()
    for (const m of recent) {
      if (m.text === text && String(m.userId) !== currentUserId) {
        distinctUsers.add(String(m.userId))
      }
    }
    // 当前用户也算一个独立"复读源"
    if (currentUserId) distinctUsers.add(currentUserId)
    // 排除 bot 自己（理论上不该在 recentMessages 里）
    if (botId) distinctUsers.delete(String(botId))

    const minCount = Math.max(2, Number(smartCfg.repeatMinCount) || 3)
    if (distinctUsers.size < minCount) return null

    // 已确认是复读潮（≥minCount 个不同用户在重复），下面任何失败都打日志方便排查
    const groupId = e?.group_id
    const textPreview = text.length > 20 ? text.slice(0, 20) + '...' : text

    // 冷却：避免同一波内反复跟
    const cooldownMs = Number(smartCfg.repeatJoinCooldownMs) || 180000
    const sinceLast = Date.now() - (state.lastRepeatJoinAt || 0)
    if (sinceLast < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - sinceLast) / 1000)
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但冷却中(剩余${remainSec}s)`)
      return null
    }

    // 通过概率筛选
    const prob = Number(smartCfg.repeatJoinProbability)
    const finalProb = Number.isFinite(prob) ? Math.max(0, Math.min(1, prob)) : 0.6
    if (Math.random() > finalProb) {
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但概率未命中(prob=${finalProb})`)
      return null
    }

    logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 准备参与`)
    return text
  }

  // ==================== smart 模式：Timing Gate 触发 ====================

  /**
   * 判断 bot 是否在该群被禁言（个人禁言或全员禁言）。
   * 兼容两套协议端字段：
   *  - ICQQ：member.shutup_time / group.mute_left / group.info.shutup_time_me / .shutup_time_whole
   *    语义：值 = 剩余禁言秒数（unix 时间戳 - 现在），> 0 即被禁言
   *  - OneBot v11 / Napcat：member.shut_up_timestamp / group.info.group_all_shut 等
   *    语义：shut_up_timestamp 是禁言到期 unix 秒时间戳，需对比当前时间
   * 短期 LRU 缓存（30s）避免每条群消息都发一次 ws RPC；
   * 任何异常都视为"未禁言"，避免误阻塞。
   */
  async isMutedInGroup(e) {
    if (!e?.group_id) return false
    const cached = mutedStatusCache.get(e.group_id)
    if (cached && Date.now() - cached.at < MUTED_CACHE_TTL_MS) return cached.isMuted

    const nowSec = Math.floor(Date.now() / 1000)
    let isMuted = false
    try {
      const grp = e.group
      if (grp) {
        // ICQQ 风格：剩余秒数 / GroupInfo 字段
        if (Number(grp.mute_left) > 0) isMuted = true
        else {
          const gi = grp.info || grp
          if (Number(gi?.shutup_time_whole) > 0) isMuted = true
          else if (Number(gi?.shutup_time_me) > 0) isMuted = true
          // OneBot v11 / Napcat 风格全员禁言字段（不同实现可能用不同名）
          else if (Number(gi?.group_all_shut) > 0) isMuted = true
          else if (Number(gi?.shut_up_timestamp_whole) > nowSec) isMuted = true
        }
      }
      // 个人禁言：拉自己的 member 信息（昂贵的 RPC，仅在群信息没显示已禁言时调）
      if (!isMuted) {
        const selfId = e.self_id || e.bot?.uin || Bot.uin
        const me = await e.group?.pickMember?.(selfId)?.getInfo?.()
        if (me) {
          if (Number(me.shutup_time) > 0) isMuted = true
          else if (Number(me.shut_up_timestamp) > nowSec) isMuted = true
        }
      }
    } catch {}

    mutedStatusCache.set(e.group_id, { isMuted, at: Date.now() })
    return isMuted
  }

  getSmartState(groupId) {
    let state = trackingChatStates.get(groupId)
    if (!state) {
      // 上限保护：超过 100 个群时按 lastMsgAt 淘汰最旧的群（防长期累积内存膨胀）
      if (trackingChatStates.size >= 100) {
        let oldestId = null
        let oldestAt = Infinity
        for (const [gid, st] of trackingChatStates) {
          if (st.lastMsgAt < oldestAt) { oldestAt = st.lastMsgAt; oldestId = gid }
        }
        if (oldestId != null) {
          const old = trackingChatStates.get(oldestId)
          if (old?.waitTimers) for (const t of old.waitTimers.values()) clearTimeout(t)
          if (old?.deferredTimer) clearTimeout(old.deferredTimer)
          trackingChatStates.delete(oldestId)
        }
      }
      state = {
        pendingCount: 0,
        lastMsgAt: Date.now(),
        replyLatencies: [],
        forceContinue: false,
        forceGateCheck: false,
        lastGateNoActionAt: 0,
        inFlight: false,
        needsRerun: false,
        rerunEvent: null,
        queuedWhileInFlight: 0,
        queuedForceGateCheck: false,
        waitTimers: new Map(),
        // 拟人化重构新增字段
        conversationPhase: 'cold',        // 'cold' | 'focus' | 'fading'
        phaseUntil: 0,                    // 当前 phase 自动衰减时间戳
        focusReplyCount: 0,               // 本轮 FOCUS 期 bot 主动回复次数
        consecutiveNoAction: 0,           // FOCUS 期 Gate 连续 no_action 次数
        lastBotReplyAt: 0,                // bot 在该群最近一次发言时间
        lastBotReplyKeywords: [],         // bot 上次发言提取的关键词（给 continuation R2 用）
        recentReplyTimestamps: [],        // bot 在该群的最近回复时间戳列表（速率限制用）
        recentIncomingTimestamps: [],     // 该群最近群消息时间戳（活跃度统计用）
        recentMessages: [],               // 最近群消息 deque {userId, text, at}，复读检测用
        lastRepeatJoinAt: 0,              // bot 最近一次参与复读的时间（防短期反复跟读）
        deferredTimer: null               // 冷群唤醒定时器
      }
      trackingChatStates.set(groupId, state)
    }
    return state
  }

  /**
   * smart 模式触发入口：每条群消息进入此函数，按 talkValue 阈值/空窗补偿/强制覆盖三种条件决定是否调 Timing Gate
   */
  async handleRandomReplySmart(e) {
    const groupId = e.group_id
    const state = this.getSmartState(groupId)
    // 记录该群最新消息时间戳给 applyReplyDebounce 用（仅 smart 模式需要，避免 strict 模式持续累积内存）
    const isSyntheticSmartEvent = e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply
    if (!isSyntheticSmartEvent) {
      lastIncomingMsgAt.set(groupId, Date.now())
      // 活跃度采样移到入口锁外，避免抢锁失败时漏统计（影响 Gate 看到的 5min 消息数）
      state.recentIncomingTimestamps = (state.recentIncomingTimestamps || []).filter(t => t > Date.now() - 300000)
      state.recentIncomingTimestamps.push(Date.now())
      // 复读检测用的最近消息 deque（保留最近 10 条文本）
      const repeatText = (typeof e?.msg === 'string' ? e.msg : '').trim()
      if (repeatText) {
        state.recentMessages = (state.recentMessages || []).slice(-9)
        state.recentMessages.push({ userId: e.user_id, text: repeatText, at: Date.now() })
      }
    }
    // 入口锁：该群已经有一个 handleRandomReplySmart 正在跑（Gate / debounce / handleTool 任一阶段）→ 让步本条
    // 必须在任何 await 之前同步检查并 set，防止 await checkTriggers 期间多个调用并发通过
    if (state.inFlight) {
      state.queuedWhileInFlight = (state.queuedWhileInFlight || 0) + 1
      state.lastMsgAt = Date.now()
      state.needsRerun = true
      if (e?._smartWaitRerun) state.queuedForceGateCheck = true
      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun
      const hasQueuedTrigger = allowDirectTrigger && this.checkTriggers(e)
      const botName = Bot.nickname
      const hasQueuedNameMention = allowDirectTrigger && smartCfg.mentionedNameReply && e.msg &&
        botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())
      if ((hasQueuedTrigger && smartCfg.inevitableAtReply !== false) || hasQueuedNameMention || e?._proactiveReply) {
        state.forceContinue = true
        state.rerunEvent = e
      } else if (!state.forceContinue) {
        state.rerunEvent = e
      }
      return false
    }
    state.inFlight = true
    try {
      // 先记录上一条消息时间用于空窗补偿（要在 lastMsgAt 被本次更新覆盖之前取出）
      const prevLastMsgAt = state.lastMsgAt || Date.now()
      const queuedCount = Math.max(0, Number(state.queuedWhileInFlight) || 0)
      state.queuedWhileInFlight = 0
      const pendingDelta = e?._smartQueuedRerun ? Math.max(1, queuedCount) : 1 + queuedCount
      state.pendingCount += pendingDelta
      state.lastMsgAt = Date.now()

      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun

      if (e?._smartWaitRerun) {
        state.forceContinue = false
        state.forceGateCheck = true
      } else if (e?._smartQueuedGateCheck) {
        state.forceGateCheck = true
      }

      if (allowDirectTrigger && e?._proactiveReply) {
        state.forceContinue = true
      }

      // ─── 本地预筛（仅对真实新消息生效）─────────────────────────
      let prefilter = { kind: 'regular', reason: '' }
      if (!isSyntheticSmartEvent) {
        prefilter = this.prefilterMessage(e, state)
        if (prefilter.kind === 'addressed_other' || prefilter.kind === 'empty_content' || prefilter.kind === 'bot_self_echo') {
          // 回滚刚才计入的 pendingCount（这些消息不应推动触发阈值）
          state.pendingCount = Math.max(0, state.pendingCount - pendingDelta)
          logger.info(`[Prefilter] group=${groupId} skip kind=${prefilter.kind} reason=${prefilter.reason}`)
          // 顺手排个 cold 兜底（如果当前是 cold 状态）
          this.scheduleDeferredGateCheck(e, state)
          return false
        }
        if (prefilter.kind === 'continuation_strong') {
          state.forceGateCheck = true
          logger.info(`[Prefilter] group=${groupId} continuation_strong reason=${prefilter.reason}`)
        }
        // 复读检测：命中且通过概率 → 跳过 Gate 直接复读原文。
        // 但 force 路径（_proactiveReply / @bot / 触发前缀 / 名字提及）必须走正常 LLM 流程，
        // 因为用户明确指名 bot 时只复读一个 "+1" 体验很差。
        const hasForceSignal = state.forceContinue
          || this.checkTriggers(e)
          || (smartCfg.mentionedNameReply && e.msg && Bot.nickname &&
              String(e.msg).toLowerCase().includes(String(Bot.nickname).toLowerCase()))
        if (!hasForceSignal) {
          const repeatText = this.detectGroupRepeat(e, state)
          if (repeatText) {
            return await this.joinRepeat(e, state, repeatText)
          }
        }
      }

      // 强制覆盖：@/触发前缀
      const hasTrigger = await this.checkTriggers(e)
      if (allowDirectTrigger && hasTrigger && smartCfg.inevitableAtReply !== false) {
        state.forceContinue = true
      }
      // 名字提及（非 @）
      if (allowDirectTrigger && !state.forceContinue && smartCfg.mentionedNameReply && e.msg) {
        const botName = Bot.nickname
        if (botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())) {
          state.forceContinue = true
        }
      }

      // ─── 对话焦点状态机：决定本条是否强制走 Gate / 阈值是否减半 ──
      const phase = this.resolveConversationPhase(state)
      if (phase === 'focus') {
        state.forceGateCheck = true
      } else if (phase === 'fading' && smartCfg.fadingForceGate === true) {
        // 用户选择激进策略：FADING 期也强制走 Gate
        state.forceGateCheck = true
      }

      // 冷却检查：no_action 后短时间内不再请求 Gate（强制覆盖可绕过）
      const rawCooldownValue = smartCfg.timingGateCooldownSeconds
      const rawCooldownSeconds = rawCooldownValue === undefined || rawCooldownValue === null || rawCooldownValue === ''
        ? NaN
        : Number(rawCooldownValue)
      const cooldownSeconds = Number.isFinite(rawCooldownSeconds) ? rawCooldownSeconds : 8
      const cooldownMs = Math.max(0, cooldownSeconds) * 1000
      if (!state.forceContinue && !state.forceGateCheck && cooldownMs > 0 && Date.now() - state.lastGateNoActionAt < cooldownMs) {
        return false
      }

      // 阈值判定（fading 期半阈值，仅作用于"非 force"路径）
      const talkValue = this.resolveTalkValue(groupId)
      const rawThreshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
      const threshold = phase === 'fading'
        ? Math.max(1, Math.floor(rawThreshold / 2))
        : rawThreshold
      const reachThreshold = state.pendingCount >= threshold
      const idleHit = this.idleCompensationMet(state, threshold, prevLastMsgAt)
      if (!state.forceContinue && !state.forceGateCheck && !reachThreshold && !idleHit) {
        // 冷群兜底：phase=cold 且未达阈值时排 deferred timer，让 bot 在合适时机自己跑一轮 Gate
        this.scheduleDeferredGateCheck(e, state)
        return false
      }

      let gateResult
      try {
        // 强制继续路径直接放行，跳过 Gate；强制 Gate 路径仍交给 Gate 判断是否补一句
        if (state.forceContinue) {
          gateResult = { decision: 'continue', reason: 'force', __forceContinue: true }
        } else {
          gateResult = await this.runTimingGate(e, state, { phase, prefilter, threshold })
        }
      } catch (err) {
        logger.error(`[TimingGate] 调用失败:`, err)
        gateResult = { decision: 'no_action', reason: 'error' }
      }

      const decision = gateResult?.decision || 'no_action'
      logger.info(`[TimingGate] group=${groupId} decision=${decision} phase=${phase} pending=${state.pendingCount}/${threshold} forceContinue=${state.forceContinue} forceGate=${state.forceGateCheck} reason=${gateResult?.reason || ''}`)

      if (decision === 'continue') {
        const wasForced = gateResult?.__forceContinue === true
        // 速率硬上限（force 路径不受限但仍记录时间戳，保证 rate limit 统计准确）
        if (!wasForced) {
          if (!this.applyRateLimitGuard(state, groupId)) {
            state.pendingCount = 0
            state.forceContinue = false
            state.forceGateCheck = false
            return false
          }
        } else {
          // force 路径直接 push 时间戳，跳过上限检查
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000)
          state.recentReplyTimestamps.push(Date.now())
        }
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.lastGateNoActionAt = 0
        state.consecutiveNoAction = 0
        // 进入 / 续命 FOCUS（非 force 路径计入 focusReplyCount）
        const focusDurationMs = Number(smartCfg.focusDurationMs) || 180000
        const prevPhase = state.conversationPhase
        state.conversationPhase = 'focus'
        state.phaseUntil = Date.now() + focusDurationMs
        // force 路径升回 focus 时视为"新一轮"，重置 focusReplyCount（避免立即又被上限拦截）
        if (wasForced && prevPhase !== 'focus') {
          state.focusReplyCount = 0
        }
        if (!wasForced) {
          state.focusReplyCount = (state.focusReplyCount || 0) + 1
          const maxFocusReplies = Number(smartCfg.focusMaxReplies) || 4
          if (state.focusReplyCount >= maxFocusReplies) {
            // 达上限：本次允许回，但之后立刻降级 FADING 防连刷
            state.conversationPhase = 'fading'
            state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
            logger.info(`[Phase] group=${groupId} focusMaxReplies(${maxFocusReplies}) 达上限，本次回复后降级 fading`)
          }
        }
        // 标记本条为"主动搭话"（非 @/前缀触发），让 sendSegmentedMessage 决定要不要去掉引用
        if (!wasForced) e._proactiveReply = true
        // force 路径（@/名字提及/proactive 等"必回"场景）跳过 debounce 立即回复；其余先 debounce 看有没有新消息
        if (!wasForced && !(await this.applyReplyDebounce(e))) {
          // 让步后回滚 focusReplyCount（这次实际没回复）
          if (!wasForced) state.focusReplyCount = Math.max(0, (state.focusReplyCount || 0) - 1)
          // 同时回滚 rate limit 计数
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).slice(0, -1)
          return false
        }
        return await this.handleTool(e)
      }
      if (decision === 'wait') {
        const sec = Math.max(1, Math.min(60, Number(gateResult.wait_seconds) || 5))
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.consecutiveNoAction = 0   // wait 不是冷漠，清零计数避免跨 wait 累积误降级
        this.scheduleWaitReply(e, sec, 'gate_wait')
        return false
      }
      // no_action
      state.lastGateNoActionAt = Date.now()
      state.pendingCount = 0
      state.forceContinue = false
      state.forceGateCheck = false
      // FOCUS 内累计 no_action，超过 focusMaxNoAction 就降级 FADING
      if (state.conversationPhase === 'focus') {
        state.consecutiveNoAction = (state.consecutiveNoAction || 0) + 1
        const maxNoAction = Number(smartCfg.focusMaxNoAction) || 2
        if (state.consecutiveNoAction >= maxNoAction) {
          state.conversationPhase = 'fading'
          state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
          state.consecutiveNoAction = 0
          logger.info(`[Phase] group=${groupId} Gate 连续 ${maxNoAction} 次 no_action，降级 fading`)
        }
      }
      return false
    } finally {
      state.inFlight = false
      if (state.needsRerun) {
        const rerunEvent = state.rerunEvent || e
        const queuedForceGateCheck = !!state.queuedForceGateCheck
        state.needsRerun = false
        state.rerunEvent = null
        state.queuedForceGateCheck = false
        const wrappedRerun = Object.create(rerunEvent)
        wrappedRerun._smartQueuedRerun = true
        if (queuedForceGateCheck) wrappedRerun._smartQueuedGateCheck = true
        this.handleRandomReplySmart(wrappedRerun).catch(err => logger.error('[TimingGate] 重跑失败:', err))
      }
    }
  }

  /**
   * 调用 Timing Gate 子代理，返回 { decision: 'continue'|'no_action'|'wait', wait_seconds?, reason? }
   * @param ctx 额外上下文：{ phase, prefilter, threshold }
   */
  async runTimingGate(e, state, ctx = {}) {
    const smartCfg = this.config.smartTrigger || {}
    const ctxSize = Math.max(5, Math.min(100, Number(smartCfg.gateContextSize) || 20))
    const botName = Bot.nickname || '机器人'

    let history = ''
    try {
      history = await this.messageManager.formatMessageHistory('group', e.group_id, ctxSize)
    } catch { history = '(无)' }

    // Gate 子代理复用 trackAiConfig（同样是"轻量 LLM 决策回不回话"用途，不再单独配置一份模型）
    const trackCfg = this.config.trackAiConfig
    const useCfg = {
      url: trackCfg?.trackAiUrl,
      model: trackCfg?.trackAiModel || 'gpt-4o-mini',
      apikey: trackCfg?.trackAiApikey
    }
    if (!useCfg.url || !useCfg.apikey || String(useCfg.apikey).startsWith('sk-xxxxx')) {
      return { decision: 'no_action', reason: 'no_api_config' }
    }

    // ─── 多维信号采集 ─────────────────────────────────────
    const phase = ctx.phase || state.conversationPhase || 'cold'
    const prefilterKind = ctx.prefilter?.kind || 'regular'
    const prefilterReason = ctx.prefilter?.reason || ''
    const recentReplyCount = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000).length
    const groupMsgRate5min = this.computeGroupMsgRate5min(state)
    const sinceLastBotReplySec = state.lastBotReplyAt
      ? Math.max(0, Math.floor((Date.now() - state.lastBotReplyAt) / 1000))
      : -1
    const sinceLastMsgSec = state.lastMsgAt
      ? Math.max(0, Math.floor((Date.now() - state.lastMsgAt) / 1000))
      : 0
    const now = new Date()
    const hh = now.getHours()
    const hhmm = `${String(hh).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const isLateNight = hh >= 23 || hh < 6
    // 是否 @ 别人 / 引用 bot
    let addressedToOther = false
    let currentMsgQuotesBot = false
    try {
      const botId = e?.bot?.uin || Bot.uin
      if (Array.isArray(e?.message)) {
        for (const seg of e.message) {
          if (seg?.type === 'at' && String(seg.qq) !== String(botId)) addressedToOther = true
          if (seg?.type === 'reply') {
            // 部分协议端会附带被回复消息的 sender 信息
            const repliedUid = seg?.sender_id || seg?.qq || seg?.user_id
            if (repliedUid && String(repliedUid) === String(botId)) currentMsgQuotesBot = true
          }
        }
      }
    } catch {}
    const triggerReason = e?._deferredReason
      ? 'deferred'
      : (prefilterKind === 'continuation_strong' ? `continuation_strong(${prefilterReason})` : 'regular')

    const promptHintBusyGroupRate = Number(smartCfg.promptHintBusyGroupRate) || 30
    const promptHintRateLimitWarn = Number(smartCfg.promptHintRateLimitWarn) || 5

    const systemPrompt = `你是 QQ 群聊节奏判断助手。机器人名字叫"${botName}"。
当前北京时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
你需要判断 ${botName} 是否应该现在插话、保持沉默、或稍后再说。

**总原则：${botName} 是群里的活跃成员，看到感兴趣/有共鸣/能玩梗的话题就应该自然参与**。
克制 ≠ 沉默。真正该 no_action 的是"明显在打扰别人"或"对话内容跟自己完全无关"。如果话题适合插一句，就 continue。

判断指引：
- continue（积极参与）：被 @/点名；用户向 ${botName} 提问或追问；${botName} 刚发言用户在回应/接续话题；群里有有趣话题/玩梗/吐槽/共鸣的好时机；有人求助且 ${botName} 能帮上；冷场需要破冰；普通聊天但话题 ${botName} 有兴趣
- no_action（明确不该插的才用）：用户之间在明确互相对话（@ 了别人或私聊话题）；同一话题 ${botName} 刚回过应该让别人说；纯水群无意义复读（除非 ${botName} 也想跟）
- wait：${botName} 刚发完一句话用户还没反应；用户句子像是没说完；明显在等下文

时段倾向：深夜（23:00-06:00）更克制，倾向 wait 或 no_action；白天可以活跃。

【信号判断指引】
- 看到"⚠ @ 了别人"信号：除非该消息内容显然是普遍话题（如"大家觉得..."），否则倾向 no_action
- 看到"焦点=focus"且"距 ${botName} 上次发言 < 60s"：用户大概率在接续，强烈倾向 continue
- 看到"最近 10 分钟已回复 ≥${promptHintRateLimitWarn} 次"：除非被点名，倾向 no_action（避免刷屏）
- 看到"群最近 5 分钟消息数 ≥ ${promptHintBusyGroupRate}"：群里在热聊，看话题是否值得插一句；有趣就 continue，跟自己无关就 no_action（**不要因为"热闹"就默认沉默**）
- 看到"触发原因=deferred"：这是定时自检，群里没新消息或 ${botName} 刚开了话头还没人接；只在非常合适时主动补一句，否则 no_action
- 看到"触发原因=continuation_strong"且消息明显在向 ${botName} 提问/反馈：强烈倾向 continue
- 没有明确"不该插"的理由时，按"群里一员的自然反应"判断 —— 普通群友看到话题有兴趣就会接，看到无聊就划走

只返回严格的 JSON，格式：{"decision":"continue|no_action|wait","wait_seconds":3,"reason":"简短理由"}
wait 时 wait_seconds 取 3-15 之间。不要任何其他文字、不要 markdown、不要代码块包装。`

    const specialSignals = []
    if (addressedToOther) specialSignals.push('⚠ 当前消息 @ 了别人，谨慎插话')
    if (currentMsgQuotesBot) specialSignals.push(`✓ 当前消息引用了 ${botName} 的某条消息`)
    const specialSignalsBlock = specialSignals.length ? `\n【特殊信号】\n${specialSignals.join('\n')}\n` : ''

    const userPrompt = `【近期群聊记录】
${history}

【当前消息】
${e.sender?.card || e.sender?.nickname || '用户'}: ${e.msg || ''}

【时间与活跃度】
- 距上一条群消息：${sinceLastMsgSec}s
- 距 ${botName} 上一次发言：${sinceLastBotReplySec >= 0 ? sinceLastBotReplySec + 's' : '长时间未发言'}
- ${botName} 最近 10 分钟在本群已回复：${recentReplyCount} 次
- 群最近 5 分钟消息数：${groupMsgRate5min}
- 当前时段：${hhmm}（${isLateNight ? '深夜' : '日间'}）

【对话状态】
- 当前焦点：${phase}（focus=刚参与话题中；fading=余热；cold=未参与）
- 触发原因：${triggerReason}
${specialSignalsBlock}
请输出 JSON 决策。`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(useCfg.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${useCfg.apikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: useCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3
        }),
        signal: controller.signal
      })
      if (!response.ok) return { decision: 'no_action', reason: `http_${response.status}` }
      const data = await response.json()
      const raw = data?.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { decision: 'no_action', reason: 'no_json' }
      const parsed = JSON.parse(jsonMatch[0])
      const dec = String(parsed.decision || '').toLowerCase()
      if (!['continue', 'no_action', 'wait'].includes(dec)) {
        return { decision: 'no_action', reason: 'invalid_decision' }
      }
      return {
        decision: dec,
        wait_seconds: Number(parsed.wait_seconds) || 5,
        reason: String(parsed.reason || '').slice(0, 80)
      }
    } catch (err) {
      return { decision: 'no_action', reason: `exception:${err.message}` }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 回复 debounce：等待 replyDebounceMs 看群里是否有新消息进来；
   * 有新消息且未到 maxConsecutiveInterrupts 上限 → 让步本轮（return false）；
   * 否则放行（return true）。force 路径应在调用方跳过本检查。
   */
  async applyReplyDebounce(e) {
    const debounceMs = Math.max(0, Number(this.config.smartTrigger?.replyDebounceMs) || 0)
    if (debounceMs <= 0 || !e?.group_id) return true
    const debounceStartAt = Date.now()
    await new Promise(r => setTimeout(r, debounceMs))
    const newestAt = lastIncomingMsgAt.get(e.group_id) || 0
    if (newestAt > debounceStartAt) {
      const max = Math.max(0, Number(this.config.smartTrigger?.maxConsecutiveInterrupts) || 0)
      const cur = (consecutiveInterrupts.get(e.group_id) || 0) + 1
      if (max === 0 || cur <= max) {
        consecutiveInterrupts.set(e.group_id, cur)
        logger.info(`[Debounce] group=${e.group_id} 检测到新消息打断，让步本轮 (${cur}/${max || '∞'})`)
        return false
      }
      logger.info(`[Debounce] group=${e.group_id} 连续打断达上限 ${max} 次，强制走完不让步`)
      consecutiveInterrupts.set(e.group_id, 0)
      return true
    }
    consecutiveInterrupts.set(e.group_id, 0)
    return true
  }

  /**
   * 解析 talkValue：优先用时段化规则，否则用全局 talkValue
   */
  resolveTalkValue(groupId) {
    const s = this.config.smartTrigger || {}
    const fallback = Number(s.talkValue) || 1.0
    if (!s.enableTalkValueRules || !Array.isArray(s.talkValueRules) || s.talkValueRules.length === 0) {
      return fallback
    }
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const rule of s.talkValueRules) {
      const range = String(rule?.range || '').trim()
      const [start, end] = range.split('-').map(x => x?.trim())
      if (!start || !end) continue
      const inRange = (start <= end && hhmm >= start && hhmm <= end) ||
                      (start > end && (hhmm >= start || hhmm <= end))
      if (inRange) {
        const v = Number(rule.value)
        if (Number.isFinite(v) && v > 0) return v
      }
    }
    return fallback
  }

  /**
   * 空窗补偿：冷群按 idle/avg_latency 折算"等效消息数"，凑够阈值就触发
   * @param state - 该群的 SmartState
   * @param threshold - 当前阈值（ceil(1/talkValue)）
   * @param prevLastMsgAt - 上一条消息的时间戳（本次入口前的值，必须由调用方传入，否则 idle=0 永远不命中）
   */
  idleCompensationMet(state, threshold, prevLastMsgAt) {
    const s = this.config.smartTrigger || {}
    if (!s.idleCompensationEnabled) return false
    const avgMs = this.computeAvgReplyLatency(state) || Number(s.avgLatencyDefaultMs) || 60000
    if (avgMs <= 0) return false
    const idleMs = Math.max(0, Date.now() - (prevLastMsgAt || Date.now()))
    return state.pendingCount + idleMs / avgMs >= threshold
  }

  /**
   * 计算最近 10 分钟平均回复延迟（毫秒）
   */
  computeAvgReplyLatency(state) {
    if (!state?.replyLatencies?.length) return 0
    const cutoff = Date.now() - 600000
    state.replyLatencies = state.replyLatencies.filter(item => item.at >= cutoff)
    if (!state.replyLatencies.length) return 0
    const sum = state.replyLatencies.reduce((acc, item) => acc + item.ms, 0)
    return sum / state.replyLatencies.length
  }

  /**
   * 记录一次"用户消息→bot 回复"的延迟，给空窗补偿用。两种模式都调用。
   */
  recordReplyLatency(groupId, latencyMs) {
    if (!groupId || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const state = this.getSmartState(groupId)
    state.replyLatencies.push({ at: Date.now(), ms: latencyMs })
    if (state.replyLatencies.length > 50) state.replyLatencies = state.replyLatencies.slice(-50)
  }

  /**
   * 安排 N 秒后强制再触发一轮 Gate，让 LLM 决定要不要补一句（wait 工具/Gate wait 决策共用）
   */
  scheduleWaitReply(e, seconds, reason) {
    const groupId = e.group_id
    if (!groupId) {
      logger.warn(`[WaitTool] 私聊场景暂不支持自动续话: user=${e.user_id}`)
      return
    }
    const state = this.getSmartState(groupId)
    const userKey = `${groupId}_${e.user_id}`
    const old = state.waitTimers.get(userKey)
    if (old) clearTimeout(old)

    const timer = setTimeout(async () => {
      state.waitTimers.delete(userKey)
      // 触发时再次校验：模式可能已切回 strict、bot 可能已被禁言、群可能已退出白名单
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode !== 'smart') {
        logger.info(`[WaitTool] group=${groupId} 已切出 smart 模式，取消续话`)
        return
      }
      if (!this.checkGroupPermission(e)) {
        logger.info(`[WaitTool] group=${groupId} 不在白名单，取消续话`)
        return
      }
      if (await this.isMutedInGroup(e)) {
        logger.info(`[WaitTool] group=${groupId} 被禁言，取消续话`)
        return
      }
      state.forceContinue = false
      state.forceGateCheck = true
      logger.info(`[WaitTool] group=${groupId} user=${e.user_id} fired after ${seconds}s reason=${reason || ''}`)
      try {
        const wrapped = Object.create(e)
        wrapped._smartWaitRerun = true
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error(`[WaitTool] 续话失败:`, err)
      }
    }, seconds * 1000)
    state.waitTimers.set(userKey, timer)
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

  getTaskStatusCacheKey(groupId, messageId) {
    return `${groupId}:${messageId}`
  }

  getTaskStatusRedisKey(groupId, messageId) {
    return `${this.TASK_STATUS_PREFIX}${groupId}:${messageId}`
  }

  getTaskStatusTtlSeconds() {
    return Math.max(60, Math.floor((this.config.groupChatMemoryDays || 1) * 24 * 60 * 60))
  }

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

  async clearTaskStatus(groupId, messageId) {
    if (!groupId || !messageId) return
    taskStatusCache.delete(this.getTaskStatusCacheKey(groupId, messageId))
    try {
      await redis.del(this.getTaskStatusRedisKey(groupId, messageId))
    } catch (error) {
      logger.warn(`[任务状态] 清理失败：${error.message}`)
    }
  }

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

    // 监听 yaml 配置文件变化，实现真正的热更新
    if (!configWatcher) {
      let reloadTimer = null
      configWatcher = chokidar.watch(configPath).on('change', () => {
        // 防抖：500ms 内多次修改只触发一次
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
          try {
            const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
            const userConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))
            const merged = this.mergeConfig(defaultConfig, userConfig)
            this.config = merged.pluginSettings

            // 刷新各模块配置
            const state = initializeSharedState(this.config)
            this.knowledgeSearcher = state.knowledgeSearcher
            this.MAX_HISTORY = this.config.groupMaxMessages || 100
            this.refreshLocalToolRegistry({ force: true }).catch(error => {
              logger.error(`[bl-chat-plugin][热更新] 重新加载本地工具失败: ${error}`)
              this.initTools()
            })

            logger.mark(`[bl-chat-plugin][热更新] message.yaml 配置已重新加载`)
          } catch (err) {
            logger.error(`[bl-chat-plugin][热更新] 重新加载配置失败: ${err}`)
          }
        }, 500)
      })
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

  mergeConfigPreserveUser(defaults, user) {
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      return user === undefined ? defaults : user
    }
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return defaults
    }

    const merged = {}
    for (const key of Object.keys(defaults)) {
      merged[key] =
        key in user ? this.mergeConfigPreserveUser(defaults[key], user[key]) : defaults[key]
    }
    for (const key of Object.keys(user)) {
      if (!(key in defaults)) {
        merged[key] = user[key]
      }
    }
    return merged
  }

  mergeMCPConfig(defaults, user) {
    const merged = this.mergeConfigPreserveUser(defaults || {}, user || {})

    if (merged.settings && typeof merged.settings === "object") {
      delete merged.settings.legacyAliasEnabled
    }

    if (user?.servers && typeof user.servers === "object" && !Array.isArray(user.servers)) {
      merged.servers = { ...user.servers }
      for (const [serverName, serverConfig] of Object.entries(user.servers)) {
        if (defaults?.servers?.[serverName]) {
          merged.servers[serverName] = this.mergeConfigPreserveUser(
            defaults.servers[serverName],
            serverConfig
          )
        }
      }
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
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
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

          // 提取被引用消息中的转发记录内容
          let forwardContent = ""
          let forwardId = null
          // 情况1: type === "forward" (NapCat/Lagrange 某些版本)
          const forwardSegment = reply.message?.find(m => m.type === "forward")
          if (forwardSegment?.id) {
            forwardId = forwardSegment.id
          }
          // 情况2: type === "json" 且 app === "com.tencent.multimsg"
          if (!forwardId) {
            const jsonSegment = reply.message?.find(m => m.type === "json")
            if (jsonSegment) {
              try {
                const jsonData = typeof jsonSegment.data === "string"
                  ? JSON.parse(jsonSegment.data)
                  : jsonSegment.data
                if (jsonData?.app === "com.tencent.multimsg") {
                  forwardId = jsonData.meta?.detail?.resid
                }
              } catch {}
            }
          }
          if (forwardId && e?.group?.getForwardMsg) {
            try {
              const forwardMsgs = await e.group.getForwardMsg(forwardId)
              if (Array.isArray(forwardMsgs) && forwardMsgs.length > 0) {
                const lines = []
                for (const fMsg of forwardMsgs) {
                  const name = fMsg.sender?.nickname || "未知"
                  const text = fMsg.message
                    ?.filter(m => m.type === "text")
                    .map(m => m.text)
                    .join("")
                    .trim()
                  if (text) lines.push(`${name}: ${text}`)
                }
                if (lines.length > 0) {
                  forwardContent = `[转发记录内容:\n${lines.join("\n")}\n]`
                }
              }
            } catch (err) {
              logger.debug(`[获取转发记录失败] ${err}`)
            }
          }

          const quotedImages = reply.message?.filter(m => m.type === "image") || []
          const hasQuotedImage = quotedImages.length > 0

          // 视频 / 语音 / 文件 segment（之前没处理，导致引用视频时 LLM 看到的描述只是"一条消息"，
          // 看不到视频链接也就没法调 videoAnalysisTool 分析）
          const quotedVideos = reply.message?.filter(m => m.type === "video") || []
          const videoUrls = quotedVideos
            .map(v => v?.url || v?.file_url || v?.data?.url || v?.data?.file_url || v?.file || v?.data?.file)
            .filter(Boolean)
          const hasQuotedVideo = quotedVideos.length > 0

          const quotedRecords = reply.message?.filter(m => m.type === "record") || []
          const recordUrls = quotedRecords
            .map(r => r?.url || r?.file_url || r?.data?.url || r?.data?.file_url || r?.file || r?.data?.file)
            .filter(Boolean)
          const hasQuotedRecord = quotedRecords.length > 0

          const quotedFiles = reply.message?.filter(m => m.type === "file") || []
          const fileNames = quotedFiles
            .map(f => f?.name || f?.data?.name || f?.file || f?.data?.file)
            .filter(Boolean)
          const hasQuotedFile = quotedFiles.length > 0

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

            // 按"存在哪些 segment"拼描述，避免遗漏视频/语音/文件
            const parts = []
            if (quotedMsg) parts.push(`"${quotedMsg}"`)
            if (forwardContent) parts.push(forwardContent)
            if (hasQuotedImage) parts.push(`${quotedImages.length}张图片`)
            if (hasQuotedVideo) {
              const urlText = videoUrls.length ? `(链接: ${videoUrls.join(", ")})` : ""
              parts.push(`一段视频${urlText}`)
            }
            if (hasQuotedRecord) {
              const urlText = recordUrls.length ? `(链接: ${recordUrls.join(", ")})` : ""
              parts.push(`一段语音${urlText}`)
            }
            if (hasQuotedFile) {
              const fileText = fileNames.length ? `(文件名: ${fileNames.join(", ")})` : ""
              parts.push(`一个文件${fileText}`)
            }
            const quotedDescription = parts.length > 0 ? parts.join("，以及") : "一条消息"

            quoteContent = `引用了 ${quotedSenderInfo}${quotedMessageId} 的消息: ${quotedDescription}，`
          }
        }
      } catch (error) {
        console.error("获取引用消息失败:", error)
      }
    }

    const content = []
    if (msg) {
      let fullMsg = msg
      if (e?.message && group && atQq.length > 0) {
        try {
          const memberMap = await group.getMemberMap()
          fullMsg = e.message.map(m => {
            if (m.type === 'text') return m.text
            if (m.type === 'at' && String(m.qq) !== String(Bot.uin)) {
              const info = memberMap.get(Number(m.qq))
              return `@${info?.card || info?.nickname || m.qq}`
            }
            return ''
          }).join('').replace(/^#tool\s*/, '').trim()
        } catch {}
      }
      content.push(`在群里说: ${fullMsg}`)
    }
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

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(userMessage, chatHistory = []) {
    try {
      const botName = Bot.nickname || '机器人'

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
      const botName = Bot.nickname || '机器人'

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

    // 禁言检测：bot 在该群被禁言（个人/全员）时不触发任何回复，避免发送失败 + 表情/red 包等也无意义
    if (await this.isMutedInGroup(e)) return false

    // 静默收集消息用于表达学习（不管是否触发AI对话）
    if (this.config.expressionLearning?.enabled && e.msg) {
      this.expressionLearner.updateGroupExpressions(e.group_id, e.msg).catch(() => {})
    }

    // 检测红包消息并随机触发抢红包（两种模式都生效）
    const walletSeg = e.message?.find(m => m.type == 'wallet')
    if (walletSeg && RED_BAG_CONFIG.enabled && toolConfigHasName(this.config.oneapi_tools, 'grabRedBagTool')) {
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
      const senderRole = roleMap[e.sender?.role] || roleMap[memberInfo?.role] || "member"

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
        ? await limit(() => this.memoryManager.getMemoryPromptForUser(groupId, userId, e.msg || ""))
        : ''
      const groupMemoryPrompt = this.config.memorySystem?.enabled && groupId
        ? await limit(() => this.memoryManager.getGroupMemoryPrompt(groupId, e.msg || ""))
        : ''
      const expressionPrompt = this.config.expressionLearning?.enabled
        ? await limit(() => this.expressionLearner.getExpressionPromptForGroup(groupId))
        : ''

      // 知识库检索
      let knowledgePrompt = ''
      if (this.knowledgeSearcher && e.msg) {
        try {
          const result = await limit(() => this.knowledgeSearcher.search(e.msg))
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
          personProfilePrompt = await limit(() => personProfileInjector.build(groupId, userId, e))
        } catch (err) {
          logger.error(`[画像注入] 失败: ${err.message}`)
        }
      }

      // 构建增强系统提示
      const groupContext = await limit(() => this.getCurrentGroupContext(e))
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
          administrators: await limit(() => getHighLevelMembers(e.group))
        },
        environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
      }, null, 2)}
2.【消息格式】
[YYYY-MM-DD HH:MM:SS] 昵称(QQ号: xxx)[群身份: xxx]: 在群里说: {message}
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
❌ 错误: "[2025-12-24 12:42:25] 哈基米(QQ号: 3012184357)[群身份: admin]: 在群里说: 想听啥？"
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
        await this.processToolCalls(message, e, session, session.groupUserMessages, atQq, senderRole, limit)
      } else if (message.content) {
        await this.handleTextResponse(message.content, e, session, session.groupUserMessages, limit)
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

  async runToolCall(toolCall, e, session, senderRole, limit) {
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
        ? await this.executeTool(toolName, params, e, limit)
        : await this.executeTool(this.toolInstances[toolName], params, e, limit)
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

  async processToolCalls(message, e, session, groupUserMessages, atQq, senderRole, limit) {
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
        toolCalls.map(toolCall => this.runToolCall(toolCall, e, session, senderRole, limit))
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
      const nextResponse = await this.retryRequest(limit, nextRequest, session.toolContent, 1, session.toolName)
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
          limit,
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

  async executeTool(tool, params, e, limit, isRetry = false) {
    try {
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        return await limit(() => mcpManager.executeToolByAlias(tool, params))
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
      ? await this.sendFinalReplyAsTextImage(e, output, limit)
      : await limit(() => this.sendSegmentedMessage(e, output))

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
        const botMsg = `${this.formatTime()} ${Bot.nickname}(QQ号:${Bot.uin})[群身份: member]: 在群里说: ${output.substring(0, 200)}`
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
        message: [{ type: "text", text: output }],
        source: "send",
        self_id: Bot.uin,
        sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      }))
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
    await limit(() => this.saveGroupUserMessages(e.group_id, e.user_id, messages))

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

  async sendSegmentedMessage(e, output, quoteChance = 0.5) {
    try {
      output = sanitizeFinalReplyText(output)
      if (!output) return null
      // smart 模式：发完话后记录 bot 上次发言时间和关键词，给 prefilter R1/R2 识别接续用
      const groupId = e?.group_id
      const triggerMode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (groupId && triggerMode === 'smart') {
        try {
          const st = this.getSmartState(groupId)
          st.lastBotReplyAt = Date.now()
          const maxKw = Number(this.config?.smartTrigger?.continuationKeywordMaxCount) || 5
          st.lastBotReplyKeywords = extractChatKeywords(output, maxKw)
        } catch (err) {
          logger.warn(`[SmartState] 记录 bot 发言失败：${err.message}`)
        }
      }
      // 主动搭话路径（smart 模式 Gate 非 force 触发）强制不引用：bot 像群友自然插话而非"回复某人"
      if (e?._proactiveReply && this.config?.smartTrigger?.proactiveReplyNoQuote !== false) {
        quoteChance = 0
      }
      const shouldQuote = Math.random() < quoteChance
      const { hasAt, msgSegments } = await this.convertAtInString(output, e.group)

      // 有真艾特时直接发送消息段数组（@ 保持在原始位置）
      if (hasAt && msgSegments) {
        const res = await e.reply(msgSegments)
        return res?.message_id
      }

      const { total_tokens } = await TotalTokens(output)
      let lastMessageId = null

      // 含 \n 的消息一律走拆分（LLM 显式用换行表达"打两条"的意图），即使 token 数很小也要拆
      const hasNewline = output.includes("\n")
      if (total_tokens <= 10 && !hasNewline) {
        const res = await e.reply(output, shouldQuote)
        lastMessageId = res?.message_id
        return lastMessageId
      }

      const segments = this.splitMessage(output)
      for (let i = 0; i < segments.length; i++) {
        if (segments[i]?.trim()) {
          const quote = shouldQuote && i === 0
          const res = await e.reply(segments[i].trim(), quote)
          lastMessageId = res?.message_id

          if (i < segments.length - 1) {
            const typingSpeed = Number(this.config?.smartTrigger?.typingSpeed) || 0
            let delay
            if (typingSpeed > 0) {
              // typingSpeed 模式：按"字符/秒"计算每段间隔，加 0-300ms 随机抖动
              delay = Math.min(Math.max(segments[i].length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
            } else {
              // 默认公式：固定起步 1s + 字符延展 + 抖动，上限 3s
              delay = Math.min(1000 + segments[i].length * 5 + Math.random() * 500, 3000)
            }
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
      const ch = processed[i]
      if (ch === '\n') {
        // \n 是 LLM 显式的"换行/分段"意图，无视长度阈值无条件切（避免 16 字以下被 idealLen*0.7 卡住不分）
        if (i + 1 > last) {
          points.push(i + 1)
          last = i + 1
        }
      } else if (punctuations.includes(ch) && i - last + 1 >= idealLen * 0.7) {
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
    if (!group) return { result: content, hasAt: false, msgSegments: null }

    const members = await group.getMemberMap()
    const atList = []

    // 匹配 @QQ号 格式（5-11位纯数字）
    for (const match of content.matchAll(/@(\d{5,11})(?!\d)/g)) {
      const member = this.findMember(match[1], members)
      if (member) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    // 匹配 @昵称 格式（非数字开头，取到标点或空白为止）
    for (const match of content.matchAll(/@([^\s\d@，。！？、；：""''（）【】,.!?;:'"()\[\]]{1,20})/g)) {
      const member = this.findMember(match[1], members)
      if (member && !atList.some(a => a.qq === member.qq)) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    if (atList.length === 0) return { result: content, hasAt: false, msgSegments: null }

    // 按位置排序，构建消息段数组（@ 保持在原始位置）
    atList.sort((a, b) => a.index - b.index)
    const msgSegments = []
    let lastEnd = 0
    for (const at of atList) {
      if (at.index > lastEnd) {
        msgSegments.push(content.slice(lastEnd, at.index))
      }
      msgSegments.push(segment.at(at.qq))
      lastEnd = at.index + at.length
    }
    if (lastEnd < content.length) {
      msgSegments.push(content.slice(lastEnd))
    }

    return { result: content, hasAt: true, msgSegments }
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
    let output = sanitizeFinalReplyText(content.replace(/\n/g, "\n"))

    // 过滤消息记录格式（多行全局匹配）
    // 匹配如: "[2026-01-27 16:12:51] 哈基米(QQ号: 2127498644)[群身份: member]: 以后注意点。"
    // 或: "[01-27 16:12:51] 哈基米(QQ号: xxx)[群身份: xxx]: 在群里说: xxx"（旧历史数据格式）
    // 或: "[16:11:11] 哈基米(QQ号: xxx)[群身份: xxx]: 在群里说: xxx"
    // 或: "[YYYY-MM-DD HH:MM:SS] 迈(QQ号: xxx)[群身份: xxx]: xxx"（AI输出的模板格式）
    output = output.replace(/\[(?:[A-Z]{4}-[A-Z]{2}-[A-Z]{2}\s+[A-Z]{2}:[A-Z]{2}:[A-Z]{2}|[A-Z]{2}-[A-Z]{2}\s+[A-Z]{2}:[A-Z]{2}:[A-Z]{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})\]\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\][:：]\s*(?:艾特了\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\])?\s*(?:在群里说[:：]\s*)?[^\n]*/gi, '')

    // 清理模式
    const patterns = [
      /$$图片$$/g,
      /[\s\S]在群里说[:：]\s/g,
      /\[(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\]\s*.?[:：]\s/g,
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
    return sanitizeFinalReplyText(output)
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
   * 清除当前群的所有记忆（群记忆 + 用户记忆）
   */
  async clearGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用此命令")
      return true
    }

    try {
      const prefix = this.memoryManager.REDIS_PREFIX
      const groupId = e.group_id
      // 群全局记忆
      const groupKey = this.memoryManager.getGroupRedisKey(groupId)
      // 该群下所有用户记忆 ytbot:memory:{groupId}:*
      const userKeys = await this.scanRedisKeys(`${prefix}${groupId}:*`)

      const allKeys = [groupKey, ...userKeys]
      if (allKeys.length) {
        await this.deleteRedisKeys(allKeys)
      }
      await e.reply(`已清除本群记忆（群共识 + ${userKeys.length} 条用户记忆）`)
    } catch (error) {
      logger.error("[群记忆] 清除失败:", error)
      await e.reply("清除失败，请查看日志")
    }
    return true
  }

  /**
   * 重载MCP配置（管理员命令）
   */
  isGroupMemoryAdmin(e) {
    return Boolean(e.isMaster || ["owner", "admin"].includes(e.sender?.role))
  }

  formatMemoryTime(timestamp) {
    if (!timestamp) return "无"
    return new Date(timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  }

  formatMemoryFactLines(facts = []) {
    return facts.map(fact => {
      const shortId = String(fact.id).slice(0, 8)
      const score = Number(fact.score ?? fact.importance ?? 0).toFixed(2)
      return `ID:${shortId} [${fact.category}] ${fact.content} (${score})`
    })
  }

  formatMemoryFacts(title, facts = []) {
    if (!facts.length) return `${title}\n暂无记忆`
    const lines = this.formatMemoryFactLines(facts)
    return `${title}\n${lines.join("\n")}\n\n删除单条记忆可发送：#删除记忆 <ID>`.slice(0, 4500)
  }

  async replyMemoryForward(e, title, sections = []) {
    const msgs = []
    for (const section of sections) {
      const facts = section.facts || []
      if (!facts.length) {
        msgs.push(`${section.title}\n暂无记忆`)
        continue
      }

      const lines = this.formatMemoryFactLines(facts)
      for (let i = 0; i < lines.length; i += 12) {
        const page = Math.floor(i / 12) + 1
        const total = Math.ceil(lines.length / 12)
        const header = total > 1 ? `${section.title} (${page}/${total})` : section.title
        msgs.push(`${header}\n${lines.slice(i, i + 12).join("\n")}`)
      }
    }

    msgs.push("删除单条记忆可发送：#删除记忆 <ID>")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await e.reply(forwardMsg)
    } catch (error) {
      logger.warn("[记忆管理] 转发消息发送失败，回退为普通文本:", error)
      await e.reply(msgs.join("\n\n").slice(0, 4500))
    }
  }

  async replyLongForward(e, title, text, pageSize = 3000) {
    const content = String(text || "")
    const msgs = []
    for (let i = 0; i < content.length; i += pageSize) {
      msgs.push(content.slice(i, i + pageSize))
    }
    if (!msgs.length) msgs.push("暂无内容")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await e.reply(forwardMsg)
    } catch (error) {
      logger.warn("[消息发送] 转发消息发送失败，回退为普通文本:", error)
      await e.reply(content.slice(0, 4500) || "暂无内容")
    }
  }

  async memoryStatus(e) {
    try {
      const status = await this.memoryManager.adminStatus({
        groupId: e.group_id,
        userId: e.user_id
      })
      const lines = [
        `记忆系统：${status.enabled ? "开启" : "关闭"}`,
        `用户记忆：${status.user?.disabled ? "已禁用" : "启用"}，${status.user?.factCount || 0} 条，关系分 ${Number(status.user?.relationshipScore ?? 0.5).toFixed(2)}`,
        `群记忆：${status.group?.disabled ? "已禁用" : "启用"}，${status.group?.factCount || 0} 条`,
        `用户上次抽取：${this.formatMemoryTime(status.user?.lastAttemptAt)}`,
        `群上次抽取：${this.formatMemoryTime(status.group?.lastAttemptAt)}`,
        `阈值：${status.config.importanceThreshold}，语义召回：${status.config.semanticRecallEnabled ? "开启" : "关闭"}`
      ]
      await e.reply(lines.join("\n"))
    } catch (error) {
      logger.error("[记忆管理] 读取记忆状态失败:", error)
      await e.reply("记忆状态读取失败，请看日志")
    }
    return true
  }

  async listMyMemory(e) {
    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "我的记忆", [
        { title: "我的记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取我的记忆失败:", error)
      await e.reply("读取我的记忆失败，请看日志")
    }
    return true
  }

  async listGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }

    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "group",
        groupId: e.group_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "群记忆", [
        { title: "群记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取群记忆失败:", error)
      await e.reply("读取群记忆失败，请看日志")
    }
    return true
  }

  async searchMemory(e) {
    const query = String(e.msg || "").replace(/^#搜索记忆\s+/, "").trim()
    if (!query) {
      await e.reply("请输入要搜索的关键词")
      return true
    }

    try {
      const myResult = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        query,
        limit: 10
      })
      const groupResult = e.group_id
        ? await this.memoryManager.adminListMemories({
            scope: "group",
            groupId: e.group_id,
            query,
            limit: 10
          })
        : { facts: [] }
      await this.replyMemoryForward(e, "搜索记忆", [
        { title: "我的匹配记忆", facts: myResult.facts },
        { title: "群匹配记忆", facts: groupResult.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 搜索记忆失败:", error)
      await e.reply("搜索记忆失败，请看日志")
    }
    return true
  }

  async deleteMemory(e) {
    const id = String(e.msg || "").replace(/^#删除记忆\s+/, "").trim()
    if (!id) {
      await e.reply("请输入要删除的记忆 id")
      return true
    }

    try {
      let result = await this.memoryManager.adminDeleteMemory({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        id
      })

      if (!result.deleted && this.isGroupMemoryAdmin(e)) {
        result = await this.memoryManager.adminDeleteMemory({
          scope: "group",
          groupId: e.group_id,
          id
        })
      }

      await e.reply(result.deleted ? `已删除记忆 ${id}` : "没有找到可删除的记忆，普通用户只能删除自己的记忆")
    } catch (error) {
      logger.error("[记忆管理] 删除记忆失败:", error)
      await e.reply("删除记忆失败，请看日志")
    }
    return true
  }

  async clearMyMemory(e) {
    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id
      })
      await e.reply(`已清空我的记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空我的记忆失败:", error)
      await e.reply("清空我的记忆失败，请看日志")
    }
    return true
  }

  async clearGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }
    if (!this.isGroupMemoryAdmin(e)) {
      await e.reply("只有群主、管理员或主人可以清空群记忆")
      return true
    }

    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "group",
        groupId: e.group_id
      })
      await e.reply(`已清空本群群记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空群记忆失败:", error)
      await e.reply("清空群记忆失败，请看日志")
    }
    return true
  }

  async disableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: false
      })
      await e.reply("已禁用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 禁用我的记忆失败:", error)
      await e.reply("禁用失败，请看日志")
    }
    return true
  }

  async enableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: true
      })
      await e.reply("已启用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 启用我的记忆失败:", error)
      await e.reply("启用失败，请看日志")
    }
    return true
  }

  async reloadMCP(e) {
    if (!e.isMaster) {
      await e.reply("只有主人才能执行此操作")
      return true
    }

    await e.reply("正在重载MCP配置...")

    try {
      await mcpManager.disconnectAll()
      mcpInitPromise = this.initMCP()
      await mcpInitPromise

      const toolCount = mcpManager.aliases?.size || mcpManager.tools?.size || 0
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
    const text = mcpManager.getToolsListText()
    await this.replyLongForward(e, "MCP工具列表", text)
    return true
  }

  async mcpStatus(e) {
    await this.replyLongForward(e, "MCP状态", mcpManager.getStatusSummary())
    return true
  }

  async testMCPTool(e) {
    if (!e.isMaster) {
      await e.reply("只有主人才能执行此操作")
      return true
    }

    const input = String(e.msg || "").replace(/^#mcp\s+测试\s+/, "").trim()
    const spaceIndex = input.indexOf(" ")
    const alias = spaceIndex === -1 ? input : input.slice(0, spaceIndex)
    const rawParams = spaceIndex === -1 ? "{}" : input.slice(spaceIndex + 1).trim()

    if (!alias) {
      await e.reply("请输入要测试的 MCP 工具名，例如：#mcp 测试 mcp_server_search {\"query\":\"你好\"}")
      return true
    }

    let params = {}
    try {
      params = rawParams ? JSON.parse(rawParams) : {}
    } catch (error) {
      await e.reply(`JSON 参数解析失败：${error.message}`)
      return true
    }

    try {
      const result = await mcpManager.executeToolByAlias(alias, params)
      await this.replyLongForward(e, `MCP测试 ${alias}`, result)
    } catch (error) {
      logger.error(`[MCP] 测试工具 ${alias} 失败:`, error)
      await e.reply(`MCP工具测试失败：${error.message}`)
    }
    return true
  }
}
