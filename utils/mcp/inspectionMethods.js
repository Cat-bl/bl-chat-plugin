// MCP 状态查询 mixin：服务/工具信息、系统提示词、健康检查、状态汇总（均为只读查询）。
// 从 MCPClient.js 拆出（行为等价搬迁），经 Object.assign 挂到 MCPClientManager.prototype，this 即 manager 实例。

export const inspectionMethods = {
  getToolsDescription() {
    return Array.from(this.aliases.values())
      .map(entry => `${entry.alias}: [${entry.serverName}/${entry.realName}] ${entry.description || "无描述"}`)
      .join("\n")
  },

  getConnectedServers() {
    return Array.from(this.clients.keys())
  },

  getServerTools(serverName) {
    return Array.from(this.aliases.values())
      .filter(entry => entry.serverName === serverName)
      .map(entry => ({
        name: entry.realName,
        alias: entry.alias,
        description: entry.description,
        inputSchema: entry.inputSchema
      }))
  },

  isServerConnected(serverName) {
    return this.clients.has(serverName)
  },

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
  },

  getServerSystemPrompt(serverName) {
    const config = this.serverConfigs.get(serverName)
    if (!config || !config.connected) return null
    return config.systemPrompt || null
  },

  isServerEnabled(serverName) {
    const config = this.serverConfigs.get(serverName)
    return config?.enabled === true && config?.connected === true
  },

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
  },

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
  },

  getToolServer(toolName) {
    const entry = this.resolveToolEntry(toolName)
    return entry?.serverName || null
  },

  isToolAvailable(toolName) {
    try {
      const entry = this.resolveToolEntry(toolName)
      return !!entry && this.clients.has(entry.serverName)
    } catch {
      return false
    }
  },

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
  },

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
  },

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
  },

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
  },
}
