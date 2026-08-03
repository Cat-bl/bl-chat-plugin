import fs from "fs"
import path from "path"
import YAML from "yaml"
import chokidar from "chokidar"

let configWatcher = null
// 模块级配置缓存：Yunzai 每条消息都会实例化插件并调用 initConfig，
// 缓存 + mtime 校验避免每条消息全量读盘/解析/合并。文件变化时走全量路径并更新缓存。
let cachedConfig = null // { pluginSettings, userMtimeMs, defaultMtimeMs }

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
  /**
   * 加载插件配置到 this.config。
   * @returns {boolean} true=本次执行了全量读盘（首启/文件变化/加载失败），调用方应刷新共享子系统；
   *                    false=直接复用了缓存
   */
  initConfig() {
    const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
    const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")
    const configPath = path.join(configDir, "message.yaml")
    const defaultConfigPath = path.join(configDefaultDir, "message.yaml")

    // 快路径：两个配置文件 mtime 都没变时直接复用缓存（每条消息都会走到这里）
    if (cachedConfig) {
      try {
        const userMtimeMs = fs.statSync(configPath).mtimeMs
        const defaultMtimeMs = fs.statSync(defaultConfigPath).mtimeMs
        if (userMtimeMs === cachedConfig.userMtimeMs && defaultMtimeMs === cachedConfig.defaultMtimeMs) {
          this.config = cachedConfig.pluginSettings
          return false
        }
      } catch {}
    }

    this.ensureConfigFiles()

    try {
      if (!fs.existsSync(defaultConfigPath)) {
        logger.error(`[配置] 默认配置文件不存在: ${defaultConfigPath}`)
        logger.error(`[配置] 请在 config_default 目录下创建 message.yaml 文件`)
        this.config = {}
        return true
      }

      const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))

      if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, "utf8"))
        let merged = this.mergeConfig(defaultConfig, config)
        try {
          // 数组增量同步：靠快照区分"默认新增"（追加）与"用户删除"（不回加）。
          // 无快照（存量用户首次升级/快照损坏）时只建基线不追加，行为与旧版完全一致
          const snapshot = this.readDefaultsSnapshot(configDir)
          if (snapshot) merged = this.applyDefaultArrayAdditions(merged, defaultConfig, snapshot)
        } catch (err) {
          logger.error(`[配置] 默认数组增量同步失败（已跳过，不影响加载）: ${err}`)
        }

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

      // 只在成功加载后缓存（stat 必须在可能的写回之后，否则 mtime 对不上）
      cachedConfig = {
        pluginSettings: this.config,
        userMtimeMs: fs.statSync(configPath).mtimeMs,
        defaultMtimeMs: fs.statSync(defaultConfigPath).mtimeMs
      }

      // 记录"本次运行看到的默认配置"，作为下次识别默认新增数组条目的基线
      this.writeDefaultsSnapshot(configDir, defaultConfig)
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
            // mergeConfig 是纯函数，用注册 watcher 时的实例调用无副作用
            const merged = this.mergeConfig(defaultConfig, userConfig)
            cachedConfig = {
              pluginSettings: merged.pluginSettings,
              userMtimeMs: fs.statSync(configPath).mtimeMs,
              defaultMtimeMs: fs.statSync(defaultConfigPath).mtimeMs
            }

            // 刷新共享子系统与最新存活实例。
            // 注意：不能把状态写回 this —— watcher 闭包捕获的是首条消息的旧实例，
            // Yunzai 每条消息都会新建实例并从 cachedConfig 取配置；
            // 跨消息生效的部分（各 Manager、工具注册表、sessionMap）经 sharedState / pluginBridge 刷新。
            // 动态 import：避免本模块静态依赖 sharedState（其依赖链需要 Yunzai 运行环境）；
            // 运行时该模块早已被主文件加载，这里直接命中模块缓存
            const { initializeSharedState, getSharedState } = await import("./sharedState.js")
            initializeSharedState(cachedConfig.pluginSettings)
            const { pluginBridge } = await import("../utils/pluginBridge.js")
            const inst = pluginBridge.instance
            if (inst) {
              inst.config = cachedConfig.pluginSettings
              inst.MAX_HISTORY = inst.config.groupMaxMessages || 100
              inst.knowledgeSearcher = getSharedState()?.knowledgeSearcher || null
              await inst.refreshLocalToolRegistry({ force: true }).catch(error => {
                logger.error(`[bl-chat-plugin][热更新] 重新加载本地工具失败: ${error}`)
                inst.initTools()
              })
            }

            logger.mark(`[bl-chat-plugin][热更新] message.yaml 配置已重新加载`)
          } catch (err) {
            logger.error(`[bl-chat-plugin][热更新] 重新加载配置失败: ${err}`)
          }
        }, 500)
      })
    }

    return true
  }
