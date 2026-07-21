// strict 模式会话追踪：用户与 bot 对话后的跟进窗口（activeConversations + 定时器）、
// 回复去抖、批量"是否在和 bot 说话"AI 判断。
// 以 mixin 形式挂到插件原型上，this 指向插件实例。
import { callAI } from "../../utils/apiClient.js"

// 会话追踪: key: `${groupId}_${userId}`, value: { lastActiveTime, chatHistory: [], timer: null }
// （handleRandomReply / handleTextResponse 也会读写，故导出）
export const activeConversations = new Map()
// 节流: key: `${groupId}_${userId}`, value: lastCallTime（handleRandomReply 也会读写，故导出）
export const trackingThrottle = new Map()
// strict 追踪回复去抖：key `${groupId}_${userId}` -> 该会话最近一条进入追踪判断的消息的单调序号。
// 用递增序号而非时间戳，避免同毫秒两条消息序号相等导致都触发。去抖醒来后若序号已被更晚
// 的消息刷新，则让步本条，只由最后一条触发回复（合并连发防刷屏）。
export const trackingLastMsgAt = new Map()
let trackingSeqCounter = 0
const pendingJudgments = [] // 批量判断队列
let batchTimer = null // 批量处理定时器
// strict 追踪判断 / smart Gate 的 trackAi 调用超时（毫秒）。
// trackAi 中转卡住时，避免 addToBatchJudgment 的 Promise 永不 resolve 导致处理协程泄漏。
const TRACK_AI_TIMEOUT_MS = 15000

