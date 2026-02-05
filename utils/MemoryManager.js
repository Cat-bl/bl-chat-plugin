/**
 * 长期记忆管理器
 * 每群每用户独立的记忆存储，按类别分组
 */
export class MemoryManager {
  constructor(config = {}) {
    this.REDIS_PREFIX = 'ytbot:memory:'
    this.config = {
      maxFactsPerUser: config.maxFactsPerUser || 100,
      importanceThreshold: config.importanceThreshold || 0.5,
      memoryDecayDays: config.memoryDecayDays || 7,
      memoryAiConfig: config.memoryAiConfig || null
    }

    // 类别定义
    this.CATEGORIES = ['identity', 'likes', 'dislikes', 'relationship', 'habits', 'skills', 'experience']

    // 类别中文映射
    this.CATEGORY_LABELS = {
      identity: '用户身份',
      likes: '用户喜好',
      dislikes: '用户讨厌',
      relationship: '用户关系',
      habits: '用户习惯',
      skills: '用户技能',
      experience: '用户经历'
    }

    this.defaultMemory = {
      categorizedFacts: this.createEmptyCategorizedFacts(),
      relationshipScore: 0.5,
      nickname: null,
      lastUpdate: Date.now()
    }
  }

  /**
   * 创建空的分类记忆结构
   */
  createEmptyCategorizedFacts() {
    const facts = {}
    for (const cat of this.CATEGORIES) {
      facts[cat] = []
    }
    return facts
  }

  /**
   * 设置 AI 配置（用于记忆提取）
   */
  setAiConfig(aiConfig) {
    this.config.memoryAiConfig = aiConfig
  }

  /**
   * 获取 Redis Key
   */
  getRedisKey(groupId, userId) {
    return `${this.REDIS_PREFIX}${groupId}:${userId}`
  }

  /**
   * 获取用户在指定群的记忆
   */
  async getUserMemory(groupId, userId) {
    try {
      const key = this.getRedisKey(groupId, userId)
      const data = await redis.get(key)

      if (data) {
        let memory = JSON.parse(data)

        // 兼容旧数据：将 facts 迁移到 categorizedFacts
        if (memory.facts?.length && !memory.categorizedFacts) {
          memory = this.migrateOldMemory(memory)
          await this.saveUserMemory(groupId, userId, memory)
        }

        // 确保 categorizedFacts 结构完整
        if (!memory.categorizedFacts) {
          memory.categorizedFacts = this.createEmptyCategorizedFacts()
        }
        for (const cat of this.CATEGORIES) {
          if (!memory.categorizedFacts[cat]) {
            memory.categorizedFacts[cat] = []
          }
        }

        // 兼容旧字段名
        if (memory.relationship !== undefined && memory.relationshipScore === undefined) {
          memory.relationshipScore = memory.relationship
          delete memory.relationship
        }

        return this.applyMemoryDecay(memory)
      }

      return JSON.parse(JSON.stringify(this.defaultMemory))
    } catch (error) {
      logger.error(`[长期记忆] 获取记忆失败: ${error}`)
      return JSON.parse(JSON.stringify(this.defaultMemory))
    }
  }

  /**
   * 迁移旧数据（facts → categorizedFacts）
   */
  migrateOldMemory(memory) {
    const categorizedFacts = this.createEmptyCategorizedFacts()

    // 旧的 facts 全部放入 identity 类别（无法判断类别）
    if (memory.facts?.length) {
      for (const fact of memory.facts) {
        categorizedFacts.identity.push(fact)
      }
    }

    // 迁移旧的 preferences
    if (memory.preferences?.likes?.length) {
      for (const like of memory.preferences.likes) {
        categorizedFacts.likes.push({
          content: like,
          importance: 0.7,
          createdAt: Date.now(),
          lastUsed: Date.now()
        })
      }
    }
    if (memory.preferences?.dislikes?.length) {
      for (const dislike of memory.preferences.dislikes) {
        categorizedFacts.dislikes.push({
          content: dislike,
          importance: 0.7,
          createdAt: Date.now(),
          lastUsed: Date.now()
        })
      }
    }

    return {
      categorizedFacts,
      relationshipScore: memory.relationship ?? memory.relationshipScore ?? 0.5,
      nickname: memory.nickname || null,
      lastUpdate: Date.now()
    }
  }

  /**
   * 保存用户记忆
   */
  async saveUserMemory(groupId, userId, memory) {
    try {
      const key = this.getRedisKey(groupId, userId)
      memory.lastUpdate = Date.now()
      await redis.set(key, JSON.stringify(memory), { EX: 90 * 24 * 60 * 60 })
    } catch (error) {
      logger.error(`[长期记忆] 保存记忆失败: ${error}`)
    }
  }

