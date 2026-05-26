import { emojiPackManager } from "../utils/EmojiPackManager.js"
import { TakeImages } from "../utils/fileUtils.js"
import common from "../../../lib/common/common.js"
import fs from "fs"
import path from "path"

async function fetchImageBuffer(url, timeoutMs = 15000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function sendForward(e, msgs, title = "表情包") {
  try {
    const forwardMsg = await common.makeForwardMsg(e, msgs, title)
    await e.reply(forwardMsg)
  } catch {
    await e.reply(msgs.join("\n"))
  }
}

export class EmojiPackPlugin extends plugin {
  constructor() {
    super({
      name: "表情包管理",
      dsc: "本地表情包库的导入/删除/打标管理",
      event: "message",
      priority: 500,
      rule: [
        { reg: "^#表情包导入$", fnc: "importEmoji", permission: "master" },
        { reg: "^#表情包列表(\\s+\\d+)?$", fnc: "listEmoji", permission: "master" },
        // hash 前缀可选：传了走前缀匹配；不传则从当前/引用消息提取图片用全 hash 精确匹配
        { reg: "^#表情包删除(\\s+\\S+)?$", fnc: "deleteEmoji", permission: "master" },
        { reg: "^#表情包打标(\\s+\\S+)?$", fnc: "retagEmoji", permission: "master" },
        { reg: "^#表情包预览(\\s+\\S+)?$", fnc: "previewEmoji", permission: "master" },
        { reg: "^#表情包封禁(\\s+\\S+)?$", fnc: "banEmoji", permission: "master" },
        { reg: "^#表情包解封(\\s+\\S+)?$", fnc: "unbanEmoji", permission: "master" },
        { reg: "^#表情包重载$", fnc: "reloadEmoji", permission: "master" },
        { reg: "^#表情包统计$", fnc: "emojiStats", permission: "master" },
        { reg: "^#表情包巡检$", fnc: "runMaintenance", permission: "master" }
      ]
    })
  }

  /**
   * 从消息文本提取 hash 前缀（去掉指令头部和首尾空白）。无参数返回空串。
   */
  extractHashPrefix(e, cmdRegex) {
    return String(e.msg || "").replace(cmdRegex, "").trim()
  }

  /**
   * 从当前消息或引用消息提取图片，下载后计算 SHA-256，返回 [{ hash, item }] 列表。
   * item 来自 emojiPackManager.loadItems()，不在库中的图片 item=null。
   */
  async resolveQuotedHashes(e) {
    const urls = await TakeImages(e)
    if (!urls?.length) return { ok: false, error: "请引用一条含表情包图片的消息再发送该命令（也可以在当前消息附带图片）" }

    const items = await emojiPackManager.loadItems(true)
    const results = []
    for (const url of urls) {
      try {
        const buffer = await fetchImageBuffer(url)
        const hash = emojiPackManager.sha256OfBuffer(buffer)
        const item = items.find(i => i.hash === hash) || null
        results.push({ hash, item })
      } catch (err) {
        results.push({ hash: null, item: null, error: err.message })
      }
    }
    return { ok: true, results }
  }

  async importEmoji(e) {
    emojiPackManager.refreshConfig()
    if (!emojiPackManager.config?.enabled) {
      return e.reply("表情包系统未启用，请先在 config/message.yaml 将 emojiSystem.enabled 设为 true")
    }

    const urls = await TakeImages(e)
    if (!urls?.length) return e.reply("请在消息中附带图片，或引用一张含图片的消息后再发送 #表情包导入")

    e.reply(`正在导入 ${urls.length} 张图片...`)

    const results = []
    for (const url of urls) {
      try {
        const buffer = await fetchImageBuffer(url)
        const result = await emojiPackManager.addFromBuffer(buffer, { source: "manual" })
        if (result.added) {
          const tagInfo = (result.item.tags || []).join(",") || "无标签"
          results.push(`✅ ${result.item.hash.slice(0, 8)} [${tagInfo}]`)
        } else if (result.reason === "duplicate") {
          results.push(`⚠️ ${result.item.hash.slice(0, 8)} 已存在`)
        } else if (result.reason === "full") {
          results.push(`❌ 库已满 (${emojiPackManager.config.maxItems} 张)`)
          break
        } else if (result.reason === "unsupported_format") {
          results.push(`❌ 不支持的图片格式`)
        }
      } catch (err) {
        results.push(`❌ 下载/处理失败: ${err.message}`)
      }
    }

    await sendForward(e, ["表情包导入结果:", ...results], "表情包导入")
    return true
  }

  async listEmoji(e) {
    const items = await emojiPackManager.loadItems(true)
    if (!items.length) return e.reply("本地表情包库为空")

    const pageMatch = e.msg.match(/(\d+)/)
    const page = pageMatch ? Math.max(1, parseInt(pageMatch[1])) : 1
    const pageSize = 10
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
    const start = (page - 1) * pageSize
    const pageItems = items.slice(start, start + pageSize)
    if (!pageItems.length) return e.reply(`第 ${page} 页没有数据，共 ${totalPages} 页`)

    const msgs = [`表情包列表 (第 ${page}/${totalPages} 页，共 ${items.length} 张)`]
    pageItems.forEach((item, i) => {
      const tags = (item.tags || []).join(",") || "无标签"
      const desc = item.description ? `\n${item.description}` : ""
      const flags = []
      if (item.isBanned) flags.push("封禁")
      if (item.noFileFlag) flags.push("缺文件")
      const flagStr = flags.length ? ` [${flags.join("|")}]` : ""
      const textLine = `${start + i + 1}. ${item.hash.slice(0, 8)}${flagStr}\n用 ${item.usedCount || 0} 次 | [${tags}]${desc}`

      const abs = emojiPackManager.getAbsoluteFilePath(item)
      if (!item.noFileFlag && fs.existsSync(abs)) {
        msgs.push([segment.image(`file://${abs}`), `\n${textLine}`])
      } else {
        msgs.push(`${textLine}\n⚠️ 文件丢失`)
      }
    })
    if (totalPages > 1) msgs.push(`提示: 发送 #表情包列表 <页码> 查看其他页`)
    await sendForward(e, msgs, "表情包列表")
    return true
  }

  async deleteEmoji(e) {
    const prefix = this.extractHashPrefix(e, /^#表情包删除\s*/)

    // 模式 A：传了 hash 前缀 → 走前缀匹配
    if (prefix) {
      if (prefix.length < 4) return e.reply("hash 前缀至少 4 位，避免误删")
      const result = await emojiPackManager.removeByHashPrefix(prefix)
      if (!result.removed) return e.reply(`未找到 hash 以 ${prefix} 开头的表情包`)
      return e.reply(`已删除 ${result.removed} 张表情包`)
    }

    // 模式 B：没传 hash → 从引用图片或当前消息附带图片提取
    const resolved = await this.resolveQuotedHashes(e)
    if (!resolved.ok) return e.reply(resolved.error)

    const lines = []
    let removedTotal = 0
    for (const { hash, item, error } of resolved.results) {
      if (error) { lines.push(`❌ 下载失败: ${error}`); continue }
      if (!item) { lines.push(`⚠️ ${hash.slice(0, 8)} 不在库中`); continue }
      const result = await emojiPackManager.removeByHashPrefix(hash)
      if (result.removed) {
        removedTotal += result.removed
        lines.push(`✅ 已删除 ${hash.slice(0, 8)}`)
      } else {
        lines.push(`❌ 删除失败 ${hash.slice(0, 8)}`)
      }
    }
    return e.reply([`已删除 ${removedTotal} 张`, ...lines].join("\n"))
  }

  async retagEmoji(e) {
    const prefix = this.extractHashPrefix(e, /^#表情包打标\s*/)

    if (prefix) {
      if (prefix.length < 4) return e.reply("请提供至少 4 位的 hash 前缀")
      e.reply("正在重新打标...")
      const result = await emojiPackManager.retagByHashPrefix(prefix)
      if (!result.updated) return e.reply(`打标失败: ${result.error || "未找到匹配的表情包"}`)
      const tags = (result.item.tags || []).join(",") || "无标签"
      return e.reply(`已更新 ${result.item.hash.slice(0, 8)}\n标签: ${tags}\n描述: ${result.item.description || "(无)"}`)
    }

    const resolved = await this.resolveQuotedHashes(e)
    if (!resolved.ok) return e.reply(resolved.error)

    e.reply(`正在为 ${resolved.results.length} 张图片重新打标...`)
    const lines = []
    for (const { hash, item, error } of resolved.results) {
      if (error) { lines.push(`❌ 下载失败: ${error}`); continue }
      if (!item) { lines.push(`⚠️ ${hash.slice(0, 8)} 不在库中`); continue }
      const result = await emojiPackManager.retagByHashPrefix(hash)
      if (result.updated) {
        const tagInfo = (result.item?.tags || []).join(",") || "无标签"
        lines.push(`✅ ${hash.slice(0, 8)}\n标签: ${tagInfo}\n描述: ${result.item?.description || "(无)"}`)
      } else {
        lines.push(`❌ 打标失败 ${hash.slice(0, 8)}: ${result.error || "未知"}`)
      }
    }
    await sendForward(e, ["打标结果", ...lines], "表情包打标")
    return true
  }

  async banEmoji(e) {
    const prefix = this.extractHashPrefix(e, /^#表情包封禁\s*/)

    if (prefix) {
      if (prefix.length < 4) return e.reply("请提供至少 4 位的 hash 前缀")
      const result = await emojiPackManager.setBannedByHashPrefix(prefix, true)
      if (!result.updated) return e.reply(`未找到 hash 以 ${prefix} 开头的表情包`)
      return e.reply(`已封禁 ${result.updated} 张表情包（不参与选图，不删除文件）`)
    }

    const resolved = await this.resolveQuotedHashes(e)
    if (!resolved.ok) return e.reply(resolved.error)

    const lines = []
    let total = 0
    for (const { hash, item, error } of resolved.results) {
      if (error) { lines.push(`❌ 下载失败: ${error}`); continue }
      if (!item) { lines.push(`⚠️ ${hash.slice(0, 8)} 不在库中`); continue }
      const result = await emojiPackManager.setBannedByHashPrefix(hash, true)
      if (result.updated) {
        total += result.updated
        lines.push(`✅ 已封禁 ${hash.slice(0, 8)}`)
      } else {
        lines.push(`❌ 封禁失败 ${hash.slice(0, 8)}`)
      }
    }
    return e.reply([`已封禁 ${total} 张`, ...lines].join("\n"))
  }

  async unbanEmoji(e) {
    const prefix = this.extractHashPrefix(e, /^#表情包解封\s*/)

    if (prefix) {
      if (prefix.length < 4) return e.reply("请提供至少 4 位的 hash 前缀")
      const result = await emojiPackManager.setBannedByHashPrefix(prefix, false)
      if (!result.updated) return e.reply(`未找到 hash 以 ${prefix} 开头的表情包`)
      return e.reply(`已解封 ${result.updated} 张表情包`)
    }

    const resolved = await this.resolveQuotedHashes(e)
    if (!resolved.ok) return e.reply(resolved.error)

    const lines = []
    let total = 0
    for (const { hash, item, error } of resolved.results) {
      if (error) { lines.push(`❌ 下载失败: ${error}`); continue }
      if (!item) { lines.push(`⚠️ ${hash.slice(0, 8)} 不在库中`); continue }
      const result = await emojiPackManager.setBannedByHashPrefix(hash, false)
      if (result.updated) {
        total += result.updated
        lines.push(`✅ 已解封 ${hash.slice(0, 8)}`)
      } else {
        lines.push(`❌ 解封失败 ${hash.slice(0, 8)}`)
      }
    }
    return e.reply([`已解封 ${total} 张`, ...lines].join("\n"))
  }

  async previewEmoji(e) {
    const prefix = this.extractHashPrefix(e, /^#表情包预览\s*/)

    if (prefix) {
      if (prefix.length < 4) return e.reply("请提供至少 4 位的 hash 前缀")
      const items = await emojiPackManager.loadItems()
      const item = items.find(i => i.hash.startsWith(prefix.toLowerCase()))
      if (!item) return e.reply(`未找到 hash 以 ${prefix} 开头的表情包`)
      const abs = emojiPackManager.getAbsoluteFilePath(item)
      if (!fs.existsSync(abs)) return e.reply(`文件丢失: ${abs}`)
      const tags = (item.tags || []).join(",") || "无标签"
      await e.reply([
        segment.image(`file://${abs}`),
        `\nhash: ${item.hash}\n标签: ${tags}\n描述: ${item.description || "(无)"}\n使用次数: ${item.usedCount || 0}`
      ])
      return true
    }

    const resolved = await this.resolveQuotedHashes(e)
    if (!resolved.ok) return e.reply(resolved.error)

    const lines = []
    for (const { hash, item, error } of resolved.results) {
      if (error) { lines.push(`❌ 下载失败: ${error}`); continue }
      if (!item) { lines.push(`⚠️ ${hash.slice(0, 8)} 不在库中（可能已删除）`); continue }
      const tags = (item.tags || []).join(",") || "无标签"
      lines.push(`hash: ${item.hash}\n标签: ${tags}\n描述: ${item.description || "(无)"}\n使用次数: ${item.usedCount || 0}\n封禁: ${item.isBanned ? "是" : "否"}`)
    }
    return e.reply(lines.join("\n----\n"))
  }

  async reloadEmoji(e) {
    emojiPackManager.refreshConfig()
    const items = await emojiPackManager.loadItems(true)
    return e.reply(`已重载，当前 ${items.length} 张表情包`)
  }

  async emojiStats(e) {
    emojiPackManager.refreshConfig()
    const stats = await emojiPackManager.stats()
    const cfg = emojiPackManager.config
    const msgs = [
      "表情包统计",
      `启用状态: ${stats.enabled ? "已启用" : "未启用"}`,
      `自动收集: ${stats.autoCollect ? "已开启" : "已关闭"}`,
      `内容审查: ${stats.contentFiltration ? "已开启" : "已关闭"}`,
      `满额替换: ${stats.doReplace ? "已开启" : "已关闭"}`,
      `周期维护: ${stats.enableMaintenance ? `已开启 (${cfg.checkIntervalMinutes || 10}分钟)` : "已关闭"}`,
      `总数: ${stats.total} / ${stats.maxItems}`,
      `已打标: ${stats.tagged}`,
      `已生成 embedding: ${stats.embedded}`,
      `封禁: ${stats.banned}`,
      `存储目录: ${emojiPackManager.storeDir}`,
      `数据库文件: ${emojiPackManager.dbPath}`,
      `VLM 自动打标: ${cfg.visionTagOnAdd !== false ? "开" : "关"}`,
      `使用 embedding 召回: ${cfg.useEmbedding !== false ? "开" : "关"}`
    ]
    await sendForward(e, msgs, "表情包统计")
    return true
  }

  async runMaintenance(e) {
    emojiPackManager.refreshConfig()
    e.reply("正在执行文件一致性巡检...")
    try {
      const report = await emojiPackManager.runMaintenance()
      if (report?.skipped) {
        return e.reply("表情包系统未启用，巡检跳过")
      }
      const lines = [
        `巡检完成（当前 ${report.total} 张表情包）`,
        `· 清理无标签无向量残废: ${report.cleanedUntagged} 个`,
        `· 补登孤立文件: ${report.orphanRegistered} 个`,
        `· 新标记缺失文件: ${report.markedMissing} 个`,
        `· 自愈已恢复文件: ${report.unmarkedRestored} 个`
      ]
      e.reply(lines.join("\n"))
    } catch (err) {
      e.reply(`巡检失败: ${err.message}`)
    }
    return true
  }
}
