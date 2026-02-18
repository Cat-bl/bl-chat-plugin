import { AbstractTool } from './AbstractTool.js'
import { mcpManager } from '../../utils/MCPClient.js'

// 内存缓存原始 e 对象，重启后丢失则降级用 fakeEvent
const eventCache = new Map()

const REDIS_KEY_PREFIX = 'bl-chat:reminder:'
const PENDING_LIST_KEY = `${REDIS_KEY_PREFIX}pending:list`
const LOCK_KEY = `${REDIS_KEY_PREFIX}lock`
const LOCK_TIMEOUT = 5000 // 锁超时时间（毫秒）

/**
 * 简单的分布式锁实现
 */
async function acquireLock(timeout = LOCK_TIMEOUT) {
  const lockValue = Date.now().toString()
  const endTime = Date.now() + timeout

  while (Date.now() < endTime) {
    const existing = await redis.get(LOCK_KEY)

    // 检查是否有过期的锁
    if (existing) {
      const lockTime = parseInt(existing)
      if (Date.now() - lockTime > LOCK_TIMEOUT) {
        // 锁已过期，强制获取
        await redis.set(LOCK_KEY, lockValue)
        return lockValue
      }
      // 等待一小段时间后重试
      await new Promise(resolve => setTimeout(resolve, 50))
      continue
    }

    // 尝试获取锁
    await redis.set(LOCK_KEY, lockValue)
    return lockValue
  }

  return null // 获取锁超时
}

async function releaseLock(lockValue) {
  const current = await redis.get(LOCK_KEY)
  if (current === lockValue) {
    await redis.del(LOCK_KEY)
  }
}

/**
 * 获取待触发提醒列表
 */