  /**
   * 应用记忆衰减（长时间未使用的记忆降低重要性）
   */
  applyMemoryDecay(memory) {
    const now = Date.now()
    const decayThreshold = this.config.memoryDecayDays * 24 * 60 * 60 * 1000

    for (const cat of this.CATEGORIES) {
      if (!memory.categorizedFacts[cat]) continue

      memory.categorizedFacts[cat] = memory.categorizedFacts[cat]
        .map(fact => {
          const timeSinceUsed = now - (fact.lastUsed || fact.createdAt)
          if (timeSinceUsed > decayThreshold) {
            const decayPeriods = Math.floor(timeSinceUsed / decayThreshold)
            fact.importance = Math.max(0.1, fact.importance - decayPeriods * 0.1)
          }
          return fact
        })
        .filter(fact => fact.importance >= this.config.importanceThreshold)
    }

    return memory
  }

  /**
   * 添加记忆（带类别）
   */
  async addMemory(groupId, userId, content, importance = 0.6, category = 'identity') {
    try {
      const memory = await this.getUserMemory(groupId, userId)

      // 确保类别有效
      if (!this.CATEGORIES.includes(category)) {
        category = 'identity'
      }

      // 在该类别中检查是否已存在相似记忆
      const categoryFacts = memory.categorizedFacts[category]
      const existingIndex = categoryFacts.findIndex(f =>
        this.isSimilarContent(f.content, content)
      )

      const now = Date.now()

      if (existingIndex >= 0) {
        categoryFacts[existingIndex].importance = Math.min(1, categoryFacts[existingIndex].importance + 0.1)
        categoryFacts[existingIndex].lastUsed = now
        logger.debug(`[长期记忆] 更新已有记忆 [${category}]: ${content}`)
      } else {
        categoryFacts.push({
          content,
          importance,
          createdAt: now,
          lastUsed: now
        })
        logger.info(`[长期记忆] 新增记忆 [${category}]: ${content} (重要性: ${importance})`)
      }

      // 该类别按重要性排序
      categoryFacts.sort((a, b) => b.importance - a.importance)

      // 总记忆数限制
      this.trimTotalFacts(memory)

      await this.saveUserMemory(groupId, userId, memory)
      return true
    } catch (error) {
      logger.error(`[长期记忆] 添加记忆失败: ${error}`)
      return false
    }
  }

  /**
   * 控制总记忆数不超过上限
   */
  trimTotalFacts(memory) {
    let total = 0
    for (const cat of this.CATEGORIES) {
      total += (memory.categorizedFacts[cat]?.length || 0)
    }

    if (total <= this.config.maxFactsPerUser) return

    // 收集所有记忆并按重要性排序，移除最不重要的
    const allFacts = []
    for (const cat of this.CATEGORIES) {
      for (const fact of memory.categorizedFacts[cat]) {
        allFacts.push({ ...fact, _category: cat })
      }
    }
    allFacts.sort((a, b) => a.importance - b.importance)

    const toRemove = total - this.config.maxFactsPerUser
    const removeSet = new Set(allFacts.slice(0, toRemove).map(f => `${f._category}:${f.content}`))

    for (const cat of this.CATEGORIES) {
      memory.categorizedFacts[cat] = memory.categorizedFacts[cat]
        .filter(f => !removeSet.has(`${cat}:${f.content}`))
    }
  }

  /**
   * 判断两条记忆内容是否相似
   */
  isSimilarContent(content1, content2) {
    if (!content1 || !content2) return false

    const s1 = content1.toLowerCase()
    const s2 = content2.toLowerCase()

    if (s1.includes(s2) || s2.includes(s1)) return true

    const words1 = new Set(s1.split(/\s+/))
    const words2 = new Set(s2.split(/\s+/))
    const intersection = [...words1].filter(w => words2.has(w))
    const union = new Set([...words1, ...words2])
    const similarity = intersection.length / union.size

    return similarity > 0.6
  }

  /**
   * 更新亲密度
   */
  async updateRelationship(groupId, userId, delta) {
    try {
      const memory = await this.getUserMemory(groupId, userId)
      memory.relationshipScore = Math.max(0, Math.min(1, (memory.relationshipScore || 0.5) + delta))
      await this.saveUserMemory(groupId, userId, memory)
      return memory.relationshipScore
    } catch (error) {
      logger.error(`[长期记忆] 更新亲密度失败: ${error}`)
      return 0.5
    }
  }

