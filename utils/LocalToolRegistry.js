import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { JinyanTool } from "../functions/functions_tools/JinyanTool.js"
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
import { ReminderTool } from "../functions/functions_tools/ReminderTool.js"
import { TextImageTool } from "../functions/functions_tools/TextImageTool.js"
import { SendLocalEmojiTool } from "../functions/functions_tools/SendLocalEmojiTool.js"
import { WaitTool } from "../functions/functions_tools/WaitTool.js"

const PLUGIN_NAME = "bl-chat-plugin"
const CUSTOM_TOOL_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const DEFAULT_RELOAD_INTERVAL_MS = 5000

const BUILT_IN_TOOL_FACTORIES = [
  () => new JinyanTool(),
  () => new SearchInformationTool(),
  () => new SearchVideoTool(),
  () => new SearchMusicTool(),
  () => new EmojiSearchTool(),
  () => new BingImageSearchTool(),
  () => new GoogleImageAnalysisTool(),
  () => new ChatHistoryTool(),
  () => new PokeTool(),
  () => new LikeTool(),
  () => new AiMindMapTool(),
  () => new WebParserTool(),
  () => new GoogleImageEditTool(),
  () => new GitHubRepoTool(),
  () => new VideoAnalysisTool(),
  () => new QQZoneTool(),
  () => new ChangeCardTool(),
  () => new VoiceTool(),
  () => new BananaTool(),
  () => new ReactionTool(),
  () => new MemberInfoTool(),
  () => new RecallTool(),
  () => new GrabRedBagTool(),
  () => new ReminderTool(),
  () => new TextImageTool(),
  () => new SendLocalEmojiTool(),
  () => new WaitTool()
]

function logInfo(message) {
  globalThis.logger?.info?.(`[LocalToolRegistry] ${message}`)
}

function logWarn(message) {
  globalThis.logger?.warn?.(`[LocalToolRegistry] ${message}`)
}

function logError(message, error) {
  if (error) globalThis.logger?.error?.(`[LocalToolRegistry] ${message}`, error)
  else globalThis.logger?.error?.(`[LocalToolRegistry] ${message}`)
}

export class LocalToolRegistry {
  constructor(options = {}) {
    this.pluginRoot = options.pluginRoot || path.join(process.cwd(), "plugins", PLUGIN_NAME)
    this.customToolsDir = options.customToolsDir || path.join(this.pluginRoot, "custom_tools")
    this.builtInToolInstances = this.createBuiltInToolInstances()
    this.builtInToolNames = new Set(Object.keys(this.builtInToolInstances))
    this.toolInstances = { ...this.builtInToolInstances }
    this.functions = this.buildFunctions(this.toolInstances)
    this.functionMap = new Map(this.functions.map(func => [func.name, func]))
    this.reloadPromise = null
    this.lastCustomToolCount = 0
    this.lastReloadAt = 0
    this.reloadIntervalMs = options.reloadIntervalMs ?? DEFAULT_RELOAD_INTERVAL_MS
  }

  getSnapshot() {
    return {
      toolInstances: { ...this.toolInstances },
      functions: [...this.functions],
      functionMap: new Map(this.functionMap),
      builtInToolCount: this.builtInToolNames.size,
      customToolCount: this.lastCustomToolCount
    }
  }

  async reload(options = {}) {
    if (!options.force && Date.now() - this.lastReloadAt < this.reloadIntervalMs) {
      return this.getSnapshot()
    }

    if (this.reloadPromise) return this.reloadPromise

    this.reloadPromise = this.reloadInternal()
      .catch(error => {
        logError("重新加载失败，保留上一份工具注册表", error)
        return this.getSnapshot()
      })
      .finally(() => {
        this.reloadPromise = null
      })

    return this.reloadPromise
  }

  async reloadInternal() {
    const toolInstances = { ...this.builtInToolInstances }
    const customTools = await this.loadCustomTools(toolInstances)

    this.toolInstances = toolInstances
    this.functions = this.buildFunctions(this.toolInstances)
    this.functionMap = new Map(this.functions.map(func => [func.name, func]))
    this.lastCustomToolCount = customTools.length
    this.lastReloadAt = Date.now()

    // logInfo(`已加载 ${this.builtInToolNames.size} 个内置工具，${customTools.length} 个自定义工具`)
    return this.getSnapshot()
  }

  createBuiltInToolInstances() {
    const instances = {}

    for (const factory of BUILT_IN_TOOL_FACTORIES) {
      try {
        const tool = factory()
        const validationError = this.validateTool(tool)
        if (validationError) {
          logWarn(`跳过无效的内置工具：${validationError}`)
          continue
        }
        if (instances[tool.name]) {
          logWarn(`跳过重复的内置工具：${tool.name}`)
          continue
        }
        instances[tool.name] = tool
      } catch (error) {
        logError("创建内置工具失败", error)
      }
    }

    return instances
  }

