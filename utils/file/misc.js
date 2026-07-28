// 杂项工具：地址解析、图片消息发送、长消息分段。
// 从 fileUtils.js 拆出（行为等价搬迁）。
import _ from "lodash";
import path from "path";
import crypto from 'crypto';
import common from '../../../../lib/common/common.js';
import { downloadImage } from "./download.js";

const _path = process.cwd()

/**
 * 获取链接内容的 SHA256 哈希值
 * @param {string} url - 链接地址
 * @returns {Promise<string|null>} - 内容的哈希值，失败时返回 null
 */
async function getContentHash(url) {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const hash = crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    return hash;
  } catch (error) {
    console.error(`获取 ${url} 内容失败:`, error);
    return null;
  }
}

/**
 * 解析文本中的各种格式链接并按进度百分比排序，同时基于内容去重
 * @param {string} inputString - 需要解析的输入字符串
 * @returns {Promise<Array>} - 按进度排序的去重链接数组
 */
export async function get_address(inputString) {
  // 支持的域名正则表达式
  const supportedDomains = [
    `filesystem\\.site\/cdn\/\\d{8}\/[a-zA-Z0-9\\-]+?\\.[a-z]{2,4}`,
    `yuanpluss\\.online:\\d+\/files\/[a-zA-Z0-9_\\/\\-]+?\\.[a-z]{2,4}`,
    `openai\\.yuanplus\\.chat\/files\/[a-zA-Z0-9_\\/\\-]+?\\.[a-z]{2,4}`,
    `fal\\.media\/files\/[\\s\\S]*`,
    `(?:\\.fal\\.media|\\.fal-prod\\.media)\/files\/[\\s\\S]*`,
    `[a-zA-Z0-9\\-]*(?:\\.[a-zA-Z0-9\\-]+)*\\.fal\\.media\/files\/[\\s\\S]*`,
    `[a-zA-Z0-9\\-]*(?:\\.[a-zA-Z0-9\\-]+)*\\.fal-prod\\.media\/files\/[\\s\\S]*`,
    `fal\\.media\/[\\s\\S]*`,
    `sfile\\.chatglm\\.cn\/(?:[a-zA-Z0-9_\\-]+(?:-[a-zA-Z0-9_]+)*\\/)*[a-zA-Z0-9_\\-]+(?:-[a-zA-Z0-9_]+)*\\.[a-z]{2,4}`,
    `[a-zA-Z0-9\\-]+(?:\\.[a-zA-Z0-9\\-]+)*\\.oaiusercontent\\.[a-zA-Z0-9\\-.]+/files/[a-zA-Z0-9\\-/]+(?:\\?.*)?`,
    `[a-zA-Z0-9_\\-.]+\\.byteimg\\.com/[^/]+/[^~]+~tplv-[a-zA-Z0-9_\\-:.]*\\.[a-z]{2,6}(?:\\?.*)?`,
    `[a-zA-Z0-9_\\-.]+\\.vlabvod\\.com(?:/[^?#]+)?(?:\\?.*)?`,
    `[a-zA-Z0-9\\-.]+\\.filesystem\\.site\/files\/[a-zA-Z0-9\\-]+(?:\/[a-zA-Z0-9\\-]+)*(?:\\?.*)?`,
    `[a-zA-Z0-9\\-]+(?:\\.[a-zA-Z0-9\\-]+)*\\.zaiwen\\.top/images/[a-zA-Z0-9\\-]+\\.[a-z]{2,4}(?:\\?.*)?`,
    `[a-zA-Z0-9\\-]+\\.s3(?:-[a-z0-9\\-]+)?\\.amazonaws\\.com/[a-zA-Z0-9\\-./]+\\.[a-z]{2,4}(?:\\?.*)?`,
    `[a-zA-Z0-9_\\-.]+\\.hf\\.space/gradio_api/file=[^?#]+\\.[a-zA-Z0-9]{2,6}(?:\\?.*)?`,
    `[a-zA-Z0-9_\\-.]+\\.hf\\.space/file=[^?#]+\\.[a-zA-Z0-9]{2,6}(?:\\?.*)?`,
    `[a-zA-Z0-9\\-]+(?:\\.[a-zA-Z0-9\\-]+)*\\.myqcloud\\.com(?:/[a-zA-Z0-9\\-_/]+)*\\.[a-z]{2,4}(?:\\?.*)?`,
    `[a-zA-Z0-9\\-]+\\.liblib\\.cloud(?:/[a-zA-Z0-9_\\-]+)*(?:/[a-zA-Z0-9_\\-]+)*\\.[a-z]{2,6}(?:\\?.*)?`,
    `[a-zA-Z0-9\\-_]+\\.s3(?:-[a-z0-9\\-]+)?\\.amazonaws\\.com/[^?]+\\.[a-zA-Z0-9]{2,6}(?:\\?[^\\s]*)?`,
    `[a-zA-Z0-9\\-]+(?:-[a-zA-Z0-9]+)*\\.oss-[a-z0-9\\-]+\\.aliyuncs\\.com/[a-zA-Z0-9\\-_/]+\\.[a-zA-Z0-9]{2,6}(?:\\?.*)?`,
    `[a-zA-Z0-9\\-]+\\.cloudfront\\.net/text_to_image_output/[a-zA-Z0-9\\-]+\\.[a-z]{2,4}(?:\\?.*)?`
  ].join('|');

  // 定义链接模式及其对应的进度提取规则
  const patterns = [
    {
      regex: `>[\\s]*\\[进度\\s*(\\d+)%\\]\\((https:\\/\\/(${supportedDomains}))\\)`,
      progressGroup: 1,
      linkGroup: 2
    },
    {
      regex: `(?:!?\\[([^进度\\]]*?)\\]\\((https:\\/\\/(${supportedDomains}))\\))`,
      progressGroup: null,
      linkGroup: 2
    },
    {
      regex: `[\\p{Emoji}\\s]*\\[([^进度\\]]*?)\\]\\((https:\\/\\/(${supportedDomains}))\\)`,
      progressGroup: null,
      linkGroup: 2
    }
  ];

  // 提取并存储链接数据
  const linkData = [];
  const seenLinks = new Set();

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex, 'gu');
    let match;
    while ((match = regex.exec(inputString)) !== null) {
      const link = match[pattern.linkGroup];
      if (!seenLinks.has(link)) {
        seenLinks.add(link);
        const progress = pattern.progressGroup !== null
          ? parseInt(match[pattern.progressGroup])
          : null;
        linkData.push({ link, progress, originalText: match[0] });
      }
    }
  }

  // 如果数组长度小于 2，直接返回
  if (linkData.length < 2) {
    const sortedLinks = linkData.map(item => item.link);
    console.log('链接数量少于 2，无需处理:', linkData);
    return sortedLinks;
  }

  // 使用 Promise.all 进行内容去重
  const contentHashMap = new Map();
  const hashPromises = linkData.map(async (item) => {
    const hash = await getContentHash(item.link);
    if (hash) contentHashMap.set(item.link, hash);
    return { ...item, hash }; // 添加哈希值到每个项
  });

  const hashedLinkData = await Promise.all(hashPromises);

  // 基于内容去重
  const uniqueLinkData = [];
  const seenHashes = new Set();

  for (const item of hashedLinkData) {
    const hash = item.hash;
    if (hash && !seenHashes.has(hash)) {
      seenHashes.add(hash);
      uniqueLinkData.push({ link: item.link, progress: item.progress, originalText: item.originalText });
    } else if (!hash) {
      // 如果获取哈希失败，保留该链接
      uniqueLinkData.push({ link: item.link, progress: item.progress, originalText: item.originalText });
    }
  }

  // 按进度排序
  uniqueLinkData.sort((a, b) => {
    if (a.progress !== null && b.progress !== null) return a.progress - b.progress;
    if (a.progress !== null) return -1;
    if (b.progress !== null) return 1;
    return 0;
  });

  // 提取排序后的链接数组
  const sortedLinks = uniqueLinkData.map(item => item.link);

  // 输出调试信息
  console.log('解析并排序后的链接数据（内容去重后）:', uniqueLinkData);
  console.log('最终链接数组:', sortedLinks);

  return sortedLinks;
}

