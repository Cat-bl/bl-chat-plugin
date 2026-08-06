// 长期记忆系统纯函数工具集。从 MemoryManager.js 拆出（行为等价搬迁）。
import { createHash } from "crypto"
import { DEFAULT_CONFIG, TOOL_FEEDBACK_MARKERS } from "./constants.js"

export function now() {
  return Date.now()
}

export function clamp(value, min = 0, max = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.max(min, Math.min(max, number))
}

export function uniq(values = []) {
  return [...new Set(values.filter(v => v !== undefined && v !== null && String(v).trim() !== "").map(String))]
}

export function sha256(text) {
  return createHash("sha256").update(String(text || "")).digest("hex")
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "")
    .trim()
}

export function compactText(text, maxLength = 240) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

export function containsToolFeedback(content) {
  const text = String(content || "")
  return TOOL_FEEDBACK_MARKERS.some(marker => text.includes(marker))
}

export function isLikelyBotCommand(content) {
  return /^[#＃/／]\s*\S/.test(String(content || "").trim())
}

export function isRealUserSource(source) {
  return source === undefined || source === null || source === "" || source === "user" || source === "message"
}

export function charJaccard(a, b) {
  const aa = new Set(normalizeText(a))
  const bb = new Set(normalizeText(b))
  if (!aa.size || !bb.size) return 0
  let intersection = 0
  for (const char of aa) {
    if (bb.has(char)) intersection++
  }
  return intersection / (aa.size + bb.size - intersection)
}

export function isSimilarContent(a, b) {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) > 0.6
  }
  const similarity = charJaccard(na, nb)
  return similarity >= 0.72 || (Math.min(na.length, nb.length) >= 6 && similarity >= 0.6)
}

function normalizeJsonArrayValue(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return null
  for (const key of ["operations", "items", "data", "results"]) {
    if (Array.isArray(value[key])) return value[key]
  }
  return [value]
}

export function parseJsonArrayResult(content) {
  const text = String(content || "").trim()
  if (!text) return { items: [], status: "empty" }

  // 找到第一个 [ 和最后一个 ]，截取中间部分尝试解析
  // 这样可以容忍 LLM 在 JSON 前后追加 markdown 围栏、解释文字等
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start >= 0 && end > start) {
    const parsed = safeJsonParse(text.slice(start, end + 1), null)
    const items = normalizeJsonArrayValue(parsed)
    if (items) return { items, status: items.length ? "ok" : "empty" }
  }

  // 兜底：尝试解析整个文本
  const parsed = safeJsonParse(text, null)
  const items = normalizeJsonArrayValue(parsed)
  if (items) return { items, status: items.length ? "ok" : "empty" }
  return { items: [], status: "invalid" }
}

export function extractJsonArray(content) {
  return parseJsonArrayResult(content).items
}

export function keywordSet(text) {
  const raw = String(text || "").toLowerCase()
  const words = raw
    .split(/[^\p{L}\p{N}\u4e00-\u9fa5]+/u)
    .map(w => w.trim())
    .filter(w => w.length >= 2)

  const cjk = raw.replace(/[^\u4e00-\u9fa5]/g, "")
  for (let i = 0; i < cjk.length - 1; i++) {
    words.push(cjk.slice(i, i + 2))
  }

  return new Set(words)
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let dot = 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    ma += a[i] * a[i]
    mb += b[i] * b[i]
  }
  if (!ma || !mb) return 0
  return Math.max(0, dot / (Math.sqrt(ma) * Math.sqrt(mb)))
}

export function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config }

  if (!Number.isFinite(Number(merged.groupExtractMinIntervalMinutes)) && Number.isFinite(Number(merged.groupExtractMinInterval))) {
    const interval = Number(merged.groupExtractMinInterval)
    merged.groupExtractMinIntervalMinutes = interval > 1000 ? interval / 60000 : interval
  }
  if (Number.isFinite(Number(merged.groupExtractMinInterval)) && !config.groupExtractMinIntervalMinutes) {
    const interval = Number(merged.groupExtractMinInterval)
    merged.groupExtractMinIntervalMinutes = interval > 1000 ? interval / 60000 : interval
  }

  merged.importanceThreshold = clamp(merged.importanceThreshold, 0, 1)
  merged.maxFactsPerUser = Math.max(1, Number(merged.maxFactsPerUser) || DEFAULT_CONFIG.maxFactsPerUser)
  merged.maxFactsPerGroup = Math.max(1, Number(merged.maxFactsPerGroup) || DEFAULT_CONFIG.maxFactsPerGroup)
  merged.memoryDecayDays = Math.max(1, Number(merged.memoryDecayDays) || DEFAULT_CONFIG.memoryDecayDays)
  const userDebounce = Number(merged.userExtractDebounceSeconds)
  merged.userExtractDebounceSeconds = Number.isFinite(userDebounce)
    ? Math.max(0, userDebounce)
    : DEFAULT_CONFIG.userExtractDebounceSeconds
  merged.userExtractMaxBatchMessages = Math.max(1, Number(merged.userExtractMaxBatchMessages) || DEFAULT_CONFIG.userExtractMaxBatchMessages)
  merged.groupExtractMinIntervalMinutes = Math.max(1, Number(merged.groupExtractMinIntervalMinutes) || DEFAULT_CONFIG.groupExtractMinIntervalMinutes)
  merged.groupExtractMaxBatchMessages = Math.max(1, Number(merged.groupExtractMaxBatchMessages) || DEFAULT_CONFIG.groupExtractMaxBatchMessages)
  const promptMaxUserFacts = Number(merged.promptMaxUserFacts)
  const promptMaxGroupFacts = Number(merged.promptMaxGroupFacts)
  merged.promptMaxUserFacts = Number.isFinite(promptMaxUserFacts)
    ? Math.max(0, promptMaxUserFacts)
    : DEFAULT_CONFIG.promptMaxUserFacts
  merged.promptMaxGroupFacts = Number.isFinite(promptMaxGroupFacts)
    ? Math.max(0, promptMaxGroupFacts)
    : DEFAULT_CONFIG.promptMaxGroupFacts
  merged.promptMaxChars = Math.max(100, Number(merged.promptMaxChars) || DEFAULT_CONFIG.promptMaxChars)
  merged.semanticRecallTopK = Math.max(1, Number(merged.semanticRecallTopK) || DEFAULT_CONFIG.semanticRecallTopK)
  const minFactsPerCategory = Number(merged.minFactsPerCategory)
  merged.minFactsPerCategory = Number.isFinite(minFactsPerCategory)
    ? Math.max(0, minFactsPerCategory)
    : DEFAULT_CONFIG.minFactsPerCategory

  return merged
}
