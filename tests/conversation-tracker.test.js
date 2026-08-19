import test from "node:test"
import assert from "node:assert/strict"

// 被测方法在调用期引用 Yunzai 全局（logger / Bot），须在调用前就位。
// node --test 每个测试文件独立子进程，不会污染其他测试。
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
globalThis.Bot = { nickname: "测试bot", uin: 10000 }

const { conversationTrackerMethods, trackingLastMsgAt } = await import("../core/conversationTracker.js")

let groupSeq = 0
const newGroupId = () => `ct_test_group_${++groupSeq}`

// 构造最小可用的"插件实例"：真实 tracker 方法 + stub 掉的外部依赖（Gate / handleTool / 触发检测）
function makeBot({ config = {}, ...overrides } = {}) {
  const smartTrigger = { deferredGateEnabled: false, ...(config.smartTrigger || {}) }
  const bot = {
    ...conversationTrackerMethods,
    config: { chatTriggerMode: "smart", ...config, smartTrigger }
  }
  bot.__calls = { handleTool: [], gate: [], waitReply: [] }
  bot.gateResult = { decision: "no_action", reason: "stub" }
  bot.checkTriggers = () => false
  bot.isGroupChatAtCapacity = () => false
  bot.handleTool = async e => { bot.__calls.handleTool.push(e); return true }
  bot.runTimingGate = async () => { bot.__calls.gate.push(1); return bot.gateResult }
  bot.scheduleWaitReply = (e, sec, reason, kind) => { bot.__calls.waitReply.push({ sec, reason, kind }) }
  Object.assign(bot, overrides)
  return bot
}

const makeEvent = (groupId, { msg = "随便聊聊", userId = 111, message } = {}) => ({
  group_id: groupId,
  user_id: userId,
  msg,
  message: message ?? [{ type: "text", text: msg }],
  sender: { nickname: "某人" }
})

// ==================== resolveConversationPhase ====================

test("resolveConversationPhase：无状态默认 cold", () => {
  const bot = makeBot()
  assert.equal(bot.resolveConversationPhase({}), "cold")
})

test("resolveConversationPhase：focus 未过期保持 focus", () => {
  const bot = makeBot()
  const state = { conversationPhase: "focus", phaseUntil: Date.now() + 10000 }
  assert.equal(bot.resolveConversationPhase(state), "focus")
})

test("resolveConversationPhase：focus 过期衰减到 fading，fading 起点接在 focus 结束时刻", () => {
  const bot = makeBot()
  const focusEnd = Date.now() - 1000
  const state = { conversationPhase: "focus", phaseUntil: focusEnd, consecutiveNoAction: 2 }
  assert.equal(bot.resolveConversationPhase(state), "fading")
  assert.equal(state.phaseUntil, focusEnd + 90000)
  assert.equal(state.consecutiveNoAction, 0)
})

test("resolveConversationPhase：长时间无消息一次性衰减到 cold 并清 focusReplyCount", () => {
  const bot = makeBot()
  const state = { conversationPhase: "focus", phaseUntil: Date.now() - 200000, focusReplyCount: 3 }
  assert.equal(bot.resolveConversationPhase(state), "cold")
  assert.equal(state.phaseUntil, 0)
  assert.equal(state.focusReplyCount, 0)
})

// ==================== applyRateLimitGuard ====================

test("applyRateLimitGuard：未达上限放行并登记时间戳", () => {
  const bot = makeBot()
  const state = { recentReplyTimestamps: [] }
  assert.equal(bot.applyRateLimitGuard(state, "g"), true)
  assert.equal(state.recentReplyTimestamps.length, 1)
})

test("applyRateLimitGuard：达上限拦截并强制降级 fading", () => {
  const bot = makeBot()
  const state = { recentReplyTimestamps: Array.from({ length: 8 }, () => Date.now()) }
  assert.equal(bot.applyRateLimitGuard(state, "g"), false)
  assert.equal(state.conversationPhase, "fading")
  assert.ok(state.phaseUntil > Date.now())
})

test("applyRateLimitGuard：10 分钟窗口外的旧时间戳被剪掉，不占配额", () => {
  const bot = makeBot()
  const state = { recentReplyTimestamps: Array.from({ length: 8 }, () => Date.now() - 700000) }
  assert.equal(bot.applyRateLimitGuard(state, "g"), true)
  assert.equal(state.recentReplyTimestamps.length, 1)
})

