import { dependencies } from "../dependence/dependencies.js";
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
const { _path, fetch, fs, path } = dependencies;

// logger 引用（假设全局可用，否则需要 import）
const logger = global.logger || console;

/**
 * 生成动态的客户端版本标识（基于当前日期）
 * @returns {Object} 包含 anthropicVersion 和 clientVersion 的对象
 */
function generateDynamicVersions() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');

    return {
        anthropicVersion: `${year}-${month}-01`, // 格式: 2026-06-01
        // 伪装成浏览器，避免中转站拒绝 CLI 客户端
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };
}

/**
 * 检测 API 格式
 * @param {string} url - API 端点 URL
 * @returns {'anthropic'|'openai'} API 格式类型
 */
function detectApiFormat(url) {
    if (!url || typeof url !== 'string') return 'openai'
    if (url.toLowerCase().includes('/v1/messages')) return 'anthropic'
    return 'openai' // 默认 OpenAI 格式
}

// 伪装成官方 Claude Code CLI 所需的常量
// 身份串必须逐字一致：Anthropic 对订阅(OAuth) token 会校验它，多数 Claude Code 中转也按此识别请求来源
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
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
function applyClaudeCodeHeaders(headers) {
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
 * 发送请求到 OpenAI API 或其他提供者并处理响应
 * @param {Object} requestData - 请求体数据
 * @param {Object} config - 配置对象
 * @returns {Object|null} - 返回处理后的响应数据或错误信息
 */
export async function YTapi(requestData, config, toolContent, toolName) {
    const provider = config.providers?.toLowerCase();

    try {
        let url, headers, finalRequestData;

        if (config.useTools) {
            // useTools 开启，先调用工具 API
            const toolsUrl = `${config.toolsAiConfig.toolsAiUrl}`;
            // 确保配置了 API key
            if (!config.toolsAiConfig.toolsAiApikey) return { error: "工具 AI Token 未配置" };

            const toolsApiFormat = detectApiFormat(toolsUrl)
            const toolsHeaders = {
                'Authorization': `Bearer ${config.toolsAiConfig.toolsAiApikey}`,
                'Content-Type': 'application/json'
            };

            if (toolsApiFormat === 'anthropic') {
                applyClaudeCodeHeaders(toolsHeaders)
            }

            let toolsResponse;
            try {
                // 保留原始请求中的 tools 字段
                let toolsRequestData = {
                    ...requestData,
                    model: config.toolsAiConfig.toolsAiModel,
                    stream: false
                };
                logger.debug("工具调用上下文：",JSON.stringify(toolsRequestData));
                // 根据格式转换请求
                if (toolsApiFormat === 'anthropic') {
                    try {
                        toolsRequestData = convertToAnthropicFormat(toolsRequestData, requestData)
                    } catch (convertError) {
                        logger.error('[Anthropic] 请求格式转换失败:', convertError)
                        return { error: `请求格式转换失败：${convertError.message}` }
                    }
                }

                const toolsResult = await fetchWithThinkingFallback(toolsUrl, toolsHeaders, toolsRequestData);
                toolsResponse = toolsResult.response;

                if (!toolsResponse.ok) {
                    logger.error(`工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${toolsResult.errorText}`);
                    return { error: `工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${toolsResult.errorText}` };
                }
            } catch (toolsFetchError) {
                logger.error("工具 API 请求失败:", toolsFetchError);
                return { error: `工具 API 请求失败：${toolsFetchError.message}` };
            }

            let toolsData;
            try {
                toolsData = await toolsResponse.json();
                logger.debug('工具 API 响应:', JSON.stringify(toolsData, null, 2));
            } catch (toolsJsonError) {
                logger.error("解析工具 API 响应 JSON 失败:", toolsJsonError);
                return { error: `解析工具 API 响应 JSON 失败：${toolsJsonError.message}` };
            }

            // 转换 Anthropic 响应为 OpenAI 格式
            if (toolsApiFormat === 'anthropic') {
                try {
                    toolsData = convertFromAnthropicFormat(toolsData)
                } catch (convertError) {
                    logger.error('[Anthropic] 响应格式转换失败:', convertError)
                    return { error: `响应格式转换失败：${convertError.message}` }
                }
            }

            // 验证转换后的格式
            if (toolsData && !toolsData.choices?.[0]?.message) {
                logger.warn('[API] 工具 API 响应格式转换后无效，降级到 OneAPI')
                // 继续执行降级逻辑，不返回错误
            } else {
                // 检查是否包含 tool_calls，无论 finish_reason 是什么
                const hasToolCalls = toolsData?.choices?.[0]?.message?.tool_calls?.length > 0;
                if (hasToolCalls) {
                    // 直接返回 tool_calls 响应
                    return processResponse(toolsData);
                }
            }

            // 检查 OneAPI 配置
            if (!config.chatAiConfig.chatApiUrl || !config.chatAiConfig.chatApiModel || !config.chatAiConfig.chatApiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }

            // 智能 URL 处理：Anthropic 格式直接使用，OpenAI 格式自动拼接端点
            const chatApiFormat = detectApiFormat(config.chatAiConfig.chatApiUrl);
            if (chatApiFormat === 'anthropic') {
                url = config.chatAiConfig.chatApiUrl;
            } else {
                // OpenAI 格式：如果 URL 不包含完整端点，自动拼接
                url = config.chatAiConfig.chatApiUrl.includes('/v1/chat/completions')
                    ? config.chatAiConfig.chatApiUrl
                    : `${config.chatAiConfig.chatApiUrl.replace(/\/$/, '')}/v1/chat/completions`;
            }

            const oneApiKey = Array.isArray(config.chatAiConfig.chatApiKey)
                ? config.chatAiConfig.chatApiKey[Math.floor(Math.random() * config.chatAiConfig.chatApiKey.length)]
                : config.chatAiConfig.chatApiKey;
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };

            finalRequestData = {
                model: config.chatAiConfig.chatApiModel,
                messages: convertToolMessagesForChat(requestData.messages, toolName),
                stream: false
            };
        } else {
            // useTools 关闭，直接使用 OneAPI
            if (!config.chatAiConfig.chatApiUrl || !config.chatAiConfig.chatApiModel || !config.chatAiConfig.chatApiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }

            // 智能 URL 处理：Anthropic 格式直接使用，OpenAI 格式自动拼接端点
            const chatApiFormat = detectApiFormat(config.chatAiConfig.chatApiUrl);
            if (chatApiFormat === 'anthropic') {
                url = config.chatAiConfig.chatApiUrl;
            } else {
                // OpenAI 格式：如果 URL 不包含完整端点，自动拼接
                url = config.chatAiConfig.chatApiUrl.includes('/v1/chat/completions')
                    ? config.chatAiConfig.chatApiUrl
                    : `${config.chatAiConfig.chatApiUrl.replace(/\/$/, '')}/v1/chat/completions`;
            }

            const oneApiKey = config.chatAiConfig.chatApiKey[Math.floor(Math.random() * config.chatAiConfig.chatApiKey.length)];
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };
            finalRequestData = {
                model: config.chatAiConfig.chatApiModel,
                messages: requestData.messages,
                stream: false
            };
        }

        // 发送 API 请求

        if (!url || !headers || !finalRequestData) {
            return { error: "缺少必要的请求参数（URL、headers 或请求体）" };
        }

        const apiFormat = detectApiFormat(url)
        let response;

        // 判断消息里是否有工具执行记录(用于决定是否给对话模型收尾提示)
        const hasExecutedTools = finalRequestData.messages?.some(m =>
            m.role === 'system' && String(m.content || '').includes('[tool_execution]')
        )

        // 根据 API 格式处理请求体
        if (apiFormat === 'openai') {
            if (url.includes('v1/chat/completions') && typeof finalRequestData === 'object' && finalRequestData !== null) {
                delete finalRequestData.tools;
                delete finalRequestData.tool_choice;
            }
            finalRequestData.messages = moveFinalToolPromptToEnd(
                removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages, hasExecutedTools)
            )
        } else if (apiFormat === 'anthropic') {
            // Anthropic 格式转换
            // 注意：对话 API 不传递 tools，避免模型参与工具调用判断
            try {
                // 与 OpenAI 路径保持一致：先清洗 system 里的工具提示词、把最终工具提示移到末尾，再转换格式
                finalRequestData.messages = moveFinalToolPromptToEnd(
                    removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages, hasExecutedTools)
                )
                // 第二个参数传 finalRequestData（不含 tools），而不是 requestData
                finalRequestData = convertToAnthropicFormat(finalRequestData, finalRequestData)
            } catch (convertError) {
                logger.error('[Anthropic] 请求格式转换失败:', convertError)
                return { error: `请求格式转换失败：${convertError.message}` }
            }
            applyClaudeCodeHeaders(headers)
        }

        logger.debug('最终请求体:', finalRequestData);
        try {
            const result = await fetchWithThinkingFallback(url, headers, finalRequestData);
            response = result.response;

            if (!response.ok) {
                logger.error(`API 请求失败：${response.status} ${response.statusText} - ${result.errorText}`);
                return { error: `API 请求失败：${response.status} ${response.statusText} - ${result.errorText}` };
            }
        } catch (fetchError) {
            logger.error(`${provider || 'API'} 请求失败:`, fetchError);
            return { error: `${provider || 'API'} 请求失败：${fetchError.message}` };
        }

        let responseData;
        try {
            responseData = await response.json();
            logger.debug(`${provider || 'API'} 响应:`, JSON.stringify(responseData, null, 2));
        } catch (jsonError) {
            logger.error(`解析 ${provider || 'API'} 响应 JSON 失败:`, jsonError);
            return { error: `解析 ${provider || 'API'} 响应 JSON 失败：${jsonError.message}` };
        }

        // 根据 API 格式转换响应
        if (apiFormat === 'anthropic') {
            try {
                responseData = convertFromAnthropicFormat(responseData)
            } catch (convertError) {
                logger.error('[Anthropic] 响应格式转换失败:', convertError)
                return { error: `响应格式转换失败：${convertError.message}` }
            }

            // 验证转换后的格式完整性
            if (!responseData?.choices?.[0]?.message) {
                logger.error('[Anthropic] 响应转换后格式无效:', responseData)
                return { error: 'API 响应转换失败，格式不完整' }
            }
        }

        return processResponse(responseData);

    } catch (error) {
        logger.error('YTapi 异常:', error);
        return { error: `发生异常：${error.message}` };
    }
}

