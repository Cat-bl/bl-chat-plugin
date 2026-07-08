// 工具结果错误判定：
// - hasExplicitErrorMarker：只认约定俗成的 "error:" 前缀和显式 "error" JSON 字段，
//   零误判，供工具历史等严格场景使用。
// - isToolResultError：显式标记之外，对短文本额外做中文"失败/错误"模糊匹配。
//   工具自身的错误消息通常很短（如"获取群成员列表失败"）；长文本多为正常内容
//   （如搜索结果正文里出现"失败"两字），不能据此判败。

const FUZZY_FAILURE_MAX_LENGTH = 100

export function hasExplicitErrorMarker(text) {
  if (typeof text !== "string") return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^error[:：]/i.test(trimmed)) return true
  if (/"error"\s*:/.test(trimmed)) return true
  return false
}

export function isToolResultError(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? "")
  if (hasExplicitErrorMarker(text)) return true
  const trimmed = text.trim()
  return trimmed.length > 0 &&
    trimmed.length <= FUZZY_FAILURE_MAX_LENGTH &&
    /失败|错误|失敗|錯誤/.test(trimmed)
}
