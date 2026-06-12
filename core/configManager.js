import fs from "fs"
import path from "path"
import YAML from "yaml"
import chokidar from "chokidar"

let configWatcher = null

// 配置初始化与递归合并。
// 以 mixin 形式挂到插件原型上（见 apps 主文件末尾的 Object.assign），
// 方法内的 this 指向插件实例，行为与拆分前完全一致。
export const configManagerMethods = {
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
,
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
        reloadTimer = setTimeout(async () => {
          try {
            const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
            const userConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))
            const merged = this.mergeConfig(defaultConfig, userConfig)
            this.config = merged.pluginSettings

            // 刷新各模块配置
            // 动态 import：避免本模块静态依赖 sharedState（其依赖链需要 Yunzai 运行环境）；
            // 运行时该模块早已被主文件加载，这里直接命中模块缓存
            const { initializeSharedState } = await import("./sharedState.js")
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
,
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
,
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
,
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
}
