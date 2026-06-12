import { EmotionManager } from "../utils/EmotionManager.js"
import { MemoryManager } from "../utils/MemoryManager.js"
import { ExpressionLearner } from "../utils/ExpressionLearner.js"
import KnowledgeSearcher from "../functions/KnowledgeSearcher.js"
import KnowledgeExpander from "../functions/KnowledgeExpander.js"
import { MessageManager } from "../utils/MessageManager.js"
import { localToolRegistry } from "../utils/LocalToolRegistry.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { toolConfigHasName } from "./toolConfig.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import schedule from 'node-schedule'

const _path = process.cwd()

// 全局共享状态单例：messageManager / emotionManager / memoryManager /
// expressionLearner / knowledgeSearcher / 工具注册表快照 / sessionMap。
// 所有子系统挂在 sharedState 上，避免热更和多次加载时重复构建。
let sharedState = null

export function getSharedState() {
  return sharedState
}

export function applyToolRegistrySnapshot(state, snapshot = localToolRegistry.getSnapshot()) {
  state.toolInstances = snapshot.toolInstances
  state.functions = snapshot.functions
  state.functionMap = snapshot.functionMap
  state.customToolCount = snapshot.customToolCount || 0
  state.builtInToolCount = snapshot.builtInToolCount || 0
  return state
}

export async function refreshLocalTools(state, options = {}) {
  const snapshot = await localToolRegistry.reload(options)
  return applyToolRegistrySnapshot(state, snapshot)
}

export function buildMemoryConfig(config) {
  const memorySystem = config.memorySystem || {}
  return {
    ...memorySystem,
    memoryAiConfig: config.memoryAiConfig || null,
    embeddingAiConfig: config.embeddingAiConfig || null,
    groupExtractMinIntervalMinutes:
      memorySystem.groupExtractMinIntervalMinutes ?? memorySystem.groupExtractMinInterval ?? 10
  }
}

export function initializeSharedState(config) {
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