export async function getResponse(messages, model, services) {
  for (const service of services) {
    try {
      const result = await Promise.race([
        service(messages, model),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("请求超时")), 360000)
        ),
      ]);
      if (result) {
        console.log(`${service.name} 调用成功`);
        return result;
      }
    } catch (error) {
      console.error(`${service.name} 调用失败：${error.message}`);
    }
  }
  console.error("所有服务都调用失败");
  return null;
}

/**
* 处理图片下载并发送
* @param {object} e - 事件对象 (假设包含 reply 方法和 segment 对象)
* @param {string[]} urls - 图片 URL 数组
* @param {string} _path - 基础路径 (用于构建保存目录)
* @returns {Promise<string[]>} - 处理结果字符串数组
*/
export async function handleImages(e, urls, _path) {
  // 如果没有 URLs，直接返回
  if (!urls || urls.length === 0) {
    return ['未提供图片 URL'];
  }

  const saveDir = path.join(_path, 'resources', 'downloaded_images'); // 统一的保存目录
  const downloadTimeout = 40000; // 下载超时时间 (毫秒)

  // 并行下载所有图片
  const downloadPromises = urls.map(async (url, index) => {
    // 为每个下载任务生成一个基础文件名前缀
    const baseNamePrefix = `image_${index}`;
    // 调用优化后的 downloadImage 函数
    return downloadImage(url, saveDir, baseNamePrefix, downloadTimeout);
  });

  try {
    // 等待所有下载完成
    const results = await Promise.all(downloadPromises);

    // 初始化结果数组，用于返回给用户或日志
    const processResults = ['概况:'];

    // 收集成功下载的图片路径，用于发送
    const successfulSegments = [];

    // 遍历处理结果
    results.forEach(result => {
      if (result.success) {
        // 如果下载成功，添加到成功列表和消息段列表
        processResults.push(`✅ 成功下载: ${result.filePath}`);
        try {
          // 确保 segment 对象可用
          if (e && typeof e.reply === 'function' && typeof segment !== 'undefined' && typeof segment.image === 'function') {
            successfulSegments.push(segment.image(`file://${result.filePath}`)); // 使用 file:// 协议或直接路径，取决于你的框架
          } else {
            processResults.push(`⚠️ 警告: 无法创建图片消息段，可能缺少 'segment' 或 'e.reply'`);
          }
        } catch (segmentError) {
          console.error(`创建图片消息段失败: ${result.filePath}`, segmentError);
          processResults.push(`❌ 创建图片消息段失败: ${result.filePath} (错误: ${segmentError.message})`);
        }

      } else {
        // 如果下载失败，记录失败信息
        processResults.push(`❌ 下载失败: ${result.url} (错误: ${result.error || '未知错误'})`);
      }
    });

    // 如果有成功下载的图片，尝试发送
    if (successfulSegments.length > 0) {
      try {
        // 假设 e.reply 方法用于回复消息，可以接受一个消息段数组
        if (e && typeof e.reply === 'function') {
          await e.reply(successfulSegments);
          processResults.push(`➡️ 已发送 ${successfulSegments.length} 张图片。`);
        } else {
          processResults.push(`⚠️ 警告: 无法发送图片，事件对象 'e' 或其 'reply' 方法无效。`);
        }
      } catch (replyError) {
        console.error('发送图片消息失败:', replyError);
        processResults.push(`❌ 发送图片消息失败: ${replyError.message}`);
      }
    } else {
      processResults.push(`ℹ️ 没有成功下载的图片可供发送。`);
    }

    // 返回处理结果字符串数组
    return processResults;

  } catch (error) {
    // 捕获 Promise.all 或其他同步错误
    console.error('处理图片下载时发生错误:', error);
    // 返回包含错误信息的处理结果
    return ['图片处理时发生意外错误:', `❌ 错误: ${error.message}`];
  }
}

