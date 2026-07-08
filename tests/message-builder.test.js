import test from "node:test"
import assert from "node:assert/strict"
import { messageBuilderMethods } from "../core/messageBuilder.js"

const clean = text => messageBuilderMethods.processToolSpecificMessage(text, "anyTool")

test("processToolSpecificMessage：普通文本原样保留", () => {
  assert.equal(clean("今天天气不错"), "今天天气不错")
})

test("processToolSpecificMessage：剥离行内 [图片] 标记", () => {
  assert.equal(clean("看这个[图片]好玩"), "看这个好玩")
})

test("processToolSpecificMessage：markdown 链接转纯文本", () => {
  assert.equal(clean("[百度](https://baidu.com)"), "百度\n- https://baidu.com")
})

test("processToolSpecificMessage：markdown 图片转纯文本（不被 [图片] 剥离拆坏）", () => {
  assert.equal(clean("![图片](https://x.com/a.jpg)"), "图片\n- https://x.com/a.jpg")
})

test("processToolSpecificMessage：完整消息记录行整行移除", () => {
  const record = "[2026-01-27 16:12:51] 哈基米(QQ号: 2127498644)[群身份: member]: 以后注意点。"
  assert.equal(clean(record), "")
})

test("processToolSpecificMessage：多行中只移除消息记录行", () => {
  const input = "你好\n[2026-01-27 16:12:51] 哈基米(QQ号: 123)[群身份: member]: 测试\n再见"
  assert.equal(clean(input), "你好\n再见")
})

test("processToolSpecificMessage：无时间戳的记录前缀残留时提取正文", () => {
  assert.equal(clean("哈基米(QQ号: 123)[群身份: member]: 你好呀"), "你好呀")
})

test("processToolSpecificMessage：剥离开头的 说: 前缀", () => {
  assert.equal(clean("说: 你好"), "你好")
})
