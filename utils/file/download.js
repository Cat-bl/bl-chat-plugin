// 文件下载/上传与 base64 转换。从 fileUtils.js 拆出（行为等价搬迁）。
import axios from "axios";
import _ from "lodash";
import mimeTypes from 'mime-types';
import fs from "fs";
import path from "path";
import { refreshTencentImageUrl } from "./tencentImage.js";

const _path = process.cwd()
const validImageExtensions = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg'];

/**
* 检查是否是有效的图片格式
* @param {Buffer} buffer - 文件buffer
* @returns {boolean} - 是否为有效图片
*/
function isBufferImage(buffer) {
  const imageSignatures = {
    jpeg: ['FF', 'D8'],
    png: ['89', '50', '4E', '47'],
    gif: ['47', '49', '46'],
    webp: ['52', '49', '46', '46'],
    bmp: ['42', '4D']
  };

  const fileHeader = [...buffer.slice(0, 8)].map(byte =>
    byte.toString(16).padStart(2, '0').toUpperCase()
  );

  return Object.values(imageSignatures).some(signature =>
    signature.every((byte, index) => fileHeader[index] === byte)
  );
}

/**
 * 获取文件扩展名
 * @param {string} url - 文件URL
 * @returns {Promise<string>} - 文件扩展名
 */
export async function getFileExtensionFromUrl(url) {
  try {
    const response = await axios.head(url);
    const contentType = response.headers['content-type'];
    const extension = mimeTypes.extensions[contentType.split(';')[0]];
    return extension ? `.${extension[0]}` : '无法识别的文件类型';
  } catch (error) {
    console.error('获取文件扩展名失败:', error.message);
    return '无法识别的文件类型';
  }
}

/**
 * 下载文件，根据 Content-Type 或 URL/文件名确定扩展名，保存文件，并根据类型发送。
 * @param {string} url - 文件 URL
 * @param {string} [originalFileName] - 可选的原始文件名参数，作为命名的参考
 * @param {object} e - 消息事件对象，用于发送文件 (假设包含 group_id, group, friend 属性)
 * @returns {Promise<{success: boolean, filePath?: string, fileName?: string, error?: string}>} - 返回操作结果
 */
