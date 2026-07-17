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

const getSegs = (config, text) =>
  replySenderMethods.getReplySegments.call(
    { config, splitMessage: replySenderMethods.splitMessage },
    text
  )

test("getReplySegments：开关默认(缺省)时按标点分段", () => {
  const text = "第一句话说得比较长一点。第二句话也说得比较长一点！"
  assert.deepEqual(getSegs({}, text), replySenderMethods.splitMessage(text))
})

test("getReplySegments：开关显式 true 时按标点分段", () => {
  const text = "第一句话说得比较长一点。第二句话也说得比较长一点！"
  assert.deepEqual(getSegs({ segmentedReplyEnabled: true }, text), replySenderMethods.splitMessage(text))
})

test("getReplySegments：开关关闭且无换行时整条不分段", () => {
  const text = "第一句话说得比较长一点。第二句话也说得比较长一点！"
  assert.deepEqual(getSegs({ segmentedReplyEnabled: false }, text), [text])
})

test("getReplySegments：开关关闭但含换行时仍按换行分段", () => {
  assert.deepEqual(getSegs({ segmentedReplyEnabled: false }, "第一段\n第二段"), ["第一段", "第二段"])
})

test("getReplySegments：开关关闭含换行时忽略标点只按换行切", () => {
  const text = "第一句。第二句！\n第三句？第四句"
  assert.deepEqual(getSegs({ segmentedReplyEnabled: false }, text), ["第一句。第二句！", "第三句？第四句"])
})
