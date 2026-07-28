// 请求发送层：带 thinking 自动降级重试的 fetch 封装。
// 直接引 node-fetch 而非经 dependence/dependencies.js（后者静态依赖 Yunzai 核心模块，
// 会让引用本模块链的文件——如 core/conversationTracker——无法脱离 Yunzai 环境单测）
import fetch from "node-fetch";

// logger 引用（假设全局可用，否则需要 import）
const logger = global.logger || console;

// 主对话 API 默认超时：网络挂起时避免长时间占住 smart 入口锁 / 群并发名额（fetch 默认无超时）
const DEFAULT_API_TIMEOUT_MS = 120000

/**
 * 发送 JSON 请求；若请求体带 thinking 且因模型不支持而失败，则去掉 thinking 后重试一次
 * 对不带 thinking 的请求（如 OpenAI 格式）原样透传，行为不变
 * @param {string} url - 请求地址
 * @param {Object} headers - 请求头
 * @param {Object} requestData - 请求体对象
 * @returns {Promise<{response: Response, errorText: string|null}>} errorText 仅在最终响应失败时填充
 */
export async function fetchWithThinkingFallback(url, headers, requestData, signal) {
    // 无外部 signal（主对话 YTapi 路径）时给默认超时；有外部 signal（callAI/Gate 已自管超时）时沿用
    let timeoutId = null
    let effectiveSignal = signal
    if (!effectiveSignal) {
        const controller = new AbortController()
        timeoutId = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS)
        effectiveSignal = controller.signal
    }

    const send = (body) => fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: effectiveSignal
    })

    try {
        const response = await send(requestData)
        if (response.ok || !requestData?.thinking) {
            return { response, errorText: response.ok ? null : await response.text().catch(() => '无法读取错误内容') }
        }

        // 失败且带了 thinking：判断是否因模型不支持 thinking
        const errorText = await response.text().catch(() => '无法读取错误内容')
        if (!/thinking/i.test(errorText)) {
            return { response, errorText }
        }

        logger.warn('[Anthropic] 模型疑似不支持 thinking，去掉该字段后重试')
        const withoutThinking = { ...requestData }
        delete withoutThinking.thinking
        const retryResponse = await send(withoutThinking)
        return {
            response: retryResponse,
            errorText: retryResponse.ok ? null : await retryResponse.text().catch(() => '无法读取错误内容')
        }
    } finally {
        if (timeoutId) clearTimeout(timeoutId)
    }
}
