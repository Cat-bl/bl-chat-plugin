import test from "node:test"
import assert from "node:assert/strict"
import {
  parseToolConfigEntry,
  toolConfigHasName,
  isCodeOrMarkdownRequest,
  looksLikeCodeOrMarkdown
} from "../core/toolConfig.js"

test("parseToolConfigEntry：普通条目", () => {
  assert.deepEqual(parseToolConfigEntry("bananaTool"), {
    name: "bananaTool",
    dedupe: false,
    marker: ""
  })
})

test("parseToolConfigEntry：带 (dedupe) 标记", () => {
  assert.deepEqual(parseToolConfigEntry("bananaTool(dedupe)"), {
    name: "bananaTool",
    dedupe: true,
    marker: "dedupe"
  })
})

test("parseToolConfigEntry：空括号也算 dedupe 标记", () => {
  const parsed = parseToolConfigEntry("fooTool()")
  assert.equal(parsed.name, "fooTool")
  assert.equal(parsed.dedupe, true)
  assert.equal(parsed.marker, "")
})

test("parseToolConfigEntry：非法格式原样返回 name", () => {
  assert.deepEqual(parseToolConfigEntry("123不合法"), {
    name: "123不合法",
    dedupe: false,
    marker: ""
  })
})

test("toolConfigHasName：解析后按名称匹配", () => {
  const tools = ["pokeTool", "bananaTool(dedupe)"]
  assert.equal(toolConfigHasName(tools, "bananaTool"), true)
  assert.equal(toolConfigHasName(tools, "pokeTool"), true)
  assert.equal(toolConfigHasName(tools, "likeTool"), false)
  assert.equal(toolConfigHasName(null, "pokeTool"), false)
})

test("isCodeOrMarkdownRequest：识别代码/文档生成请求", () => {
  assert.equal(isCodeOrMarkdownRequest("帮我写一段冒泡排序的代码"), true)
  assert.equal(isCodeOrMarkdownRequest("生成一份markdown文档"), true)
  assert.equal(isCodeOrMarkdownRequest("今天吃什么"), false)
})

test("looksLikeCodeOrMarkdown：识别代码块", () => {
  assert.equal(looksLikeCodeOrMarkdown("```js\nconsole.log(1)\n```"), true)
})

test("looksLikeCodeOrMarkdown：识别多行代码特征", () => {
  const code = "function add(a, b) {\n  return a + b;\n}"
  assert.equal(looksLikeCodeOrMarkdown(code), true)
})

test("looksLikeCodeOrMarkdown：识别 Markdown 标题与表格", () => {
  assert.equal(looksLikeCodeOrMarkdown("# 标题\n\n正文内容"), true)
  assert.equal(looksLikeCodeOrMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), true)
})

test("looksLikeCodeOrMarkdown：普通短文本返回 false", () => {
  assert.equal(looksLikeCodeOrMarkdown("今天天气不错"), false)
  assert.equal(looksLikeCodeOrMarkdown(""), false)
})
