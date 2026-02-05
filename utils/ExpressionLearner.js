/**
 * 表达学习管理器
 * 学习群友的说话风格，支持 AI 场景化学习
 */
export class ExpressionLearner {
  constructor(config = {}) {
    this.REDIS_PREFIX = 'ytbot:expression:'
    this.config = {
      minWordFrequency: config.minWordFrequency || 3,
      maxWords: config.maxWords || 50,
      blockedWords: config.blockedWords || [],
      aiLearningEnabled: config.aiLearningEnabled !== false,
      aiLearningMessageThreshold: config.aiLearningMessageThreshold || 50,
      memoryAiConfig: config.memoryAiConfig || null
    }

    // 通用词过滤列表（不记录这些词）
    this.commonWords = new Set([
      '的', '是', '了', '在', '我', '你', '他', '她', '它', '们',
      '有', '和', '与', '这', '那', '就', '也', '都', '而', '及',
      '着', '或', '一个', '没有', '不是', '什么', '怎么', '为什么',
      '可以', '能', '会', '要', '想', '去', '来', '到', '从', '把',
      '被', '让', '给', '对', '说', '看', '做', '用', '很', '太',
      '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈', '嘿', '哎',
      '好', '行', '对', '是的', '不', '没', '别', '请', '谢谢',
      // 消息格式相关词（防止从格式中提取）
      'qq', 'member', 'admin', 'owner', 'id',
      '消息', '群身份', '在群里', '群里说', '回复了', '艾特了',
      '发送了', '一张图片', '张图片', '表情', '发送了表情'
    ])

    // 敏感词过滤
    this.sensitiveWords = new Set([
      ...this.config.blockedWords
    ])

    // 消息计数器
    this.messageCounters = new Map()
    // 消息缓存（用于 AI 学习）
    this.pendingMessages = new Map()
  }

  /**
   * 获取 Redis Key
   */
  getRedisKey(groupId) {
    return `${this.REDIS_PREFIX}${groupId}`
  }

  /**
   * 获取群表达特征
   */
  async getGroupExpressions(groupId) {
    try {
      const key = this.getRedisKey(groupId)
      const data = await redis.get(key)

      if (data) {
        return JSON.parse(data)
      }

      return {
        words: {},
        patterns: [],
        emojis: {},
        messageCount: 0,
        styleExpressions: [],
        lastAiLearnTime: 0,
        lastUpdate: Date.now()
      }
    } catch (error) {
      logger.error(`[表达学习] 获取表达特征失败: ${error}`)
      return { words: {}, patterns: [], emojis: {}, messageCount: 0, styleExpressions: [], lastAiLearnTime: 0, lastUpdate: Date.now() }
    }
  }

  /**
   * 保存群表达特征
   */
  async saveGroupExpressions(groupId, expressions) {
    try {
      const key = this.getRedisKey(groupId)
      expressions.lastUpdate = Date.now()
      await redis.set(key, JSON.stringify(expressions), { EX: 30 * 24 * 60 * 60 })
    } catch (error) {
      logger.error(`[表达学习] 保存表达特征失败: ${error}`)
    }
  }

  /**
   * 提取消息中的特征词
   */
  extractWords(content) {
    if (!content || typeof content !== 'string') return []

    let text = content.replace(/https?:\/\/[^\s]+/g, '')
    text = text.replace(/@[^\s]+/g, '')
    text = text.replace(/\[CQ:[^\]]+\]/g, '')

    const words = []

    const chinesePattern = /[\u4e00-\u9fa5]{2,6}/g
    const chineseMatches = text.match(chinesePattern) || []
    words.push(...chineseMatches)

    const englishPattern = /[a-zA-Z]{2,10}/gi
    const englishMatches = text.match(englishPattern) || []
    words.push(...englishMatches.map(w => w.toLowerCase()))

    const slangPattern = /[a-zA-Z0-9]{2,6}/gi
    const slangMatches = text.match(slangPattern) || []
    words.push(...slangMatches.map(w => w.toLowerCase()))