// ==================== 复读检测与参与 ====================

test("detectGroupRepeat：3 个不同用户重复同文本命中（概率置 1）", () => {
  const bot = makeBot({ config: { smartTrigger: { repeatJoinProbability: 1 } } })
  const state = bot.getSmartState(newGroupId())
  state.recentMessages = [
    { userId: "1", text: "哈哈", at: Date.now() },
    { userId: "2", text: "哈哈", at: Date.now() }
  ]
  const e = makeEvent("g", { msg: "哈哈", userId: "3" })
  assert.equal(bot.detectGroupRepeat(e, state), "哈哈")
})

test("detectGroupRepeat：不同用户数不足 minCount 不命中", () => {
  const bot = makeBot({ config: { smartTrigger: { repeatJoinProbability: 1 } } })
  const state = bot.getSmartState(newGroupId())
  state.recentMessages = [{ userId: "1", text: "哈哈", at: Date.now() }]
  assert.equal(bot.detectGroupRepeat(makeEvent("g", { msg: "哈哈", userId: "2" }), state), null)
})

test("detectGroupRepeat：冷却期内不重复跟读", () => {
  const bot = makeBot({ config: { smartTrigger: { repeatJoinProbability: 1 } } })
  const state = bot.getSmartState(newGroupId())
  state.recentMessages = [
    { userId: "1", text: "哈哈", at: Date.now() },
    { userId: "2", text: "哈哈", at: Date.now() }
  ]
  state.lastRepeatJoinAt = Date.now()
  assert.equal(bot.detectGroupRepeat(makeEvent("g", { msg: "哈哈", userId: "3" }), state), null)
})

test("detectGroupRepeat：超长文本 / 开关关闭 不参与", () => {
  const bot = makeBot({ config: { smartTrigger: { repeatJoinProbability: 1 } } })
  const state = bot.getSmartState(newGroupId())
  assert.equal(bot.detectGroupRepeat(makeEvent("g", { msg: "a".repeat(40) }), state), null)

  const disabled = makeBot({ config: { smartTrigger: { repeatJoinEnabled: false } } })
  assert.equal(disabled.detectGroupRepeat(makeEvent("g", { msg: "哈哈" }), state), null)
})

test("joinRepeat：发送成功才提交状态（时间戳/冷却/清 pending）", async () => {
  const bot = makeBot()
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  state.pendingCount = 3
  state.forceContinue = true
  const e = { group_id: groupId, reply: async () => {} }
  assert.equal(await bot.joinRepeat(e, state, "哈哈"), true)
  assert.equal(state.recentReplyTimestamps.length, 1)
  assert.ok(state.lastRepeatJoinAt > 0)
  assert.equal(state.pendingCount, 0)
  assert.equal(state.forceContinue, false)
})

test("joinRepeat：发送失败不脏写状态", async () => {
  const bot = makeBot()
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  const e = { group_id: groupId, reply: async () => { throw new Error("发送失败") } }
  assert.equal(await bot.joinRepeat(e, state, "哈哈"), false)
  assert.equal((state.recentReplyTimestamps || []).length, 0)
  assert.equal(state.lastRepeatJoinAt, 0)
})

// ==================== resolveTalkValue / 空窗补偿 / 延迟统计 ====================

test("resolveTalkValue：未启用规则时用全局 talkValue", () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 0.5 } } })
  assert.equal(bot.resolveTalkValue("g"), 0.5)
})

test("resolveTalkValue：全天规则命中取规则值，坏规则跳过回退", () => {
  const hit = makeBot({ config: { smartTrigger: {
    talkValue: 1, enableTalkValueRules: true,
    talkValueRules: [{ range: "00:00-23:59", value: 0.2 }]
  } } })
  assert.equal(hit.resolveTalkValue("g"), 0.2)

  const bad = makeBot({ config: { smartTrigger: {
    talkValue: 1, enableTalkValueRules: true,
    talkValueRules: [{ range: "12:00", value: 0.3 }, { range: "00:00-23:59", value: "abc" }]
  } } })
  assert.equal(bad.resolveTalkValue("g"), 1)
})