async function getPendingList() {
  try {
    const data = await redis.get(PENDING_LIST_KEY)
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

/**
 * 保存待触发提醒列表
 */
async function savePendingList(list) {
  await redis.set(PENDING_LIST_KEY, JSON.stringify(list))
}

/**
 * 带锁的列表操作
 */
async function withLock(operation) {
  const lockValue = await acquireLock()
  if (!lockValue) {
    throw new Error('获取锁超时')
  }
  try {
    return await operation()
  } finally {
    await releaseLock(lockValue)
  }
}

/**
 * 定时提醒工具类
 * 支持相对时间（如"15分钟后"）和绝对时间（如"1月27号下午5点"）
 */
export class ReminderTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'reminderTool'
    this.description = `创建定时提醒。用户说"X秒后提醒我..."、"X分钟后提醒我..."、"X点提醒我..."时调用此工具。
支持精确到秒的时间（如10秒后、30秒后）、相对时间(如15分钟后、1小时后)和绝对时间(如下午5点、1月27号17:00)。
你需要将用户描述的时间转换为ISO 8601格式，当前北京时间会在系统提示中提供。
如果用户要求提醒时执行额外操作（如发歌、戳一戳），可以在extra_action中指定当前可用的任何工具。`
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'cancel'],
          description: '操作类型：create创建提醒，list查看提醒列表，cancel取消提醒'
        },
        reminder_time: {
          type: 'string',
          description: '提醒时间，ISO 8601格式（如"2026-01-27T17:00:00+08:00"）。相对时间需根据当前北京时间计算后转换。注意要包含时区信息（+08:00表示北京时间）。创建提醒时必填。'
        },
        content: {
          type: 'string',
          description: '提醒事项的简短描述，用于记录和列表显示。创建提醒时必填。'
        },
        reminder_message: {
          type: 'string',
          description: '提醒时发送的消息内容。请用自然、口语化的方式写，不要太正式，要非常像人类的口吻。'
        },
        extra_action: {
          type: 'object',
          description: '额外操作，提醒时同时执行的工具。可使用当前会话中任何可用的工具（本地工具或MCP工具）',
          properties: {
            tool: {
              type: 'string',
              description: '要调用的工具名'
            },
            params: {
              type: 'object',
              description: '工具参数，根据目标工具的参数定义填写'
            }
          }
        },
        reminder_id: {
          type: 'string',
          description: '提醒ID，取消提醒时需要提供'
        }
      },
      required: ['action']
    }
  }

  /**
   * 生成提醒ID
   */
  generateId(userId) {
    return `rem_${Date.now()}_${userId}`
  }

  /**
   * 获取 Redis key
   */
  getRedisKey(type, id) {
    return `${REDIS_KEY_PREFIX}${type}:${id}`
  }

  /**
   * 解析时间字符串为时间戳
   */
  parseTime(timeStr) {
    try {
      // 如果没有时区信息，假定为北京时间
      let normalizedTimeStr = timeStr
      if (!timeStr.includes('+') && !timeStr.includes('Z') && !timeStr.includes('-', 10)) {
        normalizedTimeStr = timeStr + '+08:00'
      }

      const date = new Date(normalizedTimeStr)
      if (isNaN(date.getTime())) {
        return null
      }
      return date.getTime()
    } catch {
      return null
    }
  }

  /**
   * 格式化时间显示（北京时间）
   */
  formatTime(timestamp) {
    const date = new Date(timestamp)
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    return `${month}月${day}日 ${hours}:${minutes}:${seconds}`
  }

  /**
   * 创建提醒
   */
  async createReminder(e, timeStr, content, reminderMessage, extraAction = null) {
    if (!timeStr) {
      return '创建提醒失败：未提供提醒时间'
    }
    if (!content) {
      return '创建提醒失败：未提供提醒内容'
    }

    const triggerTime = this.parseTime(timeStr)
    if (!triggerTime) {
      return `创建提醒失败：无法解析时间 "${timeStr}"`
    }

    const now = Date.now()
    if (triggerTime <= now) {
      return '创建提醒失败：提醒时间必须是将来的时间'
    }

    const reminderId = this.generateId(e.user_id)
    eventCache.set(reminderId, e)
    const reminderData = {
      id: reminderId,
      user_id: String(e.user_id),
      group_id: e.group_id ? String(e.group_id) : null,
      message_id: e.message_id || null,
      content: content,
      reminder_message: reminderMessage || null,  // 保存自定义提醒消息
      trigger_time: triggerTime,
      created_at: now,
      status: 'pending',
      extra_action: extraAction || null,
      retry_count: 0
    }

    try {
      // 存储提醒详情
      await redis.set(
        this.getRedisKey('detail', reminderId),
        JSON.stringify(reminderData)
      )

      // 带锁添加到待触发列表
      await withLock(async () => {
        const pendingList = await getPendingList()
        pendingList.push({
          id: reminderId,
          trigger_time: triggerTime
        })
        // 按时间排序
        pendingList.sort((a, b) => a.trigger_time - b.trigger_time)
        await savePendingList(pendingList)
      })

      const formattedTime = this.formatTime(triggerTime)
      let response = `提醒已创建！我会在 ${formattedTime} 提醒你：${content}`
      if (extraAction?.tool) {
        const toolNames = {
          searchMusicTool: '发送音乐',
          pokeTool: '戳一戳',
          voiceTool: '发送语音'
        }
        response += `（届时还会${toolNames[extraAction.tool] || '执行额外操作'}）`
      }
      response += `\n提醒ID: ${reminderId}`

      return response
    } catch (error) {
      eventCache.delete(reminderId)
      logger.error('[ReminderTool] 创建提醒失败:', error)
      return `创建提醒失败：${error.message}`
    }
  }

  /**
   * 查看提醒列表
   */
  async listReminders(e) {
    try {
      const pendingList = await getPendingList()
      const userReminders = []

      for (const item of pendingList) {
        const data = await redis.get(this.getRedisKey('detail', item.id))
        if (data) {
          const reminder = JSON.parse(data)
          if (reminder.user_id === String(e.user_id) && reminder.status === 'pending') {
            userReminders.push(reminder)
          }
        }
      }

      if (userReminders.length === 0) {
        return '你没有待执行的提醒'
      }

      // 按触发时间排序
      userReminders.sort((a, b) => a.trigger_time - b.trigger_time)

      let response = `你有 ${userReminders.length} 个待执行的提醒：\n`
      userReminders.forEach((r, i) => {
        const time = this.formatTime(r.trigger_time)
        response += `\n${i + 1}. [${time}] ${r.content}`
        if (r.extra_action?.tool) {
          const toolNames = {
            searchMusicTool: '发送音乐',
            pokeTool: '戳一戳',
            voiceTool: '发送语音'
          }
          response += ` (附带${toolNames[r.extra_action.tool] || '额外操作'})`
        }
        response += `\n   ID: ${r.id}`
      })

      return response
    } catch (error) {
      logger.error('[ReminderTool] 查看提醒列表失败:', error)
      return `查看提醒失败：${error.message}`
    }
  }

  /**
   * 取消提醒
   */
  async cancelReminder(e, reminderId) {
    if (!reminderId) {
      return '取消提醒失败：未提供提醒ID'
    }

    try {
      const data = await redis.get(this.getRedisKey('detail', reminderId))
      if (!data) {
        return `取消提醒失败：未找到ID为 ${reminderId} 的提醒`
      }

      const reminder = JSON.parse(data)

      // 验证是否是该用户的提醒（管理员可以取消任何提醒）
      if (reminder.user_id !== String(e.user_id) && !e.isMaster) {
        return '取消提醒失败：你只能取消自己的提醒'
      }

      // 带锁从待触发列表移除
      await withLock(async () => {
        const pendingList = await getPendingList()
        const newList = pendingList.filter(item => item.id !== reminderId)
        await savePendingList(newList)
      })

      // 删除 detail 数据（清理垃圾）
      await redis.del(this.getRedisKey('detail', reminderId))
      eventCache.delete(reminderId)

      return `已取消提醒：${reminder.content}`
    } catch (error) {
      logger.error('[ReminderTool] 取消提醒失败:', error)
      return `取消提醒失败：${error.message}`
    }
  }

  /**
   * 执行工具
   */
  async func(opts, e) {
    const { action, reminder_time, content, reminder_message, extra_action, reminder_id } = opts

    switch (action) {
      case 'create':
        return await this.createReminder(e, reminder_time, content, reminder_message, extra_action)
      case 'list':
        return await this.listReminders(e)
      case 'cancel':
        return await this.cancelReminder(e, reminder_id)
      default:
        return `未知操作：${action}`
    }
  }
}

