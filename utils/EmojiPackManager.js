import fs from "fs"
import { promises as fsp } from "fs"
import path from "path"
import crypto from "crypto"
import YAML from "yaml"
import sharp from "sharp"
import { vlmMethods } from "./emoji/vlmMethods.js"
import { selectionMethods } from "./emoji/selectionMethods.js"
import { logInfo, logWarn } from "./emoji/log.js"

const _path = process.cwd()
const CONFIG_PATH = path.join(_path, "plugins/bl-chat-plugin/config/message.yaml")
const CONFIG_DEFAULT_PATH = path.join(_path, "plugins/bl-chat-plugin/config_default/message.yaml")

const DEFAULT_EMOJI_CONFIG = {
  enabled: false,
  dbPath: "plugins/bl-chat-plugin/database/emoji-packs.ndjson",
  storeDir: "plugins/bl-chat-plugin/database/emoji_files",
  importDir: "plugins/bl-chat-plugin/database/emoji_import",
  maxItems: 200,
  autoCollect: false,
  visionTagOnAdd: true,
  useEmbedding: true,
  selectionTopK: 5,
  embeddingThreshold: 0.55,
  contentFiltration: true,
  doReplace: false,
  enableMaintenance: false,
  checkIntervalMinutes: 10,
  avoidRecentEnabled: true,
  avoidRecentCount: 20,
  avoidRecentTtlMinutes: 30,
  followUpDelayMinMs: 300,
  followUpDelayMaxMs: 1200,
  rateLimitEnabled: true,
  rateLimitWindowMinutes: 1,
  rateLimitMaxPerWindow: 3
}

// 打标完成后命中此黑名单的图片直接 reject（非表情包语义的 tag）
const TAG_BLACKLIST = new Set([
  "截图", "聊天记录", "代码", "文档", "网页",
  "风景", "建筑", "产品", "广告", "海报", "二维码", "logo",
  "插画", "立绘", "美术", "壁纸",
  "真人", "自拍", "明星"
])

let instance = null


function readPluginConfig() {
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_DEFAULT_PATH
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, "utf8"))?.pluginSettings || {}
  } catch (err) {
    logWarn(`读取配置失败: ${err.message}`)
    return {}
  }
}

export class EmojiPackManager {
  constructor() {
    this.config = { ...DEFAULT_EMOJI_CONFIG }
    this.analysisAiConfig = {}
    this.embeddingAiConfig = {}
    this.toolsAiConfig = {}
    this.cache = { mtimeMs: 0, items: [], loaded: false }
    this.configMtimeMs = 0
    this.pendingWriteTimer = null
    this.pendingItems = null
    this.maintenanceTimer = null
    this.maintenanceIntervalMs = 0
    this.recentPicksByGroup = new Map()  // groupId → [{ hash, tags, at }]
    this.recentSendsByGroup = new Map()  // groupId → [timestamp, ...]
    this.writeQueue = Promise.resolve()  // addFromBuffer 串行队列，避免并发写竞争
    this.refreshConfig()
  }

  static getInstance() {
    if (!instance) instance = new EmojiPackManager()
    return instance
  }

  refreshConfig() {
    try {
      const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_DEFAULT_PATH
      if (!fs.existsSync(file)) return
      const stat = fs.statSync(file)
      if (stat.mtimeMs === this.configMtimeMs) return
      const settings = readPluginConfig()
      this.config = { ...DEFAULT_EMOJI_CONFIG, ...(settings.emojiSystem || {}) }
      this.analysisAiConfig = settings.analysisAiConfig || {}
      this.embeddingAiConfig = settings.embeddingAiConfig || {}
      this.toolsAiConfig = settings.toolsAiConfig || {}
      this.configMtimeMs = stat.mtimeMs
      // 启用时自动建批量导入目录，用户重启/热开启后即可直接丢图，无需先发一次 #表情包入库
      if (this.config.enabled) {
        try { fs.mkdirSync(this.importDir, { recursive: true }) } catch {}
      }
      this.ensureMaintenanceRunning()
    } catch (err) {
      logWarn(`刷新配置失败: ${err.message}`)
    }
  }

