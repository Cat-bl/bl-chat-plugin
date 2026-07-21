// smart 触发模式：每群独立频率状态机（trackingChatStates）、时机 Gate、
// 回复 debounce、wait/deferred 续话定时器、24h LRU 淘汰。
// 以 mixin 形式挂到插件原型上，this 指向插件实例
// （collectRepeatMessage / tryJoinGroupRepeat 来自 repeatDetection mixin，
//  isMutedInGroup 来自 mutedStatus mixin，checkTriggers / handleTool 等在 apps/chat.js）。
import { prefilterMessage as prefilterMessagePure } from "../prefilter.js"
import { CompletedEventCache, getSmartEventKey, resolveWaitReplyAction } from "../waitReplyPolicy.js"
import { callAI } from "../../utils/apiClient.js"
import { mutedStatusCache, MUTED_CACHE_TTL_MS } from "./mutedStatus.js"

// smart 模式：每群独立的频率状态，进程内 Map，重启清零
const trackingChatStates = new Map() // groupId -> { pendingCount, lastMsgAt, replyLatencies: [{at, ms}], forceContinue, forceGateCheck, lastGateNoActionAt, inFlight, waitTimers: Map<userKey, timeoutId> }
// 群最后一条新消息到达时间戳，用于"准备回复前 debounce 看有没有新消息"（仅 smart 模式 set/读）
const lastIncomingMsgAt = new Map() // groupId -> ts
// 群连续被新消息打断的累计计数（达到上限后下一轮强制走完不再让步）
const consecutiveInterrupts = new Map() // groupId -> count
let activeChatLruTimer = null // 全局 24h LRU 扫描定时器，进程内单例

