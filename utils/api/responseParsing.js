// 响应解析层：流式/SSE 兜底解析与响应归一化，输出统一为 OpenAI 格式。
// 从 apiClient.js 拆出（行为等价搬迁），供 YTapi / callAI 共用。

// logger 引用（假设全局可用，否则需要 import）
const logger = global.logger || console;

/**
 * 统一处理流式响应（兼容 OpenAI 和 Anthropic SSE 格式）
 * @param {Response} response - fetch 响应对象
 * @param {string} apiFormat - 'openai' 或 'anthropic'
 * @returns {Promise<Object>} 返回 OpenAI 格式的响应对象
 */
export async function handleStreamResponseUnified(response, apiFormat) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let content = ''
    let buffer = ''
    let finishReason = null
    let done_flag = false

    try {
        while (!done_flag) {
            const { value, done } = await reader.read()
            if (done) break

            // 解码并累积到 buffer，按完整行处理，避免 chunk 切分破坏 JSON
            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split('\n')
            // 最后一行可能不完整，保留到 buffer 等下一个 chunk
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const dataStr = line.slice(6).trim()
                if (!dataStr) continue
                if (dataStr === '[DONE]') {
                    done_flag = true
                    break
                }

                try {
                    const data = JSON.parse(dataStr)

                    if (apiFormat === 'anthropic') {
                        // Anthropic 流式：content_block_delta + text_delta
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            content += data.delta.text
                        }
                        // message_delta 携带 stop_reason
                        if (data.type === 'message_delta' && data.delta?.stop_reason) {
                            finishReason = data.delta.stop_reason
                        }
                    } else {
                        // OpenAI 流式
                        const choice = data?.choices?.[0]
                        const delta = choice?.delta?.content
                        if (delta) content += delta
                        if (choice?.finish_reason) finishReason = choice.finish_reason
                    }
                } catch {
                    // 跳过解析失败的行（通常是注释行或不完整 JSON）
                }
            }
        }

        // 处理 buffer 中剩余的最后一行
        if (buffer.startsWith('data: ')) {
            const dataStr = buffer.slice(6).trim()
            if (dataStr && dataStr !== '[DONE]') {
                try {
                    const data = JSON.parse(dataStr)
                    if (apiFormat === 'anthropic') {
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            content += data.delta.text
                        }
                    } else {
                        const delta = data?.choices?.[0]?.delta?.content
                        if (delta) content += delta
                    }
                } catch { /* 忽略 */ }
            }
        }

        if (!content) {
            return { error: '未接收到有效内容' }
        }

        return {
            choices: [{
                message: { role: 'assistant', content },
                finish_reason: finishReason || 'stop'
            }]
        }
    } catch (error) {
        logger.error('[handleStreamResponseUnified] 流式响应处理失败:', error)
        return { error: `流式响应处理失败：${error.message}` }
    } finally {
        // 确保 reader 释放
        try { reader.releaseLock() } catch { /* 忽略 */ }
    }
}

/**
 * 从已读取的文本解析 SSE 格式（非流式兜底）
 * @param {string} text - 已读取的完整 SSE 文本
 * @param {string} apiFormat - 'openai' 或 'anthropic'
 * @returns {Object} OpenAI 格式的响应对象，或 { error: string }
 */
export function parseSSETextUnified(text, apiFormat) {
    let content = ''
    let finishReason = null
    for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const dataStr = line.slice(6).trim()
        if (!dataStr || dataStr === '[DONE]') break

        try {
            const data = JSON.parse(dataStr)
            if (apiFormat === 'anthropic') {
                if (data.type === 'content_block_delta' && data.delta?.text) {
                    content += data.delta.text
                }
                if (data.type === 'message_delta' && data.delta?.stop_reason) {
                    finishReason = data.delta.stop_reason
                }
            } else {
                const choice = data?.choices?.[0]
                const delta = choice?.delta?.content
                if (delta) content += delta
                if (choice?.finish_reason) finishReason = choice.finish_reason
            }
        } catch { /* 跳过解析失败的行 */ }
    }

    if (!content) {
        return { error: '未接收到有效内容' }
    }

    return {
        choices: [{
            message: { role: 'assistant', content },
            finish_reason: finishReason || 'stop'
        }]
    }
}

/**
 * 归一化 API 响应：数组取首个，detail/error 字段统一转为 { error: string }
 * @param {Object|Array} responseData - API 响应数据
 * @returns {Object} - 处理后的响应数据
 */
export function processResponse(responseData) {
    // 处理数组响应（兼容某些 API 返回数组的情况）
    if (Array.isArray(responseData) && responseData.length > 0) {
        return processResponse(responseData[0]);
    }

    // 处理对象响应
    if (typeof responseData === 'object' && responseData !== null) {
        // 错误响应
        if (responseData.detail) {
            return { error: responseData.detail };
        }
        if (responseData.error && Object.keys(responseData.error).length > 0) {
            return { error: responseData.error.message || JSON.stringify(responseData.error) };
        }

        // 正常响应
        return responseData;
    }

    // 其他类型直接返回
    return { error: `Invalid response format: ${JSON.stringify(responseData)}` };
}
