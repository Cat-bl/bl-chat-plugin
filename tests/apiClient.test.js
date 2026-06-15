import { describe, it } from 'node:test';
import assert from 'node:assert';

// 模拟转换函数（从 apiClient.js 复制）
function detectApiFormat(url) {
    if (!url || typeof url !== 'string') return 'openai'
    if (url.toLowerCase().includes('/v1/messages')) return 'anthropic'
    return 'openai'
}

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

function convertToAnthropicFormat(requestData, originalRequestData) {
    const anthropicRequest = {
        model: requestData.model,
        max_tokens: 8192,
        messages: []
    }

    // 提取系统消息（伪装成官方 Claude Code CLI：system 为数组，首块为身份串）
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
    for (const msg of nonSystemMessages) {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
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
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: {}
                    })
                }
            }
            anthropicRequest.messages.push({
                role: 'assistant',
                content
            })
        } else if (msg.role === 'tool') {
            anthropicRequest.messages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: String(msg.content || '')
                }]
            })
        } else {
            anthropicRequest.messages.push({
                role: msg.role,
                content: String(msg.content || '')
            })
        }
    }

    if (originalRequestData.tools?.length) {
        anthropicRequest.tools = originalRequestData.tools.map(tool => ({
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || { type: 'object', properties: {} }
        }))
    }

    anthropicRequest.metadata = {
        user_id: `user_${'0'.repeat(64)}_account__session_00000000-0000-4000-8000-000000000000`
    }

    return anthropicRequest
}

function convertFromAnthropicFormat(anthropicResponse) {
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

        if (toolUses.length > 0) {
            openaiResponse.choices[0].message.tool_calls = toolUses
        }
    } else if (typeof anthropicResponse.content === 'string') {
        openaiResponse.choices[0].message.content = anthropicResponse.content
    } else if (!anthropicResponse.content) {
        openaiResponse.choices[0].message.content = ''
    }

    return openaiResponse
}

describe('API 格式检测', () => {
    it('检测 Anthropic URL', () => {
        assert.strictEqual(detectApiFormat('https://api.anthropic.com/v1/messages'), 'anthropic');
    });

    it('检测 OpenAI URL', () => {
        assert.strictEqual(detectApiFormat('https://api.openai.com/v1/chat/completions'), 'openai');
    });

    it('空 URL 默认 OpenAI', () => {
        assert.strictEqual(detectApiFormat(''), 'openai');
        assert.strictEqual(detectApiFormat(null), 'openai');
        assert.strictEqual(detectApiFormat(undefined), 'openai');
    });
});

describe('Anthropic 请求格式转换', () => {
    it('基本消息转换', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                { role: 'system', content: '你是助手' },
                { role: 'user', content: '你好' }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(Array.isArray(result.system), true);
        assert.strictEqual(result.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
        assert.strictEqual(result.system[1].text, '你是助手');
        assert.strictEqual(result.messages.length, 1);
        assert.strictEqual(result.messages[0].role, 'user');
        assert.strictEqual(result.messages[0].content, '你好');
    });

    it('空 messages 数组', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: []
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(result.messages.length, 0);
    });

    it('tool_calls 转换', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                {
                    role: 'assistant',
                    content: '我来帮你搜索',
                    tool_calls: [{
                        id: 'call_123',
                        function: {
                            name: 'search',
                            arguments: '{"query":"test"}'
                        }
                    }]
                }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(result.messages[0].content.length, 2);
        assert.strictEqual(result.messages[0].content[0].type, 'text');
        assert.strictEqual(result.messages[0].content[1].type, 'tool_use');
        assert.strictEqual(result.messages[0].content[1].name, 'search');
    });

    it('tool 消息转换为 tool_result', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                {
                    role: 'tool',
                    tool_call_id: 'call_123',
                    content: 'search result'
                }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(result.messages[0].role, 'user');
        assert.strictEqual(result.messages[0].content[0].type, 'tool_result');
        assert.strictEqual(result.messages[0].content[0].tool_use_id, 'call_123');
    });

    it('工具定义转换', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [],
            tools: [{
                function: {
                    name: 'search',
                    description: 'Search tool',
                    parameters: { type: 'object', properties: {} }
                }
            }]
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(result.tools[0].name, 'search');
        assert.strictEqual(result.tools[0].description, 'Search tool');
    });
});

describe('Anthropic 响应格式转换', () => {
    it('文本响应转换', () => {
        const response = {
            content: [{ type: 'text', text: '你好' }],
            stop_reason: 'end_turn'
        };
        const result = convertFromAnthropicFormat(response);
        assert.strictEqual(result.choices[0].message.content, '你好');
        assert.strictEqual(result.choices[0].finish_reason, 'end_turn');
    });

    it('tool_use 响应转换', () => {
        const response = {
            content: [
                { type: 'text', text: '让我搜索' },
                {
                    type: 'tool_use',
                    id: 'call_123',
                    name: 'search',
                    input: { query: 'test' }
                }
            ],
            stop_reason: 'tool_use'
        };
        const result = convertFromAnthropicFormat(response);
        assert.strictEqual(result.choices[0].message.tool_calls.length, 1);
        assert.strictEqual(result.choices[0].message.tool_calls[0].function.name, 'search');
    });

    it('空 content 处理', () => {
        const response = {
            content: null,
            stop_reason: 'stop'
        };
        const result = convertFromAnthropicFormat(response);
        assert.strictEqual(result.choices[0].message.content, '');
    });

    it('错误响应透传', () => {
        const response = { error: { message: 'API error' } };
        const result = convertFromAnthropicFormat(response);
        assert.deepStrictEqual(result, response);
    });
});