  /**
   * 标记记忆被使用（更新 lastUsed）
   */
  async touchMemory(groupId, userId, content) {
    try {
      const memory = await this.getUserMemory(groupId, userId)
      for (const cat of this.CATEGORIES) {
        const fact = memory.categorizedFacts[cat]?.find(f => f.content === content)
        if (fact) {
          fact.lastUsed = Date.now()
          await this.saveUserMemory(groupId, userId, memory)
          return
        }
      }
    } catch (error) {
      logger.error(`[长期记忆] 标记记忆使用失败: ${error}`)
    }
  }

  /**
   * 生成记忆提示（注入到 prompt）- 按类别分组输出
   */
  formatMemoryPrompt(memory) {
    const prompts = []

    // 按类别输出记忆
    for (const cat of this.CATEGORIES) {
      const facts = memory.categorizedFacts?.[cat]
      if (!facts?.length) continue

      const topFacts = facts
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 5)
        .map(f => f.content)

      prompts.push(`【${this.CATEGORY_LABELS[cat]}】${topFacts.join('、')}`)
    }

    // 添加昵称
    if (memory.nickname) {
      prompts.push(`【你给TA起的昵称】${memory.nickname}`)
    }

    // 添加亲密度描述
    const score = memory.relationshipScore ?? 0.5
    if (score >= 0.8) {
      prompts.push('你们关系很好，是老朋友了')
    } else if (score <= 0.3) {
      prompts.push('你们不太熟，保持礼貌')
    }

    return prompts.join('\n')
  }

  /**
   * 获取用户记忆并生成 prompt
   */
  async getMemoryPromptForUser(groupId, userId) {
    const memory = await this.getUserMemory(groupId, userId)
    return this.formatMemoryPrompt(memory)
  }

  /**
   * 使用 AI 从对话中提取值得记忆的信息（带类别）
   */
  async extractAndSaveMemories(groupId, userId, userMessage, botReply) {
    if (!this.config.memoryAiConfig) {
      logger.debug('[长期记忆] 未配置 memoryAiConfig，跳过记忆提取')
      return
    }

    try {
      const { memoryAiUrl, memoryAiModel, memoryAiApikey } = this.config.memoryAiConfig

      if (!memoryAiUrl || !memoryAiApikey) {
        return
      }

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
              content: `你是记忆提取助手，从用户消息中提取值得长期记住的个人信息。

【提取类型与分类】
- identity: 身份（职业、学历、年龄段、性别、所在地）
- likes: 喜欢的事物（兴趣、爱好、喜欢的游戏/食物等）
- dislikes: 讨厌的事物（不喜欢的东西）
- relationship: 人际关系（感情状态、家庭成员、宠物）
- habits: 习惯（作息、饮食、行为模式）
- skills: 技能（擅长的事）
- experience: 经历/事件（重要事件）

【不要提取】
- 临时状态：今天很累、正在吃饭、刚睡醒
- 普通闲聊：哈哈、好的、emmm
- 提问内容：用户问的问题本身

【重要性评分】
- 0.9-1.0：核心身份（职业、性别、所在城市）
- 0.7-0.8：稳定喜好（长期兴趣、讨厌的事物）
- 0.5-0.6：一般信息（习惯、技能）

【输出格式】
- 用简洁的陈述句，如"程序员"而不是"用户是一个程序员"
- 返回 JSON 数组：[{"content": "信息", "category": "分类", "importance": 0.8}]
- category 必须是以上7个分类之一
- 无有效信息时返回 []
- 只输出 JSON，不要其他内容`
            },
            {
              role: 'user',
              content: `用户消息：${userMessage}\n\n请提取值得记忆的信息：`
            }
          ],
          temperature: 0.3,
          max_tokens: 300
        })
      })

      if (!response.ok) {
        logger.error(`[长期记忆] AI 请求失败: ${response.status}`)
        return
      }

      const data = await response.json()
      let content = data?.choices?.[0]?.message?.content?.trim() || '[]'

      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const memories = JSON.parse(content)

      if (Array.isArray(memories) && memories.length > 0) {
        for (const mem of memories) {
          if (mem.content && mem.importance >= 0.5) {
            const category = this.CATEGORIES.includes(mem.category) ? mem.category : 'identity'
            await this.addMemory(groupId, userId, mem.content, mem.importance, category)
          }
        }
        logger.info(`[长期记忆] 从对话中提取了 ${memories.length} 条记忆`)
      }
    } catch (error) {
      logger.error(`[长期记忆] 提取记忆失败: ${error}`)
    }
  }

  /**
   * 清除用户在指定群的所有记忆
   */
  async clearUserMemory(groupId, userId) {
    try {
      const key = this.getRedisKey(groupId, userId)
      await redis.del(key)
      logger.info(`[长期记忆] 已清除 群${groupId} 用户${userId} 的记忆`)
    } catch (error) {
      logger.error(`[长期记忆] 清除记忆失败: ${error}`)
    }
  }
}