  get dbPath() {
    const p = this.config.dbPath || DEFAULT_EMOJI_CONFIG.dbPath
    return path.isAbsolute(p) ? p : path.join(_path, p)
  }

  get storeDir() {
    const p = this.config.storeDir || DEFAULT_EMOJI_CONFIG.storeDir
    return path.isAbsolute(p) ? p : path.join(_path, p)
  }

  get importDir() {
    const p = this.config.importDir || DEFAULT_EMOJI_CONFIG.importDir
    return path.isAbsolute(p) ? p : path.join(_path, p)
  }

  async ensureDirs() {
    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true })
    await fsp.mkdir(this.storeDir, { recursive: true })
  }

  async fileExists(filepath) {
    try { await fsp.access(filepath); return true } catch { return false }
  }

  async loadItems(force = false) {
    this.refreshConfig()
    if (!(await this.fileExists(this.dbPath))) {
      this.cache = { mtimeMs: 0, items: [], loaded: true }
      return []
    }
    const stat = await fsp.stat(this.dbPath)
    if (!force && this.cache.loaded && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache.items
    }
    const data = await fsp.readFile(this.dbPath, "utf-8")
    const items = data.split("\n").map(line => {
      const trimmed = line.trim()
      if (!trimmed) return null
      try { return JSON.parse(trimmed) } catch { return null }
    }).filter(Boolean)
    this.cache = { mtimeMs: stat.mtimeMs, items, loaded: true }
    return items
  }

  async saveItems(items) {
    await this.ensureDirs()
    const data = items.map(item => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "")
    await fsp.writeFile(this.dbPath, data, "utf-8")
    const stat = await fsp.stat(this.dbPath)
    this.cache = { mtimeMs: stat.mtimeMs, items, loaded: true }
  }

  sha256OfBuffer(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex")
  }

  detectExtFromBuffer(buf) {
    const header = [...buf.slice(0, 12)].map(b => b.toString(16).padStart(2, "0").toUpperCase())
    const sig = header.join("")
    if (sig.startsWith("FFD8")) return ".jpg"
    if (sig.startsWith("89504E47")) return ".png"
    if (sig.startsWith("474946")) return ".gif"
    if (sig.startsWith("52494646") && header.slice(8, 12).join("") === "57454250") return ".webp"
    if (sig.startsWith("424D")) return ".bmp"
    return ".bin"
  }

  detectMimeFromExt(ext) {
    return {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".png": "image/png", ".gif": "image/gif",
      ".webp": "image/webp", ".bmp": "image/bmp"
    }[ext.toLowerCase()] || "application/octet-stream"
  }

  async addFromBuffer(buffer, opts = {}) {
    // 串行队列：保证同一时刻只有一个 addFromBuffer 在读-改-写 ndjson，避免并发竞争丢记录
    const task = () => this._addFromBufferInternal(buffer, opts)
    const result = this.writeQueue.then(task, task)  // 不管前一次成败都执行下一次
    this.writeQueue = result.catch(() => {})         // 防 unhandled rejection 且让链不断
    return result
  }

  async _addFromBufferInternal(buffer, {
    source = "manual", autoTag = true, autoEmbed = true,
    skipContentFilter = false, presetTags = null, presetDescription = ""
  } = {}) {
    this.refreshConfig()
    await this.ensureDirs()

    const hash = this.sha256OfBuffer(buffer)
    const items = await this.loadItems(true)
    const existing = items.find(i => i.hash === hash)
    if (existing) return { added: false, reason: "duplicate", item: existing }

    const ext = this.detectExtFromBuffer(buffer)
    if (ext === ".bin") return { added: false, reason: "unsupported_format" }

    // L0 物理预检查：尺寸 / 纵横比 / 文件大小（零成本，必拦明显非表情包）
    if (buffer.length > 10 * 1024 * 1024) {
      return { added: false, reason: "too_large", size: buffer.length }
    }
    if (buffer.length < 1024) {
      return { added: false, reason: "too_tiny", size: buffer.length }
    }
    try {
      const meta = await sharp(buffer, { failOn: "none" }).metadata()
      const w = meta.width || 0
      const h = meta.height || 0
      if (w && h) {
        if (w < 96 || h < 96) {
          return { added: false, reason: "too_small", width: w, height: h }
        }
        if (w > 1500 || h > 1500) {
          return { added: false, reason: "too_large_dim", width: w, height: h }
        }
        const ratio = Math.max(w, h) / Math.min(w, h)
        if (ratio > 3) {
          return { added: false, reason: "extreme_aspect", ratio: ratio.toFixed(2) }
        }
      }
    } catch (err) {
      // 读 metadata 失败 → 直接拒绝（非标准图片）
      return { added: false, reason: "metadata_failed", error: err.message }
    }

    // 第一道闸：库满且未开 doReplace 时直接拒绝，节省所有后续 AI 调用（content_filtration / VLM 打标 / embedding）
    const maxItems = this.config.maxItems || 200
    if (items.length >= maxItems && !this.config.doReplace) {
      return { added: false, reason: "full" }
    }

    if (this.config.contentFiltration && !skipContentFilter) {
      try {
        const verdict = await this.contentFilterWithVLM(buffer, ext)
        if (!verdict.isEmoji) {
          logInfo(`内容审查未通过 (${hash.slice(0, 8)}): ${verdict.reason}`)
          return { added: false, reason: "content_filtered", filterReason: verdict.reason }
        }
      } catch (err) {
        // fail-closed：审查异常时拒绝入库（避免错收，宁可漏收）
        logWarn(`内容审查异常 (${hash.slice(0, 8)}): ${err.message}，拒绝入库`)
        return { added: false, reason: "content_filter_error", error: err.message }
      }
    }

    // 第二道闸：库仍满（此时 doReplace 必为 true）→ LLM 决策替换
    if (items.length >= maxItems) {
      try {
        const removedHash = await this.replaceOldestByLLM(items)
        if (removedHash) {
          const removeIdx = items.findIndex(i => i.hash === removedHash)
          if (removeIdx >= 0) {
            const removed = items.splice(removeIdx, 1)[0]
            const removedAbs = path.join(this.storeDir, path.basename(removed.file))
            try { await fsp.unlink(removedAbs) } catch {}
            logInfo(`满额替换：删除 ${removed.hash.slice(0, 8)} 给 ${hash.slice(0, 8)} 让位`)
          }
        } else {
          return { added: false, reason: "full" }
        }
      } catch (err) {
        logWarn(`满额替换决策失败: ${err.message}`)
        return { added: false, reason: "full" }
      }
    }

    const fileName = `${hash}${ext}`
    const file = `emoji_files/${fileName}`
    const absFile = path.join(this.storeDir, fileName)
    await fsp.writeFile(absFile, buffer)

    const record = {
      hash,
      file,
      tags: [],
      description: "",
      embedding: null,
      usedCount: 0,
      lastUsedAt: null,
      registeredAt: new Date().toISOString(),
      source,
      isBanned: false
    }

    // 批量导入预置元数据：文件名解析出的描述/标签，autoTag=false 时即最终元数据
    if (presetDescription) record.description = String(presetDescription)
    if (Array.isArray(presetTags) && presetTags.length) {
      record.tags = presetTags.map(t => String(t).trim()).filter(Boolean)
    }

    if (autoTag && this.config.visionTagOnAdd !== false) {
      try {
        const tagResult = await this.tagWithVLM(buffer, ext)
        record.tags = tagResult.tags
        record.description = tagResult.description
        if (!record.tags.length && !record.description) {
          throw new Error("VLM 未返回有效标签或描述")
        }
      } catch (err) {
        logWarn(`VLM 打标失败 (${hash.slice(0, 8)}): ${err.message}，跳过入库`)
        try { await fsp.unlink(absFile) } catch {}
        return { added: false, reason: "tag_failed", error: err.message }
      }

      // L3 tag 黑名单复查：打标后命中"截图/风景/广告/真人"等明确非表情包 tag → 拒绝
      const hitBlacklist = (record.tags || [])
        .map(t => String(t).toLowerCase().trim())
        .filter(t => TAG_BLACKLIST.has(t))
      if (hitBlacklist.length) {
        try { await fsp.unlink(absFile) } catch {}
        logInfo(`L3 黑名单拦截 (${hash.slice(0, 8)}): 命中 [${hitBlacklist.join(",")}]`)
        return { added: false, reason: "tag_blacklist", hitTags: hitBlacklist }
      }
    }

    if (autoEmbed && this.config.useEmbedding !== false && record.description) {
      try {
        // embedding 只用 description（详细 LLM 识别内容），不混 tags 避免短词稀释语义
        record.embedding = await this.getEmbedding(record.description)
      } catch (err) {
        logWarn(`embedding 生成失败 (${hash.slice(0, 8)}): ${err.message}`)
      }
    }

    items.push(record)
    await this.saveItems(items)
    logInfo(`新增表情包: ${hash.slice(0, 8)} tags=[${(record.tags || []).join(",")}]`)
    return { added: true, item: record }
  }

  async gifToStaticPng(buffer) {
    return await sharp(buffer, { animated: false, failOn: "none" }).png().toBuffer()
  }

  async prepareVLMImage(buffer, ext) {
    if (ext.toLowerCase() === ".gif") {
      try {
        const png = await this.gifToStaticPng(buffer)
        return { buffer: png, mime: "image/png" }
      } catch (err) {
        logInfo(`GIF 首帧提取失败已回退原图（不影响功能，VLM 仍可识别）: ${err.message.split(":")[0]}`)
      }
    }
    return { buffer, mime: this.detectMimeFromExt(ext) }
  }

  scheduleSave(items) {
    // 已废弃：markUsed 现走 writeQueue 串行直写，不再用 2s 防抖（会持旧快照覆写丢失新入库表情）
    // 保留空方法避免外部潜在引用报错
    void items
  }

  async markUsed(hash) {
    // 走 writeQueue 串行：在队列里重新加载最新 items 再修改 + 立即保存，
    // 否则 scheduleSave 的 2s 防抖会持有一份旧快照，期间 addFromBuffer 写入的新表情
    // 会被这份旧快照整文件覆写丢失（文件残留磁盘 -> 巡检补登为无标签 -> 再巡检当残废删除）。
    const task = () => this._markUsedInternal(hash)
    const result = this.writeQueue.then(task, task)
    this.writeQueue = result.catch(() => {})
    return result
  }

  async _markUsedInternal(hash) {
    const items = await this.loadItems(true)
    const item = items.find(i => i.hash === hash)
    if (!item) return
    item.usedCount = (item.usedCount || 0) + 1
    item.lastUsedAt = new Date().toISOString()
    await this.saveItems(items)
  }

  async removeByHashPrefix(hashPrefix) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { removed: 0, matched: [] }
    const items = await this.loadItems(true)
    const matched = items.filter(i => i.hash.toLowerCase().startsWith(prefix))
    if (!matched.length) return { removed: 0, matched: [] }
    for (const m of matched) {
      const abs = path.join(this.storeDir, path.basename(m.file))
      try { await fsp.unlink(abs) } catch {}
    }
    const remaining = items.filter(i => !matched.some(m => m.hash === i.hash))
    await this.saveItems(remaining)
    return { removed: matched.length, matched }
  }

  async setBannedByHashPrefix(hashPrefix, banned) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { updated: 0 }
    const items = await this.loadItems(true)
    const matched = items.filter(i => i.hash.toLowerCase().startsWith(prefix))
    if (!matched.length) return { updated: 0, matched: [] }
    matched.forEach(item => { item.isBanned = !!banned })
    await this.saveItems(items)
    return { updated: matched.length, matched }
  }

  async retagByHashPrefix(hashPrefix) {
    const prefix = String(hashPrefix || "").trim().toLowerCase()
    if (!prefix) return { updated: 0 }
    const items = await this.loadItems(true)
    const target = items.find(i => i.hash.toLowerCase().startsWith(prefix))
    if (!target) return { updated: 0 }
    const abs = path.join(this.storeDir, path.basename(target.file))
    if (!fs.existsSync(abs)) return { updated: 0, reason: "file_missing" }
    const buffer = await fsp.readFile(abs)
    const ext = path.extname(target.file) || this.detectExtFromBuffer(buffer)
    try {
      const tagResult = await this.tagWithVLM(buffer, ext)
      target.tags = tagResult.tags
      target.description = tagResult.description
      if (this.config.useEmbedding !== false && target.description) {
        try {
          target.embedding = await this.getEmbedding(target.description)
        } catch (err) {
          logWarn(`重新打标 embedding 失败: ${err.message}`)
        }
      }
      await this.saveItems(items)
      return { updated: 1, item: target }
    } catch (err) {
      return { updated: 0, error: err.message }
    }
  }

  getAbsoluteFilePath(item) {
    return path.join(this.storeDir, path.basename(item.file))
  }

  async stats() {
    const items = await this.loadItems()
    return {
      total: items.length,
      tagged: items.filter(i => Array.isArray(i.tags) && i.tags.length).length,
      embedded: items.filter(i => Array.isArray(i.embedding) && i.embedding.length).length,
      banned: items.filter(i => i.isBanned).length,
      maxItems: this.config.maxItems || 200,
      enabled: !!this.config.enabled,
      autoCollect: !!this.config.autoCollect,
      contentFiltration: !!this.config.contentFiltration,
      doReplace: !!this.config.doReplace,
      enableMaintenance: !!this.config.enableMaintenance
    }
  }

  ensureMaintenanceRunning() {
    const enabled = !!this.config.enabled && !!this.config.enableMaintenance
    const intervalMs = Math.max(1, Number(this.config.checkIntervalMinutes) || 10) * 60 * 1000

    if (!enabled) {
      if (this.maintenanceTimer) {
        clearInterval(this.maintenanceTimer)
        this.maintenanceTimer = null
        this.maintenanceIntervalMs = 0
        logInfo("周期维护已停止")
      }
      return
    }

    if (this.maintenanceTimer && this.maintenanceIntervalMs === intervalMs) return

    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch(err => logWarn(`维护任务异常: ${err.message}`))
    }, intervalMs)
    this.maintenanceIntervalMs = intervalMs
    logInfo(`周期维护已启动 (每 ${this.config.checkIntervalMinutes || 10} 分钟)`)
  }

  async runMaintenance() {
    if (!this.config.enabled) return { skipped: true }
    const items = await this.loadItems(true)
    let changed = false
    const report = { markedMissing: 0, unmarkedRestored: 0, orphanRegistered: 0, cleanedUntagged: 0 }

    // 1. 记录指向的文件不存在 → 标记 noFileFlag
    for (const item of items) {
      const abs = path.join(this.storeDir, path.basename(item.file))
      const exists = fs.existsSync(abs)
      if (!exists && !item.noFileFlag) {
        item.noFileFlag = true
        changed = true
        report.markedMissing++
        logWarn(`维护：${item.hash.slice(0, 8)} 文件缺失，已标记`)
      } else if (exists && item.noFileFlag) {
        item.noFileFlag = false
        changed = true
        report.unmarkedRestored++
      }
    }

    // 2. 目录有图片但 ndjson 没记录 → 补登（仅记录 hash 和 file，不打标）
    try {
      const files = await fsp.readdir(this.storeDir)
      const knownFiles = new Set(items.map(i => path.basename(i.file)))
      for (const f of files) {
        if (knownFiles.has(f)) continue
        const ext = path.extname(f).toLowerCase()
        if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) continue
        const hashFromName = path.basename(f, ext)
        if (!/^[0-9a-f]{64}$/i.test(hashFromName)) continue
        if (items.length >= (this.config.maxItems || 200)) break
        items.push({
          hash: hashFromName.toLowerCase(),
          file: `emoji_files/${f}`,
          tags: [],
          description: "",
          embedding: null,
          usedCount: 0,
          lastUsedAt: null,
          registeredAt: new Date().toISOString(),
          source: "maintenance",
          isBanned: false
        })
        changed = true
        report.orphanRegistered++
        logInfo(`维护：补登孤立文件 ${hashFromName.slice(0, 8)}`)
      }
    } catch (err) {
      logWarn(`维护扫描目录失败: ${err.message}`)
    }

    // 3. 清理无标签、无向量、且无描述的「残废」记录（含磁盘文件）
    //    仅在启用 VLM 打标时执行，避免误删用户主动关闭打标时的合法无标签项；
    //    description 非空说明是批量导入的用户元数据（embedding 可能只是暂时生成失败），豁免
    if (this.config.visionTagOnAdd !== false) {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const hasTag = Array.isArray(item.tags) && item.tags.length > 0
        const hasEmbed = Array.isArray(item.embedding) && item.embedding.length > 0
        const hasDesc = typeof item.description === "string" && item.description.trim().length > 0
        if (!hasTag && !hasEmbed && !hasDesc) {
          const abs = path.join(this.storeDir, path.basename(item.file))
          try { await fsp.unlink(abs) } catch {}
          items.splice(i, 1)
          report.cleanedUntagged++
          changed = true
        }
      }
      if (report.cleanedUntagged) logInfo(`维护：清理 ${report.cleanedUntagged} 个无标签无向量无描述的残废记录（含磁盘文件）`)
    }

    if (changed) await this.saveItems(items)
    report.total = items.length
    return report
  }

  async maybeAutoCollect(e) {
    this.refreshConfig()
    if (!this.config.enabled || !this.config.autoCollect) return
    if (!Array.isArray(e?.message)) return

    const imageSegs = e.message.filter(seg => seg?.type === "image" && seg?.url)
    if (!imageSegs.length) return

    for (const seg of imageSegs) {
      try {
        // L0 本地快速过滤：利用 QQ 协议原生字段，零成本筛掉普通图片。
        // 真正的 QQ 表情/贴图 subType=1，普通图片 subType=0；
        // NapCat 事件字段名为 sub_type，LLBot(LuckyLilliaBot) 为 subType，双读兼容
        if ((seg.sub_type ?? seg.subType) !== 1) {
          continue
        }
        // summary 是 QQ 客户端对表情的本地描述，如 "[动画表情]" "[自定义表情]"，
        // 普通图片为空字符串。LLBot 事件不带此字段，因此仅在字段存在时校验
        if (typeof seg.summary === "string" && seg.summary === "") {
          continue
        }

        const response = await fetch(seg.url, { signal: AbortSignal.timeout(10000) })
        if (!response.ok) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length < 1024 || buffer.length > 10 * 1024 * 1024) continue
        await this.addFromBuffer(buffer, { source: "auto" })
      } catch (err) {
        logWarn(`autoCollect 失败: ${err.message}`)
      }
    }
  }
}

Object.assign(EmojiPackManager.prototype, vlmMethods, selectionMethods)

export const emojiPackManager = EmojiPackManager.getInstance()
export default emojiPackManager
