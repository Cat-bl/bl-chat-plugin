import test from "node:test"
import assert from "node:assert/strict"
import { parseImportFileName } from "../utils/emoji/importName.js"

test("基本形态：描述[tag,tag]", () => {
  assert.deepEqual(parseImportFileName("开心猫猫[开心,猫]"), { description: "开心猫猫", tags: ["开心", "猫"] })
})

test("全角括号 + 混合分隔符", () => {
  assert.deepEqual(parseImportFileName("震惊【惊讶，震惊、离谱】"), { description: "震惊", tags: ["惊讶", "震惊", "离谱"] })
})

test("无标签组：整体为描述", () => {
  assert.deepEqual(parseImportFileName("笑死"), { description: "笑死", tags: [] })
})

test("空标签组：[] 不产生 tags", () => {
  assert.deepEqual(parseImportFileName("笑死[]"), { description: "笑死", tags: [] })
})

test("仅标签无描述", () => {
  assert.deepEqual(parseImportFileName("[开心]"), { description: "", tags: ["开心"] })
})

test("多余逗号与空项过滤", () => {
  assert.deepEqual(parseImportFileName("x[a,,、b，]"), { description: "x", tags: ["a", "b"] })
})

test("tag 去重与 trim", () => {
  assert.deepEqual(parseImportFileName("x[ a , a ]"), { description: "x", tags: ["a"] })
})

test("仅空格描述 + 空 tags：两者皆空", () => {
  assert.deepEqual(parseImportFileName("   [ , ]"), { description: "", tags: [] })
})

test("空串 / null / undefined 不抛错", () => {
  assert.deepEqual(parseImportFileName(""), { description: "", tags: [] })
  assert.deepEqual(parseImportFileName(null), { description: "", tags: [] })
  assert.deepEqual(parseImportFileName(undefined), { description: "", tags: [] })
})

test("中间括号不算标签组，只取结尾", () => {
  assert.deepEqual(parseImportFileName("a[b]c"), { description: "a[b]c", tags: [] })
  assert.deepEqual(parseImportFileName("a[b]c[d]"), { description: "a[b]c", tags: ["d"] })
})

test("括号风格不成对：整体为描述", () => {
  assert.deepEqual(parseImportFileName("desc【a]"), { description: "desc【a]", tags: [] })
})

test("描述截断 300 字", () => {
  const long = "长".repeat(301)
  const { description } = parseImportFileName(long)
  assert.equal(description.length, 300)
})
