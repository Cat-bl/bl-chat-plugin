import { AbstractTool } from './AbstractTool.js';
import { TotalTokens } from "../../functions/tools/CalculateToken.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
/**
 * Search 工具类，用于自由搜索并控制返回结果的大小
 */
export class FreeSearchTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'freeSearchTool';
    this.description = '请求外部 API 进行自由搜索，检索结果，对于需要进行搜索或需要实时数据信息的时候使用';
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
      const configPath = path.join(process.cwd(), 'plugins/test-plugin/config/message.yaml');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const config = YAML.parse(configFile).pluginSettings;
      
      const apiUrl = config.searchAiConfig?.searchApiUrl || 'https://api.openai.com/v1/chat/completions'
      const apiKey = config.searchAiConfig?.searchApiKey || 'sk-xxxxxx'

      const requestData = { "model": config.searchAiConfig?.searchApiModel || 'deepseek-r1-search', "messages": [{ "role": "user", "content": query }], "temperature": 1, "top_p": 0.1 }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestData),
      })

      const analysis = await response.json()
      return analysis.choices[0]?.message.content + '\n\n提示：如果用户想基于搜索结果制作文件，可以使用 aiMindMapTool 工具继续操作。'

    } catch (error) {
      console.error('搜索过程发生错误:', error);
      return `搜索失败：${error.message || '发生未知错误'}`;
    }
  }
}