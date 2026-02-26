/**
 * 长期记忆管理器
 * 每群每用户独立的记忆存储，按类别分组
 */
export class MemoryManager {
  constructor(config = {}) {
    this.REDIS_PREFIX = 'ytbot:memory:'
    this.config = {
      maxFactsPerUser: config.maxFactsPerUser || 100,
      maxFactsPerGroup: config.maxFactsPerGroup || 50,
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

    // 群全局记忆类别
    this.GROUP_CATEGORIES = ['topic', 'rule', 'meme', 'event', 'member']

    // 群全局记忆类别中文映射
    this.GROUP_CATEGORY_LABELS = {
      topic: '群话题偏好',
      rule: '群规/约定',
      meme: '群内梗/流行语',
      event: '群内重要事件',
      member: '群成员共识'
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
              content: `你是记忆提取助手，从用户消息中尽可能多地提取值得记住的个人信息。宁可多提取也不要遗漏。

【提取类型与分类】
- identity: 身份（职业、学历、年龄段、性别、所在地、名字/网名）
- likes: 喜欢的事物（兴趣、爱好、喜欢的游戏/动漫/音乐/食物/人物等）
- dislikes: 讨厌的事物（不喜欢的东西、反感的事）
- relationship: 人际关系（感情状态、家庭成员、宠物、朋友）
- habits: 习惯（作息、饮食、口头禅、行为模式、消费习惯）
- skills: 技能（擅长的事、在学的东西）
- experience: 经历/事件（近期发生的事、过去的重要经历、计划要做的事）

【积极提取以下内容】
- 用户提到的任何个人信息、偏好、观点
- 用户的情绪倾向和态度（如"讨厌加班"、"最近很开心"）
- 用户的近况和计划（如"下周要考试"、"最近在学日语"）
- 用户提到的人际关系（如"我女朋友"、"我室友"）
- 用户的日常习惯（如"每天跑步"、"熬夜党"）

【不要提取】
- 纯粹的语气词：哈哈、好的、emmm、嗯嗯
- 对机器人的提问本身（如"你觉得呢"）

【重要性评分】
- 0.8-1.0：核心身份（职业、性别、所在城市、名字）
- 0.6-0.8：喜好和关系（兴趣、讨厌的事、家人朋友宠物）
- 0.4-0.6：一般信息（近况、习惯、计划、观点）

【输出格式】
- 用简洁的陈述句，如"程序员"而不是"用户是一个程序员"
- 返回 JSON 数组：[{"content": "信息", "category": "分类", "importance": 0.7}]
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
          if (mem.content && mem.importance >= 0.3) {
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

  // ==================== 群全局记忆 ====================

  /**
   * 获取群全局记忆 Redis Key
   */
  getGroupRedisKey(groupId) {
    return `${this.REDIS_PREFIX}group:${groupId}`
  }

  /**
   * 创建空的群全局记忆分类结构
   */
  createEmptyGroupCategorizedFacts() {
    const facts = {}
    for (const cat of this.GROUP_CATEGORIES) {
      facts[cat] = []
    }
    return facts
  }

  /**
   * 获取群全局记忆
   */
  async getGroupMemory(groupId) {
    try {
      const key = this.getGroupRedisKey(groupId)
      const data = await redis.get(key)

      if (data) {
        let memory = JSON.parse(data)
        if (!memory.categorizedFacts) {
          memory.categorizedFacts = this.createEmptyGroupCategorizedFacts()
        }
        for (const cat of this.GROUP_CATEGORIES) {
          if (!memory.categorizedFacts[cat]) {
            memory.categorizedFacts[cat] = []
          }
        }
        return this.applyGroupMemoryDecay(memory)
      }

      return { categorizedFacts: this.createEmptyGroupCategorizedFacts(), lastUpdate: Date.now() }
    } catch (error) {
      logger.error(`[群全局记忆] 获取记忆失败: ${error}`)
      return { categorizedFacts: this.createEmptyGroupCategorizedFacts(), lastUpdate: Date.now() }
    }
  }

  /**
   * 保存群全局记忆
   */
  async saveGroupMemory(groupId, memory) {
    try {
      const key = this.getGroupRedisKey(groupId)
      memory.lastUpdate = Date.now()
      await redis.set(key, JSON.stringify(memory), { EX: 90 * 24 * 60 * 60 })
    } catch (error) {
      logger.error(`[群全局记忆] 保存记忆失败: ${error}`)
    }
  }

  /**
   * 应用群全局记忆衰减
   */
  applyGroupMemoryDecay(memory) {
    const now = Date.now()
    const decayThreshold = this.config.memoryDecayDays * 24 * 60 * 60 * 1000

    for (const cat of this.GROUP_CATEGORIES) {
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
   * 添加群全局记忆
   */
  async addGroupMemory(groupId, content, importance = 0.6, category = 'topic') {
    try {
      const memory = await this.getGroupMemory(groupId)

      if (!this.GROUP_CATEGORIES.includes(category)) {
        category = 'topic'
      }

      const categoryFacts = memory.categorizedFacts[category]
      const existingIndex = categoryFacts.findIndex(f =>
        this.isSimilarContent(f.content, content)
      )

      const now = Date.now()

      if (existingIndex >= 0) {
        categoryFacts[existingIndex].importance = Math.min(1, categoryFacts[existingIndex].importance + 0.1)
        categoryFacts[existingIndex].lastUsed = now
        logger.debug(`[群全局记忆] 更新已有记忆 [${category}]: ${content}`)
      } else {
        categoryFacts.push({ content, importance, createdAt: now, lastUsed: now })
        logger.info(`[群全局记忆] 新增记忆 [${category}]: ${content} (重要性: ${importance})`)
      }

      categoryFacts.sort((a, b) => b.importance - a.importance)
      this.trimGroupTotalFacts(memory)
      await this.saveGroupMemory(groupId, memory)
      return true
    } catch (error) {
      logger.error(`[群全局记忆] 添加记忆失败: ${error}`)
      return false
    }
  }

  /**
   * 控制群全局记忆总数不超过上限
   */
  trimGroupTotalFacts(memory) {
    let total = 0
    for (const cat of this.GROUP_CATEGORIES) {
      total += (memory.categorizedFacts[cat]?.length || 0)
    }

    if (total <= this.config.maxFactsPerGroup) return

    const allFacts = []
    for (const cat of this.GROUP_CATEGORIES) {
      for (const fact of memory.categorizedFacts[cat]) {
        allFacts.push({ ...fact, _category: cat })
      }
    }
    allFacts.sort((a, b) => a.importance - b.importance)

    const toRemove = total - this.config.maxFactsPerGroup
    const removeSet = new Set(allFacts.slice(0, toRemove).map(f => `${f._category}:${f.content}`))

    for (const cat of this.GROUP_CATEGORIES) {
      memory.categorizedFacts[cat] = memory.categorizedFacts[cat]
        .filter(f => !removeSet.has(`${cat}:${f.content}`))
    }
  }

  /**
   * 生成群全局记忆 prompt
   */
  async getGroupMemoryPrompt(groupId) {
    const memory = await this.getGroupMemory(groupId)
    const prompts = []

    for (const cat of this.GROUP_CATEGORIES) {
      const facts = memory.categorizedFacts?.[cat]
      if (!facts?.length) continue

      const topFacts = facts
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 5)
        .map(f => f.content)

      prompts.push(`【${this.GROUP_CATEGORY_LABELS[cat]}】${topFacts.join('、')}`)
    }

    if (!prompts.length) return ''
    return `【群共识记忆】\n${prompts.join('\n')}`
  }

  /**
   * 使用 AI 从对话中提取群级别信息
   */
  async extractAndSaveGroupMemories(groupId, userMessage, senderName) {
    if (!this.config.memoryAiConfig) return

    try {
      const { memoryAiUrl, memoryAiModel, memoryAiApikey } = this.config.memoryAiConfig
      if (!memoryAiUrl || !memoryAiApikey) return

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
              content: `你是群记忆提取助手，从群聊消息中尽可能多地提取值得记住的群级别信息。宁可多提取也不要遗漏。

【提取类型与分类】
- topic: 群话题偏好（群里在讨论什么话题、关注什么领域）
- rule: 群规/约定（群内的规则、共识、约定）
- meme: 群内梗/流行语（群里流行的梗、口头禅、玩笑、表情包含义）
- event: 群内事件（群活动、发生的事情、值得纪念的瞬间）
- member: 群成员相关（某人的特点、昵称、擅长的事、人物关系）

【积极提取以下内容】
- 群友讨论的任何具体话题和领域
- 群友之间的互动关系、称呼
- 群里反复出现的梗、流行语、口头禅
- 群友提到的群内事件、约定
- 对某个群成员的评价或共识（如"xx很会做饭"）
- 群友共同的兴趣和喜好

【不要提取】
- 纯粹的语气词：哈哈、好的、emmm、嗯嗯
- 与群无关的纯个人私密信息

【重要性评分】
- 0.8-1.0：群规、长期共识、群成员公认特点
- 0.6-0.8：群内梗、话题偏好、群成员关系
- 0.4-0.6：一般话题、临时事件

【输出格式】
- 返回 JSON 数组：[{"content": "信息", "category": "分类", "importance": 0.7}]
- category 必须是以上5个分类之一
- 无有效信息时返回 []
- 只输出 JSON，不要其他内容`
            },
            {
              role: 'user',
              content: `发言者: ${senderName || '未知'}\n消息内容：${userMessage}\n\n请提取值得记忆的群级别信息：`
            }
          ],
          temperature: 0.3,
          max_tokens: 300
        })
      })

      if (!response.ok) {
        logger.error(`[群全局记忆] AI 请求失败: ${response.status}`)
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
          if (mem.content && mem.importance >= 0.3) {
            const category = this.GROUP_CATEGORIES.includes(mem.category) ? mem.category : 'topic'
            await this.addGroupMemory(groupId, mem.content, mem.importance, category)
          }
        }
        logger.info(`[群全局记忆] 从对话中提取了 ${memories.length} 条群记忆`)
      }
    } catch (error) {
      logger.error(`[群全局记忆] 提取记忆失败: ${error}`)
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
