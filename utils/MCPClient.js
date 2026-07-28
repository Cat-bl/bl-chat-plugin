// utils/MCPClient.js
import { createHash } from "crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { schemaMethods } from "./mcp/schemaMethods.js"
import { transportMethods } from "./mcp/transportMethods.js"
import { inspectionMethods } from "./mcp/inspectionMethods.js"

const DEFAULT_SETTINGS = {
  connectTimeoutMs: 30000,
  toolCallTimeoutMs: 60000,
  toolResultMaxChars: 8000,
  autoReconnect: true,
  reconnectMaxAttempts: 3
}

function withTimeout(promise, timeoutMs, errorMessage) {
  if (!timeoutMs || timeoutMs <= 0) return promise

  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    })
  ])
}

function stableStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export class MCPClientManager {
  constructor() {
    this.clients = new Map()
    this.tools = new Map()
    this.aliases = new Map()
    this.serverConfigs = new Map()
    this.settings = { ...DEFAULT_SETTINGS }
    this.onToolsChanged = null
    this.reconnectTimers = new Map()
    this.reconnectAttempts = new Map()
    this.reloadToken = 0
  }

  configure(settings = {}) {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settings || {})
    }
  }

  setToolsChangedCallback(callback) {
    this.onToolsChanged = typeof callback === "function" ? callback : null
  }

  notifyToolsChanged() {
    if (this.onToolsChanged) {
      try {
        this.onToolsChanged(this.getAllTools())
      } catch (error) {
        logger.error("[MCP] 刷新会话工具列表失败:", error)
      }
    }
  }

  sanitizeName(name, fallback = "tool") {
    const sanitized = String(name || fallback)
      .trim()
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")

    const safe = sanitized || fallback
    return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`
  }

  shortHash(value) {
    return createHash("sha1").update(String(value)).digest("hex").slice(0, 8)
  }

  buildAlias(serverName, toolName) {
    const base = `mcp_${this.sanitizeName(serverName, "server")}_${this.sanitizeName(toolName, "tool")}`
    if (base.length <= 64) return base

    const hash = this.shortHash(`${serverName}:${toolName}`)
    return `${base.slice(0, 55)}_${hash}`
  }

  normalizeTransportType(type) {
    const value = String(type || "stdio").toLowerCase()
    if (value === "streamable-http") return "http"
    return value
  }

  normalizeList(value) {
    if (!value) return []
    if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean)
    return [String(value)].filter(Boolean)
  }

  isToolAllowed(config, toolName) {
    const includeTools = this.normalizeList(config.includeTools)
    const excludeTools = this.normalizeList(config.excludeTools)

    if (includeTools.length && !includeTools.includes(toolName)) return false
    if (excludeTools.includes(toolName)) return false
    return true
  }

  rememberServerConfig(serverName, config = {}) {
    if (this.serverConfigs.has(serverName)) return

    this.serverConfigs.set(serverName, {
      ...config,
      type: this.normalizeTransportType(config.type),
      enabled: config.enabled === true,
      connected: false,
      toolCount: 0,
      toolNames: [],
      toolAliases: []
    })
  }

  async connectServer(serverName, config = {}) {
    const token = this.reloadToken
    this.clearReconnectTimer(serverName)

    try {
      if (this.clients.has(serverName)) {
        logger.info(`[MCP] 服务器 ${serverName} 已存在，正在重新连接...`)
        await this.disconnectServer(serverName, { preserveConfig: true })
      }

      const transportType = this.normalizeTransportType(config.type)
      const transport = this.createTransport(serverName, { ...config, type: transportType })
      this.bindTransportStderr(serverName, transport)
      const client = new Client(
        {
          name: "yunzai-mcp-client",
          version: "1.0.0"
        },
        {
          capabilities: {},
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 300,
              onChanged: error => {
                if (error) {
                  logger.error(`[MCP] 服务器 ${serverName} 工具列表刷新失败:`, error)
                  return
                }
                this.registerServerTools(serverName, this.clients.get(serverName)?.client || client, config).catch(err => {
                  logger.error(`[MCP] 服务器 ${serverName} 工具列表刷新失败:`, err)
                })
              }
            }
          }
        }
      )

      client.onclose = () => {
        this.handleUnexpectedClose(serverName, token)
      }
      client.onerror = error => {
        const configInfo = this.serverConfigs.get(serverName)
        if (configInfo) {
          configInfo.lastError = error?.message || String(error)
        }
        logger.warn(`[MCP] 服务器 ${serverName} 连接异常: ${error?.message || error}`)
      }

      logger.info(`[MCP] 正在连接 ${transportType} 服务器: ${serverName}`)
      await withTimeout(
        client.connect(transport),
        Number(config.connectTimeoutMs || this.settings.connectTimeoutMs),
        `连接 MCP 服务器 ${serverName} 超时`
      )

      this.clients.set(serverName, {
        client,
        transport,
        type: transportType,
        config,
        reconnecting: false
      })

      this.serverConfigs.set(serverName, {
        ...config,
        type: transportType,
        enabled: config.enabled === true,
        connected: true,
        connectedAt: new Date().toISOString(),
        error: null,
        lastError: null,
        reconnectAttempts: 0
      })

      this.reconnectAttempts.set(serverName, 0)
      logger.info(`[MCP] 已连接服务器: ${serverName} (${transportType})`)

      await this.registerServerTools(serverName, client, config)
      this.notifyToolsChanged()
      return true
    } catch (error) {
      logger.error(`[MCP] 连接服务器 ${serverName} 失败:`, error)

      this.serverConfigs.set(serverName, {
        ...config,
        type: this.normalizeTransportType(config.type),
        enabled: config.enabled === true,
        connected: false,
        error: error.message,
        lastError: error.message,
        failedAt: new Date().toISOString()
      })

      this.removeServerTools(serverName)
      this.notifyToolsChanged()
      this.scheduleReconnect(serverName, config, token)
      return false
    }
  }

  async listAllTools(client) {
    const allTools = []
    let cursor

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined)
      allTools.push(...(result?.tools || []))
      cursor = result?.nextCursor
    } while (cursor)

    return allTools
  }

  async registerServerTools(serverName, client, config = {}) {
    try {
      const tools = await this.listAllTools(client)
      await this.refreshServerToolsFromNotification(serverName, tools, config)
      return tools
    } catch (error) {
      logger.error(`[MCP] 获取服务器 ${serverName} 工具列表失败:`, error)
      return []
    }
  }

  async refreshServerToolsFromNotification(serverName, tools = [], configOverride = null) {
    const clientInfo = this.clients.get(serverName)
    const config = configOverride || clientInfo?.config || this.serverConfigs.get(serverName) || {}

    this.removeServerTools(serverName)

    const allowedTools = tools.filter(tool => tool?.name && this.isToolAllowed(config, tool.name))
    const registeredAliases = []
    for (const tool of allowedTools) {
      let alias = this.buildAlias(serverName, tool.name)
      const existing = this.aliases.get(alias)
      if (existing && (existing.serverName !== serverName || existing.realName !== tool.name)) {
        const hash = this.shortHash(`${serverName}:${tool.name}`)
        alias = `${alias.slice(0, 55)}_${hash}`
      }
      let counter = 2
      while (this.aliases.has(alias)) {
        const suffix = `_${counter++}`
        alias = `${alias.slice(0, 64 - suffix.length)}${suffix}`
      }
      const cleanedSchema = this.prepareInputSchema(tool.inputSchema)
      const entry = {
        alias,
        serverName,
        realName: tool.name,
        client: clientInfo?.client,
        toolInfo: tool,
        inputSchema: cleanedSchema,
        description: tool.description || "",
        updatedAt: new Date().toISOString()
      }

      this.aliases.set(alias, entry)
      this.tools.set(alias, entry)
      registeredAliases.push(alias)
      logger.info(`[MCP] 注册工具: ${alias} -> ${serverName}/${tool.name}`)
    }

    const serverConfig = this.serverConfigs.get(serverName)
    if (serverConfig) {
      serverConfig.toolCount = allowedTools.length
      serverConfig.toolNames = allowedTools.map(t => t.name)
      serverConfig.toolAliases = registeredAliases
      serverConfig.updatedAt = new Date().toISOString()
    }

    this.notifyToolsChanged()
  }

  removeServerTools(serverName) {
    for (const [alias, entry] of Array.from(this.aliases.entries())) {
      if (entry.serverName === serverName) {
        this.aliases.delete(alias)
        this.tools.delete(alias)
      }
    }
  }

  formatToolForAPI(alias, entry = this.aliases.get(alias)) {
    if (!entry) throw new Error(`MCP 工具不存在: ${alias}`)

    return {
      type: "function",
      function: {
        name: alias,
        description: `[${entry.serverName}] ${entry.description || "无描述"}`,
        parameters: entry.inputSchema || { type: "object", properties: {}, required: [] }
      }
    }
  }

  getAllTools() {
    const tools = []
    for (const [alias, entry] of this.aliases) {
      try {
        tools.push(this.formatToolForAPI(alias, entry))
      } catch (error) {
        logger.error(`[MCP] 格式化工具 ${alias} 失败:`, error)
      }
    }
    return tools
  }

  isMCPTool(toolName) {
    return typeof toolName === "string" && toolName.startsWith("mcp_")
  }

  getRealToolName(toolName) {
    const entry = this.resolveToolEntry(toolName)
    return entry?.realName || String(toolName || "").replace(/^mcp_/, "")
  }

  resolveToolEntry(toolName) {
    if (!toolName) return null
    if (this.aliases.has(toolName)) return this.aliases.get(toolName)
    return null
  }

  async executeToolByAlias(alias, args = {}) {
    const entry = this.resolveToolEntry(alias)
    if (!entry) throw new Error(`MCP 工具不存在: ${alias}`)

    const clientInfo = this.clients.get(entry.serverName)
    if (!clientInfo?.client) {
      throw new Error(`MCP 服务器 ${entry.serverName} 已断开连接`)
    }

    try {
      logger.info(`[MCP] 执行工具: ${entry.alias} -> ${entry.serverName}/${entry.realName}, 参数: ${JSON.stringify(args)}`)
      const result = await withTimeout(
        clientInfo.client.callTool({
          name: entry.realName,
          arguments: args
        }),
        Number(clientInfo.config?.toolCallTimeoutMs || this.settings.toolCallTimeoutMs),
        `MCP 工具 ${entry.alias} 执行超时`
      )
      logger.info(`[MCP] 工具 ${entry.alias} 执行完成`)
      return this.formatMCPResultForModel(result)
    } catch (error) {
      logger.error(`[MCP] 执行工具 ${entry.alias} 失败:`, error)
      throw error
    }
  }

  async executeTool(toolName, args = {}) {
    return this.executeToolByAlias(toolName, args)
  }

  formatMCPResultForModel(result, maxChars = this.settings.toolResultMaxChars) {
    const parts = []

    if (result?.isError) {
      parts.push("error: MCP 工具返回错误")
    }

    if (result?.structuredContent !== undefined) {
      parts.push(`structuredContent: ${stableStringify(result.structuredContent)}`)
    }

    if (Array.isArray(result?.content)) {
      for (const item of result.content) {
        if (!item) continue
        if (item.type === "text") {
          parts.push(item.text || "")
        } else if (item.type === "image") {
          parts.push(`[图片结果 mimeType=${item.mimeType || "unknown"}]`)
        } else if (item.type === "audio") {
          parts.push(`[音频结果 mimeType=${item.mimeType || "unknown"}]`)
        } else if (item.type === "resource_link") {
          parts.push(`[资源链接 ${item.name || item.uri || "unknown"}] ${item.uri || ""}`)
        } else if (item.type === "resource") {
          const resource = item.resource || {}
          parts.push(`[资源结果 ${resource.uri || resource.mimeType || "unknown"}]`)
        } else {
          parts.push(stableStringify(item))
        }
      }
    } else if (result !== undefined && result !== null && parts.length === 0) {
      parts.push(typeof result === "string" ? result : stableStringify(result))
    }

    let text = parts.filter(Boolean).join("\n").trim()
    if (!text) text = "MCP 工具执行完成"

    const limit = Number(maxChars || DEFAULT_SETTINGS.toolResultMaxChars)
    if (text.length > limit) {
      text = `${text.slice(0, limit)}...(MCP工具结果已截断)`
    }
    return text
  }

  handleUnexpectedClose(serverName, token = this.reloadToken) {
    const clientInfo = this.clients.get(serverName)
    const config = clientInfo?.config || this.serverConfigs.get(serverName)

    this.clients.delete(serverName)
    this.removeServerTools(serverName)

    const serverConfig = this.serverConfigs.get(serverName)
    if (serverConfig) {
      serverConfig.connected = false
      serverConfig.disconnectedAt = new Date().toISOString()
      serverConfig.lastError = serverConfig.lastError || "连接已关闭"
    }

    this.notifyToolsChanged()
    logger.warn(`[MCP] 服务器 ${serverName} 连接已关闭`)

    if (config) this.scheduleReconnect(serverName, config, token)
  }

  scheduleReconnect(serverName, config, token = this.reloadToken) {
    if (!this.settings.autoReconnect || config?.autoReconnect === false) return
    if (!config?.enabled) return
    if (token !== this.reloadToken) return

    const maxAttempts = Number(config.reconnectMaxAttempts || this.settings.reconnectMaxAttempts)
    const attempts = (this.reconnectAttempts.get(serverName) || 0) + 1
    if (attempts > maxAttempts) {
      logger.warn(`[MCP] 服务器 ${serverName} 已达到最大重连次数 ${maxAttempts}`)
      return
    }

    this.reconnectAttempts.set(serverName, attempts)
    const delay = Math.min(30000, 1000 * 2 ** (attempts - 1))
    this.clearReconnectTimer(serverName)

    const timer = setTimeout(async () => {
      if (token !== this.reloadToken) return
      logger.info(`[MCP] 正在重连服务器 ${serverName}（第 ${attempts} 次）`)
      await this.connectServer(serverName, config)
    }, delay)

    this.reconnectTimers.set(serverName, timer)
  }

  clearReconnectTimer(serverName) {
    const timer = this.reconnectTimers.get(serverName)
    if (timer) clearTimeout(timer)
    this.reconnectTimers.delete(serverName)
  }

  async disconnectServer(serverName, options = {}) {
    const clientInfo = this.clients.get(serverName)
    this.clearReconnectTimer(serverName)

    if (!clientInfo) {
      this.removeServerTools(serverName)
      return false
    }

    try {
      if (clientInfo.client) {
        clientInfo.client.onclose = undefined
        clientInfo.client.onerror = undefined
        await clientInfo.client.close().catch(() => {})
      }
      if (clientInfo.transport && typeof clientInfo.transport.close === "function") {
        await clientInfo.transport.close().catch(() => {})
      }
    } catch (error) {
      logger.error(`[MCP] 断开服务器 ${serverName} 失败:`, error)
    } finally {
      this.clients.delete(serverName)
      this.removeServerTools(serverName)

      const config = this.serverConfigs.get(serverName)
      if (config) {
        config.connected = false
        config.disconnectedAt = new Date().toISOString()
      }
      if (!options.preserveConfig && !this.serverConfigs.get(serverName)?.enabled) {
        this.serverConfigs.delete(serverName)
      }
      this.notifyToolsChanged()
    }

    logger.info(`[MCP] 已断开服务器: ${serverName}`)
    return true
  }

  async disconnectAll() {
    this.reloadToken++
    for (const serverName of Array.from(this.reconnectTimers.keys())) {
      this.clearReconnectTimer(serverName)
    }

    const serverNames = Array.from(this.clients.keys())
    for (const serverName of serverNames) {
      await this.disconnectServer(serverName, { preserveConfig: true })
    }

    this.clients.clear()
    this.aliases.clear()
    this.tools.clear()
    this.serverConfigs.clear()
    this.reconnectAttempts.clear()
    this.notifyToolsChanged()
    logger.info("[MCP] 已断开所有服务器连接")
  }

  async reconnectServer(serverName) {
    const clientInfo = this.clients.get(serverName)
    const config = clientInfo?.config || this.serverConfigs.get(serverName)
    if (!config) {
      logger.warn(`[MCP] 服务器 ${serverName} 配置不存在`)
      return false
    }

    await this.disconnectServer(serverName, { preserveConfig: true })
    return this.connectServer(serverName, config)
  }

  updateServerSystemPrompt(serverName, systemPrompt) {
    const config = this.serverConfigs.get(serverName)
    if (!config) return false
    config.systemPrompt = systemPrompt
    return true
  }

  async executeToolsBatch(toolCalls) {
    const results = await Promise.allSettled(
      toolCalls.map(({ name, args }) => this.executeToolByAlias(name, args))
    )

    return results.map((result, index) => ({
      toolName: toolCalls[index].name,
      success: result.status === "fulfilled",
      result: result.status === "fulfilled" ? result.value : null,
      error: result.status === "rejected" ? result.reason.message : null
    }))
  }

}

Object.assign(MCPClientManager.prototype, schemaMethods, transportMethods, inspectionMethods)

export const mcpManager = new MCPClientManager()