/**
 * 处理 API 响应数据
 * @param {Object|Array} responseData - API 响应数据
 * @returns {Object} - 处理后的响应数据
 */
function convertToolMessagesForChat(messages = [], fallbackToolName = 'tool') {
    const converted = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            const requests = msg.tool_calls.map((toolCall, index) => {
                const name = toolCall.function?.name || fallbackToolName || 'tool';
                return `${index + 1}. ${name}`;
            });

            const results = [];
            while (messages[i + 1]?.role === 'tool') {
                i++;
                const toolMsg = messages[i];
                const name = toolMsg.name || fallbackToolName || 'tool';
                results.push(summarizeToolResultForChat(name, toolMsg.content));
            }

            converted.push({
                role: 'system',
                content: [
                    '[tool_execution]',
                    'requests:',
                    ...requests,
                    results.length ? 'results:' : null,
                    ...results
                ].filter(Boolean).join('\n')
            });
            continue;
        }

        if (msg.role === 'tool') {
            const name = msg.name || fallbackToolName || 'tool';
            converted.push({
                role: 'system',
                content: `[tool_execution]\nresults:\n${summarizeToolResultForChat(name, msg.content)}`
            });
            continue;
        }

        converted.push(msg);
    }

    return converted.filter(Boolean);
}

function moveFinalToolPromptToEnd(messages = []) {
    const finalPrompts = [];
    const normalMessages = [];

    for (const msg of messages) {
        const content = String(msg?.content || "");
        const isFinalToolPrompt = msg?.role === "system"
            && content.includes("工具已全部执行完成")
            && content.includes("自然口语");

        if (isFinalToolPrompt) {
            finalPrompts.push(msg);
        } else {
            normalMessages.push(msg);
        }
    }

    return finalPrompts.length
        ? [...normalMessages, finalPrompts[finalPrompts.length - 1]]
        : normalMessages;
}

