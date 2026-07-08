import test from "node:test"
import assert from "node:assert/strict"
import { hasExplicitErrorMarker, isToolResultError } from "../core/toolResult.js"

test("hasExplicitErrorMarker：识别 error: 前缀", () => {
  assert.equal(hasExplicitErrorMarker("error: 参数缺失"), true)
  assert.equal(hasExplicitErrorMarker("Error：请求超时"), true)
  assert.equal(hasExplicitErrorMarker("  error: 带前导空格"), true)
})

test("hasExplicitErrorMarker：识别显式 error JSON 字段", () => {
  assert.equal(hasExplicitErrorMarker('{"error": "boom"}'), true)
  assert.equal(hasExplicitErrorMarker('{"errors": []}'), false)
})

test("hasExplicitErrorMarker：中文失败描述不算显式标记", () => {
  assert.equal(hasExplicitErrorMarker("获取群成员列表失败"), false)
})

test("hasExplicitErrorMarker：空值与非字符串返回 false", () => {
  assert.equal(hasExplicitErrorMarker(""), false)
  assert.equal(hasExplicitErrorMarker("   "), false)
  assert.equal(hasExplicitErrorMarker(null), false)
  assert.equal(hasExplicitErrorMarker(123), false)
})

test("isToolResultError：显式标记直接判败", () => {
  assert.equal(isToolResultError("error: invalid JSON arguments"), true)
  assert.equal(isToolResultError('{"error":"x"}'), true)
  assert.equal(isToolResultError({ error: "x" }), true)
})

test("isToolResultError：短文本中的失败/错误判败", () => {
  assert.equal(isToolResultError("禁言失败: 权限不足"), true)
  assert.equal(isToolResultError("发生错误，请稍后再试"), true)
})

test("isToolResultError：长文本正文出现失败两字不误判", () => {
  const searchResult = "为你找到以下资讯：" +
    "1. 某队在昨晚进行的总决赛第三场比赛中失败，主教练在赛后新闻发布会上表示球队会认真总结经验教训，争取下一场打出更好的表现；" +
    "2. 新版本客户端今日正式发布，修复了多个已知问题并优化了整体性能表现；" +
    "3. 气象部门发布的天气预报显示本周将持续晴朗天气，非常适合安排户外活动。"
  assert.ok(searchResult.length > 100)
  assert.equal(isToolResultError(searchResult), false)
})

test("isToolResultError：正常成功结果返回 false", () => {
  assert.equal(isToolResultError("已成功点赞 10 次"), false)
  assert.equal(isToolResultError(""), false)
  assert.equal(isToolResultError(null), false)
})
