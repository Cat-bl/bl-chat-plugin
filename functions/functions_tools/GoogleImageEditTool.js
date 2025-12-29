import { AbstractTool } from './AbstractTool.js';
import { getBase64Image } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";

const { mimeTypes } = dependencies;

export class GoogleImageEditTool extends AbstractTool {
    constructor() {
        super();
        this.name = 'googleImageEditTool';
        this.description = '使用Google Gemini处理用户的任意图片（或用户的群聊头像），支持编辑图片内容。当用户请求编辑图片/头像时调用此工具。';
        this.parameters = {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: '用户对图片的处理需求，例如"将图片转为黑白""把这张图的人物换一件衣服"'
                },
                images: {
                    type: 'array',
                    description: '用户提供的图片链接数组，需保留原始URL完整性。QQ头像格式："https://q1.qlogo.cn/g?b=qq&nk=用户QQ号&s=640"',
                    items: { type: 'string' }
                }
            },
            required: ['prompt', 'images'],
            additionalProperties: false
        };
    }

    async func(opts, e) {
        const STREAM = false;

        try {
            const config = this.loadConfig();
            const { prompt } = opts;

            // 处理图片URL
            const images = await Promise.all(
                this.normalizeArray(opts.images).map(url => this.processImageUrl(url))
            );

            if (!images.length) {
                return { error: '未检测到有效的图片链接' };
            }

            // 构建消息内容
            const content = await this.buildImageMessages(prompt, images);

            // 调用API
            const { imageEditApiUrl, imageEditApiKey, imageEditApiModel } = config.imageEditAiConfig || {};

            const response = await fetch(imageEditApiUrl || 'https://api.openai.com/v1/chat/completions', {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${imageEditApiKey || 'sk-xxxxxx'}`,
                },
                body: JSON.stringify({
                    model: imageEditApiModel || "gemini-3-pro-image-preview",
                    messages: [{ role: "user", content }],
                    stream: STREAM,
                }),
            });

            // 处理响应
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
            console.error('图片编辑失败:', error);
            return { error: `图片编辑失败: ${error.message}` };
        }
    }

    // ========== 工具方法 ==========

    loadConfig() {
        const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
        return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
    }

    normalizeArray(input) {
        if (Array.isArray(input)) return input;
        return typeof input === 'string' ? [input] : [];
    }

    async buildImageMessages(prompt, images) {
        const messages = [{ type: "text", text: prompt }];

        for (const url of images) {
            if (!url) continue;

            const imgData = await getBase64Image(url, "other.png");

            if (imgData.includes("该图片链接已过期")) {
                throw new Error("该图片下载链接已过期，请重新上传");
            }
            if (imgData.includes("无效的图片下载链接")) {
                throw new Error("无效的图片下载链接，请确保适配器支持且图片未过期");
            }

            const mimeType = mimeTypes.lookup("other.png") || 'application/octet-stream';
            messages.push(mimeType.startsWith('image/')
                ? { type: "image_url", image_url: { url: imgData } }
                : { type: "file", file_url: { url: imgData } }
            );
        }
        return messages;
    }

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

    async handleNormalResponse(response) {
        const data = await response.json();
        logger.error(JSON.stringify(data));

        const imageUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
            data?.choices?.[0]?.message?.images?.[0]?.url ||
            data?.choices?.[0]?.message?.content;

        if (!imageUrl) throw new Error("未接收到有效内容");
        return imageUrl;
    }

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

        // 匹配 https 链接
        const httpsMatch = content.match(/https?:\/\/[^\s)'"<>]+\.(png|jpg|jpeg|gif|webp|bmp)[^\s)'"<>]*/i);
        if (httpsMatch) {
            return httpsMatch[0];
        }

        return null;
    }

    // ========== 图片URL处理 ==========

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
                ['FF', 'D8'],             // jpeg
                ['89', '50', '4E', '47'], // png
                ['47', '49', '46'],       // gif
                ['52', '49', '46', '46'], // webp
                ['42', '4D']              // bmp
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
