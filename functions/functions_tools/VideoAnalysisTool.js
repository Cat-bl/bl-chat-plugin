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
      "视频分析工具。当用户需要分析、解读、评价、识别视频内容时调用，例如：『分析一下这个视频』『这视频讲什么』『评价一下』。" +
      "支持两种来源：(1)当前消息中直接附带的视频；(2)引用消息（回复某条视频）中的视频。" +
      "你不需要在参数里传视频链接，工具会自动从当前消息或引用消息中提取，提取不到会返回错误。"
    this.parameters = {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "用户的视频分析诉求描述。例如：『总结视频内容』『提取视频里的文字』『判断视频是否搞笑』。如果为空则做默认的视频内容分析。",
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
   * 从消息或引用消息中提取视频 URL
   * 兼容多种字段（NapCat/ICQQ 的字段名不一致）：url / file_url / data.url / data.file_url / file / data.file
   * @param {object} e - 消息对象
   * @returns {Promise<string[]>} - 视频 URL 数组
   */
  async getVideo(e) {
    const pickVideoUrl = v => v?.url || v?.file_url || v?.data?.url || v?.data?.file_url || v?.file || v?.data?.file

    // 1. 当前消息里的视频
    const videosInMessage = (e.message || [])
      .filter(m => m?.type === "video")
      .map(pickVideoUrl)
      .filter(Boolean)

    // 2. 引用消息里的视频（兼容 e.reply_id / e.source / e.reply 三种来源）
    let quotedVideos = []
    let source = null
    try {
      if (typeof e.getReply === "function") {
        source = await e.getReply()
      } else if (e.source && e.isGroup) {
        source = await Bot[e.self_id]
          ?.pickGroup(e.group_id)
          ?.getChatHistory(e.source.seq || e.reply_id, 1)
      } else if (e.source && e.isPrivate) {
        source = await Bot[e.self_id]
          ?.pickFriend(e.user_id)
          ?.getChatHistory(e.source.time || e.reply_id, 1)
      }
    } catch (err) {
      logger.debug?.(`[VideoAnalysisTool] 获取引用源失败: ${err?.message}`)
    }

    if (source) {
      const sourceArray = Array.isArray(source) ? source : [source]
      quotedVideos = sourceArray
        .flatMap(item => item?.message || [])
        .filter(m => m?.type === "video")
        .map(pickVideoUrl)
        .filter(Boolean)
    }

    // 优先用当前消息中的视频，没有再用引用消息中的
    return [...videosInMessage, ...quotedVideos]
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
      logger.error(`上传失败: ${error.message}`)
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
    try {
      const videos = await this.getVideo(e)
      const video = videos[0]
      if (!video) {
        return { error: "视频分析失败: 当前消息和引用消息里都没找到视频" }
      }
      const prompt = (opts?.prompt || e.msg || "请分析这个视频内容").toString().trim() || "请分析这个视频内容"
      const res = await this.Video(prompt, video)

      if (res?.choices) {
        return { analysis: res.choices[0]?.message?.content }
      }
      return { error: "识别失败,可能是含有违规内容" }
    } catch (error) {
      logger.error?.("[VideoAnalysisTool] 分析过程异常:", error)
      return { error: `视频分析失败: ${error.message}` }
    }
  }
}
