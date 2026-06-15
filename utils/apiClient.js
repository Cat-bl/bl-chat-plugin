import { dependencies } from "../dependence/dependencies.js";
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
const { _path, fetch, fs, path } = dependencies;

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
        // Claude CLI 真实 User-Agent 格式：claude-cli/版本号 (external, cli)
        userAgent: 'claude-cli/2.1.177 (external, cli)'
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
                const versions = generateDynamicVersions();
                toolsHeaders['anthropic-version'] = versions.anthropicVersion;
                // 不发送 User-Agent，避免中转站检测客户端类型
            }

            let toolsResponse;
            try {
                // 保留原始请求中的 tools 字段
                let toolsRequestData = {
                    ...requestData,
                    model: config.toolsAiConfig.toolsAiModel,
                    stream: false
                };

                // 根据格式转换请求
                if (toolsApiFormat === 'anthropic') {
                    try {
                        toolsRequestData = convertToAnthropicFormat(toolsRequestData, requestData)
                    } catch (convertError) {
                        logger.error('[Anthropic] 请求格式转换失败:', convertError)
                        return { error: `请求格式转换失败：${convertError.message}` }
                    }
                }

                toolsResponse = await fetch(toolsUrl, {
                    method: 'POST',
                    headers: toolsHeaders,
                    body: JSON.stringify(toolsRequestData)
                });

                if (!toolsResponse.ok) {
                    const errorText = await toolsResponse.text().catch(() => '无法读取错误内容');
                    logger.error(`工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${errorText}`);
                    return { error: `工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${errorText}` };
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

            // 处理消息，过滤并转换 tool_calls 相关内容
            const processedMessages = requestData.messages
                .map(msg => {
                    if (msg.role === 'assistant' && msg.tool_calls?.length) {
                        //return null; // 跳过含 tool_calls 的 assistant 消息
                        const prefix = `你需要使用 ${toolName} 来处理用户的需求\n`;
                        return {
                            role: 'assistant',
                            content: '[系统反馈信息]: ' + prefix + msg.tool_calls[0].function.arguments
                        };
                    } else if (msg.role === 'tool') {
                        const prefix = `使用 ${toolName} 处理完成了，这是调用的结果：\n`;
                        return {
                            role: 'user',
                            content: '[系统反馈信息]: ' + prefix + msg.content
                        };
                    }
                    return msg;
                })
                .filter(Boolean);

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

        // 根据 API 格式处理请求体
        if (apiFormat === 'openai') {
            if (url.includes('v1/chat/completions') && typeof finalRequestData === 'object' && finalRequestData !== null) {
                delete finalRequestData.tools;
                delete finalRequestData.tool_choice;
            }
            finalRequestData.messages = moveFinalToolPromptToEnd(
                removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages)
            )
        } else if (apiFormat === 'anthropic') {
            // Anthropic 格式转换
            // 注意：对话 API 不传递 tools，避免模型参与工具调用判断
            try {
                // 第二个参数传 finalRequestData（不含 tools），而不是 requestData
                finalRequestData = convertToAnthropicFormat(finalRequestData, finalRequestData)
            } catch (convertError) {
                logger.error('[Anthropic] 请求格式转换失败:', convertError)
                return { error: `请求格式转换失败：${convertError.message}` }
            }
            const versions = generateDynamicVersions();
            headers['anthropic-version'] = versions.anthropicVersion;
            // 不发送 User-Agent，避免中转站检测客户端类型
        }

        logger.debug('最终请求体:', finalRequestData);
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(finalRequestData)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '无法读取错误内容');
                logger.error(`API 请求失败：${response.status} ${response.statusText} - ${errorText}`);
                return { error: `API 请求失败：${response.status} ${response.statusText} - ${errorText}` };
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
        max_tokens: 8192,
        messages: []
    }

    // 提取系统消息
    const systemMessages = requestData.messages.filter(m => m.role === 'system')
    if (systemMessages.length > 0) {
        const systemContent = systemMessages.map(m => m.content || '').filter(Boolean).join('\n\n')
        if (systemContent) {
            anthropicRequest.system = systemContent
        }
    }

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
            // 普通消息
            convertedMsg = {
                role: msg.role,
                content: String(msg.content || '')
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

    return anthropicRequest
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
