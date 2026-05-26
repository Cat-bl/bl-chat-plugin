import { dependencies } from "../dependence/dependencies.js";
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
const { _path, fetch, fs, path } = dependencies;
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
            // useTools 开启，先调用 OpenAI API
            const openaiUrl = `${config.toolsAiConfig.toolsAiUrl}`;
            // 确保使用OpenAiModel的模型
            if (!config.toolsAiConfig.toolsAiApikey) return { error: "OpenAI Token 未配置" };

            const openaiHeaders = {
                'Authorization': `Bearer ${config.toolsAiConfig.toolsAiApikey}`,
                'Content-Type': 'application/json'
            };

            let openaiResponse;
            try {
                // 使用config.OpenAiModel替换请求中的模型
                const openaiRequestData = {
                    ...requestData,
                    model: config.toolsAiConfig.toolsAiModel,
                    stream: false
                };
                // logger.error(config.toolsAiConfig.toolsAiApikey, config.toolsAiConfig.toolsAiModel, JSON.stringify(openaiRequestData))
                // logger.error('已触发全局AI对话', config.toolsAiConfig.toolsAiApikey, config.toolsAiConfig.toolsAiModel)
                openaiResponse = await fetch(openaiUrl, {
                    method: 'POST',
                    headers: openaiHeaders,
                    body: JSON.stringify(openaiRequestData)
                });

                if (!openaiResponse.ok) {
                    const errorText = await openaiResponse.text().catch(() => '无法读取错误内容');
                    logger.error(`OpenAI API 请求失败：${openaiResponse.status} ${openaiResponse.statusText} - ${errorText}`);
                    return
                    return { error: `OpenAI API 请求失败：${openaiResponse.status} ${openaiResponse.statusText} - ${errorText}` };
                }
            } catch (openaiFetchError) {
                logger.error("OpenAI API 请求失败:", openaiFetchError);
                return
                return { error: `OpenAI API 请求失败：${openaiFetchError.message}` };
            }

            let openaiData;
            try {
                openaiData = await openaiResponse.json();
                logger.error('OpenAI 响应:', JSON.stringify(openaiData, null, 2));
            } catch (openaiJsonError) {
                console.error("解析 OpenAI 响应 JSON 失败:", openaiJsonError);
                return { error: `解析 OpenAI 响应 JSON 失败：${openaiJsonError.message}` };
            }

            // 检查是否包含 tool_calls，无论 finish_reason 是什么
            const hasToolCalls = openaiData?.choices?.[0]?.message?.tool_calls?.length > 0;
            if (hasToolCalls) {
                // 直接返回 tool_calls 响应，保持 OpenAI 模型
                return processResponse(openaiData);
            }

            // 检查 OneAPI 配置
            if (!config.chatAiConfig.chatApiUrl || !config.chatAiConfig.chatApiModel || !config.chatAiConfig.chatApiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }
            url = config.chatAiConfig.chatApiUrl.endsWith('completions') ? config.chatAiConfig.chatApiUrl : `${config.chatAiConfig.chatApiUrl}/v1/chat/completions`;
            const oneApiKey = config.chatAiConfig.chatApiKey;
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
            url = config.chatAiConfig.chatApiUrl.endsWith('completions') ? config.chatAiConfig.chatApiUrl : `${config.chatAiConfig.chatApiUrl}/v1/chat/completions`;
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

        let response;
        if (url.includes('v1/chat/completions') && typeof finalRequestData === 'object' && finalRequestData !== null) {
            delete finalRequestData.tools;
            delete finalRequestData.tool_choice;
        }
        finalRequestData.messages = moveFinalToolPromptToEnd(
            removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages)
        )
        console.log('最终请求体:', finalRequestData);
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(finalRequestData)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '无法读取错误内容');
                logger.error(`API 请求失败：${response.status} ${response.statusText} - ${errorText}`);
                return
                return { error: `API 请求失败：${response.status} ${response.statusText} - ${errorText}` };
            }
        } catch (fetchError) {
            console.error(`${provider || 'API'} 请求失败:`, fetchError);
            return
            return { error: `${provider || 'API'} 请求失败：${fetchError.message}` };
        }

        let responseData;
        try {
            responseData = await response.json();
            console.log(`${provider || 'API'} 响应:`, JSON.stringify(responseData, null, 2));
        } catch (jsonError) {
            console.error(`解析 ${provider || 'API'} 响应 JSON 失败:`, jsonError);
            return { error: `解析 ${provider || 'API'} 响应 JSON 失败：${jsonError.message}` };
        }
        return processResponse(responseData);

    } catch (error) {
        console.error('YTapi 异常:', error);
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

function getNextApiKey() {
    const apiKeys = [
        "a1eef00f6bce4a10a7de83936fce6492.0wDYtwPnWukoPxWj"
    ]
    const randomIndex = Math.floor(Math.random() * apiKeys.length)
    const apiKey = apiKeys[randomIndex]
    console.log("负载均衡-散列-使用API key:", apiKey)
    return apiKey
}