export const smartGateMethods = {
  /**
   * 启动 trackingChatStates 的 TTL 扫描器（进程内单例）：每 1 小时扫一次，
   * 把 lastMsgAt 超过 activeChatTtlHours 的群从内存状态淘汰，连同 waitTimers 一并清掉。
   */
  startActiveChatLruScanner() {
    if (activeChatLruTimer) return
    const intervalMs = 60 * 60 * 1000
    activeChatLruTimer = setInterval(() => {
      try {
        const ttlHours = Number(this.config?.smartTrigger?.activeChatTtlHours) || 24
        const cutoff = Date.now() - ttlHours * 3600 * 1000
        let removed = 0
        for (const [gid, st] of trackingChatStates) {
          if ((st.lastMsgAt || 0) < cutoff) {
            if (st.waitTimers) for (const t of st.waitTimers.values()) clearTimeout(t)
            if (st.deferredTimer) clearTimeout(st.deferredTimer)
            trackingChatStates.delete(gid)
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
            mutedStatusCache.delete(gid)
            removed += 1
          }
        }
        // 兜底：清掉孤儿条目（不应该出现，但防御性编程）
        for (const [gid, ts] of lastIncomingMsgAt) {
          if (!trackingChatStates.has(gid) && ts < cutoff) {
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
          }
        }
        // 禁言缓存独立 TTL（30 秒就过期了，但万一某个群冷下来缓存条目永远留着也不好）
        const mutedCutoff = Date.now() - MUTED_CACHE_TTL_MS * 10
        for (const [gid, item] of mutedStatusCache) {
          if (item.at < mutedCutoff) mutedStatusCache.delete(gid)
        }
        if (removed > 0) logger.info(`[ActiveChatLRU] 淘汰 ${removed} 个 ${ttlHours}h 未活跃群，当前活跃 ${trackingChatStates.size}`)
      } catch (err) {
        logger.error('[ActiveChatLRU] 扫描失败:', err)
      }
    }, intervalMs)
    activeChatLruTimer.unref?.()
  },

  /**
   * 解析对话焦点状态（FOCUS / FADING / COLD），含自动衰减。每次入口都该调一次。
   * 长时间无消息时一次性衰减到位（focus 经过 fading 直到 cold），避免误判为"刚进入 fading"。
   */
  resolveConversationPhase(state) {
    const now = Date.now()
    const smartCfg = this.config.smartTrigger || {}
    const fadingDurationMs = Number(smartCfg.fadingDurationMs) || 90000

    // 自动衰减：一次入口可能跨越多个 phase，循环到稳定状态
    while (state.phaseUntil && now > state.phaseUntil) {
      if (state.conversationPhase === 'focus') {
        state.conversationPhase = 'fading'
        // 从 focus 结束的那一刻起算 fading 持续时间
        const fadingStart = state.phaseUntil
        state.phaseUntil = fadingStart + fadingDurationMs
        state.consecutiveNoAction = 0
        if (now > state.phaseUntil) continue   // fading 也已过期，继续衰减到 cold
        break
      }
      if (state.conversationPhase === 'fading') {
        state.conversationPhase = 'cold'
        state.phaseUntil = 0
        state.focusReplyCount = 0
        state.consecutiveNoAction = 0
        break
      }
      // 已经是 cold，phaseUntil 不应该为 0 以外的值；保险起见清掉
      state.phaseUntil = 0
      break
    }
    return state.conversationPhase || 'cold'
  },

  /**
   * 本地预筛：免 LLM 决定明显该回 / 不该回 / 高优先级走 Gate。
   * 判定逻辑在 core/prefilter.js（纯函数，有单测），这里只解析 botId 并兜异常。
   */
  prefilterMessage(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    try {
      const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
      return prefilterMessagePure(e, state, smartCfg, botId)
    } catch (err) {
      logger.warn(`[Prefilter] 异常，按 regular 处理：${err.message}`)
      return { kind: 'regular', reason: 'exception' }
    }
  },

  /**
   * 计算群最近 5 分钟消息数（含 bot 自己的回复，用于 Gate prompt 活跃度信号）。
   * 仅做粗略统计：state.recentIncomingTimestamps 滑动窗口。
   */
  computeGroupMsgRate5min(state) {
    if (!Array.isArray(state?.recentIncomingTimestamps)) return 0
    const cutoff = Date.now() - 300000
    state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(t => t > cutoff)
    return state.recentIncomingTimestamps.length
  },

  /**
   * Bot 速率硬上限检查（防刷屏最终防线）。
   * 返回 true=可以继续回复，false=已超上限不该回复（force 路径请勿调用本函数）
   */
  applyRateLimitGuard(state, groupId) {
    const smartCfg = this.config.smartTrigger || {}
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[RateLimit] group=${groupId} 10min 已回复 ${state.recentReplyTimestamps.length}/${maxPer10Min} 次，强制 no_action`)
      state.conversationPhase = 'fading'
      state.phaseUntil = Date.now() + (Number(smartCfg.rateLimitCooldownMs) || 300000)
      return false
    }
    state.recentReplyTimestamps.push(Date.now())
    return true
  },

  /**
   * 冷群空窗 deferred timer：仅 phase=cold 时排，按 (threshold-currentEquiv)*avgMs 估算延迟，
   * 到点合成 _smartWaitRerun 事件再跑一轮 Gate。
   * 注意：本函数通常在 inFlight=true 时（主流程 try 块内）被调用，因此**不要**用 inFlight 守卫；
   * 真正的并发保护放在 setTimeout 回调里（callback 触发时再检查 inFlight）。
   */
  scheduleDeferredGateCheck(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    if (smartCfg.deferredGateEnabled === false) return
    if (!e?.group_id) return
    if (state.conversationPhase !== 'cold') return

    if (state.deferredTimer) clearTimeout(state.deferredTimer)

    const talkValue = this.resolveTalkValue(e.group_id)
    const threshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
    const avgMs = this.computeAvgReplyLatency(state) || Number(smartCfg.avgLatencyDefaultMs) || 60000
    const idleMs = Math.max(0, Date.now() - (state.lastMsgAt || Date.now()))
    const currentEquiv = (state.pendingCount || 0) + idleMs / avgMs
    const remaining = Math.max(0, threshold - currentEquiv)

    const minMs = Number(smartCfg.minDeferredMs) || 120000
    const maxMs = Number(smartCfg.maxDeferredMs) || 900000
    const delayMs = Math.max(minMs, Math.min(maxMs, Math.ceil(remaining * avgMs)))

    const groupId = e.group_id
    state.deferredTimer = setTimeout(async () => {
      state.deferredTimer = null
      try {
        const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
        if (mode !== 'smart') return
        if (!this.checkGroupPermission(e)) return
        if (await this.isMutedInGroup(e)) return
        if (state.inFlight) return
        const wrapped = Object.create(e)
        wrapped._smartWaitRerun = true
        wrapped._deferredReason = 'cold_idle'
        logger.info(`[DeferredGate] group=${groupId} fired delay=${delayMs}ms`)
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error('[DeferredGate] 失败:', err)
      }
    }, delayMs)
    state.deferredTimer.unref?.()
  },

  getSmartState(groupId) {
    let state = trackingChatStates.get(groupId)
    if (!state) {
      // 上限保护：超过 100 个群时按 lastMsgAt 淘汰最旧的群（防长期累积内存膨胀）
      if (trackingChatStates.size >= 100) {
        let oldestId = null
        let oldestAt = Infinity
        for (const [gid, st] of trackingChatStates) {
          if (st.lastMsgAt < oldestAt) { oldestAt = st.lastMsgAt; oldestId = gid }
        }
        if (oldestId != null) {
          const old = trackingChatStates.get(oldestId)
          if (old?.waitTimers) for (const t of old.waitTimers.values()) clearTimeout(t)
          if (old?.deferredTimer) clearTimeout(old.deferredTimer)
          trackingChatStates.delete(oldestId)
        }
      }
      state = {
        pendingCount: 0,
        lastMsgAt: Date.now(),
        replyLatencies: [],
        forceContinue: false,
        forceGateCheck: false,
        lastGateNoActionAt: 0,
        inFlight: false,
        needsRerun: false,
        rerunEvent: null,
        queuedWhileInFlight: 0,
        queuedForceGateCheck: false,
        waitTimers: new Map(),
        waitTaskVersions: new Map(),
        groupContextVersion: 0,
        userContextVersions: new Map(),
        latestIncomingEvent: null,
        completedEvents: new CompletedEventCache(),
        // 拟人化重构新增字段
        conversationPhase: 'cold',        // 'cold' | 'focus' | 'fading'
        phaseUntil: 0,                    // 当前 phase 自动衰减时间戳
        focusReplyCount: 0,               // 本轮 FOCUS 期 bot 主动回复次数
        consecutiveNoAction: 0,           // FOCUS 期 Gate 连续 no_action 次数
        lastBotReplyAt: 0,                // bot 在该群最近一次发言时间
        lastBotReplyKeywords: [],         // bot 上次发言提取的关键词（给 continuation R2 用）
        recentReplyTimestamps: [],        // bot 在该群的最近回复时间戳列表（速率限制用）
        recentIncomingTimestamps: [],     // 该群最近群消息时间戳（活跃度统计用）
        recentMessages: [],               // 最近群消息 deque {userId, text, at}，复读检测用
        lastRepeatJoinAt: 0,              // bot 最近一次参与复读的时间（防短期反复跟读）
        deferredTimer: null               // 冷群唤醒定时器
      }
      trackingChatStates.set(groupId, state)
    }
    return state
  },

  /**
   * smart 模式触发入口：每条群消息进入此函数，按 talkValue 阈值/空窗补偿/强制覆盖三种条件决定是否调 Timing Gate
   */
  async handleRandomReplySmart(e) {
    const groupId = e.group_id
    const state = this.getSmartState(groupId)
    // 记录该群最新消息时间戳给 applyReplyDebounce 用（仅 smart 模式需要，避免 strict 模式持续累积内存）
    const isSyntheticSmartEvent = e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply
    if (!isSyntheticSmartEvent && !e?._smartOriginKey) {
      try {
        e._smartOriginKey = `${groupId}:event:${(state.groupContextVersion || 0) + 1}`
      } catch {}
    }
    const eventKey = getSmartEventKey(e)
    if (isSyntheticSmartEvent && state.completedEvents.has(eventKey)) {
      logger.info(`[Smart去重] group=${groupId} message_id=${e.message_id} 已完成回复，跳过合成事件重复处理`)
      return false
    }
    if (!isSyntheticSmartEvent) {
      lastIncomingMsgAt.set(groupId, Date.now())
      state.groupContextVersion = (state.groupContextVersion || 0) + 1
      const contextUserKey = String(e.user_id || '')
      state.userContextVersions.set(contextUserKey, (state.userContextVersions.get(contextUserKey) || 0) + 1)
      state.latestIncomingEvent = e
      // 活跃度采样移到入口锁外，避免抢锁失败时漏统计（影响 Gate 看到的 5min 消息数）
      state.recentIncomingTimestamps = (state.recentIncomingTimestamps || []).filter(t => t > Date.now() - 300000)
      state.recentIncomingTimestamps.push(Date.now())
      // 复读检测用的最近消息 deque（收集逻辑抽到 collectRepeatMessage，strict/smart 共用）
      this.collectRepeatMessage(e)
    }
    // 入口锁：该群已经有一个 handleRandomReplySmart 正在跑（Gate / debounce / handleTool 任一阶段）→ 让步本条
    // 必须在任何 await 之前同步检查并 set，防止 await checkTriggers 期间多个调用并发通过
    if (state.inFlight) {
      state.queuedWhileInFlight = (state.queuedWhileInFlight || 0) + 1
      state.lastMsgAt = Date.now()
      state.needsRerun = true
      if (e?._smartWaitRerun) state.queuedForceGateCheck = true
      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun
      const hasQueuedTrigger = allowDirectTrigger && this.checkTriggers(e)
      const botName = Bot.nickname
      const hasQueuedNameMention = allowDirectTrigger && smartCfg.mentionedNameReply && e.msg &&
        botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())
      if ((hasQueuedTrigger && smartCfg.inevitableAtReply !== false) || hasQueuedNameMention || e?._proactiveReply) {
        state.forceContinue = true
        state.rerunEvent = e
      } else if (!state.forceContinue) {
        state.rerunEvent = e
      }
      return false
    }
    state.inFlight = true
    try {
      // 先记录上一条消息时间用于空窗补偿（要在 lastMsgAt 被本次更新覆盖之前取出）
      const prevLastMsgAt = state.lastMsgAt || Date.now()
      const queuedCount = Math.max(0, Number(state.queuedWhileInFlight) || 0)
      state.queuedWhileInFlight = 0
      const pendingDelta = e?._smartQueuedRerun ? Math.max(1, queuedCount) : 1 + queuedCount
      state.pendingCount += pendingDelta
      state.lastMsgAt = Date.now()

      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun

      if (e?._smartWaitRerun) {
        state.forceContinue = false
        state.forceGateCheck = true
      } else if (e?._smartQueuedGateCheck) {
        state.forceGateCheck = true
      }

      if (allowDirectTrigger && e?._proactiveReply) {
        state.forceContinue = true
      }

      // ─── 本地预筛（仅对真实新消息生效）─────────────────────────
      let prefilter = { kind: 'regular', reason: '' }
      if (!isSyntheticSmartEvent) {
        prefilter = this.prefilterMessage(e, state)
        if (prefilter.kind === 'addressed_other' || prefilter.kind === 'empty_content' || prefilter.kind === 'bot_self_echo') {
          // 回滚刚才计入的 pendingCount（这些消息不应推动触发阈值）
          state.pendingCount = Math.max(0, state.pendingCount - pendingDelta)
          logger.info(`[Prefilter] group=${groupId} skip kind=${prefilter.kind} reason=${prefilter.reason}`)
          // 顺手排个 cold 兜底（如果当前是 cold 状态）
          this.scheduleDeferredGateCheck(e, state)
          return false
        }
        if (prefilter.kind === 'force_continue' && smartCfg.inevitableAtReply !== false) {
          // @bot（含裸 @）：直接标记强制回复，与 checkTriggers 命中同路径
          state.forceContinue = true
          logger.info(`[Prefilter] group=${groupId} force_continue reason=${prefilter.reason}`)
        }
        if (prefilter.kind === 'continuation_strong') {
          state.forceGateCheck = true
          logger.info(`[Prefilter] group=${groupId} continuation_strong reason=${prefilter.reason}`)
        }
        // 复读检测：命中且通过概率 → 跳过 Gate 直接复读原文。
        // 但 force 路径（_proactiveReply / @bot / 触发前缀 / 名字提及）必须走正常 LLM 流程，
        // 因为用户明确指名 bot 时只复读一个 "+1" 体验很差。
        const hasForceSignal = state.forceContinue
          || this.checkTriggers(e)
          || (smartCfg.mentionedNameReply && e.msg && Bot.nickname &&
              String(e.msg).toLowerCase().includes(String(Bot.nickname).toLowerCase()))
        if (!hasForceSignal) {
          if (await this.tryJoinGroupRepeat(e)) return true
        }
      }

      // 强制覆盖：@/触发前缀
      const hasTrigger = await this.checkTriggers(e)
      if (allowDirectTrigger && hasTrigger && smartCfg.inevitableAtReply !== false) {
        state.forceContinue = true
      }
      // 名字提及（非 @）
      if (allowDirectTrigger && !state.forceContinue && smartCfg.mentionedNameReply && e.msg) {
        const botName = Bot.nickname
        if (botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())) {
          state.forceContinue = true
        }
      }

      // ─── 对话焦点状态机：决定本条是否强制走 Gate / 阈值是否减半 ──
      const phase = this.resolveConversationPhase(state)
      if (phase === 'focus') {
        state.forceGateCheck = true
      } else if (phase === 'fading' && smartCfg.fadingForceGate === true) {
        // 用户选择激进策略：FADING 期也强制走 Gate
        state.forceGateCheck = true
      }

      // 冷却检查：no_action 后短时间内不再请求 Gate（强制覆盖可绕过）
      const rawCooldownValue = smartCfg.timingGateCooldownSeconds
      const rawCooldownSeconds = rawCooldownValue === undefined || rawCooldownValue === null || rawCooldownValue === ''
        ? NaN
        : Number(rawCooldownValue)
      const cooldownSeconds = Number.isFinite(rawCooldownSeconds) ? rawCooldownSeconds : 8
      const cooldownMs = Math.max(0, cooldownSeconds) * 1000
      if (!state.forceContinue && !state.forceGateCheck && cooldownMs > 0 && Date.now() - state.lastGateNoActionAt < cooldownMs) {
        return false
      }

      // 阈值判定（fading 期半阈值，仅作用于"非 force"路径）
      const talkValue = this.resolveTalkValue(groupId)
      const rawThreshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
      const threshold = phase === 'fading'
        ? Math.max(1, Math.floor(rawThreshold / 2))
        : rawThreshold
      const reachThreshold = state.pendingCount >= threshold
      const idleHit = this.idleCompensationMet(state, threshold, prevLastMsgAt)
      if (!state.forceContinue && !state.forceGateCheck && !reachThreshold && !idleHit) {
        // 冷群兜底：phase=cold 且未达阈值时排 deferred timer，让 bot 在合适时机自己跑一轮 Gate
        this.scheduleDeferredGateCheck(e, state)
        return false
      }

      // 群并发已满：Gate 判定 API 不必发起，直接让步本条。
      // 不清 forceContinue / pendingCount —— @bot 等强触发保留到下一条消息（届时名额可能已释放）
      if (this.isGroupChatAtCapacity(groupId)) {
        const { active, limit } = this.getGroupChatConcurrency(groupId)
        logger.info(`[并发限制][smart-Gate] 群${groupId} 已有 ${active}/${limit} 条对话在处理，本轮不请求 Gate/不触发（非API异常，现有对话处理完后下条消息自动恢复）。msg="${String(e.msg || '').slice(0, 30)}"`)
        return false
      }

      let gateResult
      try {
        // 强制继续路径直接放行，跳过 Gate；强制 Gate 路径仍交给 Gate 判断是否补一句
        if (state.forceContinue) {
          gateResult = { decision: 'continue', reason: 'force', __forceContinue: true }
        } else {
          gateResult = await this.runTimingGate(e, state, { phase, prefilter, threshold, prevLastMsgAt })
        }
      } catch (err) {
        logger.error(`[TimingGate] 调用失败:`, err)
        gateResult = { decision: 'no_action', reason: 'error' }
      }

      const decision = gateResult?.decision || 'no_action'
      logger.info(`[TimingGate] group=${groupId} decision=${decision} phase=${phase} pending=${state.pendingCount}/${threshold} forceContinue=${state.forceContinue} forceGate=${state.forceGateCheck} reason=${gateResult?.reason || ''}`)

      if (decision === 'continue') {
        const wasForced = gateResult?.__forceContinue === true
        // 速率硬上限（force 路径不受限但仍记录时间戳，保证 rate limit 统计准确）
        if (!wasForced) {
          if (!this.applyRateLimitGuard(state, groupId)) {
            state.pendingCount = 0
            state.forceContinue = false
            state.forceGateCheck = false
            return false
          }
        } else {
          // force 路径直接 push 时间戳，跳过上限检查
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000)
          state.recentReplyTimestamps.push(Date.now())
        }
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.lastGateNoActionAt = 0
        state.consecutiveNoAction = 0
        // 进入 / 续命 FOCUS（非 force 路径计入 focusReplyCount）
        const focusDurationMs = Number(smartCfg.focusDurationMs) || 180000
        const prevPhase = state.conversationPhase
        state.conversationPhase = 'focus'
        state.phaseUntil = Date.now() + focusDurationMs
        // force 路径升回 focus 时视为"新一轮"，重置 focusReplyCount（避免立即又被上限拦截）
        if (wasForced && prevPhase !== 'focus') {
          state.focusReplyCount = 0
        }
        if (!wasForced) {
          state.focusReplyCount = (state.focusReplyCount || 0) + 1
          const maxFocusReplies = Number(smartCfg.focusMaxReplies) || 4
          if (state.focusReplyCount >= maxFocusReplies) {
            // 达上限：本次允许回，但之后立刻降级 FADING 防连刷
            state.conversationPhase = 'fading'
            state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
            logger.info(`[Phase] group=${groupId} focusMaxReplies(${maxFocusReplies}) 达上限，本次回复后降级 fading`)
          }
        }
        // 标记本条为"主动搭话"（非 @/前缀触发），让 sendSegmentedMessage 决定要不要去掉引用
        if (!wasForced) e._proactiveReply = true
        // force 路径（@/名字提及/proactive 等"必回"场景）跳过 debounce 立即回复；其余先 debounce 看有没有新消息
        if (!wasForced && !(await this.applyReplyDebounce(e))) {
          // 让步后回滚 focusReplyCount（这次实际没回复）
          if (!wasForced) state.focusReplyCount = Math.max(0, (state.focusReplyCount || 0) - 1)
          // 同时回滚 rate limit 计数
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).slice(0, -1)
          return false
        }
        const toolResult = await this.handleTool(e)
        if (e?._conversationProducedOutput === true && eventKey) {
          state.completedEvents.add(eventKey)
        }
        return toolResult
      }
      if (decision === 'wait') {
        const sec = Math.max(1, Math.min(60, Number(gateResult.wait_seconds) || 5))
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.consecutiveNoAction = 0   // wait 不是冷漠，清零计数避免跨 wait 累积误降级
        this.scheduleWaitReply(e, sec, 'gate_wait', 'gate')
        return false
      }
      // no_action
      state.lastGateNoActionAt = Date.now()
      state.pendingCount = 0
      state.forceContinue = false
      state.forceGateCheck = false
      // FOCUS 内累计 no_action，超过 focusMaxNoAction 就降级 FADING
      if (state.conversationPhase === 'focus') {
        state.consecutiveNoAction = (state.consecutiveNoAction || 0) + 1
        const maxNoAction = Number(smartCfg.focusMaxNoAction) || 2
        if (state.consecutiveNoAction >= maxNoAction) {
          state.conversationPhase = 'fading'
          state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
          state.consecutiveNoAction = 0
          logger.info(`[Phase] group=${groupId} Gate 连续 ${maxNoAction} 次 no_action，降级 fading`)
        }
      }
      return false
    } finally {
      state.inFlight = false
      if (state.needsRerun) {
        const rerunEvent = state.rerunEvent || e
        const queuedForceGateCheck = !!state.queuedForceGateCheck
        state.needsRerun = false
        state.rerunEvent = null
        state.queuedForceGateCheck = false
        const wrappedRerun = Object.create(rerunEvent)
        wrappedRerun._smartQueuedRerun = true
        if (queuedForceGateCheck) wrappedRerun._smartQueuedGateCheck = true
        this.handleRandomReplySmart(wrappedRerun).catch(err => logger.error('[TimingGate] 重跑失败:', err))
      }
    }
  },

  /**
   * 调用 Timing Gate 子代理，返回 { decision: 'continue'|'no_action'|'wait', wait_seconds?, reason? }
   * @param ctx 额外上下文：{ phase, prefilter, threshold }
   */
  async runTimingGate(e, state, ctx = {}) {
    const smartCfg = this.config.smartTrigger || {}
    const ctxSize = Math.max(5, Math.min(100, Number(smartCfg.gateContextSize) || 20))
    const botName = Bot.nickname || '机器人'

    let history = ''
    try {
      history = await this.messageManager.formatMessageHistory('group', e.group_id, ctxSize)
    } catch { history = '(无)' }

    // Gate 子代理复用 trackAiConfig（同样是"轻量 LLM 决策回不回话"用途，不再单独配置一份模型）
    const trackCfg = this.config.trackAiConfig
    const useCfg = {
      url: trackCfg?.trackAiUrl,
      model: trackCfg?.trackAiModel || 'gpt-4o-mini',
      apikey: trackCfg?.trackAiApikey
    }
    if (!useCfg.url || !useCfg.apikey || String(useCfg.apikey).startsWith('sk-xxxxx')) {
      return { decision: 'no_action', reason: 'no_api_config' }
    }

    // ─── 多维信号采集 ─────────────────────────────────────
    const phase = ctx.phase || state.conversationPhase || 'cold'
    const prefilterKind = ctx.prefilter?.kind || 'regular'
    const prefilterReason = ctx.prefilter?.reason || ''
    const recentReplyCount = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000).length
    const groupMsgRate5min = this.computeGroupMsgRate5min(state)
    const sinceLastBotReplySec = state.lastBotReplyAt
      ? Math.max(0, Math.floor((Date.now() - state.lastBotReplyAt) / 1000))
      : -1
    // 用入口处保存的"上一条消息时间"（state.lastMsgAt 在入口已被更新为当前消息时间，
    // 直接用会导致这个信号恒为 0s）
    const prevMsgAt = Number(ctx.prevLastMsgAt) || state.lastMsgAt
    const sinceLastMsgSec = prevMsgAt
      ? Math.max(0, Math.floor((Date.now() - prevMsgAt) / 1000))
      : 0
    const now = new Date()
    const hh = now.getHours()
    const hhmm = `${String(hh).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const isLateNight = hh >= 23 || hh < 6
    // 是否 @ 别人 / 引用 bot
    let addressedToOther = false
    let currentMsgQuotesBot = false
    try {
      const botId = e?.bot?.uin || Bot.uin
      if (Array.isArray(e?.message)) {
        for (const seg of e.message) {
          if (seg?.type === 'at' && String(seg.qq) !== String(botId)) addressedToOther = true
          if (seg?.type === 'reply') {
            // 部分协议端会附带被回复消息的 sender 信息
            const repliedUid = seg?.sender_id || seg?.qq || seg?.user_id
            if (repliedUid && String(repliedUid) === String(botId)) currentMsgQuotesBot = true
          }
        }
      }
    } catch {}
    const triggerReason = e?._deferredReason
      ? 'deferred'
      : (prefilterKind === 'continuation_strong' ? `continuation_strong(${prefilterReason})` : 'regular')

    const promptHintBusyGroupRate = Number(smartCfg.promptHintBusyGroupRate) || 30
    const promptHintRateLimitWarn = Number(smartCfg.promptHintRateLimitWarn) || 5

    const systemPrompt = `你是 QQ 群聊节奏判断助手。机器人名字叫"${botName}"。
当前北京时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
你需要判断 ${botName} 是否应该现在插话、保持沉默、或稍后再说。

**总原则：${botName} 是群里的活跃成员，看到感兴趣/有共鸣/能玩梗的话题就应该自然参与**。
克制 ≠ 沉默。真正该 no_action 的是"明显在打扰别人"或"对话内容跟自己完全无关"。如果话题适合插一句，就 continue。

判断指引：
- continue（积极参与）：被 @/点名；用户向 ${botName} 提问或追问；${botName} 刚发言用户在回应/接续话题；群里有有趣话题/玩梗/吐槽/共鸣的好时机；有人求助且 ${botName} 能帮上；冷场需要破冰；普通聊天但话题 ${botName} 有兴趣
- no_action（明确不该插的才用）：用户之间在明确互相对话（@ 了别人或私聊话题）；同一话题 ${botName} 刚回过应该让别人说；纯水群无意义复读（除非 ${botName} 也想跟）
- wait：${botName} 刚发完一句话用户还没反应；用户句子像是没说完；明显在等下文

时段倾向：深夜（23:00-06:00）更克制，倾向 wait 或 no_action；白天可以活跃。

【信号判断指引】
- 看到"⚠ @ 了别人"信号：除非该消息内容显然是普遍话题（如"大家觉得..."），否则倾向 no_action
- 看到"焦点=focus"且"距 ${botName} 上次发言 < 60s"：用户大概率在接续，强烈倾向 continue
- 看到"最近 10 分钟已回复 ≥${promptHintRateLimitWarn} 次"：除非被点名，倾向 no_action（避免刷屏）
- 看到"群最近 5 分钟消息数 ≥ ${promptHintBusyGroupRate}"：群里在热聊，看话题是否值得插一句；有趣就 continue，跟自己无关就 no_action（**不要因为"热闹"就默认沉默**）
- 看到"触发原因=deferred"：这是定时自检，群里没新消息或 ${botName} 刚开了话头还没人接；只在非常合适时主动补一句，否则 no_action
- 看到"触发原因=continuation_strong"且消息明显在向 ${botName} 提问/反馈：强烈倾向 continue
- 没有明确"不该插"的理由时，按"群里一员的自然反应"判断 —— 普通群友看到话题有兴趣就会接，看到无聊就划走

只返回严格的 JSON，格式：{"decision":"continue|no_action|wait","wait_seconds":3,"reason":"简短理由"}
wait 时 wait_seconds 取 3-15 之间。不要任何其他文字、不要 markdown、不要代码块包装。`

    const specialSignals = []
    if (addressedToOther) specialSignals.push('⚠ 当前消息 @ 了别人，谨慎插话')
    if (currentMsgQuotesBot) specialSignals.push(`✓ 当前消息引用了 ${botName} 的某条消息`)
    const specialSignalsBlock = specialSignals.length ? `\n【特殊信号】\n${specialSignals.join('\n')}\n` : ''

    const userPrompt = `【近期群聊记录】
${history}

【当前消息】
${e.sender?.card || e.sender?.nickname || '用户'}: ${e.msg || ''}

【时间与活跃度】
- 距上一条群消息：${sinceLastMsgSec}s
- 距 ${botName} 上一次发言：${sinceLastBotReplySec >= 0 ? sinceLastBotReplySec + 's' : '长时间未发言'}
- ${botName} 最近 10 分钟在本群已回复：${recentReplyCount} 次
- 群最近 5 分钟消息数：${groupMsgRate5min}
- 当前时段：${hhmm}（${isLateNight ? '深夜' : '日间'}）

【对话状态】
- 当前焦点：${phase}（focus=刚参与话题中；fading=余热；cold=未参与）
- 触发原因：${triggerReason}
${specialSignalsBlock}
请输出 JSON 决策。`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      const result = await callAI(
        useCfg,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        {
          temperature: 0.3,
          signal: controller.signal
        }
      )

      if (result.error) return { decision: 'no_action', reason: `api_error:${result.error}` }

      const raw = result?.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { decision: 'no_action', reason: 'no_json' }
      const parsed = JSON.parse(jsonMatch[0])
      const dec = String(parsed.decision || '').toLowerCase()
      if (!['continue', 'no_action', 'wait'].includes(dec)) {
        return { decision: 'no_action', reason: 'invalid_decision' }
      }
      return {
        decision: dec,
        wait_seconds: Number(parsed.wait_seconds) || 5,
        reason: String(parsed.reason || '').slice(0, 80)
      }
    } catch (err) {
      return { decision: 'no_action', reason: `exception:${err.message}` }
    } finally {
      clearTimeout(timeoutId)
    }
  },

  /**
   * 回复 debounce：等待 replyDebounceMs 看群里是否有新消息进来；
   * 有新消息且未到 maxConsecutiveInterrupts 上限 → 让步本轮（return false）；
   * 否则放行（return true）。force 路径应在调用方跳过本检查。
   */
  async applyReplyDebounce(e) {
    const debounceMs = Math.max(0, Number(this.config.smartTrigger?.replyDebounceMs) || 0)
    if (debounceMs <= 0 || !e?.group_id) return true
    const debounceStartAt = Date.now()
    await new Promise(r => setTimeout(r, debounceMs))
    const newestAt = lastIncomingMsgAt.get(e.group_id) || 0
    if (newestAt > debounceStartAt) {
      const max = Math.max(0, Number(this.config.smartTrigger?.maxConsecutiveInterrupts) || 0)
      const cur = (consecutiveInterrupts.get(e.group_id) || 0) + 1
      if (max === 0 || cur <= max) {
        consecutiveInterrupts.set(e.group_id, cur)
        logger.info(`[Debounce] group=${e.group_id} 检测到新消息打断，让步本轮 (${cur}/${max || '∞'})`)
        return false
      }
      logger.info(`[Debounce] group=${e.group_id} 连续打断达上限 ${max} 次，强制走完不让步`)
      consecutiveInterrupts.set(e.group_id, 0)
      return true
    }
    consecutiveInterrupts.set(e.group_id, 0)
    return true
  },

  /**
   * 解析 talkValue：优先用时段化规则，否则用全局 talkValue
   */
  resolveTalkValue(groupId) {
    const s = this.config.smartTrigger || {}
    const fallback = Number(s.talkValue) || 1.0
    if (!s.enableTalkValueRules || !Array.isArray(s.talkValueRules) || s.talkValueRules.length === 0) {
      return fallback
    }
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const rule of s.talkValueRules) {
      const range = String(rule?.range || '').trim()
      const [start, end] = range.split('-').map(x => x?.trim())
      if (!start || !end) continue
      const inRange = (start <= end && hhmm >= start && hhmm <= end) ||
                      (start > end && (hhmm >= start || hhmm <= end))
      if (inRange) {
        const v = Number(rule.value)
        if (Number.isFinite(v) && v > 0) return v
      }
    }
    return fallback
  },

  /**
   * 空窗补偿：冷群按 idle/avg_latency 折算"等效消息数"，凑够阈值就触发
   * @param state - 该群的 SmartState
   * @param threshold - 当前阈值（ceil(1/talkValue)）
   * @param prevLastMsgAt - 上一条消息的时间戳（本次入口前的值，必须由调用方传入，否则 idle=0 永远不命中）
   */
  idleCompensationMet(state, threshold, prevLastMsgAt) {
    const s = this.config.smartTrigger || {}
    if (!s.idleCompensationEnabled) return false
    const avgMs = this.computeAvgReplyLatency(state) || Number(s.avgLatencyDefaultMs) || 60000
    if (avgMs <= 0) return false
    const idleMs = Math.max(0, Date.now() - (prevLastMsgAt || Date.now()))
    return state.pendingCount + idleMs / avgMs >= threshold
  },

  /**
   * 计算最近 10 分钟平均回复延迟（毫秒）
   */
  computeAvgReplyLatency(state) {
    if (!state?.replyLatencies?.length) return 0
    const cutoff = Date.now() - 600000
    state.replyLatencies = state.replyLatencies.filter(item => item.at >= cutoff)
    if (!state.replyLatencies.length) return 0
    const sum = state.replyLatencies.reduce((acc, item) => acc + item.ms, 0)
    return sum / state.replyLatencies.length
  },

  /**
   * 记录一次"用户消息→bot 回复"的延迟，给空窗补偿用。两种模式都调用。
   */
  recordReplyLatency(groupId, latencyMs) {
    if (!groupId || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const state = this.getSmartState(groupId)
    state.replyLatencies.push({ at: Date.now(), ms: latencyMs })
    if (state.replyLatencies.length > 50) state.replyLatencies = state.replyLatencies.slice(-50)
  },

  /**
   * 安排 N 秒后强制再触发一轮 Gate，让 LLM 决定要不要补一句（wait 工具/Gate wait 决策共用）
   */
  scheduleWaitReply(e, seconds, reason, waitKind = 'tool') {
    const groupId = e.group_id
    if (!groupId) {
      logger.warn(`[WaitTool] 私聊场景暂不支持自动续话: user=${e.user_id}`)
      return
    }
    const state = this.getSmartState(groupId)
    const userKey = `${groupId}_${e.user_id}`
    const old = state.waitTimers.get(userKey)
    if (old) clearTimeout(old)
    const taskVersion = (state.waitTaskVersions.get(userKey) || 0) + 1
    state.waitTaskVersions.set(userKey, taskVersion)
    const scheduledGroupVersion = state.groupContextVersion || 0
    const versionUserKey = String(e.user_id || '')
    const scheduledUserVersion = state.userContextVersions.get(versionUserKey) || 0

    const timer = setTimeout(async () => {
      if (state.waitTaskVersions.get(userKey) !== taskVersion) return
      state.waitTimers.delete(userKey)
      // 触发时再次校验：模式可能已切回 strict、bot 可能已被禁言、群可能已退出白名单
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode !== 'smart') {
        logger.info(`[WaitTool] group=${groupId} 已切出 smart 模式，取消续话`)
        return
      }
      const action = resolveWaitReplyAction({
        kind: waitKind,
        scheduledUserVersion,
        currentUserVersion: state.userContextVersions.get(versionUserKey) || 0,
        scheduledGroupVersion,
        currentGroupVersion: state.groupContextVersion || 0
      })
      if (action === 'cancel') {
        logger.info(`[WaitTool] group=${groupId} user=${e.user_id} 用户已有新消息，取消旧续话`)
        return
      }
      const targetEvent = action === 'use_latest' ? state.latestIncomingEvent : e
      if (!targetEvent?.group_id) return
      if (!this.checkGroupPermission(targetEvent)) {
        logger.info(`[WaitTool] group=${groupId} 不在白名单，取消续话`)
        return
      }
      if (await this.isMutedInGroup(targetEvent)) {
        logger.info(`[WaitTool] group=${groupId} 被禁言，取消续话`)
        return
      }
      logger.info(`[WaitTool] group=${groupId} user=${e.user_id} fired after ${seconds}s reason=${reason || ''}`)
      try {
        const wrapped = Object.create(targetEvent)
        wrapped._smartWaitRerun = true
        wrapped._proactiveReply = true
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error(`[WaitTool] 续话失败:`, err)
      }
    }, seconds * 1000)
    state.waitTimers.set(userKey, timer)
  }
}
