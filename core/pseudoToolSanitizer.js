import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"

// 伪工具调用清洗：识别并剥离 LLM 偶尔在最终回复里吐出的工具调用痕迹
// （如 `[tool_call] ...`、`voice("...")`、JSON 形式的函数调用等），
// 尽量从中还原出可读文本；无法还原时整行丢弃。

export const PSEUDO_TOOL_MARKERS = [
  "tool", "tools", "tool_call", "toolcall", "function", "function_call", "functioncall", "func", "call", "voice", "audio", "tts", "image", "img",
  "video", "file", "send", "reply", "search", "google", "mcp", "banana", "reminder",
  "poke", "like", "music", "weather", "map", "draw", "generate", "edit",
  "工具", "工具调用", "函数", "函数调用", "调用", "语音", "音频", "图片", "图像", "视频", "文件", "发送",
  "回复", "搜索", "生图", "画图", "修图", "提醒", "戳", "点赞", "点歌", "天气", "地图"
]
export const PSEUDO_TOOL_MARKER_SET = new Set(PSEUDO_TOOL_MARKERS.map(item => item.toLowerCase()))
export const PSEUDO_TOOL_TEXT_KEYS = ["text", "content", "message", "reply", "spoken_text", "speech", "voice"]

export function isPseudoToolMarker(marker = "") {
  const normalized = String(marker || "")
    .trim()
    .replace(/tool$/i, "")
    .replace(/工具$/, "")
    .toLowerCase()
  return PSEUDO_TOOL_MARKER_SET.has(normalized) || PSEUDO_TOOL_MARKER_SET.has(`${normalized}tool`)
}

export function extractReadableTextFromObject(value) {
  if (!value || typeof value !== "object") return ""
  for (const key of PSEUDO_TOOL_TEXT_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim()
  }
  for (const key of ["arguments", "args", "params", "input"]) {
    const nested = extractReadableTextFromObject(value[key])
    if (nested) return nested
  }
  return ""
}

export function extractReadableTextFromPseudoCall(args = "") {
  const rawArgs = String(args || "").trim()
  if (!rawArgs) return ""

  const quotedOnly = rawArgs.match(/^["'`]([\s\S]*?)["'`]$/)
  if (quotedOnly) return quotedOnly[1].trim()

  const textArg = rawArgs.match(/(?:^|[,{\s])(?:text|content|message|reply|spoken_text|speech|voice)\s*[:=]\s*["'`]([\s\S]*?)["'`](?:[,}\s]|$)/i)
  if (textArg) return textArg[1].trim()

  const jsonLike = rawArgs.match(/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
  if (jsonLike) {
    try {
      const parsed = JSON.parse(jsonLike[1])
      return extractReadableTextFromObject(parsed)
    } catch {}
  }

  return ""
}

export function sanitizePseudoToolLine(line) {
  const rawLine = String(line || "")
  let current = rawLine.trim()
  if (!current) return ""

  current = current
    .replace(/^\|?\*+\s*/, "")
    .replace(/\s*\*+\|?$/, "")
    .trim()

  const wrappedTag = current.match(/^<\s*([a-zA-Z_][\w-]*|工具|函数|调用)[^>]*>([\s\S]*?)<\/\s*\1\s*>$/i)
  if (wrappedTag && isPseudoToolMarker(wrappedTag[1])) {
    return sanitizePseudoToolLine(wrappedTag[2])
  }

  const bracketWithColon = current.match(/^[\[【]\s*([^:：\]】\s]{1,32})\s*[:：]\s*([\s\S]*?)[\]】]$/)
  if (bracketWithColon && isPseudoToolMarker(bracketWithColon[1])) {
    return sanitizePseudoToolLine(bracketWithColon[2])
  }

  const bracketPrefix = current.match(/^[\[【]\s*([^\]】\s]{1,32})\s*[\]】]\s*([\s\S]*)$/)
  if (bracketPrefix && isPseudoToolMarker(bracketPrefix[1])) {
    return sanitizePseudoToolLine(bracketPrefix[2])
  }

  const labelPrefix = current.match(/^([A-Za-z_][\w-]*|工具|函数|调用|工具调用|函数调用)\s*[:：]\s*([\s\S]*)$/i)
  if (labelPrefix && isPseudoToolMarker(labelPrefix[1])) {
    return sanitizePseudoToolLine(labelPrefix[2])
  }

  try {
    const parsed = JSON.parse(current)
    const hasToolShape = parsed && typeof parsed === "object" &&
      (parsed.tool || parsed.tool_name || parsed.name || parsed.function || parsed.arguments || parsed.args)
    if (hasToolShape) {
      const readable = extractReadableTextFromObject(parsed)
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  } catch {}

  const functionCall = current.match(/^([A-Za-z_][\w.-]{0,80})\s*\(([\s\S]*)\)$/)
  if (functionCall) {
    const functionName = functionCall[1]
    const lowerName = functionName.toLowerCase()
    const looksLikeToolCall =
      lowerName === "print" ||
      lowerName === "console.log" ||
      lowerName.startsWith("mcp_") ||
      lowerName.includes("tool") ||
      lowerName.endsWith("tool") ||
      PSEUDO_TOOL_MARKER_SET.has(lowerName) ||
      isPseudoToolMarker(functionName)

    if (looksLikeToolCall) {
      const readable = extractReadableTextFromPseudoCall(functionCall[2])
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  }

  return rawLine
}

export function sanitizeFinalReplyText(content) {
  let output = String(content || "").replace(/\r\n/g, "\n")
  if (output.includes("\\n")) output = output.split("\\n").join("\n")
  output = output.replace(/(?<!\w)\/n(?!\w)/g, "\n").trim()
  if (!output) return ""

  output = ThinkingProcessor.removeThinking(output).trim()
  output = output.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/g, "$1").trim()
  output = output.replace(/^\s*`([^`]+)`\s*$/g, "$1").trim()

  const lines = output.split("\n")
  const sanitizedLines = lines
    .map(line => sanitizePseudoToolLine(line))
    .filter(line => line !== null && String(line).trim() !== "")

  return sanitizedLines.join("\n").replace(/\n{3,}/g, "\n").trim()
}