export const strictTrackingMethods = {
  /**
   * 启动/重置用户独立的会话追踪定时器
   * @param {string} conversationKey - 会话key
   * @param {object} newData - 要更新的数据 { chatHistory, lastActiveTime }
   */
  setTrackingWithTimer(conversationKey, newData = {}) {
    const timeout = (this.config.conversationTrackingTimeout || 2) * 60000
    const activeConv = activeConversations.get(conversationKey)

    // 清除旧定时器
    if (activeConv?.timer) {
      clearTimeout(activeConv.timer)
    }

    // 创建新定时器
    const timer = setTimeout(() => {
      const conv = activeConversations.get(conversationKey)
      // 确保清除的是同一个定时器（防止竞态）
      if (conv?.timer === timer) {
        activeConversations.delete(conversationKey)
        trackingThrottle.delete(conversationKey)
        trackingLastMsgAt.delete(conversationKey)
        logger.info(`[会话追踪] ${conversationKey} 超时，已清除`)
      }
    }, timeout)

    // 原子操作：创建定时器后立即存储
    activeConversations.set(conversationKey, {
      lastActiveTime: Date.now(),
      chatHistory: activeConv?.chatHistory || [],
      ...newData,
      timer
    })
  },

  /**
   * 登记本条追踪消息为该会话最新，返回其单调序号。
   * 连发时后一条会拿到更大序号并覆盖登记，使前一条的去抖检测到"还有新消息"而让步。
   * @param {string} conversationKey `${groupId}_${userId}`
   * @returns {number} 本条消息的单调序号
   */
  markTrackingArrival(conversationKey) {
    const seq = ++trackingSeqCounter
    trackingLastMsgAt.set(conversationKey, seq)
    return seq
  },

  /**
   * strict 追踪回复去抖：判定为"在跟 bot 说话"后、真正触发 handleTool 前调用。
   * 等待 debounceMs 后看本条的序号是否仍是该会话最新：
   * - 已被更晚消息刷新（用户还在连发）→ 返回 false，让步给后面那条，避免对每条各回一次刷屏；
   * - 仍是最新（用户停下来了）→ 返回 true，由本条合并回复一次（handleTool 自带群历史，能看到连发的全部消息）。
   * debounceMs<=0 时视为关闭去抖，直接放行。
   * @param {string} conversationKey `${groupId}_${userId}`
   * @param {number} seq markTrackingArrival 返回的本条序号
   */
  async applyTrackingReplyDebounce(conversationKey, seq) {
    const debounceMs = Math.max(0, Number(this.config.conversationTrackingReplyDebounceMs) || 0)
    if (debounceMs <= 0) return true

    await new Promise(r => setTimeout(r, debounceMs))

    // 等待期间有更晚的同会话消息进来（序号更大）→ 让步（那条会自己走去抖）
    const latest = trackingLastMsgAt.get(conversationKey) || 0
    if (latest > seq) {
      logger.info(`[追踪去抖] ${conversationKey} 检测到连发新消息，让步本条，由最后一条合并回复`)
      return false
    }
    return true
  },

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(userMessage, chatHistory = []) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TRACK_AI_TIMEOUT_MS)
    try {
      const botName = Bot.nickname || '机器人'

      // 构建对话历史文本
      const historyText = chatHistory.length > 0
        ? chatHistory.map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        : '(无历史记录)'

      const result = await callAI(
        {
          url: this.config.trackAiConfig.trackAiUrl,
          model: this.config.trackAiConfig.trackAiModel,
          apikey: this.config.trackAiConfig.trackAiApikey
        },
        [
          {
            role: "system",
            content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"，QQ号${Bot.uin}。

根据对话历史，判断用户新消息是否在继续跟机器人对话。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续（机器人说"中午好"→用户问"吃什么"）
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群

你只回复 true 或 false，不要输出其他内容。
`
          },
          {
            role: "user",
            content: `【近期对话记录】\n${historyText}\n\n【用户新消息】\n${userMessage}\n\n这条新消息是在跟机器人说话吗？`
          }
        ],
        { signal: controller.signal }
      )

      if (result.error) return false // 请求失败时默认不触发

      const answer = result?.choices?.[0]?.message?.content?.toLowerCase()?.trim()
      // logger.error(answer, historyText, userMessage, 8888)
      return answer === 'true' || answer?.includes('true')
    } catch (error) {
      logger.error('[会话追踪] AI判断失败:', error)
      return false // 出错时默认不触发
    } finally {
      clearTimeout(timeoutId)
    }
  },

  /**
   * 加入批量判断队列
   */
  addToBatchJudgment(conversationKey, userMessage, chatHistory, e) {
    return new Promise(resolve => {
      pendingJudgments.push({ conversationKey, userMessage, chatHistory, e, resolve })

      if (!batchTimer) {
        const batchDelay = (this.config.batchJudgmentDelay || 3) * 1000
        batchTimer = setTimeout(() => this.processBatchJudgments(), batchDelay)
      }
    })
  },

  /**
   * 处理批量判断队列
   */
  async processBatchJudgments() {
    batchTimer = null
    if (pendingJudgments.length === 0) return

    const batch = pendingJudgments.splice(0)

    if (batch.length === 1) {
      const result = await this.isUserTalkingToBot(batch[0].userMessage, batch[0].chatHistory)
      batch[0].resolve(result)
      return
    }

    try {
      const results = await this.batchIsUserTalkingToBot(batch)
      batch.forEach((item, i) => item.resolve(results[i] || false))
    } catch (error) {
      logger.error('[批量判断] 失败:', error)
      batch.forEach(item => item.resolve(false))
    }
  },

  /**
   * 批量判断多条消息是否在跟机器人对话
   */
  async batchIsUserTalkingToBot(batch) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TRACK_AI_TIMEOUT_MS)
    try {
      const botName = Bot.nickname || '机器人'

      // 为每条消息生成唯一标识（含 groupId，避免跨群同 userId 碰撞）
      const batchWithIds = batch.map((item, i) => ({
        ...item,
        id: `MSG_${i + 1}_${item.e?.group_id || 'g'}_${item.e?.user_id || 'unknown'}`
      }))

      const messagesText = batchWithIds.map(item => {
        const recentHistory = (item.chatHistory || []).slice(-3).map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        const userName = item.e?.sender?.card || item.e?.sender?.nickname || '未知用户'
        return `【${item.id}】用户: ${userName}(QQ:${item.e?.user_id})
对话历史:
${recentHistory || '(无)'}
新消息: ${item.userMessage}
---`
      }).join('\n\n')

      const result = await callAI(
        {
          url: this.config.trackAiConfig.trackAiUrl,
          model: this.config.trackAiConfig.trackAiModel,
          apikey: this.config.trackAiConfig.trackAiApikey
        },
        [
          {
            role: "system",
            content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"。

每条消息来自不同用户，有独立的对话历史，请分别独立判断。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群
- 无对话历史且消息内容与机器人无关

返回JSON对象，key为消息ID，value为判断结果。
示例: {"MSG_1_123_12345": true, "MSG_2_123_67890": false}
只返回JSON对象，不要其他内容。`
          },
          {
            role: "user",
            content: `分别判断以下${batchWithIds.length}条来自不同用户的消息:\n\n${messagesText}\n\n返回JSON对象:`
          }
        ],
        { signal: controller.signal }
      )

      if (result.error) {
        // API 错误/超时：逐条 fallback 只会重复触发同样的故障（最坏 15×N 秒），直接全判 false
        logger.error('[批量判断] API请求失败，跳过逐条回退，全部按不触发处理:', result.error)
        return batch.map(() => false)
      }

      let content = result?.choices?.[0]?.message?.content?.trim() || '{}'

      // 提取JSON对象
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const resultsMap = JSON.parse(content)
      logger.info(`[批量判断] ${batch.length}条消息，结果: ${JSON.stringify(resultsMap)}`)

      // 按ID映射回结果数组
      const results = batchWithIds.map(item => {
        const result = resultsMap[item.id]
        if (result === undefined) {
          logger.warn(`[批量判断] 缺少ID ${item.id} 的结果，回退单独判断`)
          return null // 标记需要单独判断
        }
        return result === true || result === 'true'
      })

      // 检查是否有需要单独判断的
      const needsFallback = results.some(r => r === null)
      if (needsFallback) {
        return this.fallbackToSingleJudgment(batch, results)
      }

      return results
    } catch (error) {
      logger.error('[批量判断] 解析失败:', error)
      return this.fallbackToSingleJudgment(batch)
    } finally {
      clearTimeout(timeoutId)
    }
  },

  /**
   * 回退到单独判断
   */
  async fallbackToSingleJudgment(batch, partialResults = null) {
    logger.info(`[批量判断] 回退到单独判断，共${batch.length}条`)
    const results = []
    for (let i = 0; i < batch.length; i++) {
      if (partialResults && partialResults[i] !== null) {
        results.push(partialResults[i])
      } else {
        const result = await this.isUserTalkingToBot(batch[i].userMessage, batch[i].chatHistory)
        results.push(result)
      }
    }
    return results
  }
}
