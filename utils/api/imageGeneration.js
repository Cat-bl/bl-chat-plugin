/**
 * 图片生成/编辑 API 调用公共模块
 *
 * 对齐手办化.js 的三模式自动识别，按 URL 后缀分发：
 *   - .../chat/completions  -> chat 模式（多模态 messages，由调用方走 callAI）
 *   - .../responses         -> Responses API（input + image_generation 工具）
 *   - .../v1 (或其它)        -> Images API：有图走 /images/edits (multipart)，无图走 /images/generations (JSON)
 *
 * 本模块只负责 endpoint 识别、payload 构建、请求发送与响应归一化，
 * 返回统一形状 { ok: true, result } | { ok: false, err }。
 * result 为可直接 segment.image() 的字符串（http(s) URL 或 base64://...）。
 */

import { getBase64Image } from '../fileUtils.js'

// 生成图片分辨率（OpenAI 标准：1024x1024 / 1024x1536 / 1536x1024 / auto）
// 注：实际是否生效取决于服务商和模型；不支持的会被服务商忽略
export const DEFAULT_IMAGE_SIZE = '1024x1024'

/**
 * 把用户/模型传入的尺寸或比例归一化成 API 可用尺寸
 * @param {string} size
 * @returns {string}
 */
export function normalizeImageSize(size) {
  if (!size) return DEFAULT_IMAGE_SIZE
  const s = String(size).trim().toLowerCase().replace(/[x×*]/g, 'x')
  if (s === 'auto') return s
  const alias = {
    '1:1': '1024x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '横图': '1536x864',
    '竖图': '864x1536',
    '方图': '1024x1024',
  }
  if (alias[s]) return alias[s]
  const wh = s.match(/^(\d{2,5})x(\d{2,5})$/)
  if (wh) return `${wh[1]}x${wh[2]}`
  return DEFAULT_IMAGE_SIZE
}

/**
 * 根据 URL 后缀识别 endpoint 类型（行为等价于手办化.js#resolveEndpoint）
 *
 * 注意：`/v1/messages`（Anthropic）归为 chat 类型，由调用方走 callAI
 * （callAI 内部 detectApiFormat 会识别 Anthropic 格式并转换）
 *
 * @param {string} url
 * @param {boolean} hasImages 是否带图
 * @returns {{ url: string, type: 'chat' | 'responses' | 'edits' | 'generations' }}
 */
export function resolveImageEndpoint(url, hasImages) {
  if (/\/chat\/completions\/?$/.test(url)) return { url, type: 'chat' }
  if (/\/messages\/?$/.test(url)) return { url, type: 'chat' }
  if (/\/responses\/?$/.test(url)) return { url, type: 'responses' }
  // 其它一律 images 模式：剥掉末尾可能的 /images、/images/edits、/images/generations，再按图拼
  const base = url
    .replace(/\/images(\/(edits|generations))?\/?$/, '')
    .replace(/\/+$/, '')
  return hasImages
    ? { url: `${base}/images/edits`, type: 'edits' }
    : { url: `${base}/images/generations`, type: 'generations' }
}

/**
 * 构建 Responses API 的 payload（对齐手办化.js#buildPayload 的 responses 分支）
 * @param {string} prompt
 * @param {string[]} base64Images 已是纯 base64（不含 data: 前缀）
 * @param {string} model
 * @param {string} size
 */
export function buildResponsesPayload(prompt, base64Images, model, size) {
  const content = [{ type: 'input_text', text: prompt }]
  for (const b of base64Images) {
    content.push({ type: 'input_image', image_url: `data:image/png;base64,${b}` })
  }
  return {
    model,
    input: [{ role: 'user', content }],
    tools: [{ type: 'image_generation', size }],
  }
}

/**
 * 构建 Images API 的请求体与请求头
 * @param {'edits'|'generations'} mode
 * @param {string} prompt
 * @param {string[]} base64Images 纯 base64（仅 edits 用）
 * @param {string} model
 * @param {string} size
 * @returns {{ body: BodyInit, headers: Record<string,string> }}
 */
export function buildImagesRequest(mode, prompt, base64Images, model, size) {
  if (mode === 'edits') {
    // multipart：image 字段 + prompt + model + size（多图用同名 image 重复 append）
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('size', size)
    base64Images.forEach((b, i) => {
      const buf = Buffer.from(b, 'base64')
      form.append('image', new Blob([buf], { type: 'image/png' }), `image_${i}.png`)
    })
    return { body: form, headers: {} }
  }
  // generations：纯 JSON
  return {
    body: JSON.stringify({ model, prompt, size, n: 1 }),
    headers: { 'Content-Type': 'application/json' },
  }
}

/**
 * 发送请求并解析 JSON，非 2xx 或非 JSON 都抛可读错误（对齐手办化.js#parseJsonOrThrow）
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {BodyInit} body
 * @param {string} key API key
 */
export async function postImageApi(url, headers, body, key) {
  const finalHeaders = { Authorization: `Bearer ${key}`, ...headers }
  const res = await fetch(url, { method: 'POST', headers: finalHeaders, body })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ''} ｜ ${summarizeBody(text)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`响应不是 JSON（可能是网关错误页/超时）｜ ${summarizeBody(text)}`)
  }
}