test("idleCompensationMet：空窗折算等效消息数凑够阈值触发", () => {
  const bot = makeBot({ config: { smartTrigger: { idleCompensationEnabled: true, avgLatencyDefaultMs: 60000 } } })
  const state = { pendingCount: 0, replyLatencies: [] }
  assert.equal(bot.idleCompensationMet(state, 2, Date.now() - 121000), true)
  assert.equal(bot.idleCompensationMet(state, 2, Date.now() - 30000), false)

  const off = makeBot()
  assert.equal(off.idleCompensationMet(state, 2, Date.now() - 121000), false)
})

test("computeAvgReplyLatency：取 10 分钟内平均值，过期条目剪除", () => {
  const bot = makeBot()
  assert.equal(bot.computeAvgReplyLatency({ replyLatencies: [] }), 0)
  const state = { replyLatencies: [
    { at: Date.now(), ms: 1000 },
    { at: Date.now(), ms: 3000 },
    { at: Date.now() - 700000, ms: 99999 }
  ] }
  assert.equal(bot.computeAvgReplyLatency(state), 2000)
  assert.equal(state.replyLatencies.length, 2)
})

test("computeGroupMsgRate5min：只统计 5 分钟内的消息", () => {
  const bot = makeBot()
  assert.equal(bot.computeGroupMsgRate5min({}), 0)
  const state = { recentIncomingTimestamps: [Date.now(), Date.now(), Date.now() - 400000] }
  assert.equal(bot.computeGroupMsgRate5min(state), 2)
})

// ==================== strict 追踪回复去抖 ====================

test("applyTrackingReplyDebounce：关闭时直接放行", async () => {
  const bot = makeBot({ config: { conversationTrackingReplyDebounceMs: 0 } })
  assert.equal(await bot.applyTrackingReplyDebounce("k", 1), true)
})

test("applyTrackingReplyDebounce：等待期无新消息放行，有新消息让步", async () => {
  const bot = makeBot({ config: { conversationTrackingReplyDebounceMs: 20 } })

  const quietKey = `ct_quiet_${Date.now()}`
  const seq1 = bot.markTrackingArrival(quietKey)
  assert.equal(await bot.applyTrackingReplyDebounce(quietKey, seq1), true)

  const busyKey = `ct_busy_${Date.now()}`
  const seq2 = bot.markTrackingArrival(busyKey)
  const pending = bot.applyTrackingReplyDebounce(busyKey, seq2)
  bot.markTrackingArrival(busyKey) // 等待期内又来一条
  assert.equal(await pending, false)
  trackingLastMsgAt.delete(quietKey)
  trackingLastMsgAt.delete(busyKey)
})

// ==================== isMutedInGroup ====================

test("isMutedInGroup：mute_left>0 判定禁言，且 30s 内走缓存", async () => {
  const bot = makeBot()
  const groupId = newGroupId()
  assert.equal(await bot.isMutedInGroup({ group_id: groupId, group: { mute_left: 120 } }), true)
  // 同群第二次查询：即使群信息已显示未禁言，仍命中缓存返回 true
  assert.equal(await bot.isMutedInGroup({ group_id: groupId, group: { mute_left: 0 } }), true)
})

test("isMutedInGroup：无禁言信号且拉不到成员信息时判为未禁言", async () => {
  const bot = makeBot()
  assert.equal(await bot.isMutedInGroup({ group_id: newGroupId(), group: {} }), false)
})

// ==================== handleRandomReplySmart 标志生命周期 ====================

test("smart：Gate continue → 触发 handleTool，状态清零并升 focus", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  const groupId = newGroupId()

  const result = await bot.handleRandomReplySmart(makeEvent(groupId))

  assert.equal(result, true)
  assert.equal(bot.__calls.gate.length, 1)
  assert.equal(bot.__calls.handleTool.length, 1)
  const state = bot.getSmartState(groupId)
  assert.equal(state.pendingCount, 0)
  assert.equal(state.conversationPhase, "focus")
  assert.equal(state.focusReplyCount, 1)
  assert.equal(state.recentReplyTimestamps.length, 1)
  assert.equal(state.inFlight, false)
})