function summarizeToolResultForChat(toolName, content = '') {
    const text = String(content || '');
    return `content: ${text}`;
}

/**
 * 将请求数据转换为 Anthropic 格式
 * @param {Object} requestData - OpenAI 格式请求数据
 * @param {Object} originalRequestData - 原始请求数据（可能包含 tools）
 * @returns {Object} Anthropic 格式请求数据
 */
function convertToAnthropicFormat(requestData, originalRequestData) {
    const anthropicRequest = {
        model: requestData.model,
        max_tokens: 16000,
        messages: []
    }

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

    // 默认开启自适应思考；effort 不显式设置，走模型默认（Opus 4.8 默认 high）
    // 不支持 thinking 的模型/中转会在请求失败时由 fetchWithThinkingFallback 自动去掉该字段重试，不报错
    anthropicRequest.thinking = { type: 'adaptive' }

    return anthropicRequest
}

/**
 * 发送 JSON 请求；若请求体带 thinking 且因模型不支持而失败，则去掉 thinking 后重试一次
 * 对不带 thinking 的请求（如 OpenAI 格式）原样透传，行为不变
 * @param {string} url - 请求地址
 * @param {Object} headers - 请求头
 * @param {Object} requestData - 请求体对象
 * @returns {Promise<{response: Response, errorText: string|null}>} errorText 仅在最终响应失败时填充
 */
