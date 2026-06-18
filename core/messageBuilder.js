// 消息内容构建与格式化：把 QQ 消息事件转为发给模型的文本（含群上下文、
import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"
// 引用、@、群身份等），以及工具结果/最终输出的格式化。
// 以 mixin 形式挂到插件原型上，this 指向插件实例。
import { sanitizeFinalReplyText } from "./pseudoToolSanitizer.js"

export const roleMap = { owner: "owner", admin: "admin", member: "member" }

const groupContextCache = new Map()
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000

export const messageBuilderMethods = {
  async callOneBotApi(e, action, params = {}) {
    const bot = e?.bot
      || (typeof Bot !== "undefined" ? Bot : null)
      || (typeof globalThis.bot !== "undefined" ? globalThis.bot : null)
      || (typeof globalThis.Bot !== "undefined" ? globalThis.Bot : null)

    if (!bot?.sendApi) throw new Error("找不到 OneBot API 调用接口")
    return await bot.sendApi(action, params)
  }
,
  normalizeGroupContextText(value, maxLength = 800) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxLength)
  }
,
  pickNoticeText(value) {
    if (!value) return ""
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(item => this.pickNoticeText(item)).filter(Boolean).join("")
    if (typeof value !== "object") return ""

    for (const key of ["content", "text", "msg", "message", "notice", "title", "data"]) {
      const text = this.pickNoticeText(value[key])
      if (text) return text
    }
    return ""
  }
,
  extractGroupNoticeText(response) {
    const payload = response?.data ?? response
    const notices = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.notices)
        ? payload.notices
        : Array.isArray(payload?.notice)
          ? payload.notice
          : [payload].filter(Boolean)

    const sorted = notices.slice().sort((a, b) => {
      const getTime = item => Number(item?.publish_time || item?.time || item?.create_time || item?.updated_at || 0)
      return getTime(b) - getTime(a)
    })

    for (const notice of sorted) {
      const text = this.normalizeGroupContextText(this.pickNoticeText(notice), 800)
      if (text) return text
    }
    return ""
  }
,
  async getCurrentGroupContext(e) {
    const groupId = String(e?.group_id || "")
    if (!groupId) return { groupId: "", groupName: "", groupNotice: "" }

    const groupName = this.normalizeGroupContextText(
      e?.group_name || e?.group?.name || e?.group?.info?.group_name || e?.group?.info?.name,
      120
    )

    const cached = groupContextCache.get(groupId)
    if (cached && Date.now() - cached.at < GROUP_CONTEXT_CACHE_TTL_MS) {
      return { ...cached.data, groupName }
    }

    let groupNotice = ""
    for (const action of ["get_group_notice", "_get_group_notice"]) {
      try {
        const noticeRes = await this.callOneBotApi(e, action, { group_id: Number(groupId) })
        groupNotice = this.extractGroupNoticeText(noticeRes)
        if (groupNotice) break
      } catch (error) {
        logger.debug?.(`[群上下文] ${action} 获取群公告失败 group=${groupId}: ${error.message}`)
      }
    }

    const data = { groupId, groupName, groupNotice }
    groupContextCache.set(groupId, { at: Date.now(), data })
    return data
  }
,
  formatTime() {
    const now = new Date()
    const pad = n => String(n).padStart(2, "0")
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
  }
