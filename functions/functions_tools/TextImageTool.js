// 把文字 / Markdown / 代码渲染成 QQ 聊天气泡风格的图片。
// 渲染管线：markdown-it + shiki -> HTML 片段 -> puppeteer.setContent -> 元素截图。
// shiki 提供原生语法高亮（100+ 语言），换行交给浏览器 CSS 处理，不再硬切。

import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { AbstractTool } from "./AbstractTool.js"
import { renderMarkdownToHtml } from "./textImage/renderer.js"

const require = createRequire(import.meta.url)
const puppeteer = require("puppeteer")

const AVATAR_SIZE = 64
const DELETE_RETRY_DELAYS_MS = [0, 200, 1000]
const NODE_MAJOR = parseInt(process.version.slice(1).split(".")[0], 10)

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function fetchAvatarDataUrl(avatarUrl) {
  if (!avatarUrl) return ""
  try {
    const response = await fetch(avatarUrl)
    if (!response.ok) return ""
    const contentType = response.headers.get("content-type") || "image/png"
    const buffer = Buffer.from(await response.arrayBuffer())
    return `data:${contentType};base64,${buffer.toString("base64")}`
  } catch {
    return ""
  }
}

function buildPageHtml({ markdownHtml, nickname, avatarDataUrl }) {
  const avatarTag = avatarDataUrl
    ? `<img class="avatar" src="${avatarDataUrl}" alt="">`
    : `<div class="avatar avatar-fallback">AI</div>`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans CN', system-ui, sans-serif; }
  .frame { display: inline-block; padding: 28px; background: #f4f6fb; }
  .row { display: flex; gap: 14px; align-items: flex-start; }
  .avatar { width: ${AVATAR_SIZE}px; height: ${AVATAR_SIZE}px; border-radius: 50%; flex: 0 0 ${AVATAR_SIZE}px; object-fit: cover; background: #8fb6ff; }
  .avatar-fallback { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 22px; font-weight: 700; }
  .col { display: flex; flex-direction: column; gap: 6px; min-width: 220px; max-width: 820px; }
  .name { color: #8a94a6; font-size: 14px; padding-left: 4px; }
  .bubble { background: #fff; border-radius: 18px; padding: 16px 22px; box-shadow: 0 2px 8px rgba(120, 130, 150, 0.18); color: #1f2937; font-size: 16px; line-height: 1.75; word-wrap: break-word; overflow-wrap: break-word; position: relative; }
  /* 气泡左上小尖角 */
  .bubble::before { content: ''; position: absolute; left: -8px; top: 14px; width: 0; height: 0; border: 8px solid transparent; border-right-color: #fff; border-left: 0; }
  .bubble > *:first-child { margin-top: 0; }
  .bubble > *:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4 { margin: 14px 0 8px; line-height: 1.4; color: #111827; font-weight: 700; }
  .bubble h1 { font-size: 22px; }
  .bubble h2 { font-size: 19px; }
  .bubble h3 { font-size: 17px; }
  .bubble h4 { font-size: 15px; }
  .bubble p { margin: 6px 0; }
  .bubble ul, .bubble ol { margin: 6px 0; padding-left: 26px; }
  .bubble li { margin: 2px 0; }
  .bubble blockquote { margin: 10px 0; padding: 8px 14px; border-left: 4px solid #c9d2df; color: #5b6472; background: #f9fafb; border-radius: 6px; }
  .bubble blockquote p { margin: 0; }
  .bubble code { background: rgba(120, 130, 150, 0.14); padding: 1px 6px; border-radius: 4px; font-family: 'Consolas', 'Cascadia Mono', 'JetBrains Mono', monospace; font-size: 14px; color: #be185d; }
  .bubble pre { background: #0d1117 !important; border-radius: 10px; padding: 14px 16px; margin: 10px 0; font-size: 13px; line-height: 1.6; overflow: hidden; }
  .bubble pre code { background: transparent; padding: 0; color: inherit; font-size: 13px; }
  /* 长行交给浏览器软换行，shiki 输出的每个 .line / span 一并处理 */
  .bubble pre, .bubble pre code, .bubble pre .line, .bubble pre span { white-space: pre-wrap !important; overflow-wrap: anywhere; }
  .bubble pre.shiki { background: #0d1117 !important; }
  .bubble a { color: #2563eb; text-decoration: none; word-break: break-all; }
  .bubble img { max-width: 100%; border-radius: 8px; }
  .bubble table { border-collapse: collapse; margin: 10px 0; font-size: 14px; }
  .bubble th, .bubble td { border: 1px solid #e5e7eb; padding: 6px 12px; }
  .bubble th { background: #f3f4f6; }
  .bubble hr { border: 0; border-top: 1px solid #e5e7eb; margin: 12px 0; }
</style>
</head>
<body>
<div class="frame">
  <div class="row">
    ${avatarTag}
    <div class="col">
      <div class="name">${escapeHtml(nickname)}</div>
      <div class="bubble">${markdownHtml}</div>
    </div>
  </div>
</div>
</body>
</html>`
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function deleteGeneratedFile(filePath) {
  for (let index = 0; index < DELETE_RETRY_DELAYS_MS.length; index++) {
    const delay = DELETE_RETRY_DELAYS_MS[index]
    if (delay > 0) await wait(delay)
    try {
      await fs.promises.unlink(filePath)
      return
    } catch (error) {
      if (error?.code === "ENOENT") return
      const canRetry = ["EBUSY", "EPERM"].includes(error?.code) && index < DELETE_RETRY_DELAYS_MS.length - 1
      if (canRetry) continue
      globalThis.logger?.warn?.(`[textImageTool] 清理临时图片失败：${error.message}`)
      return
    }
  }
}

// 每次调用都启停 browser：渲染完立刻关闭，不常驻。
// 代价是每次调用多 ~500ms 启动开销，换来的是非高峰期 0 内存占用。
async function launchBrowser() {
  return puppeteer.launch({
    headless: NODE_MAJOR >= 16 ? "new" : true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  })
}

export class TextImageTool extends AbstractTool {
  constructor() {
    super()
    this.name = "textImageTool"
    this.description =
      "把文字、Markdown 或代码内容渲染成一张类似 QQ 聊天气泡样式的图片并发送。只要用户要求写代码、给代码、实现算法、提供示例代码、编写 Markdown/MD 文档或输出较长结构化文本，都必须调用本工具，把完整内容作为 text 参数发送，不要直接在普通回复里发送代码或 Markdown 原文。也适用于文字可能被 QQ 群管家、其他 QQ 机器人、风控、敏感词检测撤回的场景。代码内容即使没有使用 ``` 包裹，也可以交给本工具自动识别并按代码块高亮渲染。也适用于使用普通文字无法更好的表达时调用"
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "需要转成图片发送的完整内容。用户要求写代码、示例代码、算法实现或 Markdown/MD 文档时，请把生成好的完整代码/文档放在这里"
        },
        nickname: {
          type: "string",
          description: "图片中显示的昵称，不填则使用机器人昵称"
        },
        avatarUrl: {
          type: "string",
          description: "图片左侧头像链接，不填则使用机器人 QQ 头像"
        }
      },
      required: ["text"],
      additionalProperties: false
    }
  }

  async func(opts, e) {
    const text = String(opts.text || "").trim()
    if (!text) return "error: text 不能为空"

    const nickname = String(opts.nickname || globalThis.Bot?.nickname || "机器人").trim()
    const avatarUrl =
      opts.avatarUrl || `https://q1.qlogo.cn/g?b=qq&nk=${globalThis.Bot?.uin || e?.self_id || ""}&s=100`
    let imagePath = ""

    try {
      imagePath = await this.renderChatImage({ text, nickname, avatarUrl })
      await e.reply(segment.image(imagePath))
      return this.terminal("已将文字、Markdown 或代码转为图片发送成功，不需要再重复发送原始内容，绝对不要以文本形式发送代码和markdown内容，会导致严重群内刷屏！！！。")
    } finally {
      if (imagePath) await deleteGeneratedFile(imagePath)
    }
  }

  async renderChatImage({ text, nickname, avatarUrl }) {
    const outputDir = path.join(process.cwd(), "resources", "bl-chat-plugin", "safe_text_images")
    await fs.promises.mkdir(outputDir, { recursive: true })

    const [avatarDataUrl, markdownHtml] = await Promise.all([
      fetchAvatarDataUrl(avatarUrl),
      renderMarkdownToHtml(text)
    ])
    const html = buildPageHtml({ markdownHtml, nickname, avatarDataUrl })

    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 })
      // 头像已经是 data URL，没有外部网络资源；用 domcontentloaded 即可
      await page.setContent(html, { waitUntil: "domcontentloaded" })

      const handle = await page.$(".frame")
      if (!handle) throw new Error("未找到聊天气泡 DOM")

      const outputPath = path.join(
        outputDir,
        `safe_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
      )
      await handle.screenshot({ path: outputPath, type: "png" })
      return outputPath
    } finally {
      await browser.close().catch(() => {})
    }
  }
}