async function fetchWithThinkingFallback(url, headers, requestData, signal) {
    const send = (body) => fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
    })

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
}

/**
 * 将 OpenAI 的 image_url 格式转换为 Anthropic 的 image 格式
 * @param {string} imageUrl - 图片 URL（支持 http(s):// 或 data:image/...;base64,... 格式）
 * @returns {Object|null} Anthropic image block 或 null
 */
function convertImageUrlToAnthropicFormat(imageUrl) {
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
function convertFromAnthropicFormat(anthropicResponse) {
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

/**
 * 通用 AI API 调用函数
 * 自动检测 API 格式（OpenAI/Anthropic），转换请求和响应，支持流式和非流式
 *
 * @param {Object} config - API 配置 { url, model, apikey }
 * @param {Array} messages - OpenAI 格式的消息数组
 * @param {Object} options - 可选参数
 * @param {number} [options.maxTokens] - 最大 token 数
 * @param {number} [options.temperature] - 温度参数
 * @param {Array} [options.tools] - 工具定义（OpenAI 格式）
 * @param {boolean} [options.stream] - 是否流式响应
 * @param {AbortSignal} [options.signal] - 用于取消请求的 AbortSignal
 * @param {Object} [options.additionalParams] - 其他额外的请求体参数
 * @returns {Promise<Object>} 返回 OpenAI 格式的响应对象，或 { error: string }
 */
export async function callAI(config, messages, options = {}) {
    const {
        maxTokens,
        temperature,
        tools,
        stream = false,
        signal,
        additionalParams = {}
    } = options

    // 验证配置
    if (!config?.url || !config?.model || !config?.apikey) {
        return { error: 'API 配置不完整，需要 url、model、apikey' }
    }

    // 检测 API 格式
    const apiFormat = detectApiFormat(config.url)

    try {
        // 构建请求头
        const headers = {
            'Authorization': `Bearer ${config.apikey}`,
            'Content-Type': 'application/json'
        }

        // 构建基础请求体（OpenAI 格式）
        let requestData = {
            model: config.model,
            messages: messages,
            stream: stream,
            ...additionalParams
        }

        if (maxTokens !== undefined) requestData.max_tokens = maxTokens
        if (temperature !== undefined) requestData.temperature = temperature
        if (tools && tools.length > 0) requestData.tools = tools

        // 根据格式转换请求
        if (apiFormat === 'anthropic') {
            // 应用 Claude Code 请求头（伪装为官方 CLI）
            applyClaudeCodeHeaders(headers)

            // 转换为 Anthropic 格式（自动添加 system 身份串、metadata、thinking 等伪装字段）
            try {
                requestData = convertToAnthropicFormat(requestData, requestData)
            } catch (convertError) {
                logger.error('[callAI] Anthropic 请求格式转换失败:', convertError)
                return { error: `请求格式转换失败：${convertError.message}` }
            }
        }

        // 发送请求（signal 单独传递，不进 body）
        const result = await fetchWithThinkingFallback(config.url, headers, requestData, signal)
        const response = result.response

        if (!response.ok) {
            logger.error(`[callAI] API 请求失败：${response.status} ${response.statusText} - ${result.errorText}`)
            return { error: `API 请求失败：${response.status} ${response.statusText}` }
        }

        // 处理流式响应
        if (stream) {
            return handleStreamResponseUnified(response, apiFormat)
        }

        // 处理非流式响应
        let responseData
        try {
            responseData = await response.json()
        } catch (jsonError) {
            logger.error('[callAI] 解析响应 JSON 失败:', jsonError)
            return { error: `解析响应 JSON 失败：${jsonError.message}` }
        }

        // 转换 Anthropic 响应为 OpenAI 格式
        if (apiFormat === 'anthropic') {
            try {
                responseData = convertFromAnthropicFormat(responseData)
            } catch (convertError) {
                logger.error('[callAI] Anthropic 响应格式转换失败:', convertError)
                return { error: `响应格式转换失败：${convertError.message}` }
            }
        }

        return processResponse(responseData)

    } catch (error) {
        logger.error('[callAI] 调用异常:', error)
        return { error: `调用异常：${error.message}` }
    }
}

/**
 * 统一处理流式响应（兼容 OpenAI 和 Anthropic SSE 格式）
 * @param {Response} response - fetch 响应对象
 * @param {string} apiFormat - 'openai' 或 'anthropic'
 * @returns {Promise<string>} 拼接后的完整文本内容
 */
async function handleStreamResponseUnified(response, apiFormat) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let content = ''

    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue
                const dataStr = line.slice(6).trim()
                if (dataStr === '[DONE]') break

                try {
                    const data = JSON.parse(dataStr)

                    if (apiFormat === 'anthropic') {
                        // Anthropic 流式格式
                        if (data.type === 'content_block_delta' && data.delta?.text) {
                            content += data.delta.text
                        }
                    } else {
                        // OpenAI 流式格式
                        const delta = data?.choices?.[0]?.delta?.content
                        if (delta) content += delta
                    }
                } catch (parseError) {
                    // 跳过解析失败的行
                }
            }
        }

        if (!content) {
            throw new Error('未接收到有效内容')
        }

        // 返回 OpenAI 格式的响应对象
        return {
            choices: [{
                message: {
                    role: 'assistant',
                    content: content
                },
                finish_reason: 'stop'
            }]
        }
    } catch (error) {
        logger.error('[handleStreamResponseUnified] 流式响应处理失败:', error)
        return { error: `流式响应处理失败：${error.message}` }
    }
}

function processResponse(responseData) {
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