  async loadCustomTools(toolInstances) {
    await fs.promises.mkdir(this.customToolsDir, { recursive: true }).catch(() => {})
    const files = await this.scanCustomToolFiles(this.customToolsDir)
    const loaded = []

    for (const filePath of files) {
      try {
        const stat = await fs.promises.stat(filePath)
        const moduleUrl = `${pathToFileURL(filePath).href}?mtime=${stat.mtimeMs}`
        const moduleExports = await import(moduleUrl)
        const candidates = this.getExportCandidates(moduleExports)

        if (!candidates.length) {
          const exportNames = Object.keys(moduleExports || {}).join(", ") || "空"
          logWarn(`跳过 ${this.relativePath(filePath)}：未找到可用的工具导出，实际导出项：${exportNames}`)
          continue
        }

        let fileLoaded = 0
        for (const candidate of candidates) {
          let tool = null
          try {
            tool = this.instantiateCandidate(candidate)
          } catch (error) {
            logWarn(`跳过 ${this.relativePath(filePath)} 的导出项：${error.message}`)
            continue
          }

          const validationError = this.validateTool(tool)
          if (validationError) {
            logWarn(`跳过 ${this.relativePath(filePath)}：${validationError}`)
            continue
          }
          if (this.builtInToolNames.has(tool.name)) {
            logWarn(`跳过自定义工具 "${tool.name}"（${this.relativePath(filePath)}）：与内置工具同名`)
            continue
          }
          if (toolInstances[tool.name]) {
            logWarn(`跳过自定义工具 "${tool.name}"（${this.relativePath(filePath)}）：工具名重复`)
            continue
          }

          toolInstances[tool.name] = tool
          loaded.push(tool)
          fileLoaded++
        }

        if (!fileLoaded) {
          logWarn(`跳过 ${this.relativePath(filePath)}：没有有效的工具导出`)
        }
      } catch (error) {
        logError(`加载自定义工具文件 ${this.relativePath(filePath)} 失败`, error)
      }
    }

    return loaded
  }

  async scanCustomToolFiles(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = []

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await this.scanCustomToolFiles(entryPath))
        continue
      }

      if (!entry.isFile()) continue
      if (entry.name.endsWith(".example")) continue
      if (!CUSTOM_TOOL_EXTENSIONS.has(path.extname(entry.name))) continue
      files.push(entryPath)
    }

    return files.sort()
  }

  getExportCandidates(moduleExports) {
    const seen = new Set()
    const candidates = []
    const addCandidate = value => {
      if (!value || seen.has(value)) return
      seen.add(value)
      candidates.push(value)
    }

    for (const value of [moduleExports?.default, ...Object.values(moduleExports || {})]) {
      addCandidate(value)

      if (this.isPlainExportContainer(value)) {
        for (const nestedValue of Object.values(value)) {
          addCandidate(nestedValue)
        }
      }
    }

    return candidates
  }

  isPlainExportContainer(value) {
    if (!value || typeof value !== "object") return false
    if (typeof value.execute === "function" || typeof value.func === "function") return false
    if (value.name && value.description && value.parameters) return false
    return Object.getPrototypeOf(value) === Object.prototype
  }

  instantiateCandidate(candidate) {
    if (typeof candidate === "function") {
      return new candidate()
    }
    return candidate
  }

  validateTool(tool) {
    if (!tool || typeof tool !== "object") return "导出内容不是工具对象或工具类"
    if (!tool.name || typeof tool.name !== "string") return "缺少 tool.name"
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      return `tool.name "${tool.name}" 不合法，只能使用字母、数字、_ 或 -`
    }
    if (!tool.description || typeof tool.description !== "string") return `工具 "${tool.name}" 缺少 description`
    if (!tool.parameters || typeof tool.parameters !== "object") return `工具 "${tool.name}" 缺少 parameters schema`
    if (tool.parameters.type !== "object") return `工具 "${tool.name}" 的 parameters.type 必须是 object`
    if (!tool.parameters.properties || typeof tool.parameters.properties !== "object") {
      return `工具 "${tool.name}" 的 parameters.properties 必须是对象`
    }
    if (tool.parameters.required && !Array.isArray(tool.parameters.required)) {
      return `工具 "${tool.name}" 的 parameters.required 必须是数组`
    }
    if (typeof tool.execute !== "function") return `工具 "${tool.name}" 缺少 execute(params, event)`

    return null
  }

  buildFunctions(toolInstances) {
    const functions = []

    for (const tool of Object.values(toolInstances)) {
      try {
        const info = typeof tool.getToolInfo === "function"
          ? tool.getToolInfo()
          : {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            }

        functions.push({
          name: info.name,
          description: info.description,
          parameters: info.parameters
        })
      } catch (error) {
        logError(`构建工具 ${tool?.name || "未知"} 的 schema 失败`, error)
      }
    }

    return functions
  }

  relativePath(filePath) {
    return path.relative(this.pluginRoot, filePath).replaceAll("\\", "/")
  }
}

export const localToolRegistry = new LocalToolRegistry()
