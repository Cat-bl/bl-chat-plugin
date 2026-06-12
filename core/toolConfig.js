// 工具配置条目解析与最终回复形态判断

/**
 * 解析 oneapi_tools 配置条目。条目可带 `(dedupe)` 标记，
 * 例如 `bananaTool(dedupe)`，表示同一用户同一工具上一次调用未完成时跳过新调用。
 */
export function parseToolConfigEntry(entry) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1],
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}

export function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

/**
 * 用户消息是否在明确要求生成代码 / Markdown
 */
export function isCodeOrMarkdownRequest(text = "") {
  const content = String(text || "").toLowerCase()
  return /写.*(代码|算法|函数|脚本|程序|markdown|md|文档)|给.*(代码|示例代码|算法|markdown|md文档)|实现.*(算法|函数|代码|脚本|程序)|生成.*(代码|markdown|md文档|文档)|编写.*(代码|markdown|md|文档)|代码给我|md文档|markdown文档|代码截图/.test(content)
}

/**
 * 文本内容看起来像代码或 Markdown（用于决定最终回复是否转图发送）
 */
export function looksLikeCodeOrMarkdown(text = "") {
  const content = String(text || "")
  if (/```[\s\S]*```/.test(content)) return true
  if (/^\s{0,3}#{1,4}\s+\S/m.test(content) && content.split(/\r?\n/).length >= 3) return true
  if (/^\s*\|.+\|\s*$/m.test(content) && /^\s*\|[-:\s|]+\|\s*$/m.test(content)) return true

  const lines = content.split(/\r?\n/)
  const nonEmptyLines = lines.filter(line => line.trim())
  if (nonEmptyLines.length < 3) return false

  const codeLineCount = nonEmptyLines.filter(line =>
    /^\s*(def|class|for|if|elif|else|while|return|import|from|print|break|continue|const|let|var|function|class|export|switch|try|catch|public|private|static|package|func|fn)\b/.test(line) ||
    /^\s{2,}\S/.test(line) ||
    /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(line) ||
    /[{}();]/.test(line)
  ).length

  return codeLineCount >= 2
}
