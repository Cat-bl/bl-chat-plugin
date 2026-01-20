import { AbstractTool } from './AbstractTool.js'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { getRedBagType } from '../../utils/redBagUtils.js'

/**
 * 抢红包工具类
 * 当用户让机器人抢红包时调用（支持引用红包消息或自动查找最近红包）
 */
export class GrabRedBagTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'grabRedBagTool'
    this.description = '抢红包工具。当用户让机器人抢红包时调用此工具，支持引用红包消息或自动查找群内最近的红包。'
    this.parameters = {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: '确认执行抢红包操作',
          default: true
        }
      }
    }
  }

  /**
   * 获取配置中的 groupMaxMessages
   */
  getGroupMaxMessages() {
    try {
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml')
      if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, 'utf8'))
        return config?.pluginSettings?.groupMaxMessages || 100
      }
    } catch (err) {
      // ignore
    }
    return 100
  }

  /**
   * 从消息中提取红包元素
   */
  extractWalletFromMessage(msg) {
    const message = msg.message || msg.msg || []
    for (const seg of message) {
      if (seg.type === 'wallet') {
        return {
          wallet: seg.data || seg,
          msgSeq: msg.message_seq || msg.seq || ''
        }
      }
    }
    return null
  }

  /**
   * 从群历史消息中查找最近的红包
   */
  async findRecentRedBag(bot, groupId) {
    try {
      const count = this.getGroupMaxMessages()
      const history = await bot.sendApi('get_group_msg_history', {
        group_id: groupId,
        count
      })

      const messages = history?.data?.messages || []
      // 从最新消息开始找
      for (const msg of messages.reverse()) {
        const result = this.extractWalletFromMessage(msg)
        if (result) {
          return result
        }
      }
    } catch (err) {
      console.error('获取群历史消息失败:', err)
    }
    return null
  }

  /**
   * 执行抢红包
   */
  async func(opts, e) {
    const bot = e.bot ?? Bot
    const groupId = e.group_id

    if (!groupId) {
      return '此功能仅支持群聊使用'
    }

    let walletElement = null
    let msgSeq = ''

    // 1. 优先从引用消息获取红包
    let replyMsg = null
    try {
      if (e.getReply) {
        replyMsg = await e.getReply()
      }
    } catch (err) {
      // ignore
    }

    if (!replyMsg) {
      const replyId = e.reply_id || e.source?.message_id || e.source?.seq
      if (replyId) {
        try {
          const sourceMsg = await bot.sendApi('get_msg', { message_id: replyId })
          if (sourceMsg?.data) {
            replyMsg = sourceMsg.data
          }
        } catch (err) {
          // ignore
        }
      }
    }

    // 从引用消息中提取红包
    if (replyMsg) {
      const result = this.extractWalletFromMessage(replyMsg)
      if (result) {
        walletElement = result.wallet
        msgSeq = result.msgSeq
      }
    }

    // 2. 如果引用消息没有红包，从最近群消息中查找
    if (!walletElement) {
      const result = await this.findRecentRedBag(bot, groupId)
      if (result) {
        walletElement = result.wallet
        msgSeq = result.msgSeq
      }
    }

    if (!walletElement) {
      return '没有找到红包，请引用红包消息或确认群内最近有红包'
    }

    const title = walletElement.title || '红包'
    const redBagType = getRedBagType(walletElement)

    try {
      // 口令红包：先发送口令
      if (redBagType.type === 'password' && title) {
        try {
          await bot.pickGroup(groupId).sendMsg(title)
          // 等待一小段时间让服务器处理
          await new Promise(resolve => setTimeout(resolve, 500))
        } catch (err) {
          console.error('发送口令失败:', err)
        }
      }

      const result = await bot.sendApi('grab_red_bag', {
        recv_uin: String(groupId),
        recv_type: 2,
        peer_uid: String(groupId),
        name: bot.nickname || 'Bot',
        pc_body: walletElement.pc_body || '',
        wishing: walletElement.title || '',
        msg_seq: walletElement.msg_seq || String(msgSeq || ''),
        index: walletElement.string_index || ''
      })

      const grabResult = result?.data?.result?.grabRedBagRsp
      if (grabResult?.recvdOrder?.amount && grabResult.recvdOrder.amount !== '0') {
        const amount = parseInt(grabResult.recvdOrder.amount) / 100
        return `抢到了「${title}」红包，金额: ${amount}元`
      } else if (grabResult?.result === 7) {
        return `抢「${title}」红包失败：红包已被抢完或已过期`
      } else if (grabResult?.result === 0 && (!grabResult?.recvdOrder?.amount || grabResult.recvdOrder.amount === '0')) {
        return `抢「${title}」红包失败：可能已经抢过了`
      } else {
        return `抢「${title}」红包失败，错误码: ${grabResult?.result || '未知'}`
      }
    } catch (err) {
      if (err.message?.includes('超时')) {
        return `抢「${title}」红包请求超时，可能红包已被抢完`
      }
      return `抢红包出错: ${err.message}`
    }
  }
}
