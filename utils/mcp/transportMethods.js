// MCP 传输层构建 mixin：stdio / SSE / streamableHttp 三种传输的创建与 stderr 绑定。
// 从 MCPClient.js 拆出（行为等价搬迁），经 Object.assign 挂到 MCPClientManager.prototype，this 即 manager 实例。
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export const transportMethods = {
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
  },

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
  },

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
  },

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
  },

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
      stderr: "pipe",
      env: { ...process.env, ...cleanEnv }
    })
  },

  bindTransportStderr(serverName, transport) {
    if (!transport?.stderr || typeof transport.stderr.on !== "function") return
    transport.stderr.on("data", chunk => {
      const text = String(chunk || "").trim()
      if (!text) return
      logger.warn(`[MCP] 服务器 ${serverName} stderr: ${text.slice(0, 2000)}`)
    })
  },
}
