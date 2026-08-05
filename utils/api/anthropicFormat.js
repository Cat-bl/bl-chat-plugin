// Anthropic 格式适配：API 格式检测、Claude Code CLI 伪装、OpenAI <-> Anthropic 请求/响应转换。
// 从 apiClient.js 拆出（行为等价搬迁），供 YTapi / callAI 共用。

// logger 引用（假设全局可用，否则需要 import）
const logger = global.logger || console;

/**
 * 检测 API 格式
 * @param {string} url - API 端点 URL
 * @returns {'anthropic'|'openai'} API 格式类型
 */
export function detectApiFormat(url) {
    if (!url || typeof url !== 'string') return 'openai'
    if (url.toLowerCase().includes('/v1/messages')) return 'anthropic'
    return 'openai' // 默认 OpenAI 格式
}

// 伪装成官方 Claude Code CLI 所需的常量
// 身份串必须逐字一致：Anthropic 对订阅(OAuth) token 会校验它，多数 Claude Code 中转也按此识别请求来源
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_CLI_VERSION = '2.1.177'

/**
 * 给 Anthropic 请求头补上官方 Claude Code CLI 的指纹（对齐 claude-cli 2.1.x 实际抓包的请求头）
 * 注意：
 * - 若用订阅(OAuth) token 直连官方，需在 anthropic-beta 里再加 oauth-2025-04-20
 * - 部分中转/网关(如 Bedrock/Vertex)会拒绝未知 beta flag；若报 "invalid beta flag"，
 *   优先删 tmp-preserve-thinking-2025-10-01、fine-grained-tool-streaming-2025-05-14(已 GA)
 * - x-stainless-package-version 取 @anthropic-ai/sdk 较新版本，中转一般不校验其精确值
 * @param {Object} headers - 待补充的请求头对象
 * @returns {Object} 同一个对象（便于链式调用）
 */
