import { AbstractTool } from './AbstractTool.js';
import { get_address, getBase64Image } from '../../utils/fileUtils.js';
import { dependencies } from "../../dependence/dependencies.js";
const { mimeTypes } = dependencies;

/**
* 多模型AI绘图工具类
*/
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
          description: '用户提供的任意图片链接数组。必须保留原始URL完整性，包括所有查询参数。对于QQ头像，需要拼接反馈标准化链接如"https://q1.qlogo.cn/g?b=qq&nk=用户QQ号&s=640"。示例：\n' +
            '1. "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhSpon0PNM0ysZkSasHTTFhNhPkn2xiM9ogCIP8KKPTzyfGXgYsDMgRwcm9kUIC9owFaELWsiGLkylkWILRwFGxE3cQ&spec=0&rkey=CAQSOAB6JWENi5LM1F9SWC-_lnNTz6V9r7O2ev3HX_QmYpr_odrwSXfUpXfNIyIowntqLF3KoE8inPMs"\n' +
            '2. "https://gchat.qpic.cn/gchatpic_new/2119611465/782312429-2903731874-87B79F5B839EA2F3AD0AD48DD539D946/0?term=2&is_origin=0"' +
            '3. "https://q1.qlogo.cn/g?b=qq&nk=116789034&s=640"',
          items: {
            type: 'string',
            description: '完整的图片URL，必须与用户输入一致'
          }
        }
      },
      required: ['prompt'],
      additionalProperties: false
    };
  }

  /**
   * 执行绘图操作
   */
  async func(opts, e) {
    const STREAM = false
    const { prompt } = opts;
    let imageUrls = [];

    if (!prompt) {
      return "错误：绘图提示词（prompt）不能为空。";
    }

    // 确保 opts.images 是数组并处理每个URL
    const rawImages = Array.isArray(opts.images) ? opts.images :
      typeof opts.images === 'string' ? [opts.images] : [];

    // 处理所有图片URL
    const images = await Promise.all(
      rawImages.map(url => this.processImageUrl(url))
    );

    // 构建图片分析消息
    let imgurls = [{
      "type": "text",
      "text": "你必须至少生成一张高质量的图片:" + prompt
    }];

    // 处理每张图片
    for (let url of images) {
      const filetypes = "other.png";
      const img_urls = await getBase64Image(url, filetypes);

      if (img_urls.includes("该图片链接已过期")) {
        return { error: "该图片下载链接已过期，请重新上传" };
      }
      if (img_urls.includes("无效的图片下载链接")) {
        return { error: "无效的图片下载链接，请确保适配器支持且图片未过期" };
      }

      const mimeType = mimeTypes.lookup(filetypes) || 'application/octet-stream';
      const isImage = mimeType.startsWith('image/');

      imgurls.push(isImage ? {
        "type": "image_url",
        "image_url": { url: img_urls }
      } : {
        "type": "file",
        "file_url": { url: img_urls }
      });
    }


    try {
      const apiUrl = 'https://api.lhyb.dpdns.org/v1/chat/completions'
      const apiKey = 'sk-jDOxqRDt0iZKgi313OiyrGsZjQTo19Qkr6sYoVyy6pdrZ2US'
      //  const apiKey = await this.getZaiKey()
      const history = [{ role: "user", content: imgurls }];
      const requestData = {
        model: "gemini-3-pro-image-preview",
        // image_size: "1K",
        messages: history,
        stream: STREAM,
      }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestData),
      })

      if (STREAM) {
        if (!response.ok || !response.body) {
          throw new Error(`API请求失败: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedContent = "";
        let imageUrl = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          // 处理 SSE 格式的数据
          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataStr = line.slice(6).trim(); // 移除 "data: " 前缀
              if (dataStr === "[DONE]") break; // 结束信号

              try {
                const data = JSON.parse(dataStr);
                // 提取内容片段
                if (data?.choices?.[0]?.delta?.content) {
                  accumulatedContent += data.choices[0].delta.content;
                }
              } catch (error) {
                console.error("解析数据片段失败:", error, "数据:", dataStr);
              }
            }
          }
        }

        // 处理累积的完整内容
        if (!accumulatedContent) {
          throw new Error("未接收到有效内容");
        }

        // 尝试从累积内容中提取图片数据
        imageUrl = accumulatedContent;
        let processedImageUrl
        if (imageUrl.includes("base64")) {
          const base64Data = imageUrl.split("[image]")[1];
          const trueBase64Data = base64Data.split(",")[1];
          //  logger.error(base64Data)
          processedImageUrl = `base64://${trueBase64Data}`; // 只取纯base64部分
        } else if (imageUrl.includes("https")) {
          const base64Data = imageUrl.split("[image1]")[1] || imageUrl.split("![Generated Image]")[1];
          const trueBase64Data = base64Data.match(/https?:\/\/[^\s)'"]+/)[0]
          processedImageUrl = trueBase64Data; // 只取纯https部分
        }
        if (processedImageUrl) {
          await e.reply([segment.image(processedImageUrl)]);
          return '图片编辑成功';
        }
        return { error: `图片编辑失败` };
      } else {
        const data = await response.json()
        // 更健壮的图片数据提取逻辑
        let imageUrl = null
        // 检查多种可能的图片数据路径
        imageUrl =
          data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
          data?.choices?.[0]?.message?.images?.[0]?.url ||
          data?.choices?.[0]?.message?.content;


        let processedImageUrl
        if (imageUrl.includes("base64")) {
          const base64Data = imageUrl.split("[image]")[1];
          const trueBase64Data = base64Data.split(",")[1];
          processedImageUrl = `base64://${trueBase64Data}`; // 只取纯base64部分
        } else if (imageUrl.includes("https")) {
          const base64Data = imageUrl.split("[image1]")[1] || imageUrl.split("[image]")[1];
          const trueBase64Data = base64Data.match(/https?:\/\/[^\s)'"]+/)[0]
          processedImageUrl = trueBase64Data; // 只取纯https部分
        }

        if (processedImageUrl) {
          await e.reply([segment.image(processedImageUrl)]);
          return '图片编辑成功';

        }
        return { error: `图片编辑失败` };
      }

    } catch (error) {
      console.error('图片生成失败', error);
      return { error: `图片生成失败: ${error.message}` };
    }
  }

  async processImageUrl(url) {
    if (!url) return null;

    // 处理腾讯图床链接
    if (url.includes('qq.com')) {
      const fid = url.match(/fileid=([^&]+)/)?.[1];
      const rkey = await this.getRKey(url);
      const host = await this.extractDomain(url);

      if (fid && rkey && host) {
        // 尝试不同的 appid
        for (let appid = 1408; appid >= 1403; appid--) {
          const newUrl = `${host}/download?appid=${appid}&fileid=${fid}&spec=0&rkey=${rkey}`;
          if (await this.isUrlAvailable(newUrl)) {
            return newUrl;
          }
        }
      }
    }

    return url;
  }

  getRKey(url) {
    const rkeyMatch = url.match(/rkey=([^&]+)/);
    return rkeyMatch ? rkeyMatch[1] : null;
  }

  extractDomain(url) {
    const ampIndex = url.indexOf('&');
    return ampIndex !== -1 ? url.slice(0, ampIndex) : url;
  }

  async isUrlAvailable(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxRedirects: 5
      });

      const contentType = response.headers['content-type'];

      if (contentType?.includes('application/json')) {
        const text = Buffer.from(response.data).toString();
        if (text.includes('retcode') || text.includes('error')) {
          return false;
        }
      }

      const buffer = Buffer.from(response.data);

      const imageSignatures = {
        jpeg: ['FF', 'D8'],
        png: ['89', '50', '4E', '47'],
        gif: ['47', '49', '46'],
        webp: ['52', '49', '46', '46'],
        bmp: ['42', '4D']
      };

      const fileHeader = [...buffer.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0').toUpperCase());

      return Object.values(imageSignatures).some(signature =>
        signature.every((byte, index) => fileHeader[index] === byte)
      );

    } catch (error) {
      //console.error('URL检查失败:', error.message);
      return false;
    }
  }

  async getZaiKey() {
    const res = await fetch('http://localhost:9223/token')
    const data = await res.json()
    return data.token || ''
  }
}