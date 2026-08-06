import test from "node:test"
import assert from "node:assert/strict"
import {
  clamp,
  uniq,
  sha256,
  safeJsonParse,
  normalizeText,
  compactText,
  containsToolFeedback,
  isLikelyBotCommand,
  isRealUserSource,
  charJaccard,
  isSimilarContent,
  extractJsonArray,
  parseJsonArrayResult,
  keywordSet,
  cosineSimilarity,
  normalizeConfig
} from "../utils/memory/helpers.js"

test("clamp：范围裁剪与非法输入", () => {
  assert.equal(clamp(0.5), 0.5)
  assert.equal(clamp(2), 1)
  assert.equal(clamp(-1), 0)
  assert.equal(clamp("abc"), 0)
  assert.equal(clamp("0.7"), 0.7)
  assert.equal(clamp(5, 0, 10), 5)
})

test("uniq：去重并过滤空值", () => {
  assert.deepEqual(uniq(["a", "a", 1, null, undefined, "", "b"]), ["a", "1", "b"])
  assert.deepEqual(uniq(), [])
})

test("sha256：输出稳定的十六进制摘要", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  assert.equal(sha256(""), sha256(null))
})

test("safeJsonParse：非法 JSON 返回 fallback", () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 })
  assert.equal(safeJsonParse("{broken", "fb"), "fb")
  assert.equal(safeJsonParse("{broken"), null)
})

test("normalizeText：小写化并去掉非文字字符", () => {
  assert.equal(normalizeText("  Hello, 世界! "), "hello世界")
  assert.equal(normalizeText(null), "")
})

test("compactText：折叠空白并截断", () => {
  assert.equal(compactText("  a   b\n\nc  "), "a b c")
  assert.equal(compactText("x".repeat(300), 10), "x".repeat(10))
})

test("containsToolFeedback：识别工具痕迹标记", () => {
  assert.equal(containsToolFeedback("[tool_result] 完成"), true)
  assert.equal(containsToolFeedback("工具已全部执行完成，请回复"), true)
  assert.equal(containsToolFeedback("今天天气不错"), false)
})

test("isLikelyBotCommand：过滤常见机器人命令前缀", () => {
  assert.equal(isLikelyBotCommand("#表情包列表"), true)
  assert.equal(isLikelyBotCommand("/help"), true)
  assert.equal(isLikelyBotCommand("今天聊聊 #AI"), false)
})

test("isRealUserSource：仅用户来源为真", () => {
  assert.equal(isRealUserSource(undefined), true)
  assert.equal(isRealUserSource(""), true)
  assert.equal(isRealUserSource("user"), true)
  assert.equal(isRealUserSource("message"), true)
  assert.equal(isRealUserSource("tool"), false)
})

test("charJaccard：相同为 1、无交集为 0", () => {
  assert.equal(charJaccard("苹果", "苹果"), 1)
  assert.equal(charJaccard("abc", "xyz"), 0)
  assert.equal(charJaccard("", "abc"), 0)
})

test("isSimilarContent：相同/包含/无关", () => {
  assert.equal(isSimilarContent("我喜欢吃苹果", "我喜欢吃苹果"), true)
  assert.equal(isSimilarContent("我喜欢吃苹果", "我喜欢吃苹果啊"), true)
  assert.equal(isSimilarContent("abc", "xyz"), false)
  assert.equal(isSimilarContent("", "abc"), false)
})

test("extractJsonArray：容忍围栏与解释文字", () => {
  assert.deepEqual(extractJsonArray('```json\n[{"op":"add"}]\n```'), [{ op: "add" }])
  assert.deepEqual(extractJsonArray('说明文字 [1,2,3] 结尾'), [1, 2, 3])
  assert.deepEqual(extractJsonArray('{"a":1}'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray("完全不是 JSON"), [])
})

test("parseJsonArrayResult：区分空结果、非法格式并兼容包装对象", () => {
  assert.deepEqual(parseJsonArrayResult("[]"), { items: [], status: "empty" })
  assert.deepEqual(parseJsonArrayResult("完全不是 JSON"), { items: [], status: "invalid" })
  assert.deepEqual(parseJsonArrayResult('{"operations":[{"operation":"upsert"}]}'), {
    items: [{ operation: "upsert" }],
    status: "ok"
  })
})

test("keywordSet：分词并生成中文 2-gram", () => {
  const set = keywordSet("hello 世界真好")
  assert.equal(set.has("hello"), true)
  assert.equal(set.has("世界"), true)
  assert.equal(set.has("界真"), true)
  assert.equal(set.has("真好"), true)
})

test("cosineSimilarity：同向 1、正交 0、长度不等 0", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0)
  assert.equal(cosineSimilarity([], []), 0)
})

test("normalizeConfig：默认值合并与数值兜底", () => {
  const config = normalizeConfig({})
  assert.equal(config.maxFactsPerUser, 100)
  assert.equal(config.importanceThreshold, 0.5)

  const clamped = normalizeConfig({ importanceThreshold: 5, maxFactsPerUser: -3 })
  assert.equal(clamped.importanceThreshold, 1)
  assert.equal(clamped.maxFactsPerUser, 1)

  const zeroValues = normalizeConfig({
    userExtractDebounceSeconds: 0,
    promptMaxUserFacts: 0,
    promptMaxGroupFacts: 0,
    minFactsPerCategory: 0
  })
  assert.equal(zeroValues.userExtractDebounceSeconds, 0)
  assert.equal(zeroValues.promptMaxUserFacts, 0)
  assert.equal(zeroValues.promptMaxGroupFacts, 0)
  assert.equal(zeroValues.minFactsPerCategory, 0)
})

test("normalizeConfig：兼容旧字段 groupExtractMinInterval（毫秒/分钟自适应）", () => {
  assert.equal(normalizeConfig({ groupExtractMinInterval: 600000 }).groupExtractMinIntervalMinutes, 10)
  assert.equal(normalizeConfig({ groupExtractMinInterval: 15 }).groupExtractMinIntervalMinutes, 15)
})
