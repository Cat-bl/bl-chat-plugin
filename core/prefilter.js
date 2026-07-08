// smart 模式本地预筛（纯函数）：免 LLM 决定明显该回 / 不该回 / 高优先级走 Gate。
// 从 core/conversationTracker.js#prefilterMessage 拆出以便单测；
// botId 由调用方解析（e.bot.uin / Bot.uin），本模块不碰 Yunzai 全局。
import { isQuestionMessage, isFeedbackMessage } from "./chatHeuristics.js"

/**
 * @returns {{kind: string, reason: string}} kind 取值：
 *   'force_continue' - @ 了 bot（含裸 @ 无文本），应强制回复，绝不能被空文本/@ 他人检查吞掉
 *   'addressed_other' - 消息 @ 了非 bot
 *   'empty_content' - 纯表情/图片/转账，无文本
 *   'bot_self_echo' - bot 自己发的消息
 *   'continuation_strong' - 命中 R1/R2/R3/R4 任一，应走 Gate
 *   'regular' - 默认
 */
export function prefilterMessage(e, state = {}, smartCfg = {}, botId = null) {
  // bot 自己发的消息（防自激励）
  if (botId && String(e?.user_id) === String(botId)) {
    return { kind: 'bot_self_echo', reason: 'sender_is_self' }
  }
  // @ 检测：@bot 必须最优先识别并放行——裸 @（不带文字，e.msg 为空）
  // 不能落到下面的 empty_content 检查被当成"纯表情/图片"丢弃
  if (Array.isArray(e?.message)) {
    const atSegs = e.message.filter(m => m?.type === 'at')
    if (atSegs.length > 0) {
      const atSelf = atSegs.some(m => String(m?.qq) === String(botId))
      if (atSelf) {
        return { kind: 'force_continue', reason: 'at_bot' }
      }
      // @ 别人（且不是 @ bot）→ 跳过
      if (smartCfg.skipWhenAddressedOther !== false) {
        return { kind: 'addressed_other', reason: 'at_other_user' }
      }
    }
  }
  // 空文本（纯表情/图片/转账）→ 跳过
  if (smartCfg.skipWhenEmptyText !== false) {
    const rawText = (typeof e?.msg === 'string' ? e.msg : '').trim()
    if (!rawText) {
      return { kind: 'empty_content', reason: 'no_text' }
    }
  }

  // 以下为 continuation_strong 识别（必须距 bot 上次发言不远）
  const text = String(e?.msg || '')
  const sinceLastBotReply = state.lastBotReplyAt ? Date.now() - state.lastBotReplyAt : Infinity
  const quickResponseMs = Number(smartCfg.quickResponseMs) || 30000
  const lookbackMs = Number(smartCfg.continuationLookbackMs) || 180000

  // R1：秒回反应（30s 内任何消息都视为接续）
  if (sinceLastBotReply <= quickResponseMs) {
    return { kind: 'continuation_strong', reason: 'R1_quick_response' }
  }
  // R2/R3/R4 共同前提：在 lookback 窗口内
  if (sinceLastBotReply <= lookbackMs) {
    // R2 关键词匹配
    if (smartCfg.continuationKeywordMatch !== false && Array.isArray(state.lastBotReplyKeywords)) {
      for (const kw of state.lastBotReplyKeywords) {
        if (kw && text.includes(kw)) {
          return { kind: 'continuation_strong', reason: `R2_keyword:${kw}` }
        }
      }
    }
    // R3 问句
    if (smartCfg.continuationQuestionMatch !== false && isQuestionMessage(text)) {
      return { kind: 'continuation_strong', reason: 'R3_question' }
    }
    // R4 反馈词
    if (smartCfg.continuationFeedbackMatch !== false && isFeedbackMessage(text)) {
      return { kind: 'continuation_strong', reason: 'R4_feedback' }
    }
  }
  return { kind: 'regular', reason: '' }
}