test("smart：focus 期连续 no_action 达上限降级 fading", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  state.conversationPhase = "focus"
  state.phaseUntil = Date.now() + 60000

  await bot.handleRandomReplySmart(makeEvent(groupId))
  assert.equal(state.consecutiveNoAction, 1)
  assert.equal(state.conversationPhase, "focus")
  assert.ok(state.lastGateNoActionAt > 0)

  await bot.handleRandomReplySmart(makeEvent(groupId))
  assert.equal(state.conversationPhase, "fading")
  assert.equal(state.consecutiveNoAction, 0)
  assert.equal(bot.__calls.handleTool.length, 0)
})

test("smart：@bot 强制路径跳过 Gate 直接回复，新一轮 focus 计数从 0 开始", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 0.1 } } }) // 阈值 10，验证 force 无视阈值
  bot.checkTriggers = () => true
  const groupId = newGroupId()
  const e = makeEvent(groupId, { msg: "", message: [{ type: "at", qq: 10000 }] })

  const result = await bot.handleRandomReplySmart(e)

  assert.equal(result, true)
  assert.equal(bot.__calls.gate.length, 0)
  assert.equal(bot.__calls.handleTool.length, 1)
  const state = bot.getSmartState(groupId)
  assert.equal(state.conversationPhase, "focus")
  assert.equal(state.focusReplyCount, 0)
  assert.equal(state.forceContinue, false)
  assert.equal(state.recentReplyTimestamps.length, 1) // force 也计入速率统计
})

test("smart：未达阈值不请求 Gate，pendingCount 累积", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 0.2 } } }) // 阈值 5
  const groupId = newGroupId()

  const result = await bot.handleRandomReplySmart(makeEvent(groupId))

  assert.equal(result, false)
  assert.equal(bot.__calls.gate.length, 0)
  assert.equal(bot.getSmartState(groupId).pendingCount, 1)
})

test("smart：入口锁占用时让步并登记排队重跑", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  state.inFlight = true
  const e = makeEvent(groupId)

  const result = await bot.handleRandomReplySmart(e)

  assert.equal(result, false)
  assert.equal(state.queuedWhileInFlight, 1)
  assert.equal(state.needsRerun, true)
  assert.equal(state.rerunEvent, e)
  // 复位，避免影响后续（本测试不触发 finally 的重跑路径）
  state.inFlight = false
  state.needsRerun = false
  state.rerunEvent = null
})

test("smart：同一 message_id 的重复投递只处理一次", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  const groupId = newGroupId()
  const first = makeEvent(groupId, { msg: "@机器人 你好" })
  first.message_id = "duplicate-message-1"
  const second = makeEvent(groupId, { msg: "@机器人 你好" })
  second.message_id = "duplicate-message-1"

  assert.equal(await bot.handleRandomReplySmart(first), true)
  assert.equal(await bot.handleRandomReplySmart(second), false)
  assert.equal(bot.__calls.gate.length, 1)
  assert.equal(bot.__calls.handleTool.length, 1)
})

test("smart：不同机器人账号收到同一 message_id 时不会互相误去重", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  const groupId = newGroupId()
  const first = makeEvent(groupId, { msg: "@机器人A 你好" })
  first.self_id = "bot-a"
  first.message_id = "shared-message-id"
  const second = makeEvent(groupId, { msg: "@机器人B 你好" })
  second.self_id = "bot-b"
  second.message_id = "shared-message-id"

  assert.equal(await bot.handleRandomReplySmart(first), true)
  assert.equal(await bot.handleRandomReplySmart(second), true)
  assert.equal(bot.__calls.gate.length, 2)
  assert.equal(bot.__calls.handleTool.length, 2)
})

test("smart：首轮仍在处理中时，同一 message_id 不会被排成第二轮", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  let releaseHandleTool
  const handleToolBlocked = new Promise(resolve => { releaseHandleTool = resolve })
  bot.handleTool = async e => {
    bot.__calls.handleTool.push(e)
    await handleToolBlocked
    return true
  }
  const groupId = newGroupId()
  const first = makeEvent(groupId, { msg: "你知道我刚才说的果汁值是什么？" })
  first.message_id = "same-user-message"
  const duplicate = makeEvent(groupId, { msg: "你知道我刚才说的果汁值是什么？" })
  duplicate.message_id = "same-user-message"

  const firstRun = bot.handleRandomReplySmart(first)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await bot.handleRandomReplySmart(duplicate), false)
  const state = bot.getSmartState(groupId)
  assert.equal(state.needsRerun, false)
  assert.equal(state.queuedWhileInFlight, 0)
  releaseHandleTool()
  assert.equal(await firstRun, true)
  assert.equal(bot.__calls.handleTool.length, 1)
})