export function applyClaudeCodeHeaders(headers) {
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-beta'] = 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,tmp-preserve-thinking-2025-10-01'
    headers['user-agent'] = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`
    headers['x-app'] = 'cli'
    headers['x-stainless-lang'] = 'js'
    headers['x-stainless-package-version'] = '0.104.1'
    headers['x-stainless-runtime'] = 'node'
    headers['x-stainless-runtime-version'] = 'v22.20.0'
    headers['x-stainless-os'] = 'Linux'
    headers['x-stainless-arch'] = 'x64'
    headers['x-stainless-retry-count'] = '0'
    return headers
}

/**
 * 将请求数据转换为 Anthropic 格式
 * @param {Object} requestData - OpenAI 格式请求数据
 * @param {Object} originalRequestData - 原始请求数据（可能包含 tools）
 * @returns {Object} Anthropic 格式请求数据
 */
export function convertToAnthropicFormat(requestData, originalRequestData) {
    const anthropicRequest = {
        model: requestData.model,
        max_tokens: 16000,
        messages: []
    }

    const temperature = requestData.temperature
    const topP = requestData.top_p
    const hasTemperature = typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 1
    const hasTopP = typeof topP === 'number' && Number.isFinite(topP) && topP > 0 && topP <= 1

    // Anthropic 建议 temperature/top_p 二选一；优先保留调用方明确设置的 temperature。
    if (hasTemperature) anthropicRequest.temperature = temperature
    else if (hasTopP) anthropicRequest.top_p = topP

    // 提取系统消息，并伪装成官方 Claude Code CLI：
    // system 必须是数组，且首块逐字为身份串（带 cache_control），原本的系统提示词追加在其后
    const systemBlocks = [
        { type: 'text', text: CLAUDE_CODE_IDENTITY, cache_control: { type: 'ephemeral' } }
    ]
    const systemMessages = requestData.messages.filter(m => m.role === 'system')
    const systemContent = systemMessages.map(m => m.content || '').filter(Boolean).join('\n\n')
    if (systemContent) {
        systemBlocks.push({ type: 'text', text: systemContent })
    }
    anthropicRequest.system = systemBlocks

    // 转换非系统消息
    const nonSystemMessages = requestData.messages.filter(m => m.role !== 'system')

    // Anthropic 要求消息交替且首条必须是 user
    const normalizedMessages = []
    let lastRole = null

    for (const msg of nonSystemMessages) {
        let convertedMsg = null

        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            // OpenAI tool_calls -> Anthropic tool_use
            const content = []
            if (msg.content && String(msg.content).trim()) {
                content.push({ type: 'text', text: msg.content })
            }
            for (const toolCall of msg.tool_calls) {
                try {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: JSON.parse(toolCall.function.arguments || '{}')
                    })
                } catch (parseError) {
                    logger.warn(`[Anthropic] 解析 tool_call arguments 失败: ${parseError.message}`)
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: {}
                    })
                }
            }
            if (content.length === 0) {
                content.push({ type: 'text', text: '正在调用工具...' })
            }
            convertedMsg = {
                role: 'assistant',
                content
            }
        } else if (msg.role === 'tool') {
            // OpenAI tool -> Anthropic tool_result (归类为 user 角色)
            convertedMsg = {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: String(msg.content || '')
                }]
            }
        } else {
            // 普通消息（可能包含多模态内容）
            if (Array.isArray(msg.content)) {
                // 多模态消息：转换 image_url 为 Anthropic 的 image 格式
                const convertedContent = []
                for (const block of msg.content) {
                    if (block.type === 'text') {
                        convertedContent.push({ type: 'text', text: block.text || '' })
                    } else if (block.type === 'image_url') {
                        // OpenAI image_url -> Anthropic image
                        const imageUrl = block.image_url?.url || block.url || ''
                        const imageBlock = convertImageUrlToAnthropicFormat(imageUrl)
                        if (imageBlock) {
                            convertedContent.push(imageBlock)
                        }
                    } else {
                        // 其他类型保持不变
                        convertedContent.push(block)
                    }
                }
                convertedMsg = {
                    role: msg.role,
                    content: convertedContent.length > 0 ? convertedContent : [{ type: 'text', text: '' }]
                }
            } else {
                // 纯文本消息
                convertedMsg = {
                    role: msg.role,
                    content: String(msg.content || '')
                }
            }
        }

        // 合并连续相同角色的消息
        if (convertedMsg.role === lastRole && normalizedMessages.length > 0) {
            const lastMsg = normalizedMessages[normalizedMessages.length - 1]

            // 合并 content
            if (Array.isArray(lastMsg.content) && Array.isArray(convertedMsg.content)) {
                lastMsg.content.push(...convertedMsg.content)
            } else if (Array.isArray(lastMsg.content)) {
                lastMsg.content.push({ type: 'text', text: String(convertedMsg.content) })
            } else if (Array.isArray(convertedMsg.content)) {
                lastMsg.content = [{ type: 'text', text: String(lastMsg.content) }, ...convertedMsg.content]
            } else {
                lastMsg.content = String(lastMsg.content) + '\n' + String(convertedMsg.content)
            }
        } else {
            normalizedMessages.push(convertedMsg)
            lastRole = convertedMsg.role
        }
    }

    // 确保首条消息是 user
    if (normalizedMessages.length > 0 && normalizedMessages[0].role !== 'user') {
        normalizedMessages.unshift({
            role: 'user',
            content: '继续'
        })
    }

    // 验证消息数组不为空
    if (normalizedMessages.length === 0) {
        throw new Error('转换后的消息数组为空，至少需要一条消息')
    }

    anthropicRequest.messages = normalizedMessages

    // 转换工具定义
    if (originalRequestData.tools?.length) {
        anthropicRequest.tools = originalRequestData.tools.map(tool => ({
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || { type: 'object', properties: {} }
        }))
    }

    // 伪装成官方 CLI 的 metadata（user_id 值官方不会严格校验，可按需替换）
    anthropicRequest.metadata = {
        user_id: `user_${'0'.repeat(64)}_account__session_00000000-0000-4000-8000-000000000000`
    }

    // 自适应思考与自定义采样参数存在协议兼容冲突：仅在调用方没有指定采样时启用。
    // 不支持 thinking 的模型/中转会在请求失败时由 fetchWithThinkingFallback 自动去掉后重试。
    if (!hasTemperature && !hasTopP) {
        anthropicRequest.thinking = { type: 'adaptive' }
    }

    return anthropicRequest
}

/**
 * 将 OpenAI 的 image_url 格式转换为 Anthropic 的 image 格式
 * @param {string} imageUrl - 图片 URL（支持 http(s):// 或 data:image/...;base64,... 格式）
 * @returns {Object|null} Anthropic image block 或 null
 */
export function convertImageUrlToAnthropicFormat(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return null

    // 处理 base64 data URL
    if (imageUrl.startsWith('data:image/')) {
        const match = imageUrl.match(/^data:image\/([^;]+);base64,(.+)$/)
        if (match) {
            const [, format, data] = match
            // 映射常见格式到 MIME type
            const mimeType = `image/${format}`
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: data
                }
            }
        }
    }

    // 处理普通 URL（Anthropic 也支持，但需要用 URL 类型）
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        // 注意：Anthropic API 的 image source 只支持 base64，不支持 URL
        // 这里返回 null，调用方需要先下载图片转为 base64
        logger.warn('[convertImageUrlToAnthropicFormat] Anthropic 不支持直接传 URL，需要先转为 base64')
        return null
    }

    return null
}

/**
 * 将 Anthropic 响应转换为 OpenAI 格式
 * @param {Object} anthropicResponse - Anthropic 格式响应
 * @returns {Object} OpenAI 格式响应
 */
export function convertFromAnthropicFormat(anthropicResponse) {
    // 错误响应直接返回
    if (anthropicResponse.error) {
        return anthropicResponse
    }

    const openaiResponse = {
        choices: [{
            message: {
                role: 'assistant',
                content: ''
            },
            finish_reason: anthropicResponse.stop_reason || 'stop'
        }],
        usage: anthropicResponse.usage
    }

    // 处理 content 数组
    if (Array.isArray(anthropicResponse.content)) {
        const textParts = []
        const toolUses = []

        for (const block of anthropicResponse.content) {
            if (block.type === 'text') {
                textParts.push(block.text || '')
            } else if (block.type === 'tool_use') {
                toolUses.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input || {})
                    }
                })
            }
        }

        openaiResponse.choices[0].message.content = textParts.join('\n')

        // 只在有工具调用时才添加 tool_calls 字段
        if (toolUses.length > 0) {
            openaiResponse.choices[0].message.tool_calls = toolUses
        }
    } else if (typeof anthropicResponse.content === 'string') {
        openaiResponse.choices[0].message.content = anthropicResponse.content
    } else if (!anthropicResponse.content) {
        // content 为 null/undefined，保持空字符串
        openaiResponse.choices[0].message.content = ''
    }

    return openaiResponse
}
