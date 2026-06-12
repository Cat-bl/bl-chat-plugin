import test from "node:test"
import assert from "node:assert/strict"
import { AbstractTool } from "../functions/functions_tools/AbstractTool.js"

function makeTool(parameters) {
  const tool = new AbstractTool()
  tool.name = "demoTool"
  tool.description = "测试用工具"
  tool.parameters = parameters
  return tool
}

test("缺少必填参数时返回错误信息", () => {
  const tool = makeTool({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"]
  })
  assert.equal(tool.validateParameters({}), "缺少必填参数: city")
})

test("参数齐全且类型正确时返回 true", () => {
  const tool = makeTool({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"]
  })
  assert.equal(tool.validateParameters({ city: "北京" }), true)
})

test("参数不是对象时返回错误信息", () => {
  const tool = makeTool({ type: "object", properties: {}, required: [] })
  assert.equal(tool.validateParameters(null), "参数必须是一个对象")
  assert.equal(tool.validateParameters("字符串"), "参数必须是一个对象")
})

test("array 类型：字符串自动转为单元素数组", () => {
  const tool = makeTool({
    type: "object",
    properties: { qq: { type: "array", items: { type: "string" } } },
    required: ["qq"]
  })
  const params = { qq: "123456" }
  assert.equal(tool.validateParameters(params), true)
  assert.deepEqual(params.qq, ["123456"])
})

test("array 类型：元素类型不符时返回错误信息", () => {
  const tool = makeTool({
    type: "object",
    properties: { qq: { type: "array", items: { type: "string" } } },
    required: ["qq"]
  })
  assert.equal(
    tool.validateParameters({ qq: [123] }),
    "参数 qq 的数组元素类型错误，应为 string"
  )
})

test("number 自动转 string、string 自动转 number", () => {
  const tool = makeTool({
    type: "object",
    properties: {
      text: { type: "string" },
      count: { type: "number" }
    },
    required: []
  })
  const params = { text: 42, count: "7" }
  assert.equal(tool.validateParameters(params), true)
  assert.equal(params.text, "42")
  assert.equal(params.count, 7)
})

test("无法转换的类型返回错误信息", () => {
  const tool = makeTool({
    type: "object",
    properties: { count: { type: "number" } },
    required: []
  })
  assert.equal(tool.validateParameters({ count: "abc" }), "参数 count 类型错误，应为 number")
})

test("pattern 不匹配时返回错误信息", () => {
  const tool = makeTool({
    type: "object",
    properties: { qq: { type: "string", pattern: "^\\d+$" } },
    required: []
  })
  assert.equal(tool.validateParameters({ qq: "abc" }), "参数 qq 格式不正确")
  assert.equal(tool.validateParameters({ qq: "123" }), true)
})

test("number 的 minimum/maximum 约束", () => {
  const tool = makeTool({
    type: "object",
    properties: { n: { type: "number", minimum: 1, maximum: 10 } },
    required: []
  })
  assert.equal(tool.validateParameters({ n: 0 }), "参数 n 不能小于 1")
  assert.equal(tool.validateParameters({ n: 11 }), "参数 n 不能大于 10")
  assert.equal(tool.validateParameters({ n: 5 }), true)
})

test("execute：参数校验失败时返回 error 字符串而不抛异常", async () => {
  const tool = makeTool({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"]
  })
  assert.equal(await tool.execute({}), "error: 缺少必填参数: city")
})

test("execute：func 抛异常时返回 error 字符串", async () => {
  const tool = makeTool({ type: "object", properties: {}, required: [] })
  tool.func = async () => { throw new Error("内部崩溃") }
  assert.equal(await tool.execute({}), "error: 工具 demoTool 执行失败: 内部崩溃")
})

test("execute：func 正常返回时透传结果", async () => {
  const tool = makeTool({ type: "object", properties: {}, required: [] })
  tool.func = async () => "执行成功"
  assert.equal(await tool.execute({}), "执行成功")
})

test("getToolInfo：缺少名称或描述时抛异常", () => {
  const tool = new AbstractTool()
  assert.throws(() => tool.getToolInfo(), /工具名称是必需的/)
  tool.name = "demoTool"
  assert.throws(() => tool.getToolInfo(), /工具描述是必需的/)
  tool.description = "描述"
  assert.deepEqual(tool.getToolInfo(), {
    name: "demoTool",
    description: "描述",
    parameters: tool.parameters
  })
})
