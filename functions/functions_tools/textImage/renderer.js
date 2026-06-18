// markdown-it + shiki：把任意 markdown / 代码渲染成带语法高亮的 HTML 片段。
// shiki 同时承担 markdown-it 的 highlight 钩子。两者都做了模块级单例，避免每次调用重复初始化。

import MarkdownIt from "markdown-it"
import { createHighlighter } from "shiki"

const THEME = "github-dark"

// 预加载这些常用语言：调用 markdown-it 时 highlight 是同步钩子，必须先把语言备齐。
// 罕见语言通过 ensureLanguagesLoaded() 在渲染前异步补加载，加载失败的退化成 plain text。
const PRELOADED_LANGS = [
  "javascript", "typescript", "python", "html", "css", "json", "yaml",
  "bash", "shell", "sql", "java", "go", "rust", "c", "cpp", "csharp",
  "php", "ruby", "kotlin", "swift", "vue", "jsx", "tsx", "xml",
  "markdown", "ini", "toml", "dockerfile", "diff", "lua"
]

let highlighterPromise = null
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: PRELOADED_LANGS
    }).catch(err => {
      // 初始化失败时清空缓存，允许下次重试
      highlighterPromise = null
      throw err
    })
  }
  return highlighterPromise
}

function normalizeLang(lang) {
  const v = String(lang || "").toLowerCase().trim()
  if (!v) return ""
  // 几个常见别名手动归一，shiki 不一定都支持
  if (v === "py" || v === "python3") return "python"
  if (v === "js" || v === "node" || v === "mjs" || v === "cjs") return "javascript"
  if (v === "ts") return "typescript"
  if (v === "yml") return "yaml"
  if (v === "sh" || v === "zsh") return "bash"
  return v
}

async function ensureLang(highlighter, lang) {
  const normalized = normalizeLang(lang)
  if (!normalized) return ""
  const loaded = highlighter.getLoadedLanguages()
  if (loaded.includes(normalized)) return normalized
  try {
    await highlighter.loadLanguage(normalized)
    return normalized
  } catch {
    return ""
  }
}

let mdInstance = null
async function getMarkdown() {
  if (mdInstance) return mdInstance
  const highlighter = await getHighlighter()
  mdInstance = new MarkdownIt({
    // 禁用原始 HTML：避免模型吐出的 <script> / 样式直接落到页面里
    html: false,
    breaks: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      const normalized = normalizeLang(lang)
      const loaded = highlighter.getLoadedLanguages()
      const useLang = normalized && loaded.includes(normalized) ? normalized : "text"
      try {
        return highlighter.codeToHtml(code, { lang: useLang, theme: THEME })
      } catch {
        // 返回空串让 markdown-it 走默认转义
        return ""
      }
    }
  })
  return mdInstance
}

// 扫描 markdown 中所有 ``` 围栏代码块和"裸代码"启发式语言标记，预先 await loadLanguage。
// markdown-it 的 highlight 钩子是同步的，无法在钩子里 await 加载。
async function ensureLanguagesLoaded(text) {
  const highlighter = await getHighlighter()
  const langs = new Set()
  const fence = /^```\s*([a-zA-Z0-9+#_.-]+)/gm
  let m
  while ((m = fence.exec(text)) !== null) {
    langs.add(m[1])
  }
  await Promise.all([...langs].map(lang => ensureLang(highlighter, lang)))
}

// 把没有 ``` 围栏、但看起来像代码的整段文本，用 shiki 渲染成代码块。
// 触发条件参考旧的 SVG 版本：>=3 行且包含若干代码特征。判定不强求严格，宁可渲成代码也比当散文渲染好看。
const CODEY_KEYWORDS = /^\s*(def|class|import|from|for|if|elif|else|while|return|print|const|let|var|function|export|switch|try|catch|<\?xml|<!DOCTYPE|<html|<script|<style|package |#include)\b/m
const CODEY_BRACKETS = /[{};]/
function looksLikeWholeCodeBlock(text) {
  if (text.includes("```")) return false
  // 含明显 markdown 标识就别误判
  if (/^#{1,3}\s+\S/m.test(text)) return false
  if (/^>\s+\S/m.test(text)) return false
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 3) return false
  return CODEY_KEYWORDS.test(text) && CODEY_BRACKETS.test(text)
}

function inferLangFromText(text) {
  if (/^\s*<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text)) return "html"
  if (/^\s*<\?xml|<\w+[^>]*xmlns/i.test(text)) return "xml"
  if (/^\s*(import\s+\w|from\s+\w+\s+import|def\s+\w+\s*\()/m.test(text)) return "python"
  if (/^\s*(const|let|var|function|class|import|export)\b|=>\s*\{|console\.log/m.test(text)) return "javascript"
  if (/^\s*\{[\s\S]*"\w+"\s*:/.test(text)) return "json"
  if (/^\s*[\w.-]+\s*:\s*\S/m.test(text) && !/[{};]/.test(text)) return "yaml"
  if (/^\s*(#!\/|cd\s|echo\s|grep\s|curl\s|sudo\s|npm\s|pnpm\s|git\s)/m.test(text)) return "bash"
  return "text"
}

// 顶层入口：把任意文本（可能是纯 markdown / 含代码的 markdown / 纯代码）渲染成 HTML 片段。
export async function renderMarkdownToHtml(text) {
  const src = String(text || "")
  if (!src.trim()) return ""

  // 整段是裸代码 -> 包成 ``` 围栏，让 markdown-it 走 highlight 钩子
  let actualText = src
  if (looksLikeWholeCodeBlock(src)) {
    const lang = inferLangFromText(src)
    actualText = `\`\`\`${lang}\n${src}\n\`\`\``
  }

  await ensureLanguagesLoaded(actualText)
  const md = await getMarkdown()
  return md.render(actualText)
}