/**
 * 解析 Responses API 响应（对齐手办化.js#callApi 的 responses 分支）
 */
export function parseResponsesImageResult(data) {
  const imageData = data?.output
    ?.filter(o => o.type === 'image_generation_call')
    .map(o => o.result)
    .filter(Boolean)
  if (imageData?.length) return `base64://${imageData[0]}`
  const textOutput =
    data?.output_text ||
    data?.output?.find(o => o.type === 'message')?.content?.[0]?.text
  return extractImageUrl(textOutput)
}

/**
 * 解析 Images API 响应（对齐手办化.js#callImagesApi 的尾部）
 */
export function parseImagesApiResult(data) {
  const item = data?.data?.[0]
  if (item?.b64_json) return `base64://${item.b64_json}`
  if (item?.url) return item.url
  // 兜底：从任意文本字段里抽链接
  return extractImageUrl(JSON.stringify(data))
}

/**
 * 从模型返回的文本/URL 中提取图片地址
 * 支持 Markdown 图片格式、base64 data URI、http 链接
 * （行为等价于手办化.js#extractImageUrl，两工具里原本各有一份完全相同的实现）
 */
export function extractImageUrl(content) {
  if (!content) return null

  // Markdown: ![xxx](url)
  const mdMatch = content.match(
    /!\[.*?\]\((data:image\/[^;]+;base64,[^)]+|https?:\/\/[^)]+)\)/,
  )
  if (mdMatch) {
    const url = mdMatch[1]
    if (url.startsWith('data:image')) {
      const base64Data = url.replace(/^data:image\/[^;]+;base64,/, '')
      return `base64://${base64Data}`
    }
    return url
  }

  // 纯 base64 data URI
  const base64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/)
  if (base64Match) return `base64://${base64Match[1]}`

  // 带扩展名的 http/https 链接
  const httpsMatch = content.match(
    /https?:\/\/[^\s)'"<>]+\.(png|jpg|jpeg|gif|webp|bmp)[^\s)'"<>]*/i,
  )
  if (httpsMatch) return httpsMatch[0]

  // 通用 http/https 链接
  const httpMatch = content.match(/https?:\/\/[^\s)'"<>]+/)
  if (httpMatch) return httpMatch[0]

  return null
}

/**
 * 把外部图片 URL 数组转成纯 base64 字符串数组
 * 借助现有 getBase64Image，自动处理腾讯图床等过期场景
 * @param {string[]} images
 * @returns {Promise<string[]>} 纯 base64（不含 data: 前缀）
 */
export async function imagesToBase64(images) {
  const out = []
  for (const url of images) {
    if (!url) continue
    const dataUrl = await getBase64Image(url, 'other.png')
    if (dataUrl.includes('该图片链接已过期')) {
      throw new Error('该图片下载链接已过期，请重新上传')
    }
    if (dataUrl.includes('无效的图片下载链接')) {
      throw new Error('无效的图片下载链接，请确保适配器支持且图片未过期')
    }
    // getBase64Image 可能返回 data:image/...;base64,xxx 或 http(s) 直链
    const b64 = dataUrl.startsWith('data:')
      ? dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
      : null
    if (!b64) throw new Error('图片下载失败，无法转 base64')
    out.push(b64)
  }
  return out
}

/**
 * 高层调用：根据 endpoint 类型走 responses / images API，返回图片 URL
 * chat 模式不在此处理（由调用方走 callAI 保持原行为）
 * @param {{ url: string, type: string }} endpoint resolveImageEndpoint 的返回值
 * @param {string} prompt
 * @param {string[]} images 图片 URL 数组（edits 需要；generations 会被忽略）
 * @param {string} model
 * @param {string} key API key
 * @returns {Promise<string|null>} 图片 URL（http(s) 或 base64://...），未找到返回 null
 */
export async function callImageGenApi(endpoint, prompt, images, model, key, size = DEFAULT_IMAGE_SIZE) {
  const base64Images = await imagesToBase64(images)
  const targetSize = normalizeImageSize(size)

  if (endpoint.type === 'responses') {
    const payload = buildResponsesPayload(prompt, base64Images, model, targetSize)
    const data = await postImageApi(
      endpoint.url,
      { 'Content-Type': 'application/json' },
      JSON.stringify(payload),
      key,
    )
    const url = parseResponsesImageResult(data)
    if (!url) throw new Error('未找到图片信息')
    return url
  }

  // edits / generations
  const { body, headers } = buildImagesRequest(
    endpoint.type,
    prompt,
    base64Images,
    model,
    targetSize,
  )
  const data = await postImageApi(endpoint.url, headers, body, key)
  const url = parseImagesApiResult(data)
  if (!url) throw new Error('未找到图片信息')
  return url
}

// ─── 内部工具 ──────────────────────────────────────

function summarizeBody(text) {
  if (!text) return '(空响应)'
  if (/^\s*<(!doctype|html|head)/i.test(text)) {
    const title = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
    return title
      ? `HTML 错误页: ${title}`
      : `HTML 错误页: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`
  }
  return text.slice(0, 200)
}