test("smart：前一轮回复已读取到排队的 @ 消息时取消第二轮", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  let enteredHandleTool
  const handleToolEntered = new Promise(resolve => { enteredHandleTool = resolve })
  let releaseHistorySnapshot
  const historySnapshotReady = new Promise(resolve => { releaseHistorySnapshot = resolve })
  bot.handleTool = async e => {
    bot.__calls.handleTool.push(e)
    enteredHandleTool()
    await historySnapshotReady
    e._smartHistoryContextVersion = bot.getSmartState(e.group_id).groupContextVersion
    e._conversationProducedOutput = true
    return true
  }
  bot.checkTriggers = e => e.msg?.includes("果汁值")
  const groupId = newGroupId()
  const oldMessage = makeEvent(groupId, { msg: "前一条普通消息" })
  oldMessage.message_id = "old-message"
  const atMessage = makeEvent(groupId, { msg: "你知道我刚才说的果汁值是什么？" })
  atMessage.message_id = "at-message"

  const firstRun = bot.handleRandomReplySmart(oldMessage)
  await handleToolEntered
  assert.equal(await bot.handleRandomReplySmart(atMessage), false)
  releaseHistorySnapshot()
  assert.equal(await firstRun, true)
  await new Promise(resolve => setImmediate(resolve))

  const state = bot.getSmartState(groupId)
  assert.equal(bot.__calls.handleTool.length, 1)
  assert.equal(state.needsRerun, false)
  assert.equal(state.forceContinue, false)
})

test("smart：@ 消息在前一轮历史快照之后到达时仍保留必回第二轮", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  bot.checkTriggers = e => e.msg?.includes("果汁值")
  let enteredFirstHandleTool
  const firstHandleToolEntered = new Promise(resolve => { enteredFirstHandleTool = resolve })
  let releaseFirstHandleTool
  const firstHandleToolBlocked = new Promise(resolve => { releaseFirstHandleTool = resolve })
  bot.handleTool = async e => {
    bot.__calls.handleTool.push(e)
    if (bot.__calls.handleTool.length === 1) {
      e._smartHistoryContextVersion = Number(e._smartContextVersion) || 0
      enteredFirstHandleTool()
      await firstHandleToolBlocked
    }
    e._conversationProducedOutput = true
    return true
  }
  const groupId = newGroupId()
  const oldMessage = makeEvent(groupId, { msg: "前一条普通消息" })
  oldMessage.message_id = "snapshot-old-message"
  const atMessage = makeEvent(groupId, { msg: "你知道我刚才说的果汁值是什么？" })
  atMessage.message_id = "snapshot-at-message"

  const firstRun = bot.handleRandomReplySmart(oldMessage)
  await firstHandleToolEntered
  assert.equal(await bot.handleRandomReplySmart(atMessage), false)
  releaseFirstHandleTool()
  assert.equal(await firstRun, true)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(bot.__calls.handleTool.length, 2)
})

