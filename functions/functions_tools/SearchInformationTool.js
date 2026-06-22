import { AbstractTool } from './AbstractTool.js';
import { TotalTokens } from "../../functions/tools/CalculateToken.js";
import { callAI } from "../../utils/apiClient.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
/**
 * Search 工具类，用于自由搜索并控制返回结果的大小
 */
export class SearchInformationTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'searchInformationTool';
    this.description = '请求外部 API 进行自由搜索，检索结果，对于需要进行搜索或需要实时数据信息的时候使用，总结群聊聊天记录时无需调用';
    this.parameters = {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: '搜索的查询关键词'
        }
      },
      required: ['query']
    };

    // 固定最大 token 数量为 30000
    this.maxTokens = 30000;
  }

  /**
   * 截断文本以控制 token 数量
   * @param {string} text - 需要截断的文本
   * @returns {Promise<string>} 截断后的文本
   */
  async truncateText(text) {
    if (!text) return '未找到相关搜索结果';

    const tokens = await TotalTokens(text);

    if (tokens.completion_tokens <= this.maxTokens) {
      return text;
    }

    // 如果超出限制，按比例截断文本
    const ratio = this.maxTokens / tokens.completion_tokens;
    const truncatedLength = Math.floor(text.length * ratio);
    const truncated = text.substring(0, truncatedLength);

    return `${truncated}\n\n[注意：结果已截断，显示内容已达到长度限制]`;
  }

  /**
   * 将各种格式的结果转换为字符串
   * @param {any} result - 任意类型的结果
   * @returns {string} 转换后的字符串
   */
  resultToString(result) {
    // logger.error('result', result)
    if (typeof result === 'string') {
      return result;
    }

    if (result === null || result === undefined) {
      return '未找到相关搜索结果';
    }

    if (typeof result === 'object') {
      // 处理常见的结果格式
      if (result.content) {
        return String(result.content);
      }
      if (result.results && Array.isArray(result.results)) {
        return result.results.map((item, index) => {
          if (typeof item === 'string') {
            return `${index + 1}. ${item}`;
          }
          if (item.title && item.content) {
            return `${index + 1}. ${item.title}\n${item.content}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.data.webPages.value && Array.isArray(result.data.webPages.value)) {
        return result.data.webPages.value.map((item, index) => {
          if (typeof item.snippet === 'string') {
            return `${index + 1}. ${item.snippet}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.message) {
        return String(result.message);
      }
    }

    // 最后的兜底方案
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  /**
   * 处理搜索操作并返回字符串结果
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   * @returns {Promise<string>} 字符串形式的搜索结果
   */
  async func(opts, e) {
    const { query } = opts;

    if (!query?.trim()) {
      return '搜索失败：搜索关键词不能为空';
    }

    try {
      // 配置路径
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const config = YAML.parse(configFile).pluginSettings;

      const apiUrl = config.searchAiConfig?.searchApiUrl || 'https://api.openai.com/v1/chat/completions'
      const apiKey = config.searchAiConfig?.searchApiKey || 'sk-xxxxxx'
      const apiModel = config.searchAiConfig?.searchApiModel || 'deepseek-r1-search'

      const result = await callAI(
        {
          url: apiUrl,
          model: apiModel,
          apikey: apiKey
        },
        [{ role: "user", content: "请联网搜索：" + query }],
        { stream: false }
      )

      if (result.error) {
        return `搜索失败：${result.error}`
      }

      const content = result?.choices?.[0]?.message?.content || '未找到相关搜索结果'
      return content + '\n\n提示：如果用户想基于搜索结果制作文件，可以使用 aiMindMapTool 工具继续操作。'

    } catch (error) {
      console.error('搜索过程发生错误:', error);
      return `搜索失败：${error.message || '发生未知错误'}`;
    }
  }

  // 自动检测并解析响应（兼容流式 + 非流式）
  async parseResponse(response) {
    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // 检测流式响应（优先级高，避免先 json() 消费 body）
    if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
      return await this.handleStreamResponse(response);
    }

    // 检测 JSON 响应
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }

    // Content-Type 未明确时，先读 body 一次性判断
    const text = await response.text();
    // 尝试按 SSE 格式解析
    if (text.includes('data: ')) {
      return this.parseSSEText(text);
    }
    // 尝试按 JSON 解析
    try {
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content || '';
    } catch {
      throw new Error('无法解析响应格式');
    }
  }

  // 从已读取的文本中解析 SSE 格式
  parseSSEText(text) {
    let content = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === "[DONE]") break;
      try {
        const data = JSON.parse(dataStr);
        content += data?.choices?.[0]?.delta?.content || "";
      } catch { }
    }
    if (!content) throw new Error("未接收到有效内容");
    return content;
  }

  async handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      for (const line of decoder.decode(value).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") break;

        try {
          const data = JSON.parse(dataStr);
          content += data?.choices?.[0]?.delta?.content || "";
        } catch { }
      }
    }

    if (!content) throw new Error("未接收到有效内容");
    return content;
  }
}