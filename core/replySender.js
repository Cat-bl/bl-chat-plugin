// 最终回复发送：分段发送、消息切分、@转换、文本转图。
// 以 mixin 形式挂到插件原型上，this 指向插件实例。
import { isCodeOrMarkdownRequest, looksLikeCodeOrMarkdown, toolConfigHasName } from "./toolConfig.js"
import { sanitizeFinalReplyText } from "./pseudoToolSanitizer.js"
import { extractChatKeywords } from "./chatHeuristics.js"
import { TotalTokens } from "../functions/tools/CalculateToken.js"

export const replySenderMethods = {
  shouldUseTextImageForFinalReply({ content, output, session, toolName, e }) {
    if (toolName === "textImageTool") return false
    if (!toolConfigHasName(this.config.oneapi_tools, "textImageTool")) return false
    if (!this.toolInstances?.textImageTool?.execute) return false

    const userText = `${session?.userContent || ""}\n${e?.msg || ""}`
    const userAskedForCodeOrMarkdown = isCodeOrMarkdownRequest(userText)
    const replyLooksLikeCodeOrMarkdown = looksLikeCodeOrMarkdown(content) || looksLikeCodeOrMarkdown(output)

    return replyLooksLikeCodeOrMarkdown || (userAskedForCodeOrMarkdown && String(output || "").trim().length > 30)
  }
,
  async sendFinalReplyAsTextImage(e, output) {
    const tool = this.toolInstances?.textImageTool
    try {
      const result = await tool.execute({ text: output }, e)
      if (typeof result === "string" && result.trim().startsWith("error:")) {
        throw new Error(result)
      }
      logger.info("[textImageTool] 最终回复已转为图片发送")
      return null
    } catch (error) {
      logger.warn(`[textImageTool] 最终回复转图失败，回退为普通文本: ${error.message}`)
      return await this.sendSegmentedMessage(e, output)
    }
  }
,
  async sendSegmentedMessage(e, output, quoteChance = 0.5) {
    try {
      output = sanitizeFinalReplyText(output)
      if (!output) return null
      if (output.includes("\\n")) {
        logger.warn(`[分段发送] sanitize后仍含字面\\n! raw=${JSON.stringify(output).slice(0, 200)}`)
      }
      // smart 模式：发完话后记录 bot 上次发言时间和关键词，给 prefilter R1/R2 识别接续用
      const groupId = e?.group_id
      const triggerMode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (groupId && triggerMode === 'smart') {
        try {
          const st = this.getSmartState(groupId)
          st.lastBotReplyAt = Date.now()
          const maxKw = Number(this.config?.smartTrigger?.continuationKeywordMaxCount) || 5
          st.lastBotReplyKeywords = extractChatKeywords(output, maxKw)
        } catch (err) {
          logger.warn(`[SmartState] 记录 bot 发言失败：${err.message}`)
        }
      }
      // 主动搭话路径（smart 模式 Gate 非 force 触发）强制不引用：bot 像群友自然插话而非"回复某人"
      if (e?._proactiveReply && this.config?.smartTrigger?.proactiveReplyNoQuote !== false) {
        quoteChance = 0
      }
      const shouldQuote = Math.random() < quoteChance

      // @ 转换可能失败（group 对象过期等），失败时跳过不影响分段
      let groupForAt = null
      try {
        groupForAt = e.group
      } catch {}

      // 含 @ 时也要分段：先拆分再对每段单独处理 @
      const hasNewline = output.includes("\n")
      if (groupForAt && hasNewline) {
        try {
          const { hasAt } = await this.convertAtInString(output, groupForAt)
          if (hasAt) {
            const segments = this.splitMessage(output)
            let lastMessageId = null
            for (let i = 0; i < segments.length; i++) {
              const seg = segments[i]?.trim()
              if (!seg) continue
              const { hasAt: segHasAt, msgSegments } = await this.convertAtInString(seg, groupForAt)
              const quote = shouldQuote && i === 0
              if (segHasAt && msgSegments) {
                const res = await e.reply(msgSegments, quote)
                lastMessageId = res?.message_id
              } else {
                const res = await e.reply(seg, quote)
                lastMessageId = res?.message_id
              }
              if (i < segments.length - 1) {
                const typingSpeed = Number(this.config?.smartTrigger?.typingSpeed) || 0
                let delay
                if (typingSpeed > 0) {
                  delay = Math.min(Math.max(seg.length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
                } else {
                  delay = Math.min(1000 + seg.length * 5 + Math.random() * 500, 3000)
                }
                await new Promise(r => setTimeout(r, delay))
              }
            }
            return lastMessageId
          }
        } catch (err) {
          logger.warn(`[分段发送] @ 分段处理失败，走普通分段: ${err.message}`)
        }
      }

      // 无换行时含 @ 直接发（不需要分段）
      if (groupForAt && !hasNewline) {
        try {
          const { hasAt, msgSegments } = await this.convertAtInString(output, groupForAt)
          if (hasAt && msgSegments) {
            const res = await e.reply(msgSegments)
            return res?.message_id
          }
        } catch (err) {
          logger.warn(`[分段发送] convertAtInString 失败，跳过 @ 转换: ${err.message}`)
        }
      }

      // token 计算可能失败，失败时默认走分段逻辑
      let totalTokens = 999
      try {
        const result = await TotalTokens(output)
        totalTokens = result.total_tokens
      } catch (err) {
        logger.warn(`[分段发送] TotalTokens 计算失败，按需分段: ${err.message}`)
      }

      let lastMessageId = null
      if (totalTokens <= 10 && !hasNewline) {
        const res = await e.reply(output, shouldQuote)
        lastMessageId = res?.message_id
        return lastMessageId
      }

      const segments = this.splitMessage(output)
      for (let i = 0; i < segments.length; i++) {
        if (segments[i]?.trim()) {
          const quote = shouldQuote && i === 0
          const res = await e.reply(segments[i].trim(), quote)
          lastMessageId = res?.message_id

          if (i < segments.length - 1) {
            const typingSpeed = Number(this.config?.smartTrigger?.typingSpeed) || 0
            let delay
            if (typingSpeed > 0) {
              delay = Math.min(Math.max(segments[i].length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
            } else {
              delay = Math.min(1000 + segments[i].length * 5 + Math.random() * 500, 3000)
            }
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      return lastMessageId
    } catch (error) {
      logger.error(`[分段发送-异常] 走了catch兜底! error=${error?.message || error}, stack=${error?.stack?.slice(0, 300)}`)
      try {
        const fallbackSegments = output.split("\n").filter(s => s.trim())
        if (fallbackSegments.length > 1) {
          let lastId = null
          for (const seg of fallbackSegments) {
            const res = await e.reply(seg.trim())
            lastId = res?.message_id
          }
          return lastId
        }
      } catch {}
      const res = await e.reply(output)
      return res?.message_id
    }
  }
,
  splitMessage(text) {
    const punctuations = ["。", "！", "？", "；", "!", "?", ";", "\n"]
    const cqCodes = [], emojis = []
    let processed = text

    processed = processed.replace(/$$CQ:[^$$]+$$/g, m => { cqCodes.push(m); return `{{CQ${cqCodes.length - 1}}}` })
    processed = processed.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, m => { emojis.push(m); return `{{E${emojis.length - 1}}}` })
    processed = processed.replace(/\.{3,}|…+/g, "{{...}}")

    const idealLen = processed.length <= 300
      ? processed.length
      : Math.ceil(processed.length / Math.min(Math.ceil(processed.length / 300), 5))
    const points = []
    let last = 0

    for (let i = 0; i < processed.length; i++) {
      const ch = processed[i]
      if (ch === '\n') {
        // \n 是 LLM 显式的"换行/分段"意图，无视长度阈值无条件切（避免 16 字以下被 idealLen*0.7 卡住不分）
        if (i + 1 > last) {
          points.push(i + 1)
          last = i + 1
        }
      } else if (punctuations.includes(ch) && i - last + 1 >= idealLen * 0.7) {
        points.push(i + 1)
        last = i + 1
      }
    }

    const segments = []
    let start = 0
    for (const p of points) {
      if (p > start) { segments.push(processed.slice(start, p)); start = p }
    }
    if (start < processed.length) segments.push(processed.slice(start))

    return segments.map(s =>
      s.replace(/{{\.\.\.}}/g, "...")
        .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[i])
        .replace(/{{E(\d+)}}/g, (_, i) => emojis[i])
        .trim()
    )
  }
,
  async convertAtInString(content, group) {
    if (!group) return { result: content, hasAt: false, msgSegments: null }

    const members = await group.getMemberMap()
    const atList = []

    // 匹配 @QQ号 格式（5-11位纯数字）
    for (const match of content.matchAll(/@(\d{5,11})(?!\d)/g)) {
      const member = this.findMember(match[1], members)
      if (member) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    // 匹配 @昵称 格式（非数字开头，取到标点或空白为止）
    for (const match of content.matchAll(/@([^\s\d@，。！？、；：""''（）【】,.!?;:'"()\[\]]{1,20})/g)) {
      const member = this.findMember(match[1], members)
      if (member && !atList.some(a => a.qq === member.qq)) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    if (atList.length === 0) return { result: content, hasAt: false, msgSegments: null }

    // 按位置排序，构建消息段数组（@ 保持在原始位置）
    atList.sort((a, b) => a.index - b.index)
    const msgSegments = []
    let lastEnd = 0
    for (const at of atList) {
      if (at.index > lastEnd) {
        msgSegments.push(content.slice(lastEnd, at.index))
      }
      msgSegments.push(segment.at(at.qq))
      lastEnd = at.index + at.length
    }
    if (lastEnd < content.length) {
      msgSegments.push(content.slice(lastEnd))
    }

    return { result: content, hasAt: true, msgSegments }
  }
,
  findMember(target, members) {
    if (/^\d+$/.test(target)) {
      const member = members.get(Number(target))
      if (member) return { qq: Number(target), info: member }
    }

    const search = target.toLowerCase()
    for (const [qq, info] of members) {
      if ([info.card, info.nickname].some(n => n?.toLowerCase().includes(search))) {
        return { qq, info }
      }
    }
    return null
  }
}
