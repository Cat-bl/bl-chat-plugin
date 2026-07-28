import test from "node:test"
import assert from "node:assert/strict"
import { toolExecutorMethods } from "../core/toolExecutor.js"

const {
  getToolRunKey,
  isDedupeTool,
  syncDedupeToolConfig,
  normalizeAssistantToolMessage,
  serializeToolResult,
  dedupeToolCalls,
  executeTool
} = toolExecutorMethods

test("getToolRunKey：群/用户/工具名拼接", () => {
  assert.equal(getToolRunKey(123, 456, "bananaTool"), "123:456:bananaTool")
})

test("isDedupeTool：按 dedupeToolNames 集合判断", () => {
  const self = { dedupeToolNames: new Set(["bananaTool"]) }
  assert.equal(isDedupeTool.call(self, "bananaTool"), true)
  assert.equal(isDedupeTool.call(self, "pokeTool"), false)
  assert.ok(!isDedupeTool.call({}, "bananaTool"))
})

test("syncDedupeToolConfig：解析 (dedupe) 标记并容忍非数组输入", () => {
  const self = { config: {} }
  syncDedupeToolConfig.call(self, ["bananaTool(dedupe)", "pokeTool", "likeTool( dedupe )"])
  assert.deepEqual([...self.dedupeToolNames].sort(), ["bananaTool", "likeTool"])

  syncDedupeToolConfig.call(self, "not-an-array")
  assert.equal(self.dedupeToolNames.size, 0)
})

test("normalizeAssistantToolMessage：补齐 type/arguments 默认值", () => {
  const normalized = normalizeAssistantToolMessage({
    tool_calls: [{ id: "c1", function: { name: "search" } }]
  })
  assert.equal(normalized.role, "assistant")
  assert.equal(normalized.content, "")
  assert.deepEqual(normalized.tool_calls, [
    { id: "c1", type: "function", function: { name: "search", arguments: "{}" } }
  ])
  assert.equal("reasoning_content" in normalized, false)
})

test("normalizeAssistantToolMessage：保留 reasoning_content", () => {
  const normalized = normalizeAssistantToolMessage({
    content: "想一下",
    reasoning_content: "思考过程",
    tool_calls: []
  })
  assert.equal(normalized.reasoning_content, "思考过程")
})

test("serializeToolResult：字符串透传、MCP content 数组拼接、对象 JSON 化", () => {
  assert.equal(serializeToolResult("ok"), "ok")
  assert.equal(
    serializeToolResult({ content: [{ type: "text", text: "a" }, { type: "image", url: "u" }] }),
    'a\n{"type":"image","url":"u"}'
  )
  assert.equal(serializeToolResult({ a: 1 }), '{"a":1}')
  assert.equal(serializeToolResult(null), '""')
})

test("dedupeToolCalls：同名同参去重、不同参保留", () => {
  const calls = [
    { function: { name: "poke", arguments: '{"qq":1}' } },
    { function: { name: "poke", arguments: '{"qq":1}' } },
    { function: { name: "poke", arguments: '{"qq":2}' } },
    { function: { name: "like" } },
    { function: { name: "like" } }
  ]
  const deduped = dedupeToolCalls(calls)
  assert.equal(deduped.length, 3)
  assert.deepEqual(deduped.map(c => c.function.arguments || null), ['{"qq":1}', '{"qq":2}', null])
})

test("executeTool：本地工具走 execute，非法输入返回 null", async () => {
  const tool = { execute: async (params, e) => `ran:${params.x}:${e.id}` }
  assert.equal(await executeTool(tool, { x: 1 }, { id: "e1" }), "ran:1:e1")
  assert.equal(await executeTool(null, {}, {}), null)
  assert.equal(await executeTool("notMcpTool", {}, {}), null)
})
