import test from "node:test"
import assert from "node:assert/strict"
import { replySenderMethods } from "../core/replySender.js"

const split = text => replySenderMethods.splitMessage(text)

test("splitMessage：CQ 码整体保护，不被分段切断", () => {
  const cq = "[CQ:image,file=abc.jpg,url=https://example.com/a.jpg]"
  const text = `这是一段比较长的话，看看这个图。${cq}后面还有一句结尾的话！`
  const segments = split(text)
  const joined = segments.join("")
  assert.ok(joined.includes(cq), "CQ 码应完整保留在输出中")
  assert.ok(segments.some(s => s.includes(cq)), "CQ 码不应被切成两段")
})

test("splitMessage：按换行切分", () => {
  assert.deepEqual(split("第一段\n第二段"), ["第一段", "第二段"])
})

test("splitMessage：短文本不切分", () => {
  assert.deepEqual(split("你好呀"), ["你好呀"])
})

test("splitMessage：省略号不被当作切分点（3+ 个点规整为 ...）", () => {
  const segments = split("我想想......好吧")
  assert.deepEqual(segments, ["我想想...好吧"])
})