    return words.filter(word => {
      if (this.commonWords.has(word)) return false
      if (this.sensitiveWords.has(word)) return false
      if (/^\d+$/.test(word)) return false
      if (word.length < 2) return false
      return true
    })
  }

  /**
   * 提取表情符号
   */
  extractEmojis(content) {
    if (!content) return []
    const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
    return content.match(emojiPattern) || []
  }

  /**
   * 提取句式特征
   */
  extractPatterns(content) {
    if (!content) return []

    const patterns = []

    if (content.includes('...')) patterns.push('...')
    if (/吧$/.test(content)) patterns.push('...吧')
    if (/啊$/.test(content)) patterns.push('...啊')
    if (/呢$/.test(content)) patterns.push('...呢')
    if (/哈哈+/.test(content)) patterns.push('哈哈')
    if (/笑死/.test(content)) patterns.push('笑死')
    if (/啊这/.test(content)) patterns.push('啊这')
    if (/无语/.test(content)) patterns.push('无语')
    if (/绝了/.test(content)) patterns.push('绝了')
    if (/真的假的/.test(content)) patterns.push('真的假的')
    if (/确实/.test(content)) patterns.push('确实')
    if (/属于是/.test(content)) patterns.push('属于是')

    return patterns
  }

  /**
   * 更新群表达特征
   */
  async updateGroupExpressions(groupId, content) {
    try {
      const counter = this.messageCounters.get(groupId) || 0
      this.messageCounters.set(groupId, counter + 1)

      // 缓存消息用于 AI 学习
      if (this.config.aiLearningEnabled && content) {
        const pending = this.pendingMessages.get(groupId) || []
        pending.push(content)
        // 只保留最近的消息
        if (pending.length > this.config.aiLearningMessageThreshold) {
          pending.shift()
        }
        this.pendingMessages.set(groupId, pending)
      }

      // 词频统计：每5条消息更新一次
      if (counter % 5 === 0) {
        const expressions = await this.getGroupExpressions(groupId)
        expressions.messageCount = (expressions.messageCount || 0) + 5

        const words = this.extractWords(content)
        const emojis = this.extractEmojis(content)
        const patterns = this.extractPatterns(content)

        for (const word of words) {
          expressions.words[word] = (expressions.words[word] || 0) + 1
        }

        for (const emoji of emojis) {
          expressions.emojis[emoji] = (expressions.emojis[emoji] || 0) + 1
        }

        for (const pattern of patterns) {
          if (!expressions.patterns.includes(pattern)) {
            expressions.patterns.push(pattern)
          }
        }

        if (Object.keys(expressions.words).length > this.config.maxWords * 2) {
          const sorted = Object.entries(expressions.words)
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.config.maxWords)
          expressions.words = Object.fromEntries(sorted)
        }

        if (Object.keys(expressions.emojis).length > 20) {
          const sorted = Object.entries(expressions.emojis)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
          expressions.emojis = Object.fromEntries(sorted)
        }

        await this.saveGroupExpressions(groupId, expressions)
      }

      // AI 场景化学习：达到消息阈值时触发
      if (this.config.aiLearningEnabled && this.config.memoryAiConfig) {
        const pending = this.pendingMessages.get(groupId) || []
        if (pending.length >= this.config.aiLearningMessageThreshold) {
          // 异步执行，不阻塞
          this.learnStyleWithAI(groupId, [...pending]).catch(err => {
            logger.error(`[表达学习] AI 学习失败: ${err}`)
          })
          this.pendingMessages.set(groupId, [])
        }
      }
    } catch (error) {
      logger.error(`[表达学习] 更新表达特征失败: ${error}`)
    }
  }

  /**
   * 使用 AI 从消息样本中提取场景化表达
   */
  async learnStyleWithAI(groupId, messages) {
    const { memoryAiUrl, memoryAiModel, memoryAiApikey } = this.config.memoryAiConfig

    if (!memoryAiUrl || !memoryAiApikey) return

    try {
      const messageSample = messages
        .filter(m => m && m.length > 1 && m.length < 200)
        .slice(-100)
        .join('\n')

      if (!messageSample) return

      const response = await fetch(memoryAiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${memoryAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: memoryAiModel || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `分析以下群聊消息样本，提取群友的表达习惯。

【任务】
归纳群友在不同情境下的常用表达方式，只提取有特色的、非通用的表达。

【输出格式】
返回 JSON 数组：
[
  {"situation": "表示赞叹", "expressions": ["绝绝子", "yyds"]},
  {"situation": "表示无语", "expressions": ["笑死", "绷不住"]}
]

【注意】
- situation 用简短的中文描述（4-8字）
- expressions 只提取群里实际出现的词/短语
- 不要提取通用词（好、行、嗯、哦等）
- 最多返回 5 个场景
- 无明显规律时返回 []
- 只输出 JSON，不要其他内容`
            },
            {
              role: 'user',
              content: `群聊消息样本：\n${messageSample}`
            }
          ],
          temperature: 0.3,
          max_tokens: 400
        })
      })

      if (!response.ok) {
        logger.error(`[表达学习] AI 请求失败: ${response.status}`)
        return
      }

      const data = await response.json()
      let content = data?.choices?.[0]?.message?.content?.trim() || '[]'

      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const styleResults = JSON.parse(content)

      if (!Array.isArray(styleResults) || styleResults.length === 0) return

      const expressions = await this.getGroupExpressions(groupId)

      // 合并新学到的表达
      const existingStyles = expressions.styleExpressions || []

      for (const newStyle of styleResults) {
        if (!newStyle.situation || !newStyle.expressions?.length) continue

        const existingIndex = existingStyles.findIndex(s =>
          s.situation === newStyle.situation
        )

        if (existingIndex >= 0) {
          // 合并表达，去重
          const merged = new Set([
            ...existingStyles[existingIndex].expressions,
            ...newStyle.expressions
          ])
          existingStyles[existingIndex].expressions = [...merged].slice(0, 6)
          existingStyles[existingIndex].count = (existingStyles[existingIndex].count || 0) + 1
        } else {
          existingStyles.push({
            situation: newStyle.situation,
            expressions: newStyle.expressions.slice(0, 6),
            count: 1
          })
        }
      }

      // 最多保留 10 个场景，按 count 排序
      expressions.styleExpressions = existingStyles
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 10)

      expressions.lastAiLearnTime = Date.now()
      await this.saveGroupExpressions(groupId, expressions)

      logger.info(`[表达学习] 群${groupId} AI 学习完成，提取了 ${styleResults.length} 个场景`)
    } catch (error) {
      logger.error(`[表达学习] AI 学习失败: ${error}`)
    }
  }

  /**
   * 生成表达提示（注入到 prompt）
   */
  formatExpressionPrompt(expressions) {
    const prompts = []

    // 优先使用场景化表达
    if (expressions.styleExpressions?.length > 0) {
      const styleLines = expressions.styleExpressions
        .slice(0, 5)
        .map(s => `- ${s.situation}时，群友常说${s.expressions.map(e => `"${e}"`).join('、')}`)

      prompts.push(`【群聊表达风格】\n${styleLines.join('\n')}`)
    } else {
      // 兜底：使用词频统计
      const topWords = Object.entries(expressions.words || {})
        .filter(([_, count]) => count >= this.config.minWordFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word]) => word)

      if (topWords.length > 0) {
        prompts.push(`【群里常用词】${topWords.join('、')}`)
      }

      if (expressions.patterns?.length > 0) {
        const topPatterns = expressions.patterns.slice(0, 5)
        prompts.push(`【常见句式】${topPatterns.join('、')}`)
      }
    }

    // 常用 emoji（两种模式都展示）
    const topEmojis = Object.entries(expressions.emojis || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([emoji]) => emoji)

    if (topEmojis.length > 0) {
      prompts.push(`【常用表情】${topEmojis.join('')}`)
    }

    if (prompts.length > 0) {
      prompts.push('适当使用这些表达方式让回复更自然，但不要生硬堆砌')
    }

    return prompts.join('\n')
  }

  /**
   * 获取表达特征并生成 prompt
   */
  async getExpressionPromptForGroup(groupId) {
    const expressions = await this.getGroupExpressions(groupId)
    return this.formatExpressionPrompt(expressions)
  }

  /**
   * 添加自定义屏蔽词
   */
  addBlockedWords(words) {
    for (const word of words) {
      this.sensitiveWords.add(word)
    }
  }
}
