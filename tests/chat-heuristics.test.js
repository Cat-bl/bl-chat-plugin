import test from "node:test"
import assert from "node:assert/strict"
import {
  extractChatKeywords,
  isQuestionMessage,
  isFeedbackMessage
} from "../core/chatHeuristics.js"

test("extractChatKeywords：提取非停用词关键词并去重", () => {
  const keywords = extractChatKeywords("今天玩原神还是打游戏 原神")
  assert.ok(keywords.includes("今天"))
  assert.ok(keywords.includes("原神"))
  assert.equal(keywords.filter(k => k === "原神").length, 1)
})

test("extractChatKeywords：过滤 CQ 码和链接", () => {
  const keywords = extractChatKeywords("[CQ:image,file=abc.jpg] https://example.com 原神启动")
  assert.ok(!keywords.some(k => k.includes("CQ")))
  assert.ok(!keywords.some(k => k.includes("example")))
})

test("extractChatKeywords：中文长词拆 2-gram", () => {
  const keywords = extractChatKeywords("人工智能技术")
  assert.ok(keywords.includes("人工"))
})

test("extractChatKeywords：非字符串输入返回空数组", () => {
  assert.deepEqual(extractChatKeywords(null), [])
  assert.deepEqual(extractChatKeywords(123), [])
})

test("extractChatKeywords：默认最多返回 5 个", () => {
  const keywords = extractChatKeywords("苹果 香蕉 橘子 葡萄 西瓜 芒果 草莓")
  assert.ok(keywords.length <= 5)
})

test("isQuestionMessage：识别问号与问句尾字", () => {
  assert.equal(isQuestionMessage("你吃了吗"), true)
  assert.equal(isQuestionMessage("这是什么?"), true)
  assert.equal(isQuestionMessage("今天天气如何？"), true)
  assert.equal(isQuestionMessage("我吃过了"), false)
})

test("isQuestionMessage：非字符串输入返回 false", () => {
  assert.equal(isQuestionMessage(null), false)
  assert.equal(isQuestionMessage(undefined), false)
})

test("isFeedbackMessage：整条是反馈词", () => {
  assert.equal(isFeedbackMessage("确实"), true)
  assert.equal(isFeedbackMessage("哈哈"), true)
})

test("isFeedbackMessage：反馈词开头后接标点", () => {
  assert.equal(isFeedbackMessage("对哦，你说得有道理"), true)
  assert.equal(isFeedbackMessage("好的 我知道了"), true)
})

test("isFeedbackMessage：普通陈述不算反馈", () => {
  assert.equal(isFeedbackMessage("今天有点冷"), false)
  assert.equal(isFeedbackMessage(""), false)
})
