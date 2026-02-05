/**
 * 情感系统管理器
 * 每个群独立的情绪状态，影响机器人回复风格
 */
export class EmotionManager {
  constructor(config = {}) {
    this.REDIS_PREFIX = 'ytbot:emotion:'
    this.config = {
      decayRate: config.decayRate || 0.02,
      eventWeights: {
        praised: 0.1,
        scolded: -0.15,
        ignored: -0.05,
        mentioned: 0.05,
        conversation: 0.02,
        ...config.eventWeights
      }
    }
    this.defaultState = {
      mood: 0.6,
      energy: 0.7,
      lastUpdate: Date.now(),
      recentEvents: []
    }

    // 正面词汇
    this.positiveWords = [
      '谢谢', '感谢', '厉害', '棒', '好棒', '牛', '强', '优秀', '可爱',
      '喜欢', '爱你', '好人', '帮大忙', '太好了', '真棒', 'nb', 'nice',
      '赞', '666', '很好', '不错', '聪明', '机智'
    ]

    // 负面词汇
    this.negativeWords = [
      '傻', '笨', '蠢', '废物', '垃圾', '滚', '闭嘴', '烦', '讨厌',
      '无聊', '没用', '菜', '差劲', '恶心', '丑', '弱智', '智障'
    ]
  }

  /**
   * 获取 Redis Key
   */
  getRedisKey(groupId) {
    return `${this.REDIS_PREFIX}${groupId}`
  }

  /**
   * 获取指定群的情绪状态
   */
  async getEmotion(groupId) {
    try {
      const key = this.getRedisKey(groupId)
      const data = await redis.get(key)

      if (data) {
        const state = JSON.parse(data)
        // 应用时间衰减
        return this.applyDecay(state)
      }

      return { ...this.defaultState }
    } catch (error) {
      logger.error(`[情感系统] 获取情绪失败: ${error}`)
      return { ...this.defaultState }
    }
  }

  /**
   * 保存情绪状态
   */
  async saveEmotion(groupId, state) {
    try {
      const key = this.getRedisKey(groupId)
      state.lastUpdate = Date.now()
      await redis.set(key, JSON.stringify(state), { EX: 7 * 24 * 60 * 60 }) // 7天过期
    } catch (error) {
      logger.error(`[情感系统] 保存情绪失败: ${error}`)
    }
  }

  /**
   * 应用时间衰减（情绪向中性回归）
   */
  applyDecay(state) {
    const now = Date.now()
    const hoursPassed = (now - state.lastUpdate) / (1000 * 60 * 60)

    if (hoursPassed < 0.1) return state // 不到6分钟不衰减

    const decayAmount = this.config.decayRate * hoursPassed

    // mood 向 0.5 回归
    if (state.mood > 0.5) {
      state.mood = Math.max(0.5, state.mood - decayAmount)
    } else if (state.mood < 0.5) {
      state.mood = Math.min(0.5, state.mood + decayAmount)
    }

    // energy 向 0.7 回归
    if (state.energy > 0.7) {
      state.energy = Math.max(0.7, state.energy - decayAmount)
    } else if (state.energy < 0.7) {
      state.energy = Math.min(0.7, state.energy + decayAmount)
    }

    state.lastUpdate = now
    return state
  }

  /**
   * 分析消息内容，判断情绪事件类型
   */
  analyzeMessage(content, isAtBot = false) {
    if (!content) return null

    const lowerContent = content.toLowerCase()

    // 检测正面词汇
    for (const word of this.positiveWords) {
      if (lowerContent.includes(word)) {
        return 'praised'
      }
    }

    // 检测负面词汇
    for (const word of this.negativeWords) {
      if (lowerContent.includes(word)) {
        return 'scolded'
      }
    }

    // 被@
    if (isAtBot) {
      return 'mentioned'
    }

    // 普通对话
    return 'conversation'
  }

  /**
   * 更新指定群的情绪
   */
  async updateEmotion(groupId, event, customDelta = null) {
    try {
      const state = await this.getEmotion(groupId)
      const delta = customDelta !== null ? customDelta : (this.config.eventWeights[event] || 0)

      // 更新 mood
      state.mood = Math.max(0, Math.min(1, state.mood + delta))

      // 更新 energy（对话消耗精力，被夸增加精力）
      if (event === 'conversation') {
        state.energy = Math.max(0, Math.min(1, state.energy - 0.01))
      } else if (event === 'praised') {
        state.energy = Math.max(0, Math.min(1, state.energy + 0.03))
      } else if (event === 'scolded') {
        state.energy = Math.max(0, Math.min(1, state.energy - 0.05))
      }

      // 记录最近事件（保留最近10条）
      state.recentEvents.unshift({
        event,
        delta,
        time: Date.now()
      })
      if (state.recentEvents.length > 10) {
        state.recentEvents = state.recentEvents.slice(0, 10)
      }

      await this.saveEmotion(groupId, state)

      logger.debug(`[情感系统] 群${groupId} 情绪更新: ${event} (${delta > 0 ? '+' : ''}${delta}) → mood=${state.mood.toFixed(2)}, energy=${state.energy.toFixed(2)}`)

      return state
    } catch (error) {
      logger.error(`[情感系统] 更新情绪失败: ${error}`)
      return this.defaultState
    }
  }

  /**
   * 根据消息内容自动更新情绪
   */
  async updateEmotionFromMessage(groupId, content, isAtBot = false) {
    const event = this.analyzeMessage(content, isAtBot)
    if (event) {
      return await this.updateEmotion(groupId, event)
    }
    return await this.getEmotion(groupId)
  }

  /**
   * 生成情绪描述（注入到 prompt）
   */
  getEmotionPrompt(state) {
    const prompts = []

    // 心情描述
    if (state.mood >= 0.8) {
      prompts.push('你现在心情非常好，回复充满热情和活力')
    } else if (state.mood >= 0.7) {
      prompts.push('你现在心情不错，回复积极友好')
    } else if (state.mood <= 0.2) {
      prompts.push('你现在心情很低落，回复简短冷淡')
    } else if (state.mood <= 0.35) {
      prompts.push('你现在有点不开心，回复比较敷衍')
    }

    // 精力描述
    if (state.energy <= 0.2) {
      prompts.push('你现在很累，想尽快结束对话')
    } else if (state.energy <= 0.4) {
      prompts.push('你现在有点疲惫，回复简洁')
    }

    return prompts.length > 0 ? prompts.join('，') : ''
  }

  /**
   * 获取情绪状态并生成 prompt
   */
  async getEmotionPromptForGroup(groupId) {
    const state = await this.getEmotion(groupId)
    return this.getEmotionPrompt(state)
  }
}
