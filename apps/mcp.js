import { mcpManager } from "../utils/MCPClient.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import common from "../../../lib/common/common.js"

/**
 * MCP 管理命令插件：重载 / 列表 / 状态 / 测试。
 * MCP 连接的初始化与工具列表同步仍由对话主插件持有
 * （reloadMCP 通过 pluginBridge.instance 调用主插件的 reloadMCPConnections）。
 * priority 9998：先于对话主插件（9999）处理命令。
 */
export class McpCommands extends plugin {
  constructor() {
    super({
      name: "MCP管理",
      dsc: "MCP 服务与工具管理命令",
      event: "message",
      priority: 9998,
      rule: [
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" },
        { reg: "^#mcp\\s+状态", fnc: "mcpStatus" },
        { reg: "^#mcp\\s+测试\\s+\\S+", fnc: "testMCPTool" }
      ]
    })
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

  async reloadMCP(e) {
    if (!e.isMaster) {
      await e.reply("只有主人才能执行此操作")
      return true
    }

    await e.reply("正在重载MCP配置...")

    try {
      await mcpManager.disconnectAll()
      await pluginBridge.instance.reloadMCPConnections()

      const toolCount = mcpManager.aliases?.size || mcpManager.tools?.size || 0
      await e.reply(`MCP重载完成，当前加载 ${toolCount} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 重载失败:", error)
      await e.reply(`MCP重载失败: ${error.message}`)
    }

    return true
  }

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
