import test from "node:test"
import assert from "node:assert/strict"
import { prefilterMessage } from "../core/prefilter.js"

const BOT_UIN = 123456
const prefilter = (e, state = {}) => prefilterMessage(e, state, {}, BOT_UIN)

const makeEvent = ({ message = [], msg = "", userId = 10001 } = {}) => ({
  user_id: userId,
  message,
  msg
})

test("prefilterMessage：裸 @bot（无文本）返回 force_continue，不被 empty_content 吞掉", () => {
  const e = makeEvent({ message: [{ type: "at", qq: BOT_UIN }], msg: "" })
  assert.deepEqual(prefilter(e), { kind: "force_continue", reason: "at_bot" })
})

test("prefilterMessage：@bot 携带文本同样 force_continue", () => {
  const e = makeEvent({ message: [{ type: "at", qq: BOT_UIN }, { type: "text", text: "在吗" }], msg: "在吗" })
  assert.equal(prefilter(e).kind, "force_continue")
})

test("prefilterMessage：@bot 的 qq 为字符串也能识别（String 比较）", () => {
  const e = makeEvent({ message: [{ type: "at", qq: String(BOT_UIN) }], msg: "" })
  assert.equal(prefilter(e).kind, "force_continue")
})

test("prefilterMessage：@ 别人返回 addressed_other", () => {
  const e = makeEvent({ message: [{ type: "at", qq: 999 }], msg: "你来" })
  assert.equal(prefilter(e).kind, "addressed_other")
})

test("prefilterMessage：无 @ 的空文本仍为 empty_content", () => {
  const e = makeEvent({ message: [{ type: "image", url: "x" }], msg: "" })
  assert.equal(prefilter(e).kind, "empty_content")
})

test("prefilterMessage：bot 自己的消息返回 bot_self_echo", () => {
  const e = makeEvent({ userId: BOT_UIN, message: [{ type: "text", text: "我自己" }], msg: "我自己" })
  assert.equal(prefilter(e).kind, "bot_self_echo")
})

test("prefilterMessage：普通文本返回 regular", () => {
  const e = makeEvent({ message: [{ type: "text", text: "今天天气不错" }], msg: "今天天气不错" })
  assert.equal(prefilter(e).kind, "regular")
})

test("prefilterMessage：bot 刚发言后的消息命中 R1 接续", () => {
  const e = makeEvent({ message: [{ type: "text", text: "哈哈哈" }], msg: "哈哈哈" })
  const state = { lastBotReplyAt: Date.now() - 5000 }
  assert.deepEqual(prefilter(e, state), { kind: "continuation_strong", reason: "R1_quick_response" })
})