,
  async buildMessageContent(sender, msg, images, atQq = [], group, e = null) {
    const senderRole = roleMap[sender.role] || "member"
    const messageId = e?.message_id ? `[消息ID:${e.message_id}]` : ''
    const senderInfo = `${sender.card || sender.nickname}(qq号: ${sender.user_id})[群身份: ${senderRole}]${messageId}`

    let atContent = ""
    if (atQq.length > 0 && group) {
      const memberMap = await group.getMemberMap()
      const atUsers = atQq.map(qq => {
        const info = memberMap.get(Number(qq))
        if (!info) return `@未知用户(${qq})`
        return `@${info.card || info.nickname}`
      })
      atContent = `${atUsers.join(" ")} `
    }

    let quoteContent = ""
    if (e?.getReply) {
      try {
        const reply = await e.getReply()
        if (reply) {
          const quotedSender = reply.sender
          let quotedMsg = ""
          if (reply.message && Array.isArray(reply.message)) {
            quotedMsg = reply.message
              .filter(m => m.type === "text")
              .map(m => m.text)
              .join("")
              .trim()
          } else if (typeof reply.raw_message === "string") {
            quotedMsg = reply.raw_message
          }

          // 提取被引用消息中的转发记录内容
          let forwardContent = ""
          let forwardId = null
          // 情况1: type === "forward" (NapCat/Lagrange 某些版本)
          const forwardSegment = reply.message?.find(m => m.type === "forward")
          if (forwardSegment?.id) {
            forwardId = forwardSegment.id
          }
          // 情况2: type === "json" 且 app === "com.tencent.multimsg"
          if (!forwardId) {
            const jsonSegment = reply.message?.find(m => m.type === "json")
            if (jsonSegment) {
              try {
                const jsonData = typeof jsonSegment.data === "string"
                  ? JSON.parse(jsonSegment.data)
                  : jsonSegment.data
                if (jsonData?.app === "com.tencent.multimsg") {
                  forwardId = jsonData.meta?.detail?.resid
                }
              } catch {}
            }
          }
          if (forwardId && e?.group?.getForwardMsg) {
            try {
              const forwardMsgs = await e.group.getForwardMsg(forwardId)
              if (Array.isArray(forwardMsgs) && forwardMsgs.length > 0) {
                const lines = []
                for (const fMsg of forwardMsgs) {
                  const name = fMsg.sender?.nickname || "未知"
                  const text = fMsg.message
                    ?.filter(m => m.type === "text")
                    .map(m => m.text)
                    .join("")
                    .trim()
                  if (text) lines.push(`${name}: ${text}`)
                }
                if (lines.length > 0) {
                  forwardContent = `[转发记录内容:\n${lines.join("\n")}\n]`
                }
              }
            } catch (err) {
              logger.debug(`[获取转发记录失败] ${err}`)
            }
          }

          const quotedImages = reply.message?.filter(m => m.type === "image") || []
          const hasQuotedImage = quotedImages.length > 0

          // 视频 / 语音 / 文件 segment（之前没处理，导致引用视频时 LLM 看到的描述只是"一条消息"，
          // 看不到视频链接也就没法调 videoAnalysisTool 分析）
          const quotedVideos = reply.message?.filter(m => m.type === "video") || []
          const videoUrls = quotedVideos
            .map(v => v?.url || v?.file_url || v?.data?.url || v?.data?.file_url || v?.file || v?.data?.file)
            .filter(Boolean)
          const hasQuotedVideo = quotedVideos.length > 0

          const quotedRecords = reply.message?.filter(m => m.type === "record") || []
          const recordUrls = quotedRecords
            .map(r => r?.url || r?.file_url || r?.data?.url || r?.data?.file_url || r?.file || r?.data?.file)
            .filter(Boolean)
          const hasQuotedRecord = quotedRecords.length > 0

          const quotedFiles = reply.message?.filter(m => m.type === "file") || []
          const fileNames = quotedFiles
            .map(f => f?.name || f?.data?.name || f?.file || f?.data?.file)
            .filter(Boolean)
          const hasQuotedFile = quotedFiles.length > 0

          if (quotedSender) {
            let quotedNickname = quotedSender.nickname || quotedSender.card || "未知用户"

            if (group) {
              try {
                const memberMap = await group.getMemberMap()
                const quotedMemberInfo = memberMap.get(Number(quotedSender.user_id))
                if (quotedMemberInfo) {
                  quotedNickname = quotedMemberInfo.card || quotedMemberInfo.nickname || quotedNickname
                }
              } catch (err) {
              }
            }

            const quotedMessageId = reply.message_id ? `(消息ID:${reply.message_id})` : ''

            const parts = []
            if (quotedMsg) parts.push(`"${quotedMsg}"`)
            if (forwardContent) parts.push(forwardContent)
            if (hasQuotedImage) parts.push(`${quotedImages.length}张图片`)
            if (hasQuotedVideo) {
              const urlText = videoUrls.length ? `(链接: ${videoUrls.join(", ")})` : ""
              parts.push(`一段视频${urlText}`)
            }
            if (hasQuotedRecord) {
              const urlText = recordUrls.length ? `(链接: ${recordUrls.join(", ")})` : ""
              parts.push(`一段语音${urlText}`)
            }
            if (hasQuotedFile) {
              const fileText = fileNames.length ? `(文件名: ${fileNames.join(", ")})` : ""
              parts.push(`一个文件${fileText}`)
            }
            const quotedDescription = parts.length > 0 ? parts.join("，以及") : "一条消息"

            quoteContent = `[回复 ${quotedNickname}${quotedMessageId}的消息: ${quotedDescription}] `
          }
        }
      } catch (error) {
        console.error("获取引用消息失败:", error)
      }
    }

    const content = []
    if (msg) {
      let fullMsg = msg
      if (e?.message && group && atQq.length > 0) {
        try {
          const memberMap = await group.getMemberMap()
          fullMsg = e.message.map(m => {
            if (m.type === 'text') return m.text
            if (m.type === 'at' && String(m.qq) !== String(Bot.uin)) {
              const info = memberMap.get(Number(m.qq))
              return `@${info?.card || info?.nickname || m.qq}`
            }
            return ''
          }).join('').replace(/^#tool\s*/, '').trim()
        } catch {}
      }
      content.push(`在群里说: ${fullMsg}`)
    }
    if (images?.length) {
      content.push(`发送了${images.length === 1 ? "一张" : images.length + " 张"}图片${images.map(img => `\n![图片](${img})`).join("")}`)
    }

    return `${this.formatTime()} ${senderInfo}: ${quoteContent}${atContent}${content.join("，")}`
  }
,
  formatMessages(messages, e, currentUserContent = null) {
    if (!messages?.length) return messages

    const systemMsgs = messages.filter(m => m.role === "system")
    const lastUser = messages[messages.length - 1]?.role === "user" ? [messages[messages.length - 1]] : []
    let middle = messages.slice(systemMsgs.length, messages.length - lastUser.length)

    // 格式化中间消息
    // 注意：传入的 messages 经 chat.js#handleTool 构造，历史只会是 role: 'user' / 'assistant'
    // （见 chat.js 调用点：chatHistory.map 已把每条消息映射成 user 或 assistant），
    // 不会出现 role: 'tool'。如未来要把工具调用记录回灌进历史，再补对应分支。
    const formattedLines = []

    for (let i = 0; i < middle.length; i++) {
      const msg = middle[i]

      if (msg.role === "user" && msg.content) {
        if (!msg.content.startsWith("【系统提示】")) {
          formattedLines.push(msg.content)
        }
      } else if (msg.role === "assistant" && msg.content) {
        if (!msg.content.startsWith("【系统提示】")) {
          const assistantContent = msg.content.length > 200
            ? msg.content.substring(0, 200) + "..."
            : msg.content
          formattedLines.push(`[Bot回复]: ${assistantContent}`)
        }
      }
    }

    const formatted = formattedLines.join("\n")

    return [
      ...systemMsgs,
      formatted ? { role: "user", content: `当前QQ群[${e.group_id}]的群聊历史记录：\n${formatted}` } : null,
      { role: "assistant", content: "【系统提示】: 收到，我会根据历史记录和最新消息回复，需要时调用工具" },
      ...lastUser
    ].filter(Boolean)
  }
,
  /**
   * 格式化工具返回结果（截断过长内容）
   */
  formatToolResult(content, toolName) {
    if (!content) return "执行完成"
    let result = typeof content === "string" ? content : JSON.stringify(content)
    const maxLength = {
      searchInformationTool: 500,
      webParserTool: 500,
      chatHistoryTool: 800,
      default: 300
    }

    const limit = maxLength[toolName] || maxLength.default

    if (result.length > limit) {
      result = result.substring(0, limit) + "...(内容已截断)"
    }

    if (result.includes("成功")) {
      return "✓ " + result
    } else if (result.includes("失败") || result.includes("错误")) {
      return "✗ " + result
    }

    return result
  }
,
  processToolSpecificMessage(content, toolName) {
    let output = sanitizeFinalReplyText(content.replace(/\n/g, "\n"))

    // 过滤消息记录格式（多行全局匹配）
    // 匹配如: "[2026-01-27 16:12:51] 哈基米(QQ号: 2127498644)[群身份: member]: 以后注意点。"
    // 或: "[01-27 16:12:51] 哈基米(QQ号: xxx)[群身份: xxx]: 在群里说: xxx"（旧历史数据格式）
    // 或: "[16:11:11] 哈基米(QQ号: xxx)[群身份: xxx]: 在群里说: xxx"
    // 或: "[YYYY-MM-DD HH:MM:SS] 迈(QQ号: xxx)[群身份: xxx]: xxx"（AI输出的模板格式）
    output = output.replace(/\[(?:[A-Z]{4}-[A-Z]{2}-[A-Z]{2}\s+[A-Z]{2}:[A-Z]{2}:[A-Z]{2}|[A-Z]{2}-[A-Z]{2}\s+[A-Z]{2}:[A-Z]{2}:[A-Z]{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2})\]\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\][:：]\s*(?:艾特了\s*[^(\n]+\((?:QQ号|qq号)[:：]\s*\d+\)\[群身份[:：]\s*\w+\])?\s*(?:在群里说[:：]\s*)?[^\n]*/gi, '')

    // 清理模式
    const patterns = [
      /$$图片$$/g,
      /[\s\S]在群里说[:：]\s/g,
      /\[(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\]\s*.?[:：]\s/g,
      /[\s\S]*?/g
    ]

    for (const p of patterns) output = output.replace(p, "").trim()
    // 提取消息内容
    const match = /$$群身份: .+?$$[:：]\s*(.)/i.exec(output)
    if (match) output = match[1]
    output = output.replace(/^[说說][:：]\s/, "")

    output = ThinkingProcessor.removeThinking(output)
    output = output.replace(/!?$$(.*?)$$(.∗?)(.∗?)/g, "$1\n- $2")
    // 清理多余空行
    output = output.replace(/\n{3,}/g, '\n').trim()
    return sanitizeFinalReplyText(output)
  }
}
