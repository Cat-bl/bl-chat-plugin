// 对话消息适配层：把带工具调用痕迹的消息序列改写成对话模型可读的形式。
// 从 apiClient.js 拆出（行为等价搬迁），仅 YTapi 的对话降级路径使用。
import { FINAL_TOOL_PROMPT } from "../textUtils.js"

/**
 * 把 assistant tool_calls / tool 消息折叠成 system 的 [tool_execution] 摘要，
 * 使不支持工具协议的对话模型也能理解工具执行历史
 */
export function convertToolMessagesForChat(messages = [], fallbackToolName = 'tool') {
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

export function moveFinalToolPromptToEnd(messages = []) {
    const finalPrompts = [];
    const normalMessages = [];

    for (const msg of messages) {
        const content = String(msg?.content || "");
        // 通过共享常量识别收尾提示（textUtils#removeToolPromptsFromMessages 生成的完整文案），
        // 避免提示词文案与此处的片段匹配各改各的导致静默失效
        const isFinalToolPrompt = msg?.role === "system"
            && content.includes(FINAL_TOOL_PROMPT);

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