/**
 * 检查并触发到期的提醒
 * 此函数由 test.js 的定时任务调用
 */
export async function checkPendingReminders(toolInstances) {
  try {
    const now = Date.now()

    // 带锁获取并立即移除到期的提醒（防止重复触发）
    const dueReminders = await withLock(async () => {
      const pendingList = await getPendingList()

      if (!pendingList || pendingList.length === 0) {
        return []
      }

      // 找出所有到期的提醒
      const due = pendingList.filter(item => item.trigger_time <= now)

      if (due.length === 0) {
        return []
      }

      // 立即从列表中移除（先移除再处理，防止下一秒 cron 重复触发）
      const remaining = pendingList.filter(item => item.trigger_time > now)
      await savePendingList(remaining)

      return due
    })

    if (dueReminders.length === 0) {
      return
    }

    logger.info(`[ReminderTool] 发现 ${dueReminders.length} 个到期提醒`)

    // 逐个处理提醒
    for (const item of dueReminders) {
      try {
        const success = await triggerReminder(item.id, toolInstances)
        if (!success) {
          // 失败的重新添加回列表，延迟10秒重试
          await addBackToListForRetry(item.id)
        }
      } catch (error) {
        logger.error(`[ReminderTool] 触发提醒 ${item.id} 失败:`, error)
        await addBackToListForRetry(item.id)
      }
    }

  } catch (error) {
    logger.error('[ReminderTool] 检查待触发提醒失败:', error)
  }
}

/**
 * 将失败的提醒重新添加到列表等待重试
 */
async function addBackToListForRetry(reminderId) {
  const MAX_RETRY = 3

  try {
    await withLock(async () => {
      const pendingList = await getPendingList()

      // 检查是否已存在（避免重复添加）
      if (pendingList.some(item => item.id === reminderId)) {
        return
      }

      // 检查重试次数
      const detailData = await redis.get(`${REDIS_KEY_PREFIX}detail:${reminderId}`)
      if (!detailData) {
        return
      }

      const detail = JSON.parse(detailData)
      detail.retry_count = (detail.retry_count || 0) + 1

      if (detail.retry_count >= MAX_RETRY) {
        logger.error(`[ReminderTool] 提醒 ${reminderId} 重试 ${MAX_RETRY} 次后仍失败，已放弃`)
        detail.status = 'failed'
        await redis.set(`${REDIS_KEY_PREFIX}detail:${reminderId}`, JSON.stringify(detail))
        return
      }

      // 更新重试次数
      await redis.set(`${REDIS_KEY_PREFIX}detail:${reminderId}`, JSON.stringify(detail))

      // 延迟10秒重试
      pendingList.push({
        id: reminderId,
        trigger_time: Date.now() + 10000
      })
      pendingList.sort((a, b) => a.trigger_time - b.trigger_time)
      await savePendingList(pendingList)

      logger.info(`[ReminderTool] 提醒 ${reminderId} 将在 10 秒后重试（第 ${detail.retry_count} 次）`)
    })
  } catch (error) {
    logger.error(`[ReminderTool] 重新添加提醒到列表失败:`, error)
  }
}

