import { AbstractTool } from './AbstractTool.js';
import { getBase64Image, normalizeImageUrls } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
import { callAI } from "../../utils/apiClient.js";
import {
    resolveImageEndpoint,
    callImageGenApi,
    extractImageUrl,
} from '../../utils/api/imageGeneration.js';
import fs from "fs";
import YAML from "yaml";
import path from "path";

const { mimeTypes, axios } = dependencies;

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
        try {
            const config = this.loadConfig();
            const { prompt } = opts;
            const { imageEditApiUrl, imageEditApiKey, imageEditApiModel } = config.imageEditAiConfig || {};
            const apiUrl = imageEditApiUrl || 'https://api.openai.com/v1/chat/completions';
            const apiModel = imageEditApiModel || "gemini-3-pro-image-preview";
            const apiKey = imageEditApiKey || 'sk-xxxxxx';

            // 处理图片URL
            const images = await normalizeImageUrls(this.normalizeArray(opts.images));

            if (!images.length) {
                return { error: '未检测到有效的图片链接' };
            }

            const endpoint = resolveImageEndpoint(apiUrl, true);
            let processedUrl;

            if (endpoint.type === 'chat') {
                // chat/completions 模式：多模态 messages 走 callAI（保持原行为）
                const content = await this.buildImageMessages(prompt, images);
                const result = await callAI(
                    { url: apiUrl, model: apiModel, apikey: apiKey },
                    [{ role: "user", content }],
                    { stream: false }
                );

                if (result.error) {
                    return { error: `图片编辑失败: ${result.error}` };
                }

                // 兼容两种响应格式：
                // 1. images 数组（部分模型如 Gemini 把图片放在 message.images 里）
                // 2. content 字符串（Markdown 图片或 base64 data URI）
                const msg = result?.choices?.[0]?.message || {}
                const imageUrl = msg.images?.[0]?.image_url?.url ||
                    msg.images?.[0]?.url ||
                    msg.content || ''

                processedUrl = extractImageUrl(imageUrl);
            } else {
                // responses / images(edits) 模式
                processedUrl = await callImageGenApi(endpoint, prompt, images, apiModel, apiKey);
            }

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

    // ========== 图片URL处理 ==========

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

        // NapCat 的 nc_get_rkey 返回数组（data[1] 为群聊 rkey，带 &rkey= 前缀）；
        // LLBot(LuckyLilliaBot) 的 get_rkey 返回 { private_key, group_key }。
        // 记住可用名（工具实例为注册器单例）；缓存仅决定尝试顺序，失败仍回退
        for (const action of [...new Set([this.rkeyAction, 'nc_get_rkey', 'get_rkey'])].filter(Boolean)) {
            try {
                const response = await this.callApi(action);
                const data = response?.data ?? response;
                const value = Array.isArray(data) ? data[1]?.rkey : data?.group_key;
                if (value) {
                    this.rkeyAction = action;
                    return String(value).replace(/^&?rkey=/, '');
                }
            } catch (error) {
                console.error(`获取rkey失败(${action}):`, error);
            }
        }

        // 如果接口调用失败，返回原始rkey
        return rkeyMatch[1];
    }

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