,
  /**
   * 读取默认配置快照（上次运行看到的 config_default 内容）。
   * 不存在/损坏时返回 null，调用方视为无基线：只建快照、不做数组增量。
   */
  readDefaultsSnapshot(configDir) {
    try {
      const snapshotPath = path.join(configDir, ".defaults-snapshot.yaml")
      if (!fs.existsSync(snapshotPath)) return null
      const parsed = YAML.parse(fs.readFileSync(snapshotPath, "utf8"))
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }
,
  writeDefaultsSnapshot(configDir, defaultConfig) {
    try {
      const snapshotPath = path.join(configDir, ".defaults-snapshot.yaml")
      const content =
        "# 插件内部文件：记录上次运行时的默认配置，用于识别 config_default 新增的数组条目，请勿手动修改\n" +
        YAML.stringify(defaultConfig)
      // 内容没变就不重复写盘
      if (fs.existsSync(snapshotPath) && fs.readFileSync(snapshotPath, "utf8") === content) return
      fs.writeFileSync(snapshotPath, content)
    } catch (err) {
      globalThis.logger?.warn?.(`[配置] 写入默认配置快照失败: ${err}`)
    }
  }
,
  /**
   * 把默认配置里"新出现"的字符串数组条目追加进合并结果（典型场景：oneapi_tools 新增工具）。
   * 新增 = 在新默认里且不在快照里；用户删除 = 在快照里且不在用户配置里，永不回加。
   * 只处理纯字符串数组（集合语义）；对象数组（如 talkValueRules）保持用户值不动。
   * 比对时剥掉尾部 "(标记)"（如 dedupe），避免默认条目改标记后被当作新条目重复追加。
   */
  applyDefaultArrayAdditions(merged, defaults, snapshot) {
    const stripMark = value => String(value).trim().replace(/\s*\([^)]*\)\s*$/, "")
    const walk = (mergedNode, defaultsNode, snapshotNode, parentPath) => {
      if (!mergedNode || !defaultsNode || typeof defaultsNode !== "object" || Array.isArray(defaultsNode)) return
      for (const key of Object.keys(defaultsNode)) {
        const defaultValue = defaultsNode[key]
        const keyPath = parentPath ? `${parentPath}.${key}` : key
        if (Array.isArray(defaultValue)) {
          const snapshotValue = snapshotNode?.[key]
          const userValue = mergedNode[key]
          if (!Array.isArray(snapshotValue) || !Array.isArray(userValue)) continue
          if (!defaultValue.every(item => typeof item === "string")) continue
          const snapshotKeys = new Set(snapshotValue.filter(item => typeof item === "string").map(stripMark))
          const userKeys = new Set(userValue.filter(item => typeof item === "string").map(stripMark))
          const additions = defaultValue.filter(
            item => !snapshotKeys.has(stripMark(item)) && !userKeys.has(stripMark(item))
          )
          if (additions.length) {
            mergedNode[key] = [...userValue, ...additions]
            globalThis.logger?.info?.(`[配置] 默认配置新增条目已同步到 ${keyPath}: ${additions.join(", ")}`)
          }
        } else if (defaultValue && typeof defaultValue === "object") {
          walk(mergedNode[key], defaultValue, snapshotNode?.[key], keyPath)
        }
      }
    }
    walk(merged, defaults, snapshot, "")
    return merged
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