/**
* 将长文本消息分段添加到转发消息数组
* @param {Object} e 事件对象
* @param {String|Array} messages 要发送的消息
* @param {Number} maxLength 单段最大长度，默认1000字符
*/
export async function sendLongMessage(e, messages, forwardMsg, maxLength = 1000) {
  // 如果是字符串，转换为数组处理
  const msgArray = typeof messages === 'string' ? [messages] : messages;

  try {
    // 先尝试直接将所有消息添加到转发消息中
    const directForwardMsg = [...forwardMsg];
    msgArray.forEach(msg => directForwardMsg.push(msg));

    // 尝试一次性发送所有消息
    const jsonPart = await common.makeForwardMsg(e, directForwardMsg, 'Preview');
    await e.reply(jsonPart);
    logger.info('消息已成功一次性发送');

  } catch (error) {
    logger.warn(`一次性发送失败，将尝试分段发送: ${error.message}`);

    try {
      // 创建新的转发消息数组
      const segmentedForwardMsg = [...forwardMsg];

      // 对每条消息进行处理
      for (let msg of msgArray) {
        if (typeof msg === 'string' && msg.length > maxLength) {
          // 计算需要分成几段
          const segmentCount = Math.ceil(msg.length / maxLength);
          logger.info(`消息长度为${msg.length}，将分为${segmentCount}段发送`);

          // 分段处理文本
          for (let i = 0; i < segmentCount; i++) {
            const start = i * maxLength;
            const end = Math.min(start + maxLength, msg.length);
            const segment = msg.substring(start, end);

            if (segment.trim()) {
              segmentedForwardMsg.push(segment);
            }
          }
        } else {
          segmentedForwardMsg.push(msg);
        }
      }

      // 生成转发消息并发送
      const jsonPart = await common.makeForwardMsg(e, segmentedForwardMsg, 'Preview');
      await e.reply(jsonPart);
      logger.info('消息已成功分段发送');

    } catch (secondError) {
      logger.error(`分段发送也失败了: ${secondError.message}`);
      await e.reply('消息发送失败，请稍后重试');
    }
  }
}
