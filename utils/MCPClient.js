// utils/MCPClient.js
import { createHash } from "crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const DEFAULT_SETTINGS = {
  connectTimeoutMs: 30000,
  toolCallTimeoutMs: 60000,
  toolResultMaxChars: 8000,
  autoReconnect: true,
  reconnectMaxAttempts: 3
}

const UNSUPPORTED_SCHEMA_FIELDS = [
  "$schema",
  "$id",
  "$comment",
  "examples",
  "default",
  "readOnly",
  "writeOnly",
  "deprecated",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains"
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

  createTransport(serverName, config) {
    switch (config.type) {
      case "sse":
        return this.createSSETransport(serverName, config)
      case "http":
        return this.createStreamableHTTPTransport(serverName, config)
      case "stdio":
      default:
        return this.createStdioTransport(serverName, config)
    }
  }

  buildHeaders(config, defaults = {}) {
    const headers = { ...defaults }
    if (config.headers && typeof config.headers === "object") {
      Object.entries(config.headers).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          headers[key] = String(value).replace(/^["']|["']$/g, "")
        }
      })
    }
    return headers
  }

  createSSETransport(serverName, config) {
    if (!config.baseUrl) {
      throw new Error(`SSE 服务器 ${serverName} 需要配置 baseUrl`)
    }

    logger.info(`[MCP] SSE 连接配置: ${config.baseUrl}`)
    return new SSEClientTransport(new URL(config.baseUrl), {
      requestInit: {
        headers: this.buildHeaders(config)
      }
    })
  }

  createStreamableHTTPTransport(serverName, config) {
    if (!config.baseUrl) {
      throw new Error(`Streamable HTTP 服务器 ${serverName} 需要配置 baseUrl`)
    }

    logger.info(`[MCP] Streamable HTTP 连接配置: ${config.baseUrl}`)
    return new StreamableHTTPClientTransport(new URL(config.baseUrl), {
      requestInit: {
        headers: this.buildHeaders(config, {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream"
        })
      }
    })
  }

  createStdioTransport(serverName, config) {
    const { command, args = [], env = {} } = config

    if (!command) {
      throw new Error(`stdio 服务器 ${serverName} 需要配置 command`)
    }

    const cleanEnv = {}
    if (env && typeof env === "object") {
      Object.entries(env).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          cleanEnv[key] = String(value)
        }
      })
    }

    return new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...cleanEnv }
    })
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

  resolveRef(ref, root) {
    if (!ref || typeof ref !== "string" || !ref.startsWith("#/")) return null

    const parts = ref.slice(2).split("/").map(part =>
      part.replace(/~1/g, "/").replace(/~0/g, "~")
    )
    let current = root
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) return null
      current = current[part]
    }
    return current
  }

  dereferenceSchema(schema, root = schema, seen = new Set()) {
    if (!schema || typeof schema !== "object") return schema
    if (Array.isArray(schema)) {
      return schema.map(item => this.dereferenceSchema(item, root, seen))
    }

    if (schema.$ref) {
      if (seen.has(schema.$ref)) {
        const { $ref, ...rest } = schema
        return this.dereferenceSchema(rest, root, seen)
      }

      const target = this.resolveRef(schema.$ref, root)
      if (target) {
        seen.add(schema.$ref)
        const { $ref, ...rest } = schema
        const merged = {
          ...this.dereferenceSchema(target, root, seen),
          ...this.dereferenceSchema(rest, root, seen)
        }
        seen.delete(schema.$ref)
        return merged
      }
    }

    const result = {}
    for (const [key, value] of Object.entries(schema)) {
      result[key] = this.dereferenceSchema(value, root, seen)
    }
    return result
  }

  cleanSchema(schema) {
    if (!schema || typeof schema !== "object") return schema

    const cleaned = JSON.parse(JSON.stringify(schema))
    const visit = obj => {
      if (!obj || typeof obj !== "object") return
      if (Array.isArray(obj)) {
        obj.forEach(visit)
        return
      }

      for (const field of UNSUPPORTED_SCHEMA_FIELDS) {
        delete obj[field]
      }
      delete obj.$ref
      delete obj.$defs
      delete obj.definitions

      Object.values(obj).forEach(visit)
    }

    visit(cleaned)
    return cleaned
  }

  prepareInputSchema(schema) {
    try {
      if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {}, required: [] }
      }

      const cloned = JSON.parse(JSON.stringify(schema))
      const dereferenced = this.dereferenceSchema(cloned, cloned)
      const cleaned = this.cleanSchema(dereferenced)

      if (!cleaned || typeof cleaned !== "object") {
        return { type: "object", properties: {}, required: [] }
      }

      if (!cleaned.type) cleaned.type = "object"
      if (cleaned.type === "object" && (!cleaned.properties || typeof cleaned.properties !== "object")) {
        cleaned.properties = {}
      }
      if (cleaned.type === "object" && !Array.isArray(cleaned.required)) {
        cleaned.required = []
      }

      return cleaned
    } catch (error) {
      logger.warn(`[MCP] 工具参数 schema 处理失败，已使用空参数兜底: ${error.message}`)
      return { type: "object", properties: {}, required: [] }
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

  getToolsDescription() {
    return Array.from(this.aliases.values())
      .map(entry => `${entry.alias}: [${entry.serverName}/${entry.realName}] ${entry.description || "无描述"}`)
      .join("\n")
  }

  getConnectedServers() {
    return Array.from(this.clients.keys())
  }

  getServerTools(serverName) {
    return Array.from(this.aliases.values())
      .filter(entry => entry.serverName === serverName)
      .map(entry => ({
        name: entry.realName,
        alias: entry.alias,
        description: entry.description,
        inputSchema: entry.inputSchema
      }))
  }

  isServerConnected(serverName) {
    return this.clients.has(serverName)
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

  getMCPSystemPrompts(context = {}) {
    const prompts = []

    for (const [serverName, config] of this.serverConfigs) {
      if (!config.connected || !config.systemPrompt) continue

      if (config.promptConditions) {
        const conditions = config.promptConditions

        if (conditions.messageType && context.messageType) {
          if (!conditions.messageType.includes(context.messageType)) continue
        }

        if (conditions.groups && context.groupId) {
          if (!conditions.groups.includes(context.groupId)) continue
        }

        if (conditions.keywords && context.message) {
          const hasKeyword = conditions.keywords.some(kw =>
            context.message.toLowerCase().includes(String(kw).toLowerCase())
          )
          if (!hasKeyword) continue
        }
      }

      prompts.push(`【${serverName}】\n${config.systemPrompt.trim()}`)
    }

    if (!prompts.length) return ""
    return "\n\n【MCP扩展能力】\n" + prompts.join("\n\n")
  }

  getServerSystemPrompt(serverName) {
    const config = this.serverConfigs.get(serverName)
    if (!config || !config.connected) return null
    return config.systemPrompt || null
  }

  isServerEnabled(serverName) {
    const config = this.serverConfigs.get(serverName)
    return config?.enabled === true && config?.connected === true
  }

  getServersInfo() {
    return Array.from(this.serverConfigs.entries()).map(([name, config]) => ({
      name,
      type: config.type || "stdio",
      description: config.description || "",
      enabled: config.enabled,
      connected: config.connected === true,
      toolCount: config.toolCount || 0,
      toolNames: config.toolNames || [],
      toolAliases: config.toolAliases || [],
      hasSystemPrompt: !!config.systemPrompt,
      connectedAt: config.connectedAt,
      disconnectedAt: config.disconnectedAt,
      error: config.error || config.lastError,
      reconnectAttempts: this.reconnectAttempts.get(name) || 0
    }))
  }

  updateServerSystemPrompt(serverName, systemPrompt) {
    const config = this.serverConfigs.get(serverName)
    if (!config) return false
    config.systemPrompt = systemPrompt
    return true
  }

  getToolsSummary() {
    const serverTools = new Map()
    for (const entry of this.aliases.values()) {
      if (!serverTools.has(entry.serverName)) serverTools.set(entry.serverName, [])
      serverTools.get(entry.serverName).push(entry.alias)
    }

    const lines = []
    for (const [server, tools] of serverTools) {
      const config = this.serverConfigs.get(server)
      const type = config?.type || "stdio"
      lines.push(`${server} (${type}): ${tools.length}个工具 (${tools.join(", ")})`)
    }

    return lines.join("\n") || "无已加载的MCP工具"
  }

  getToolServer(toolName) {
    const entry = this.resolveToolEntry(toolName)
    return entry?.serverName || null
  }

  isToolAvailable(toolName) {
    try {
      const entry = this.resolveToolEntry(toolName)
      return !!entry && this.clients.has(entry.serverName)
    } catch {
      return false
    }
  }

  getToolInfo(toolName) {
    const entry = this.resolveToolEntry(toolName)
    if (!entry) return null

    return {
      name: entry.realName,
      alias: entry.alias,
      displayName: entry.alias,
      serverName: entry.serverName,
      description: entry.description,
      inputSchema: entry.inputSchema
    }
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

  async healthCheck() {
    const report = {
      timestamp: new Date().toISOString(),
      totalServers: this.clients.size,
      totalTools: this.aliases.size,
      servers: []
    }

    for (const [serverName, { client, type }] of this.clients) {
      const serverReport = {
        name: serverName,
        type,
        status: "unknown",
        toolCount: 0
      }

      try {
        const tools = await this.listAllTools(client)
        serverReport.status = "healthy"
        serverReport.toolCount = tools.length
      } catch (error) {
        serverReport.status = "unhealthy"
        serverReport.error = error.message
      }

      report.servers.push(serverReport)
    }

    return report
  }

  getStatusSummary() {
    const servers = this.getServersInfo()
    if (!servers.length) return "当前没有配置任何 MCP 服务器"

    const lines = ["【MCP 服务器状态】"]
    for (const server of servers) {
      lines.push("")
      lines.push(`${server.connected ? "✅" : "❌"} ${server.name}`)
      lines.push(`类型: ${server.type}`)
      lines.push(`状态: ${server.connected ? "已连接" : "未连接"}`)
      lines.push(`工具数: ${server.toolCount}`)
      if (server.description) lines.push(`描述: ${server.description}`)
      if (server.reconnectAttempts) lines.push(`重连次数: ${server.reconnectAttempts}`)
      if (server.error) lines.push(`错误: ${server.error}`)
      if (server.toolAliases?.length) {
        lines.push(`工具: ${server.toolAliases.slice(0, 8).join(", ")}${server.toolAliases.length > 8 ? "..." : ""}`)
      }
    }
    return lines.join("\n")
  }

  getToolsListText() {
    const servers = this.getServersInfo()
    if (!servers.length) return "当前没有配置任何 MCP 服务器"

    const lines = ["【MCP 工具列表】"]
    for (const server of servers) {
      lines.push("")
      lines.push(`${server.connected ? "✅" : "❌"} ${server.name} (${server.type})`)
      const tools = this.getServerTools(server.name)
      if (!tools.length) {
        lines.push("暂无可用工具")
        continue
      }
      for (const tool of tools) {
        lines.push(`- ${tool.alias}`)
        lines.push(`  原名: ${tool.name}`)
        if (tool.description) lines.push(`  描述: ${tool.description}`)
      }
    }
    return lines.join("\n")
  }
}

export const mcpManager = new MCPClientManager()
