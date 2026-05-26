import { AbstractTool } from "./AbstractTool.js"
import { emojiPackManager } from "../../utils/EmojiPackManager.js"
import fs from "fs"

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class SendLocalEmojiTool extends AbstractTool {
  constructor() {
    super()
    this.name = "sendLocalEmojiTool"
    this.description = [
      "此工具你可以积极主动调用",
      "从本地表情包库挑选一张合适的表情包发送到当前会话。",
      "适合场景：情绪共鸣（笑/无奈/惊讶/共鸣）、玩笑接梗、表达态度。",
      "不适合场景：严肃问答、技术讨论、对方在咨询正式问题或寻求帮助。",
      "人类常见用法是 '文字 + 表情' 组合（如 '哈哈哈[图]'、'我服了[图]'），优先通过 followUpText 提供伴随文字使表达更自然；",
      "纯单发表情仅适合 '完全无言以对' 或 '对方说了让人无语的话' 等极少数场景。"
    ].join("\n")
    this.parameters = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "情绪或场景关键词，例如：'开心'、'无奈'、'吐槽'、'惊讶'、'生气'、'尴尬'、'卖萌'。会用于从本地库中匹配最合适的表情包。"
        },
        followUpText: {
          type: "string",
          description: "可选。先发送这段文字再发表情包，模拟人类'先说一句话再发图'的习惯。如果只想发表情包不带文字（纯反应场景），可不传此参数。文字不超过 80 字。"
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }

  async func(opts, e) {
    emojiPackManager.refreshConfig()

    if (!emojiPackManager.config?.enabled) {
      return "error: 表情包系统未启用，请在 config/message.yaml 中将 emojiSystem.enabled 设为 true"
    }

    const query = String(opts.query || "").trim()
    if (!query) return "error: query 参数不能为空"

    const groupId = e?.group_id || e?.user_id

    const rl = emojiPackManager.checkRateLimit(groupId)
    if (!rl.allowed) {
      return `error: 近期 ${rl.windowMinutes} 分钟内已发送 ${rl.count} 张表情包（上限 ${rl.max}），本轮请直接用文字回复，不要再调用本工具`
    }

    const { item, strategy } = await emojiPackManager.selectEmoji(query, { groupId })
    if (!item) {
      return "error: 本地表情包库为空，请先通过 #表情包导入 添加表情包"
    }

    const absPath = emojiPackManager.getAbsoluteFilePath(item)
    if (!fs.existsSync(absPath)) {
      return `error: 表情包文件丢失: ${item.hash.slice(0, 8)}`
    }

    const rawFollowUp = typeof opts.followUpText === "string" ? opts.followUpText.trim() : ""
    const followUpText = rawFollowUp ? rawFollowUp.slice(0, 80) : ""

    let textSent = false
    try {
      if (followUpText) {
        await e.reply(followUpText)
        textSent = true
        const cfg = emojiPackManager.config
        const minMs = Number(cfg.followUpDelayMinMs) || 300
        const maxMs = Math.max(minMs, Number(cfg.followUpDelayMaxMs) || 800)
        await sleep(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs)
      }
      await e.reply(segment.image(`file://${absPath}`))
      emojiPackManager.recordPick(groupId, item.hash, item.tags || [])
      emojiPackManager.recordSend(groupId)
      emojiPackManager.markUsed(item.hash).catch(() => {})
      const tagInfo = (item.tags || []).slice(0, 3).join(",") || "无标签"
      const followInfo = followUpText ? ` + 文字"${followUpText.slice(0, 20)}${followUpText.length > 20 ? "..." : ""}"` : ""
      return `已发送表情包 [${tagInfo}]${followInfo} (策略: ${strategy})`
    } catch (err) {
      // 文字已发但图失败：仍计入限流，避免 bot 反复尬聊"哈哈哈"无图
      if (textSent) emojiPackManager.recordSend(groupId)
      return `error: 表情包发送失败: ${err.message}`
    }
  }
}
