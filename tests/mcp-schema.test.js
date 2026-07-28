import test from "node:test"
import assert from "node:assert/strict"
import { schemaMethods } from "../utils/mcp/schemaMethods.js"

const { resolveRef, cleanSchema, prepareInputSchema } = schemaMethods

test("resolveRef：JSON Pointer 解析与 ~0/~1 转义", () => {
  const root = { $defs: { Foo: { type: "string" } }, "a/b": { "c~d": 42 } }
  assert.deepEqual(resolveRef("#/$defs/Foo", root), { type: "string" })
  assert.equal(resolveRef("#/a~1b/c~0d", root), 42)
  assert.equal(resolveRef("#/missing/path", root), null)
  assert.equal(resolveRef("http://ext/ref", root), null)
  assert.equal(resolveRef(null, root), null)
})

test("dereferenceSchema：$ref 展开且本地字段覆盖目标字段", () => {
  const root = {
    $defs: { Name: { type: "string", description: "原描述" } },
    type: "object",
    properties: {
      name: { $ref: "#/$defs/Name", description: "覆盖描述" }
    }
  }
  const result = schemaMethods.dereferenceSchema(root)
  assert.equal(result.properties.name.type, "string")
  assert.equal(result.properties.name.description, "覆盖描述")
  assert.equal(result.properties.name.$ref, undefined)
})

test("dereferenceSchema：循环 $ref 不死循环", () => {
  const root = {
    $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    $ref: "#/$defs/Node"
  }
  const result = schemaMethods.dereferenceSchema(root)
  assert.equal(result.type, "object")
})

test("cleanSchema：剔除不支持字段并只保留安全字段", () => {
  const cleaned = cleanSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      a: { type: "string", default: "x", examples: ["y"], minLength: 2 }
    },
    required: ["a", "ghost"]
  })
  assert.deepEqual(cleaned, {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"]
  })
})

test("cleanSchema：const 与 anyOf 组合折叠为 enum", () => {
  const cleaned = cleanSchema({
    type: "object",
    properties: {
      mode: { anyOf: [{ const: "fast" }, { const: "slow" }] }
    }
  })
  assert.equal(cleaned.properties.mode.type, "string")
  assert.deepEqual(cleaned.properties.mode.enum, ["fast", "slow"])
})

test("cleanSchema：可空类型数组取首个有效类型", () => {
  const cleaned = cleanSchema({
    type: "object",
    properties: { q: { type: ["string", "null"] } }
  })
  assert.equal(cleaned.properties.q.type, "string")
})

test("cleanSchema：数值 enum 收进 description（模型侧只保留字符串 enum）", () => {
  const cleaned = cleanSchema({
    type: "object",
    properties: { level: { type: "integer", enum: [1, 2, 2] } }
  })
  assert.equal(cleaned.properties.level.type, "integer")
  assert.equal(cleaned.properties.level.enum, undefined)
  assert.ok(cleaned.properties.level.description.includes("1、2"))
})

test("cleanSchema：数组 tuple items 取首个，object 属性非法值兜底为 string", () => {
  const cleaned = cleanSchema({
    type: "object",
    properties: {
      list: { type: "array", items: [{ type: "number" }, { type: "string" }] },
      bad: "not-a-schema"
    }
  })
  assert.deepEqual(cleaned.properties.list.items, { type: "number" })
  assert.deepEqual(cleaned.properties.bad, { type: "string" })
})

test("cleanSchema：array 类型缺 items 时补默认 string items", () => {
  const cleaned = cleanSchema({ type: "array" })
  assert.deepEqual(cleaned.items, { type: "string" })
})

test("prepareInputSchema：空/非法输入兜底为空 object schema", () => {
  const empty = { type: "object", properties: {}, required: [] }
  assert.deepEqual(prepareInputSchema.call(schemaMethods, null), empty)
  assert.deepEqual(prepareInputSchema.call(schemaMethods, "oops"), empty)
})

test("prepareInputSchema：$defs + $ref 全流程展开清洗", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { Query: { type: "string", description: "查询词" } },
    type: "object",
    properties: { query: { $ref: "#/$defs/Query" } },
    required: ["query"]
  }
  const result = prepareInputSchema.call(schemaMethods, schema)
  assert.deepEqual(result, {
    type: "object",
    properties: { query: { type: "string", description: "查询词" } },
    required: ["query"]
  })
})

test("prepareInputSchema：顶层缺 type 时补 object", () => {
  const result = prepareInputSchema.call(schemaMethods, { properties: { a: { type: "string" } } })
  assert.equal(result.type, "object")
  assert.deepEqual(result.required, [])
})
