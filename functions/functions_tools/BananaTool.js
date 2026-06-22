import { AbstractTool } from './AbstractTool.js';
import { getBase64Image, normalizeImageUrls } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import { callAI } from "../../utils/apiClient.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";

const { mimeTypes, axios } = dependencies;

export class BananaTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'bananaTool';
    this.description = '根据提示词生成图片, 使用nano-banana-2模型进行绘图';
    this.parameters = {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '绘图的描述提示词',
          minLength: 1,
          maxLength: 4000
        },
        images: {
          type: 'array',
          description: '用户提供的图片链接数组，需保留原始URL完整性',
          items: { type: 'string' }
        }
      },
      required: ['prompt'],
      additionalProperties: false
    };
  }

  async func(opts, e) {
    const config = this.loadConfig();
    const { prompt, images: rawImages } = opts;

    if (!prompt) return "错误：绘图提示词（prompt）不能为空。";

    // 处理图片
    const images = await normalizeImageUrls(this.normalizeArray(rawImages));
    const imgurls = await this.buildImageMessages(prompt, images);

    try {
      const { imageEditApiUrl: apiUrl, imageEditApiKey: apiKey, imageEditApiModel: model } =
        config.imageEditAiConfig || {};

      const result = await callAI(
        {
          url: apiUrl || 'https://api.openai.com/v1/chat/completions',
          model: model || "gemini-3-pro-image-preview",
          apikey: apiKey || 'sk-xxxxxx'
        },
        [{ role: "user", content: imgurls }],
        { stream: false }
      )

      if (result.error) {
        return { error: `图片生成失败: ${result.error}` }
      }

      // 兼容两种响应格式：
      // 1. images 数组（部分模型如 Gemini 把图片放在 message.images 里）
      // 2. content 字符串（Markdown 图片或 base64 data URI）
      const msg = result?.choices?.[0]?.message || {}
      const imageUrl = msg.images?.[0]?.image_url?.url ||
        msg.images?.[0]?.url ||
        msg.content || ''
      const processedUrl = this.extractImageUrl(imageUrl);

      if (processedUrl) {
        await e.reply([segment.image(processedUrl)]);
        return '图片编辑成功';
      }
      return { error: '图片编辑失败' };
    } catch (error) {
      console.error('图片生成失败', error);
      return { error: `图片生成失败: ${error.message}` };
    }
  }

  // 加载配置
  loadConfig() {
    const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
  }

  // 数组标准化
  normalizeArray(input) {
    if (Array.isArray(input)) return input;
    return typeof input === 'string' ? [input] : [];
  }

  // 构建图片消息
  async buildImageMessages(prompt, images) {
    const messages = [{ type: "text", text: "你必须至少生成一张高质量的图片:" + prompt }];

    for (const url of images) {
      if (!url) continue;
      const imgData = await getBase64Image(url, "other.png");

      if (imgData.includes("该图片链接已过期") || imgData.includes("无效的图片下载链接")) {
        throw new Error(imgData);
      }

      const mimeType = mimeTypes.lookup("other.png") || 'application/octet-stream';
      messages.push(mimeType.startsWith('image/')
        ? { type: "image_url", image_url: { url: imgData } }
        : { type: "file", file_url: { url: imgData } }
      );
    }
    return messages;
  }

  // 从模型返回的文本/URL 中提取图片地址（支持 Markdown 图片格式、base64 data URI、http 链接）
  extractImageUrl(content) {
    if (!content) return null;

    // 匹配 Markdown 图片格式: ![xxx](url)
    const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+|https?:\/\/[^)]+)\)/);
    if (mdMatch) {
      const url = mdMatch[1];
      if (url.startsWith('data:image')) {
        const base64Data = url.replace(/^data:image\/[^;]+;base64,/, '');
        return `base64://${base64Data}`;
      }
      return url;
    }

    // 匹配纯 base64 data URI
    const base64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (base64Match) {
      return `base64://${base64Match[1]}`;
    }

    // 匹配带扩展名的 http/https 链接
    const httpsMatch = content.match(/https?:\/\/[^\s)'"<>]+\.(png|jpg|jpeg|gif|webp|bmp)[^\s)'"<>]*/i);
    if (httpsMatch) {
      return httpsMatch[0];
    }

    // 匹配通用 http/https 链接
    const httpMatch = content.match(/https?:\/\/[^\s)'"<>]+/);
    if (httpMatch) {
      return httpMatch[0];
    }

    return null;
  }

  /**
   * 调用OneBotv11 API
   */
  async callApi(action, params = {}) {
    try {
      if (typeof Bot !== 'undefined' && Bot.sendApi) {
        return await Bot.sendApi(action, params);
      } else if (typeof global.bot !== 'undefined' && global.bot.sendApi) {
        return await global.bot.sendApi(action, params);
      } else {
        throw new Error('找不到OneBotv11 API调用接口');
      }
    } catch (error) {
      console.error(`调用API ${action} 失败:`, error);
      throw error;
    }
  }

  async getRKey(url) {
    // 检查URL是否包含rkey参数
    const rkeyMatch = url.match(/rkey=([^&]+)/);
    if (!rkeyMatch) return null;

    try {
      const response = await this.callApi('nc_get_rkey');
      if (response?.status === 'ok' && response?.data?.length >= 2) {
        // 取数组中第二个元素的rkey，去掉开头的"&rkey="
        const rkeyValue = response.data[1].rkey;
        return rkeyValue.replace(/^&rkey=/, '');
      }
    } catch (error) {
      console.error('获取rkey失败:', error);
    }

    // 如果接口调用失败，返回原始rkey
    return rkeyMatch[1];
  }

  // 处理图片URL（腾讯图床等）
  async processImageUrl(url) {
    if (!url?.includes('qq.com')) return url;

    const fid = url.match(/fileid=([^&]+)/)?.[1];
    const rkey = await this.getRKey(url);
    const host = url.slice(0, url.indexOf('&')) || url;

    if (fid && rkey && host) {
      for (let appid = 1408; appid >= 1403; appid--) {
        const newUrl = `${host}/download?appid=${appid}&fileid=${fid}&spec=0&rkey=${rkey}`;
        if (await this.isUrlAvailable(newUrl)) return newUrl;
      }
    }
    return url;
  }

  // 检查URL可用性
  async isUrlAvailable(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxRedirects: 5
      });

      if (response.headers['content-type']?.includes('application/json')) {
        const text = Buffer.from(response.data).toString();
        if (text.includes('retcode') || text.includes('error')) return false;
      }

      const header = [...Buffer.from(response.data).slice(0, 8)]
        .map(b => b.toString(16).padStart(2, '0').toUpperCase());

      const signatures = [
        ['FF', 'D8'],           // jpeg
        ['89', '50', '4E', '47'], // png
        ['47', '49', '46'],      // gif
        ['52', '49', '46', '46'], // webp
        ['42', '4D']            // bmp
      ];

      return signatures.some(sig => sig.every((b, i) => header[i] === b));
    } catch {
      return false;
    }
  }

  async getZaiKey() {
    const res = await fetch('http://localhost:9223/token');
    return (await res.json()).token || '';
  }
}