test("smart：多条排队消息中历史只覆盖前半段时保留最新 @ 的必回重跑", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  bot.checkTriggers = e => e.msg?.includes("果汁值")
  let enteredFirstHandleTool
  const firstHandleToolEntered = new Promise(resolve => { enteredFirstHandleTool = resolve })
  let allowHistorySnapshot
  const historySnapshotAllowed = new Promise(resolve => { allowHistorySnapshot = resolve })
  let historySnapshotTaken
  const historySnapshotReady = new Promise(resolve => { historySnapshotTaken = resolve })
  let releaseFirstHandleTool
  const firstHandleToolBlocked = new Promise(resolve => { releaseFirstHandleTool = resolve })
  bot.handleTool = async e => {
    bot.__calls.handleTool.push(e)
    if (bot.__calls.handleTool.length === 1) {
      enteredFirstHandleTool()
      await historySnapshotAllowed
      e._smartHistoryContextVersion = bot.getSmartState(e.group_id).groupContextVersion
      historySnapshotTaken()
      await firstHandleToolBlocked
    }
    e._conversationProducedOutput = true
    return true
  }
  const groupId = newGroupId()
  const oldMessage = makeEvent(groupId, { msg: "前一条普通消息" })
  oldMessage.message_id = "partial-old-message"
  const firstAtMessage = makeEvent(groupId, { msg: "第一个果汁值问题" })
  firstAtMessage.message_id = "partial-at-before-snapshot"
  const secondAtMessage = makeEvent(groupId, { msg: "第二个果汁值问题" })
  secondAtMessage.message_id = "partial-at-after-snapshot"

  const firstRun = bot.handleRandomReplySmart(oldMessage)
  await firstHandleToolEntered
  assert.equal(await bot.handleRandomReplySmart(firstAtMessage), false)
  allowHistorySnapshot()
  await historySnapshotReady
  assert.equal(await bot.handleRandomReplySmart(secondAtMessage), false)
  releaseFirstHandleTool()
  assert.equal(await firstRun, true)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(bot.__calls.handleTool.length, 2)
  assert.equal(bot.__calls.handleTool[1].message_id, "partial-at-after-snapshot")
})

test("smart：Gate wait 决策 → 排续话定时器且秒数被夹到上限", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "wait", wait_seconds: 300 }
  const groupId = newGroupId()

  const result = await bot.handleRandomReplySmart(makeEvent(groupId))

  assert.equal(result, false)
  assert.deepEqual(bot.__calls.waitReply, [{ sec: 60, reason: "gate_wait", kind: "gate" }])
  const state = bot.getSmartState(groupId)
  assert.equal(state.pendingCount, 0)
  assert.equal(state.consecutiveNoAction, 0)
})

test("smart：速率上限已满时 Gate continue 也不回复", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  state.recentReplyTimestamps = Array.from({ length: 8 }, () => Date.now())

  const result = await bot.handleRandomReplySmart(makeEvent(groupId))

  assert.equal(result, false)
  assert.equal(bot.__calls.handleTool.length, 0)
  assert.equal(state.conversationPhase, "fading")
  assert.equal(state.pendingCount, 0)
})

test("smart：debounce 检测到新消息让步时回滚 focus 计数和速率时间戳", async () => {
  const bot = makeBot({ config: { smartTrigger: { talkValue: 1 } } })
  bot.gateResult = { decision: "continue" }
  bot.applyReplyDebounce = async () => false
  const groupId = newGroupId()

  const result = await bot.handleRandomReplySmart(makeEvent(groupId))

  assert.equal(result, false)
  assert.equal(bot.__calls.handleTool.length, 0)
  const state = bot.getSmartState(groupId)
  assert.equal(state.focusReplyCount, 0)
  assert.equal(state.recentReplyTimestamps.length, 0)
})

// ==================== getSmartState（放最后：会向共享 Map 灌入大量状态） ====================

test("getSmartState：同群返回同一状态对象，新状态字段齐全", () => {
  const bot = makeBot()
  const groupId = newGroupId()
  const state = bot.getSmartState(groupId)
  assert.equal(bot.getSmartState(groupId), state)
  assert.equal(state.pendingCount, 0)
  assert.equal(state.conversationPhase, "cold")
  assert.ok(state.waitTimers instanceof Map)
  assert.ok(state.receivedEvents)
  assert.ok(state.completedEvents)
})

test("getSmartState：超过 100 群按 lastMsgAt 淘汰最旧，活跃群保留", () => {
  const bot = makeBot()
  const keepId = newGroupId()
  const keepState = bot.getSmartState(keepId) // lastMsgAt = 现在，不该被淘汰
  const oldStates = []
  for (let i = 0; i < 100; i++) {
    const st = bot.getSmartState(`ct_lru_old_${i}`)
    st.lastMsgAt = i + 1 // 回拨成远古时间，成为淘汰候选
    oldStates.push(st)
  }
  bot.getSmartState(`ct_lru_new`) // 触发淘汰
  assert.equal(bot.getSmartState(keepId), keepState)
  assert.notEqual(bot.getSmartState("ct_lru_old_0"), oldStates[0]) // 最旧的已被淘汰重建
})
