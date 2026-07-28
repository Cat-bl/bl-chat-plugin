// MCP 生命周期 mixin：mcp-servers.yaml 读取与连接初始化、工具列表刷新、
// 就绪等待与 #mcp 重载入口。
// 从 apps/chat.js 拆出（行为等价搬迁），经 Object.assign 挂到 ChatPlugin.prototype，this 即插件实例。
import fs from "fs"
import path from "path"
import YAML from "yaml"
import { mcpManager } from "../utils/MCPClient.js"
import { delay } from "./asyncUtils.js"

const _path = process.cwd()

// MCP 初始化 promise：waitForMCPReady / reloadMCPConnections 共享（原 apps/chat.js 模块级变量随迁）
let mcpInitPromise = null

// 构造函数首次初始化入口：保持"整个进程只 initMCP 一次"的语义
export function startMcpInit(plugin) {
  mcpInitPromise = plugin.initMCP()
  return mcpInitPromise
}

export const mcpLifecycleMethods = {
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
  },

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

    for (const session of this.sessionMap.values()) {
      session.tools = this.tools
    }

  },

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
  },

  /**
   * 重新发起 MCP 初始化并更新 waitForMCPReady 等待的同一个 promise。
   * 供 apps/mcp.js 的 #mcp 重载命令通过 pluginBridge 调用。
   */
  reloadMCPConnections() {
    mcpInitPromise = this.initMCP()
    return mcpInitPromise
  },
}
