import { AbstractTool } from './AbstractTool.js';
import { getBase64Image } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";

const { mimeTypes } = dependencies;

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
    const STREAM = false;
    const config = this.loadConfig();
    const { prompt, images: rawImages } = opts;

    if (!prompt) return "错误：绘图提示词（prompt）不能为空。";

    // 处理图片
    const images = await Promise.all(
      this.normalizeArray(rawImages).map(url => this.processImageUrl(url))
    );
    const imgurls = await this.buildImageMessages(prompt, images);

    try {
      const { imageEditApiUrl: apiUrl, imageEditApiKey: apiKey, imageEditApiModel: model } =
        config.imageEditAiConfig || {};

      const response = await fetch(apiUrl || 'https://api.openai.com/v1/chat/completions', {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || 'sk-xxxxxx'}`,
        },
        body: JSON.stringify({
          model: model || "gemini-3-pro-image-preview",
          messages: [{ role: "user", content: imgurls }],
          stream: STREAM,
        }),
      });

      const imageUrl = STREAM
        ? await this.handleStreamResponse(response)
        : await this.handleNormalResponse(response);

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
    const configPath = path.join(process.cwd(), 'plugins/test-plugin/config/message.yaml');
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

  // 处理流式响应
  async handleStreamResponse(response) {
    if (!response.ok || !response.body) {
      throw new Error(`API请求失败: ${response.statusText}`);
    }

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

  // 处理普通响应
  async handleNormalResponse(response) {
    const data = await response.json();
    return data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
      data?.choices?.[0]?.message?.images?.[0]?.url ||
      data?.choices?.[0]?.message?.content;
  }

  // 提取图片URL
  extractImageUrl(imageUrl) {
    if (!imageUrl) return null;

    if (imageUrl.includes("base64")) {
      const base64Data = imageUrl.split("[image1]")[1] || imageUrl.split("[image]")[1];
      const trueBase64 = base64Data?.split(",")[1] || imageUrl.replace(/^data:image\/\w+;base64,/, "");
      return `base64://${trueBase64}`;
    }

    if (imageUrl.includes("https")) {
      const segment = imageUrl.split("[image1]")[1] || imageUrl.split("[image]")[1];
      return segment?.match(/https?:\/\/[^\s)'"]+/)?.[0];
    }

    return null;
  }

  // 处理图片URL（腾讯图床等）
  async processImageUrl(url) {
    if (!url?.includes('qq.com')) return url;

    const fid = url.match(/fileid=([^&]+)/)?.[1];
    const rkey = url.match(/rkey=([^&]+)/)?.[1];
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