/**
 * 触发单个提醒
 * @returns {boolean} 是否成功
 */
async function triggerReminder(reminderId, toolInstances) {
  const data = await redis.get(`${REDIS_KEY_PREFIX}detail:${reminderId}`)
  if (!data) {
    return true // 数据不存在，视为已处理
  }

  const reminder = JSON.parse(data)

  if (reminder.status !== 'pending') {
    return true // 已处理过
  }

  try {
    // 先处理额外操作（调用工具）
    if (reminder.extra_action?.tool) {
      const { tool, params } = reminder.extra_action

      try {
        // 优先使用内存缓存的原始 e，重启后降级构造 fakeEvent
        const cachedEvent = eventCache.get(reminderId)
        const fakeEvent = cachedEvent || {
          group_id: reminder.group_id ? Number(reminder.group_id) : null,
          user_id: Number(reminder.user_id),
          sender: {
            user_id: Number(reminder.user_id),
            nickname: '定时提醒用户'
          },
          message_type: reminder.group_id ? 'group' : 'private',
          self_id: Bot?.uin,
          bot: Bot,
          group: reminder.group_id ? Bot?.pickGroup?.(Number(reminder.group_id)) : null,
          isGroup: !!reminder.group_id,
          reply: reminder.group_id
            ? Bot?.pickGroup?.(Number(reminder.group_id))?.sendMsg?.bind(Bot.pickGroup(Number(reminder.group_id)))
            : Bot?.pickFriend?.(Number(reminder.user_id))?.sendMsg?.bind(Bot.pickFriend(Number(reminder.user_id)))
        }

        // 合并用户 QQ 到 params（如 pokeTool 需要 target）
        const mergedParams = { ...(params || {}) }
        if (tool === 'pokeTool' && !mergedParams.target) {
          mergedParams.target = [reminder.user_id]
        }

        // 判断是 MCP 工具还是本地工具
        if (mcpManager?.isMCPTool?.(tool)) {
          // MCP 工具
          const realToolName = mcpManager.getRealToolName(tool)
          await mcpManager.executeTool(realToolName, mergedParams)
          logger.info(`[ReminderTool] 已执行 MCP 工具: ${tool}`)
        } else if (toolInstances?.[tool]) {
          // 本地工具
          await toolInstances[tool].execute(mergedParams, fakeEvent)
          logger.info(`[ReminderTool] 已执行本地工具: ${tool}`)
        } else {
          logger.warn(`[ReminderTool] 未找到工具: ${tool}`)
        }
      } catch (error) {
        logger.error(`[ReminderTool] 执行额外操作 ${tool} 失败:`, error)
        // 额外操作失败不影响提醒消息发送
      }

      // 延迟一秒后发送提醒消息
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // 再发送提醒消息（引用回复）
    // 优先使用自定义消息，否则使用默认格式
    const messageText = reminder.reminder_message || `提醒你：${reminder.content}`

    if (reminder.group_id) {
      const message = []
      // 如果有原消息ID，添加引用
      if (reminder.message_id) {
        message.push({ type: 'reply', data: { id: String(reminder.message_id) } })
      }
      message.push({ type: 'at', data: { qq: String(reminder.user_id) } })
      message.push({ type: 'text', data: { text: ` ${messageText}` } })

      await Bot.sendApi('send_group_msg', {
        group_id: Number(reminder.group_id),
        message: message
      })
    } else {
      const message = []
      if (reminder.message_id) {
        message.push({ type: 'reply', data: { id: String(reminder.message_id) } })
      }
      message.push({ type: 'text', data: { text: messageText } })

      await Bot.sendApi('send_private_msg', {
        user_id: Number(reminder.user_id),
        message: message
      })
    }

    logger.info(`[ReminderTool] 已发送提醒给用户 ${reminder.user_id}: ${reminder.content}`)

    // 更新状态为已完成
    reminder.status = 'completed'
    await redis.set(
      `${REDIS_KEY_PREFIX}detail:${reminderId}`,
      JSON.stringify(reminder)
    )

    // 延迟删除 detail 数据（保留 1 分钟用于调试）
    setTimeout(async () => {
      try {
        await redis.del(`${REDIS_KEY_PREFIX}detail:${reminderId}`)
      } catch (e) {
        // 忽略删除失败
      }
    }, 60000)

    eventCache.delete(reminderId)

    return true

  } catch (error) {
    logger.error(`[ReminderTool] 发送提醒消息失败:`, error)
    return false
  }
}
