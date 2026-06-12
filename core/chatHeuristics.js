// 拟人化对话相关：本地预筛辅助常量与函数

// 中文停用词（提取关键词时跳过这些）
export const CHAT_STOPWORDS = new Set([
  "的", "了", "是", "也", "就", "都", "吧", "吗", "呢", "啊", "么", "哦", "呀", "嘛", "哈",
  "这", "那", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "觉得", "感觉", "可能", "应该", "不", "没", "有", "在", "和", "与", "或", "但", "而",
  "什么", "怎么", "怎样", "如何", "哪里", "哪个", "为什么", "因为", "所以",
  "一个", "一些", "这个", "那个", "这样", "那样", "这里", "那里",
  "可以", "不能", "需要", "想要", "知道", "听说", "看到"
])

// 反馈词（用户消息开头或主体如果是这些，认为是在回应 bot）
export const FEEDBACK_WORDS = [
  "嗯", "对", "不对", "真的", "真的吗", "是吗", "是的", "确实", "对哦", "也是",
  "好的", "好吧", "可以", "可以的", "不可以", "不是", "没错", "没", "我也", "我觉得", "我感觉",
  "那", "那你", "那我", "你说", "你这", "你这么说",
  "啊？", "啊", "诶", "诶？", "哦", "哦？", "哈哈", "哈"
]

// 问句尾字（消息末尾包含这些算问句）
export const QUESTION_TAIL_CHARS = ["?", "？", "吗", "呢", "啊", "么", "嘛"]

/**
 * 从一段文本提取关键词（给 R2 关键词命中识别用）。
 * 简单实现：按中英标点切分，取长度 ≥2 的非停用词词块，去重，最多 maxCount 个。
 */
export function extractChatKeywords(text, maxCount = 5) {
  if (!text || typeof text !== "string") return []
  // 去除 CQ 码、@ 字段等噪声
  const cleaned = text
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
  // 按非中英文数字字符切分
  const tokens = cleaned.split(/[^一-龥A-Za-z0-9]+/).filter(Boolean)
  const seen = new Set()
  const result = []
  for (const tok of tokens) {
    const t = tok.trim()
    if (t.length < 2) continue
    if (CHAT_STOPWORDS.has(t)) continue
    // 对中文长词额外拆分 2-3 字滑动窗口（避免长句一个 token 没法匹配）
    if (/^[一-龥]+$/.test(t) && t.length >= 4) {
      // 取 2-gram 前缀作为辅助关键词
      for (let i = 0; i <= t.length - 2 && result.length < maxCount; i++) {
        const gram = t.slice(i, i + 2)
        if (CHAT_STOPWORDS.has(gram)) continue
        if (seen.has(gram)) continue
        seen.add(gram)
        result.push(gram)
      }
    } else {
      if (seen.has(t)) continue
      seen.add(t)
      result.push(t)
    }
    if (result.length >= maxCount) break
  }
  return result.slice(0, maxCount)
}

/**
 * 判断消息是否是问句（含 ? / ？ 或末尾 5 字含问句尾字）
 */
export function isQuestionMessage(text) {
  if (!text || typeof text !== "string") return false
  if (/[?？]/.test(text)) return true
  const tail = text.slice(-5)
  for (const ch of QUESTION_TAIL_CHARS) {
    if (tail.includes(ch)) return true
  }
  return false
}

/**
 * 判断消息是否以反馈词开头或主体由反馈词构成
 */
export function isFeedbackMessage(text) {
  if (!text || typeof text !== "string") return false
  const t = text.trim()
  if (!t) return false
  // 整条就是反馈词
  if (FEEDBACK_WORDS.includes(t)) return true
  // 开头是反馈词（后接标点或空格）
  for (const w of FEEDBACK_WORDS) {
    if (t.startsWith(w)) {
      const next = t.charAt(w.length)
      if (!next || /[\s,，。.!！?？~～]/.test(next)) return true
    }
  }
  return false
}
