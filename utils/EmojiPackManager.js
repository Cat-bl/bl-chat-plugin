import fs from "fs"
import { promises as fsp } from "fs"
import path from "path"
import crypto from "crypto"
import YAML from "yaml"
import sharp from "sharp"

const _path = process.cwd()
const CONFIG_PATH = path.join(_path, "plugins/bl-chat-plugin/config/message.yaml")
const CONFIG_DEFAULT_PATH = path.join(_path, "plugins/bl-chat-plugin/config_default/message.yaml")

const DEFAULT_EMOJI_CONFIG = {
  enabled: false,
  dbPath: "plugins/bl-chat-plugin/database/emoji-packs.ndjson",
  storeDir: "plugins/bl-chat-plugin/database/emoji_files",
  maxItems: 200,
  autoCollect: false,
  visionTagOnAdd: true,
  useEmbedding: true,
  selectionTopK: 20,
  embeddingThreshold: 0.5,
  contentFiltration: false,
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

let instance = null

function logInfo(msg) { globalThis.logger?.info?.(`[EmojiPackManager] ${msg}`) }
function logWarn(msg) { globalThis.logger?.warn?.(`[EmojiPackManager] ${msg}`) }
function logError(msg) { globalThis.logger?.error?.(`[EmojiPackManager] ${msg}`) }

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

  async _addFromBufferInternal(buffer, { source = "manual", autoTag = true, autoEmbed = true } = {}) {
    this.refreshConfig()
    await this.ensureDirs()

    const hash = this.sha256OfBuffer(buffer)
    const items = await this.loadItems(true)
    const existing = items.find(i => i.hash === hash)
    if (existing) return { added: false, reason: "duplicate", item: existing }

    const ext = this.detectExtFromBuffer(buffer)
    if (ext === ".bin") return { added: false, reason: "unsupported_format" }

    // 第一道闸：库满且未开 doReplace 时直接拒绝，节省所有后续 AI 调用（content_filtration / VLM 打标 / embedding）
    const maxItems = this.config.maxItems || 200
    if (items.length >= maxItems && !this.config.doReplace) {
      return { added: false, reason: "full" }
    }

    if (this.config.contentFiltration) {
      try {
        const verdict = await this.contentFilterWithVLM(buffer, ext)
        if (!verdict.isEmoji) {
          logInfo(`内容审查未通过 (${hash.slice(0, 8)}): ${verdict.reason}`)
          return { added: false, reason: "content_filtered", filterReason: verdict.reason }
        }
      } catch (err) {
        logWarn(`内容审查异常 (${hash.slice(0, 8)})：${err.message}，跳过审查继续入库`)
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
    }

    if (autoEmbed && this.config.useEmbedding !== false && (record.tags.length || record.description)) {
      try {
        const text = [record.description, ...(record.tags || [])].filter(Boolean).join(" ")
        record.embedding = await this.getEmbedding(text)
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

  async callOpenAIChat(cfg, urlField, keyField, modelField, body) {
    const url = cfg?.[urlField]
    const key = cfg?.[keyField]
    if (!url || !key || String(key).includes("sk-xxx")) {
      throw new Error(`${keyField} 未配置`)
    }
    const finalBody = { model: cfg[modelField], ...body }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(finalBody)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`API ${response.status}: ${text.slice(0, 120)}`)
    }
    return await response.json()
  }

  async tagWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `请观察这张表情包图片，输出严格的 JSON 格式（不要 markdown 代码块），只包含两个字段：
- "tags": 字符串数组，提取该表情包传达的 3-5 个情绪/语气/场景标签，例如 ["开心","无奈","吐槽","惊讶"]
- "description": 一句话描述图片内容（不超过 30 字）
只输出 JSON，不要任何其他文字。`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("VLM 未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 5) : [],
      description: String(parsed.description || "").slice(0, 100)
    }
  }

  async contentFilterWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `严格判断这张图是否是真正适合 QQ/微信聊天的**表情包**。
判定标准必须从严，宁可漏判不要错收。

【判定为 true 的必要条件】（至少明显具备一项）：
1. 典型表情包/梗图：网络流行梗图、二次元角色表情、ACG 同人表情、emoji 贴纸、QQ/微信官方表情样式
2. 强烈情绪/反应表达：图中主体（人/动物/物体）正在做夸张的表情、动作、姿势（生气、哭泣、惊讶、无语、嘲讽、得意、崩溃、卖萌、震惊等可一眼识别的情绪）
3. 自带梗字/吐槽文字：图片上写有"我也想""绷不住了""我就笑笑""你说啥"等中文梗字 / 二次创作配文
4. 拟人化反应：动物或无生命物体做出明显人类化的搞笑表情/动作

【判定为 false（必拒）】：
- 普通宠物日常照（猫狗坐着、躺着、走路、吃东西等没有夸张表情/动作的）
- 插画、美术作品、艺术绘画、写实画风的角色立绘、CG 截图
- 风景照、建筑、产品图、广告海报、横幅、二维码
- 真人照片、自拍、合照、明星生图
- 文档截图、聊天截图、文字截图、网页截图、代码截图
- 仅"画风不错"或"角色好看"但没有明显情绪/动作/梗的图
- 不确定的图

**关键测试**：把这张图发到群里，群友能立刻明白"这是在表达 XX 情绪/梗"吗？不能就是 false。

仅输出严格 JSON（不要 markdown 代码块）：{"is_emoji": true 或 false, "reason": "简短理由"}`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("内容审查未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      isEmoji: parsed.is_emoji === true,
      reason: String(parsed.reason || "").slice(0, 60)
    }
  }

  async replaceOldestByLLM(items) {
    const cfg = this.toolsAiConfig
    if (!cfg?.toolsAiUrl || !cfg?.toolsAiApikey || String(cfg.toolsAiApikey).includes("sk-xxx")) {
      throw new Error("toolsAiConfig 未配置")
    }
    if (!items.length) return null

    // 按 1/(usedCount+1) 加权抽样最多 20 张候选
    const sample = []
    const weighted = items.map((item, idx) => ({ idx, weight: 1 / ((item.usedCount || 0) + 1) }))
    const total = weighted.reduce((a, b) => a + b.weight, 0)
    const candidatePool = [...weighted]
    const N = Math.min(20, candidatePool.length)
    for (let i = 0; i < N; i++) {
      let r = Math.random() * candidatePool.reduce((s, c) => s + c.weight, 0)
      for (let j = 0; j < candidatePool.length; j++) {
        r -= candidatePool[j].weight
        if (r <= 0) {
          sample.push(items[candidatePool[j].idx])
          candidatePool.splice(j, 1)
          break
        }
      }
    }

    const list = sample.map((item, i) => {
      const tags = (item.tags || []).join(",") || "无标签"
      const desc = (item.description || "").slice(0, 20)
      return `${i}. [${tags}] ${desc} (用过${item.usedCount || 0}次)`
    }).join("\n")

    const prompt = `本地表情包库已满，需要从下列候选中删除一张以腾出空间存新表情。
请优先选择：使用次数少、标签笼统/重复、不易复用的表情包。
候选列表：
${list}

仅输出 JSON（不要 markdown 代码块）：{"index": <候选编号 0-${sample.length - 1}>, "reason": "简短理由"}`

    const response = await fetch(cfg.toolsAiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.toolsAiApikey}` },
      body: JSON.stringify({
        model: cfg.toolsAiModel || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`tools API ${response.status}: ${text.slice(0, 120)}`)
    }
    const json = await response.json()
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("替换决策未返回 JSON")
    const parsed = JSON.parse(match[0])
    const idx = Number(parsed.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sample.length) {
      throw new Error(`替换决策 index 非法: ${parsed.index}`)
    }
    return sample[idx].hash
  }

  async getEmbedding(input) {
    const cfg = this.embeddingAiConfig
    if (!cfg?.embeddingApiUrl || !cfg?.embeddingApiKey || cfg.embeddingApiKey.includes("sk-xxx")) {
      throw new Error("embeddingAiConfig 未配置")
    }
    const response = await fetch(cfg.embeddingApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.embeddingApiKey}` },
      body: JSON.stringify({ model: cfg.embeddingApiModel || "text-embedding-3-small", input })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`embedding API ${response.status}: ${text.slice(0, 120)}`)
    }
    const json = await response.json()
    return json.data?.[0]?.embedding || null
  }

  cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  }

  levenshtein(a, b) {
    const m = a.length, n = b.length
    if (!m) return n
    if (!n) return m
    let prev = new Array(n + 1)
    let curr = new Array(n + 1)
    for (let j = 0; j <= n; j++) prev[j] = j
    for (let i = 1; i <= m; i++) {
      curr[0] = i
      for (let j = 1; j <= n; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
      }
      ;[prev, curr] = [curr, prev]
    }
    return prev[n]
  }

  getRecentExclusions(groupId) {
    if (!groupId) return { hashes: new Set(), tags: new Set() }
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    const picks = this.recentPicksByGroup.get(String(groupId)) || []
    const fresh = picks.filter(p => p.at >= cutoff)
    if (fresh.length !== picks.length) {
      if (fresh.length) this.recentPicksByGroup.set(String(groupId), fresh)
      else this.recentPicksByGroup.delete(String(groupId))
    }
    const hashes = new Set(fresh.map(p => p.hash))
    const tags = new Set()
    for (const p of fresh) for (const t of (p.tags || [])) tags.add(String(t).toLowerCase())
    return { hashes, tags }
  }

  recordPick(groupId, hash, tags) {
    if (!groupId || !hash) return
    const key = String(groupId)
    const list = this.recentPicksByGroup.get(key) || []
    list.push({ hash, tags: Array.isArray(tags) ? tags.slice() : [], at: Date.now() })
    const max = Number(this.config.avoidRecentCount) || 20
    while (list.length > max) list.shift()
    this.recentPicksByGroup.set(key, list)
    // 顺手清理过期群条目
    const ttlMs = (Number(this.config.avoidRecentTtlMinutes) || 30) * 60 * 1000
    const cutoff = Date.now() - ttlMs
    for (const [gid, picks] of this.recentPicksByGroup) {
      const fresh = picks.filter(p => p.at >= cutoff)
      if (!fresh.length) this.recentPicksByGroup.delete(gid)
      else if (fresh.length !== picks.length) this.recentPicksByGroup.set(gid, fresh)
    }
  }

  checkRateLimit(groupId) {
    if (this.config.rateLimitEnabled === false) return { allowed: true }
    if (!groupId) return { allowed: true }
    const max = Number(this.config.rateLimitMaxPerWindow) || 0
    if (max <= 0) return { allowed: true }
    const windowMinutes = Number(this.config.rateLimitWindowMinutes) || 5
    const windowMs = windowMinutes * 60 * 1000
    const cutoff = Date.now() - windowMs
    const key = String(groupId)
    const all = this.recentSendsByGroup.get(key) || []
    const fresh = all.filter(t => t >= cutoff)
    if (fresh.length !== all.length) {
      if (fresh.length) this.recentSendsByGroup.set(key, fresh)
      else this.recentSendsByGroup.delete(key)
    }
    return fresh.length >= max
      ? { allowed: false, count: fresh.length, max, windowMinutes }
      : { allowed: true, count: fresh.length, max, windowMinutes }
  }

  recordSend(groupId) {
    if (!groupId) return
    const key = String(groupId)
    const list = this.recentSendsByGroup.get(key) || []
    list.push(Date.now())
    this.recentSendsByGroup.set(key, list)
    // 顺手清过期群
    const windowMs = (Number(this.config.rateLimitWindowMinutes) || 5) * 60 * 1000
    const cutoff = Date.now() - windowMs
    for (const [gid, ts] of this.recentSendsByGroup) {
      const fresh = ts.filter(t => t >= cutoff)
      if (!fresh.length) this.recentSendsByGroup.delete(gid)
      else if (fresh.length !== ts.length) this.recentSendsByGroup.set(gid, fresh)
    }
  }

  /**
   * 从候选数组按"基础相关分 × usedCount 反向权重 × 冷启动 boost"加权抽样。
   * candidates: [{ item, score }]，score 是 [0,1] 区间的"越大越相关"。
   * 解决 200 张表情包只有 Top 5 反复出现的问题：让长尾和新图都有机会被选中。
   */
  weightedSampleByUsage(candidates) {
    if (!candidates?.length) return null
    const weights = candidates.map(({ item, score }) => {
      const baseScore = Math.max(0.01, Number(score) || 0.01)
      const usageWeight = 1 / ((item.usedCount || 0) + 1)
      const coldBoost = (item.usedCount || 0) === 0 ? 2 : 1
      return baseScore * usageWeight * coldBoost
    })
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) {
      return candidates[Math.floor(Math.random() * candidates.length)]
    }
    let r = Math.random() * total
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i]
      if (r <= 0) return candidates[i]
    }
    return candidates[candidates.length - 1]
  }

  async selectEmoji(query, options = {}) {
    this.refreshConfig()
    const allItems = await this.loadItems()
    const usableAll = allItems.filter(i => !i.isBanned)
    if (!usableAll.length) return { item: null, strategy: "empty" }

    let items = usableAll
    if (this.config.avoidRecentEnabled !== false && options.groupId) {
      const { hashes: recentHashes, tags: recentTags } = this.getRecentExclusions(options.groupId)
      if (recentHashes.size || recentTags.size) {
        const filtered = usableAll.filter(item => {
          if (recentHashes.has(item.hash)) return false
          const itemTagsLc = (item.tags || []).map(t => String(t).toLowerCase())
          if (itemTagsLc.some(t => recentTags.has(t))) return false
          return true
        })
        if (filtered.length) items = filtered
        // 若过滤后为空，items 保持 usableAll，避免无图可发
      }
    }

    const q = String(query || "").trim().toLowerCase()
    const useEmbed = this.config.useEmbedding !== false
    const hasEmbedCfg = !!(this.embeddingAiConfig?.embeddingApiUrl
      && this.embeddingAiConfig?.embeddingApiKey
      && !String(this.embeddingAiConfig.embeddingApiKey).includes("sk-xxx"))
    const embeddedItems = items.filter(i => Array.isArray(i.embedding) && i.embedding.length)

    // L1: embedding
    if (q && useEmbed && hasEmbedCfg && embeddedItems.length) {
      try {
        const qEmbed = await this.getEmbedding(q)
        if (Array.isArray(qEmbed)) {
          const threshold = Number(this.config.embeddingThreshold) || 0.3
          const topK = Number(this.config.selectionTopK) || 20
          const ranked = embeddedItems
            .map(item => ({ item, score: this.cosineSimilarity(qEmbed, item.embedding) }))
            .filter(r => r.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
          if (ranked.length) {
            const picked = this.weightedSampleByUsage(ranked)
            return { item: picked.item, strategy: "embedding" }
          }
        }
      } catch (err) {
        logWarn(`embedding 选图失败，降级到标签匹配: ${err.message}`)
      }
    }

    // L2: tag Levenshtein
    const taggedItems = items.filter(i => Array.isArray(i.tags) && i.tags.length)
    if (q && taggedItems.length) {
      const topK = Number(this.config.selectionTopK) || 20
      const ranked = taggedItems.map(item => {
        const dists = item.tags.map(tag => {
          const t = String(tag).toLowerCase()
          if (t === q) return 0
          if (t.includes(q) || q.includes(t)) return 1
          return this.levenshtein(t, q)
        })
        const minDist = Math.min(...dists)
        // 编辑距离越小越相关 → 转换为 score 越大越相关
        return { item, score: 1 / (1 + minDist) }
      }).sort((a, b) => b.score - a.score).slice(0, topK)
      if (ranked.length) {
        const picked = this.weightedSampleByUsage(ranked)
        return { item: picked.item, strategy: "levenshtein" }
      }
    }

    // L3: usedCount-weighted random
    const weights = items.map(i => 1 / ((i.usedCount || 0) + 1))
    const total = weights.reduce((a, b) => a + b, 0)
    let r = Math.random() * total
    for (let i = 0; i < items.length; i++) {
      r -= weights[i]
      if (r <= 0) return { item: items[i], strategy: "weighted_random" }
    }
    return { item: items[items.length - 1], strategy: "weighted_random" }
  }

  scheduleSave(items) {
    this.pendingItems = items
    if (this.pendingWriteTimer) clearTimeout(this.pendingWriteTimer)
    this.pendingWriteTimer = setTimeout(() => {
      const toSave = this.pendingItems
      this.pendingItems = null
      this.pendingWriteTimer = null
      this.saveItems(toSave).catch(err => logWarn(`节流写入失败: ${err.message}`))
    }, 2000)
  }

  async markUsed(hash) {
    const items = await this.loadItems(true)
    const item = items.find(i => i.hash === hash)
    if (!item) return
    item.usedCount = (item.usedCount || 0) + 1
    item.lastUsedAt = new Date().toISOString()
    this.scheduleSave(items)
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
      if (this.config.useEmbedding !== false && (target.tags.length || target.description)) {
        try {
          const text = [target.description, ...(target.tags || [])].filter(Boolean).join(" ")
          target.embedding = await this.getEmbedding(text)
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

    // 3. 清理无标签无向量的「残废」记录（含磁盘文件）
    //    仅在启用 VLM 打标时执行，避免误删用户主动关闭打标时的合法无标签项
    if (this.config.visionTagOnAdd !== false) {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const hasTag = Array.isArray(item.tags) && item.tags.length > 0
        const hasEmbed = Array.isArray(item.embedding) && item.embedding.length > 0
        if (!hasTag && !hasEmbed) {
          const abs = path.join(this.storeDir, path.basename(item.file))
          try { await fsp.unlink(abs) } catch {}
          items.splice(i, 1)
          report.cleanedUntagged++
          changed = true
        }
      }
      if (report.cleanedUntagged) logInfo(`维护：清理 ${report.cleanedUntagged} 个无标签无向量的残废记录（含磁盘文件）`)
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
        const response = await fetch(seg.url, { signal: AbortSignal.timeout(10000) })
        if (!response.ok) continue
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length < 1024 || buffer.length > 5 * 1024 * 1024) continue
        await this.addFromBuffer(buffer, { source: "auto" })
      } catch (err) {
        logWarn(`autoCollect 失败: ${err.message}`)
      }
    }
  }
}

export const emojiPackManager = EmojiPackManager.getInstance()
export default emojiPackManager