export async function downloadAndSaveFile(url, originalFileName, e) {
  try {
    // 1. 发起 fetch 请求并获取响应
    const response = await fetch(url.trim());

    // 检查响应状态是否成功
    if (!response.ok) {
      throw new Error(`下载文件失败：${url}，状态：${response.status} ${response.statusText}`);
    }

    // 获取文件数据
    const fileBuffer = await response.arrayBuffer();

    // 2. 确定文件扩展名 (优先级: Content-Type (通过 mime-types) -> URL Path -> originalFileName -> Default)
    let fileExtension = '.unknown'; // 默认未知扩展名

    // 尝试从 Content-Type header 获取扩展名 (最可靠，使用 mime-types)
    const contentType = response.headers.get('content-type');
    if (contentType) {
      const mimeExt = mimeTypes.extension(contentType.split(';')[0].trim());
      if (mimeExt) {
        fileExtension = `.${mimeExt}`; // mime-types 返回不带点的扩展名，需要加上点
      }
    }

    // 如果 Content-Type 没有提供明确的扩展名，尝试从 URL 路径获取
    // 只有当 Content-Type 没有给出有效扩展名时才尝试 URL
    if (fileExtension === '.unknown') {
      const cleanUrl = url.split('?')[0]; // 移除查询字符串
      const urlExt = path.extname(cleanUrl);
      // 确保获取到的扩展名不是空的或者只有 '.'
      if (urlExt && urlExt.length > 1) {
        fileExtension = urlExt;
      }
    }

    // 作为最后的备选，如果 Content-Type 和 URL 都没能确定扩展名，
    // 尝试从提供的 originalFileName 参数获取 (可靠性最低)
    // 只有当 Content-Type 和 URL 都失败，并且 originalFileName 提供了才尝试
    if (fileExtension === '.unknown' && originalFileName) {
      const cleanOriginalFileName = originalFileName.split('?')[0]; // 移除查询字符串
      const originalExt = path.extname(cleanOriginalFileName);
      if (originalExt && originalExt.length > 1) {
        fileExtension = originalExt;
      }
    }

    // 如果经过所有尝试仍然是未知类型，给一个通用的默认值 .bin
    if (fileExtension === '.unknown') {
      console.warn(`无法判断文件扩展名：${url}，使用 .bin`);
      fileExtension = '.bin';
    }


    // 3. 生成最终的文件名
    const timestamp = new Date().getTime();
    let baseName = 'downloaded_file'; // 默认的基础文件名

    // 优先使用 originalFileName 的基础名
    if (originalFileName) {
      const cleanOriginalFileName = originalFileName.split('?')[0];
      // 获取不带扩展名的文件名部分
      const nameWithoutExt = path.basename(cleanOriginalFileName, path.extname(cleanOriginalFileName));
      // 如果获取到的基础名不是空的，就使用它
      if (nameWithoutExt) {
        baseName = nameWithoutExt;
      } else {
        // 如果 originalFileName 清理后只剩下扩展名或为空，则使用默认基础名
        baseName = 'downloaded_file';
      }
    } else {
      // 如果没有提供 originalFileName，尝试从 URL 路径中获取基础名
      const cleanUrl = url.split('?')[0];
      const urlBaseName = path.basename(cleanUrl, path.extname(cleanUrl));
      // 确保获取到的基础名不是空的或者只是 '/'
      if (urlBaseName && urlBaseName !== '/') {
        baseName = urlBaseName;
      }
    }

    // 组合最终文件名: 基础名_时间戳.扩展名
    const finalFileName = `${baseName}_${timestamp}${fileExtension}`;

    // 4. 保存文件
    const saveDir = path.join(_path, 'resources/YT_alltools'); // 使用外部定义的 _path
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const filePath = path.join(saveDir, finalFileName);
    // 将 ArrayBuffer 转换为 Node.js Buffer
    fs.writeFileSync(filePath, Buffer.from(fileBuffer));

    if (!validImageExtensions.includes(fileExtension.toLowerCase())) {
      console.log(`检测到非图片文件（${fileExtension}），尝试发送：${filePath}`);
      if (e.group_id) {
        await e.group.sendFile(filePath);
        console.log(`已发送文件到群 ${e.group_id}`);
      } else {
        await e.friend.sendFile(filePath);
        console.log("已发送文件到好友");
      }
    } else {
      console.log(`检测到图片文件（${fileExtension}），不自动发送。`);
    }
    return {
      success: true,
      filePath,
      fileName: finalFileName,
    };

  } catch (error) {
    // 7. 捕获并处理错误
    console.error(`文件下载保存或处理失败: ${url}:`, error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function PluginUploadFile(base64Data, filename) {
  try {
    const response = await fetch('https://openai.yuanplus.chat/v2/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        base64Data: base64Data,
        filename: filename
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log(data);
      return data;
    } else {
      return {};
    }

  } catch (error) {
    console.error('上传错误:', error);
    return {};
  }
}

export async function getBase64Image(imageUrl, filename) {
  try {
    const finalUrl = await refreshTencentImageUrl(imageUrl);
    const response = await axios.get(finalUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      maxBodyLength: 15 * 1024 * 1024,
      validateStatus: function (status) {
        return status >= 200 && status <= 500;
      }
    });

    if (response?.status >= 400) {
      return "该图片链接已过期，请重新获取";
    }

    // 检查是否返回了JSON错误信息(腾讯下载图床)
    if (response.headers['content-type']?.includes('application/json')) {
      const text = Buffer.from(response.data).toString();
      if (text.includes('retmsg') || text.includes('expired') || text.includes('error')) {
        return "该图片链接已过期，请重新获取";
      }
    }

    const buffer = Buffer.from(response.data);
    // 检查是否是有效的图片格式
    if (!isBufferImage(buffer)) {
      return "无效的图片格式";
    }

    const mimeType = mimeTypes.lookup(filename) || 'application/octet-stream';
    const base64 = `data:${mimeType};base64,` + buffer.toString('base64');
    return base64;

  } catch (error) {
    console.error('校验失败:', error.message);
    return "无效的图片下载链接";
  }
}

/**
 * 获取Base64格式的文件
 * @param {string} fileUrl - 文件URL
 * @param {string} filename - 文件名
 * @param {string} type - 文件类型('file'或'img')
 * @returns {Promise<string>} - Base64字符串或错误信息
 */
export async function getBase64File(fileUrl, filename, type = 'file') {
  try {
    const finalUrl = type === 'img' ? await refreshTencentImageUrl(fileUrl) : fileUrl;
    const response = await axios.get(finalUrl, {
      responseType: 'arraybuffer',
      timeout: 60000, // 设置超时时间为60秒
      maxRedirects: 5, // 设置最大重定向次数
      maxBodyLength: 20 * 1024 * 1024,
      validateStatus: function (status) {
        return status >= 200 && status <= 500;
      }
    });

    if (response?.status >= 400) {
      return "该文件链接已过期，请重新获取";
    }

    // 检查是否返回了JSON错误信息
    if (response.headers['content-type']?.includes('application/json')) {
      const text = Buffer.from(response.data).toString();
      if (text.includes('retmsg') || text.includes('expired') || text.includes('error')) {
        return "该文件链接已过期，请重新获取";
      }
    }

    const buffer = Buffer.from(response.data);

    // 如果是图片类型，需要验证图片格式
    if (type === 'img' && !isBufferImage(buffer)) {
      return "无效的图片格式";
    }

    // 获取MIME类型
    const mimeType = getMimeType(filename, type);
    const base64 = `data:${mimeType};base64,` + buffer.toString('base64');
    return base64;

  } catch (error) {
    console.error('校验失败（lookup）:', error.message);
    return type === 'img' ? "无效的图片下载链接" : "无效的文件下载链接";
  }
}

/**
* 获取文件的MIME类型
* @param {string} filename - 文件名
* @param {string} type - 文件类型('file'或'img')
* @returns {string} - MIME类型
*/
function getMimeType(filename, type) {
  const mimeType = mimeTypes.lookup(filename);

  if (mimeType) return mimeType;

  // 默认MIME类型
  if (type === 'img') {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}

/**
 * 下载图片并保存到指定目录，根据 Content-Type 确定扩展名。
 * @param {string} url - 图片 URL
 * @param {string} saveDir - 保存文件的目录路径
 * @param {string} baseNamePrefix - 文件名的基础前缀 (例如 'dall_e_chat_0')
 * @param {number} timeout - 下载超时时间 (毫秒)
 * @returns {Promise<{ success: boolean, filePath?: string, fileExtension?: string, error?: string, url: string }>} - 下载结果
 */
export async function downloadImage(url, saveDir, baseNamePrefix, timeout = 40000) {
  const sourceUrl = url.trim(); // 保留原始 URL 用于下载和错误报告
  const controller = new AbortController();
  const signal = controller.signal;
  let timeoutId = null;

  // 设置下载超时
  timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(`下载超时中止: ${sourceUrl}`);
  }, timeout);

  try {
    // 1. 发起请求，使用 axios 且带 AbortController 信号
    const response = await axios({
      url: sourceUrl,
      method: 'GET',
      responseType: 'stream',
      signal: signal,
    });

    // 检查响应状态
    if (response.status >= 400) {
      throw new Error(`HTTP 错误: ${response.status} ${response.statusText}`);
    }

    // 2. 确定文件扩展名 (优先级: Content-Type (通过 mime-types) -> URL Path -> Default)
    let fileExtension = '.unknown'; // 默认未知扩展名

    // 尝试从 Content-Type header 获取扩展名 (最可靠，使用 mime-types)
    const contentType = response.headers.get('content-type');
    if (contentType) {
      const mimeExt = mimeTypes.extension(contentType.split(';')[0].trim());
      if (mimeExt) {
        fileExtension = `.${mimeExt}`; // mime-types 返回不带点的扩展名，需要加上点
      }
    }

    // 如果 Content-Type 没有提供明确的扩展名，尝试从 URL 路径获取
    // 只有当 Content-Type 没有给出有效扩展名时才尝试 URL
    if (fileExtension === '.unknown') {
      const cleanUrl = sourceUrl.split('?')[0]; // 移除查询字符串
      const urlExt = path.extname(cleanUrl);
      // 确保获取到的扩展名不是空的或者只有 '.'
      if (urlExt && urlExt.length > 1) {
        fileExtension = urlExt.toLowerCase(); // 转换为小写以便后续检查
      }
    }

    // 如果经过所有尝试仍然是未知类型，给一个通用的默认值 .bin
    if (fileExtension === '.unknown') {
      console.warn(`无法确定文件扩展名，URL: ${sourceUrl}. 使用 .bin`);
      fileExtension = '.bin';
    }

    // 3. 检查确定的扩展名是否是允许的图片格式
    if (!validImageExtensions.includes(fileExtension)) {
      // 如果不是图片，中止下载并返回错误
      controller.abort(); // 确保中止进行中的流
      throw new Error(`文件类型不受支持 (${fileExtension})`);
    }

    // 4. 确保保存目录存在
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    // 5. 构建最终保存路径 (包含确定的扩展名)
    const timestamp = new Date().getTime();
    const finalFileName = `${baseNamePrefix}_${timestamp}${fileExtension}`;
    const filePath = path.join(saveDir, finalFileName);

    // 6. 保存文件流
    const writer = fs.createWriteStream(filePath);

    // 监听写入流的错误事件
    writer.on('error', (err) => {
      console.error(`文件写入错误: ${filePath}`, err);
      // 如果写入出错，也需要中止下载流
      controller.abort();
    });

    // 监听下载流的错误事件 (例如网络错误)
    response.data.on('error', (err) => {
      console.error(`下载流错误: ${sourceUrl}`, err);
      // 如果下载流出错，也需要中止写入流
      writer.destroy(err); // 销毁写入流并触发其 error 事件
    });


    // 将下载流导向写入流
    response.data.pipe(writer);

    // 等待写入完成
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject); // writer error will also reject this promise
      signal.onabort = () => reject(new Error('下载被中止或超时')); // AbortController signal
    });

    // 清除超时定时器
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    console.log(`图片下载成功: ${filePath}`);
    return {
      success: true,
      filePath,
      fileExtension, // 返回实际确定的扩展名
      url: sourceUrl // 返回原始 URL
    };

  } catch (err) {
    // 清除超时定时器 (如果在超时前发生了其他错误)
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // 处理 AbortError (超时或手动中止)
    if (err.name === 'AbortError') {
      return { success: false, error: '下载超时或被中止', url: sourceUrl };
    }

    console.error(`下载图片失败: ${sourceUrl}:`, err.message);
    return { success: false, error: err.message, url: sourceUrl };
  }
}
