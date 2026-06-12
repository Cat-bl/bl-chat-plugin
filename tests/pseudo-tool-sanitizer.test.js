import test from "node:test"
import assert from "node:assert/strict"
import {
  isPseudoToolMarker,
  sanitizePseudoToolLine,
  sanitizeFinalReplyText
} from "../core/pseudoToolSanitizer.js"

test("isPseudoToolMarker：识别中英文工具标记", () => {
  assert.equal(isPseudoToolMarker("tool"), true)
  assert.equal(isPseudoToolMarker("voiceTool"), true)
  assert.equal(isPseudoToolMarker("工具调用"), true)
  assert.equal(isPseudoToolMarker("语音"), true)
  assert.equal(isPseudoToolMarker("普通文本"), false)
})

test("sanitizePseudoToolLine：剥离 [tool_call] 前缀", () => {
  assert.equal(sanitizePseudoToolLine("[tool_call] 你好呀"), "你好呀")
})

test("sanitizePseudoToolLine：还原 voice(\"...\") 中的文本", () => {
  assert.equal(sanitizePseudoToolLine('voice("早上好")'), "早上好")
})

test("sanitizePseudoToolLine：JSON 形式的伪调用提取 text 字段", () => {
  assert.equal(
    sanitizePseudoToolLine('{"tool": "voiceTool", "arguments": {"text": "晚安"}}'),
    "晚安"
  )
})

test("sanitizePseudoToolLine：无法还原的伪调用整行丢弃（返回 null）", () => {
  assert.equal(sanitizePseudoToolLine("sendImageTool()"), null)
})

test("sanitizePseudoToolLine：普通文本原样保留（含原始缩进）", () => {
  assert.equal(sanitizePseudoToolLine("今天天气不错"), "今天天气不错")
  assert.equal(sanitizePseudoToolLine("  缩进文本"), "  缩进文本")
})

test("sanitizeFinalReplyText：去掉 <think> 思考块", () => {
  assert.equal(
    sanitizeFinalReplyText("<think>内部推理</think>最终回复"),
    "最终回复"
  )
})

test("sanitizeFinalReplyText：剥离外层代码块包裹", () => {
  assert.equal(sanitizeFinalReplyText("```\n你好\n```"), "你好")
  assert.equal(sanitizeFinalReplyText("```text\n你好\n```"), "你好")
})

test("sanitizeFinalReplyText：字面量 \\n 转换为换行", () => {
  assert.equal(sanitizeFinalReplyText("第一行\\n第二行"), "第一行\n第二行")
})

test("sanitizeFinalReplyText：多行中剔除伪工具行保留正文", () => {
  const input = "你好\n[tool_call] sendImageTool()\n再见"
  assert.equal(sanitizeFinalReplyText(input), "你好\n再见")
})

test("sanitizeFinalReplyText：空输入返回空字符串", () => {
  assert.equal(sanitizeFinalReplyText(""), "")
  assert.equal(sanitizeFinalReplyText(null), "")
  assert.equal(sanitizeFinalReplyText(undefined), "")
})
