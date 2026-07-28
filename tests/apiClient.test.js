import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    detectApiFormat,
    CLAUDE_CODE_IDENTITY,
    applyClaudeCodeHeaders,
    convertToAnthropicFormat,
    convertImageUrlToAnthropicFormat,
    convertFromAnthropicFormat
} from '../utils/api/anthropicFormat.js';
import { parseSSETextUnified, processResponse } from '../utils/api/responseParsing.js';
import { convertToolMessagesForChat, moveFinalToolPromptToEnd } from '../utils/api/chatMessageAdapters.js';
import { FINAL_TOOL_PROMPT } from '../utils/textUtils.js';

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

describe('Claude Code 请求头伪装', () => {
    it('补齐 CLI 指纹并返回同一对象', () => {
        const headers = { 'Content-Type': 'application/json' };
        const result = applyClaudeCodeHeaders(headers);
        assert.strictEqual(result, headers);
        assert.strictEqual(headers['anthropic-version'], '2023-06-01');
        assert.match(headers['user-agent'], /^claude-cli\//);
        assert.strictEqual(headers['x-app'], 'cli');
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
        assert.strictEqual(result.system[0].text, CLAUDE_CODE_IDENTITY);
        assert.strictEqual(result.system[1].text, '你是助手');
        assert.strictEqual(result.messages.length, 1);
        assert.strictEqual(result.messages[0].role, 'user');
        assert.strictEqual(result.messages[0].content, '你好');
        assert.strictEqual(result.thinking.type, 'adaptive');
    });

    it('空 messages 数组抛出异常', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: []
        };
        assert.throws(() => convertToAnthropicFormat(request, request), /消息数组为空/);
    });

    it('tool_calls 转换（首条非 user 时自动补 user 消息）', () => {
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
        // Anthropic 要求首条为 user，assistant 前会补一条 user
        assert.strictEqual(result.messages[0].role, 'user');
        const assistantMsg = result.messages[1];
        assert.strictEqual(assistantMsg.content.length, 2);
        assert.strictEqual(assistantMsg.content[0].type, 'text');
        assert.strictEqual(assistantMsg.content[1].type, 'tool_use');
        assert.strictEqual(assistantMsg.content[1].name, 'search');
        assert.deepStrictEqual(assistantMsg.content[1].input, { query: 'test' });
    });

    it('tool_call arguments 非法 JSON 时降级为空 input', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                { role: 'user', content: '搜一下' },
                {
                    role: 'assistant',
                    tool_calls: [{
                        id: 'call_bad',
                        function: { name: 'search', arguments: '{invalid json' }
                    }]
                }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        const toolUse = result.messages[1].content.find(b => b.type === 'tool_use');
        assert.deepStrictEqual(toolUse.input, {});
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

    it('连续相同角色的消息被合并', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                { role: 'user', content: '第一句' },
                { role: 'user', content: '第二句' }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        assert.strictEqual(result.messages.length, 1);
        assert.strictEqual(result.messages[0].content, '第一句\n第二句');
    });

    it('多模态消息转换：base64 图片转 image block', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '看这张图' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
                    ]
                }
            ]
        };
        const result = convertToAnthropicFormat(request, request);
        const blocks = result.messages[0].content;
        assert.strictEqual(blocks[0].type, 'text');
        assert.strictEqual(blocks[1].type, 'image');
        assert.strictEqual(blocks[1].source.media_type, 'image/png');
        assert.strictEqual(blocks[1].source.data, 'QUJD');
    });

    it('工具定义转换', () => {
        const request = {
            model: 'claude-3-5-sonnet',
            messages: [{ role: 'user', content: 'hi' }],
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

describe('图片 URL 转 Anthropic 格式', () => {
    it('base64 data URL 转换', () => {
        const block = convertImageUrlToAnthropicFormat('data:image/jpeg;base64,QUJD');
        assert.strictEqual(block.type, 'image');
        assert.strictEqual(block.source.type, 'base64');
        assert.strictEqual(block.source.media_type, 'image/jpeg');
    });

    it('http URL 不支持，返回 null', () => {
        assert.strictEqual(convertImageUrlToAnthropicFormat('https://example.com/a.jpg'), null);
    });

    it('非法输入返回 null', () => {
        assert.strictEqual(convertImageUrlToAnthropicFormat(null), null);
        assert.strictEqual(convertImageUrlToAnthropicFormat(''), null);
        assert.strictEqual(convertImageUrlToAnthropicFormat('not-a-url'), null);
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
        assert.strictEqual(result.choices[0].message.tool_calls[0].function.arguments, '{"query":"test"}');
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

describe('SSE 文本兜底解析', () => {
    it('解析 OpenAI 格式 SSE', () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"你"}}]}',
            'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]'
        ].join('\n');
        const result = parseSSETextUnified(sse, 'openai');
        assert.strictEqual(result.choices[0].message.content, '你好');
        assert.strictEqual(result.choices[0].finish_reason, 'stop');
    });

    it('解析 Anthropic 格式 SSE', () => {
        const sse = [
            'data: {"type":"content_block_delta","delta":{"text":"早上"}}',
            'data: {"type":"content_block_delta","delta":{"text":"好"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}'
        ].join('\n');
        const result = parseSSETextUnified(sse, 'anthropic');
        assert.strictEqual(result.choices[0].message.content, '早上好');
        assert.strictEqual(result.choices[0].finish_reason, 'end_turn');
    });

    it('无有效内容时返回错误', () => {
        const result = parseSSETextUnified('data: [DONE]', 'openai');
        assert.ok(result.error);
    });

    it('跳过解析失败的行', () => {
        const sse = [
            'data: {broken json}',
            'data: {"choices":[{"delta":{"content":"ok"}}]}'
        ].join('\n');
        const result = parseSSETextUnified(sse, 'openai');
        assert.strictEqual(result.choices[0].message.content, 'ok');
    });
});

describe('响应归一化 processResponse', () => {
    it('数组响应取首个', () => {
        const result = processResponse([{ choices: [{ message: { content: 'hi' } }] }]);
        assert.strictEqual(result.choices[0].message.content, 'hi');
    });

    it('detail 字段转错误', () => {
        assert.deepStrictEqual(processResponse({ detail: 'bad request' }), { error: 'bad request' });
    });

    it('error 对象转错误消息', () => {
        assert.deepStrictEqual(
            processResponse({ error: { message: 'quota exceeded' } }),
            { error: 'quota exceeded' }
        );
    });

    it('正常响应原样返回', () => {
        const data = { choices: [{ message: { content: 'ok' } }] };
        assert.strictEqual(processResponse(data), data);
    });

    it('非对象响应返回错误', () => {
        assert.ok(processResponse('plain text').error);
        assert.ok(processResponse(null).error);
    });
});

describe('工具消息折叠为对话可读形式', () => {
    it('assistant tool_calls + tool 结果折叠为 [tool_execution] system 消息', () => {
        const messages = [
            { role: 'user', content: '帮我点赞' },
            {
                role: 'assistant',
                tool_calls: [{ id: 'c1', function: { name: 'likeTool', arguments: '{}' } }]
            },
            { role: 'tool', name: 'likeTool', content: '点赞成功' },
            { role: 'assistant', content: '搞定啦' }
        ];
        const result = convertToolMessagesForChat(messages, 'likeTool');
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[1].role, 'system');
        assert.ok(result[1].content.includes('[tool_execution]'));
        assert.ok(result[1].content.includes('1. likeTool'));
        assert.ok(result[1].content.includes('content: 点赞成功'));
        assert.strictEqual(result[2].content, '搞定啦');
    });

    it('孤立 tool 消息也折叠为 system 摘要', () => {
        const messages = [{ role: 'tool', name: 'pokeTool', content: '戳了一下' }];
        const result = convertToolMessagesForChat(messages);
        assert.strictEqual(result[0].role, 'system');
        assert.ok(result[0].content.includes('content: 戳了一下'));
    });

    it('普通消息原样保留', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' }
        ];
        assert.deepStrictEqual(convertToolMessagesForChat(messages), messages);
    });
});

describe('收尾提示移动到消息末尾', () => {
    it('最终工具提示被移到最后且只保留一条', () => {
        const finalPrompt = { role: 'system', content: FINAL_TOOL_PROMPT };
        const messages = [
            finalPrompt,
            { role: 'user', content: '你好' },
            { role: 'system', content: `前缀 ${FINAL_TOOL_PROMPT} 后缀` }
        ];
        const result = moveFinalToolPromptToEnd(messages);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].content, '你好');
        assert.ok(result[1].content.includes(FINAL_TOOL_PROMPT));
    });

    it('没有收尾提示时原样返回', () => {
        const messages = [
            { role: 'system', content: '普通系统提示' },
            { role: 'user', content: 'hi' }
        ];
        assert.deepStrictEqual(moveFinalToolPromptToEnd(messages), messages);
    });
});
