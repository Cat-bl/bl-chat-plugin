import { AbstractTool } from "./AbstractTool.js"
import { getBase64Image } from "../../utils/fileUtils.js"
import { dependencies } from "../../dependence/dependencies.js"
const { mimeTypes } = dependencies

/**
 * 视频处理工具类，用于处理用户的视频相关请求
 */
export class VideoAnalysisTool extends AbstractTool {
  constructor() {
    super()
    this.name = "videoAnalysisTool"
    this.description =
      "进行视频分析, 当用户需要分析、处理、识别视频内容，比如说让你分析一下这个视频，或者看一下这视频，让你评价一下这个视频等时使用此工具，你不用考虑上下文中是否有视频链接，可以直接调用比工具，调用之后高数回自动获得视频链接，可提取视频中的文字信息并进行理解分析。"
    this.parameters = {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "用户的视频处理需求描述，如果为空则进行默认的视频分析",
        },
      },
      additionalProperties: false,
    }

    this.video = null

    //this.apiKey = ""
    this.apiKeys = [
      "a1eef00f6bce4a10a7de83936fce6492.0wDYtwPnWukoPxWj",
      "eb6e78fe1a7043feb275ab9b502fdabb.vWlqF16E7bngdKef",
    ]
  }

  async Video(prompt, video) {
    try {
      // 获取公共可访问的视频URL
      const publicUrl = await this.getVideoUrl(video)
      logger.info("最终使用的视频URL:", publicUrl)

      const apiUrl = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
      const apiKey = this.getNextApiKey()

      const requestData = {
        model: "glm-4.1v-thinking-flash", // glm-4.5v
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "video_url",
                video_url: { url: publicUrl }, // 使用公共URL
              },
            ],
          },
        ],
      }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestData),
      })

      return await response.json()
    } catch (error) {
      console.error("Video方法错误:", error)
      return { error: "视频处理失败: " + error.message }
    }
  }
  getNextApiKey() {
    const randomIndex = Math.floor(Math.random() * this.apiKeys.length)
    const apiKey = this.apiKeys[randomIndex]
    console.log("负载均衡-散列-使用API key:", apiKey)
    return apiKey
  }

  /**
   * 获取图片列表（包括消息和引用消息中的图片）
   * @param {object} e - 消息对象
   * @returns {Promise<Buffer[]>} - 返回图片 Buffer 数组
   */
  async getVideo(e) {
    const imagesInMessage = e.message.filter(m => m.type === "video").map(video => video.url)

    const tasks = []

    /**
     * 获取引用消息中的图片
     */
    let quotedImages = []
    let source = null
    if (e.reply_id) {
      source = await e.getReply()
    } else if (e.source) {
      if (e.isGroup) {
        source = await Bot[e.self_id]
          .pickGroup(e.group_id)
          .getChatHistory(e.source.seq || e.reply_id, 1)
      } else if (e.isPrivate) {
        source = await Bot[e.self_id]
          .pickFriend(e.user_id)
          .getChatHistory(e.source.time || e.reply_id, 1)
      }
    }

    if (source) {
      const sourceArray = Array.isArray(source) ? source : [source]

      quotedImages = sourceArray
        .flatMap(item => item.message)
        .filter(msg => msg.type === "video")
        .map(video => video.url)
    }

    /**
     * 如果没有引用消息中的图片，且消息中没有图片，则获取引用消息的发送者头像
     */
    if (
      quotedImages.length === 0 &&
      imagesInMessage.length === 0 &&
      source &&
      (e.source || e.reply_id)
    ) {
      const sourceArray = Array.isArray(source) ? source : [source]
      const quotedUser = sourceArray[0].sender.user_id
    }

    return quotedImages
  }

  /**
   * 上传视频到免费公共存储服务
   * @param {Buffer} buffer - 视频文件的Buffer数据
   * @returns {Promise<string>} - 返回公共可访问的视频URL
   */
  async uploadToFreeService(buffer) {
    try {
      const formData = new FormData()
      const blob = new Blob([buffer], { type: "video/mp4" })
      formData.append("file", blob, `video_${Date.now()}.mp4`)

      const response = await fetch("https://www.bigmodel.cn/api/biz/file/uploadTemporaryImage", {
        method: "POST",
        body: formData,
        headers: {
          authorization: `Bearer ${this.getNextApiKey()}`,
        },
      })

      const result = await response.json()
      return result.url
    } catch (error) {
      logger.error(`上传到 ${service} 失败: ${error.message}`)
    }
  }

  /**
   * 获取视频的公共URL
   * @param {string} video - 视频地址
   * @returns {Promise<string>} - 公共可访问的视频URL
   */
  async getVideoUrl(video) {
    if (!video) throw new Error("视频地址不能为空")

    try {
      // 尝试直接使用原始URL（如果已经被识别为视频）
      if (video.endsWith(".mp4")) {
        return video
      }

      // 下载视频并上传到公共存储
      const response = await fetch(video, {
        headers: {
          Referer: "https://www.qq.com/", // 绕过腾讯防盗链
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      })

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      return await this.uploadToFreeService(buffer)
    } catch (error) {
      logger.error("获取视频URL失败:", error)
      throw new Error("视频处理失败，请稍后再试")
    }
  }

  async func(opts, e) {
    logger.error("调用了视频识别工具:", 6666)
    try {
      let text = e.msg || null
      let video = null

      const images = await this.getVideo(e)
      if (e.video && e.video.length > 0) {
        video = e.video[0] || images[0]
      } else {
        video = images[0]
      }
      if (!video) return { error: `视频分析失败: 没有找到视频链接` }
      let prompt = text
      let res = await this.Video(prompt, video)

      if (res.choices) {
        return {
          analysis: res.choices[0]?.message.content,
        }
      } else {
        return {
          error: "识别失败,可能是含有违规内容",
        }
      }
    } catch (error) {
      console.error("视频分析过程发生错误:", error)
      return { error: `视频分析失败: ${error.message}` }
    }
  }
}
