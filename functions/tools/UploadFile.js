import axios from '../../node_modules/axios/index.js';
import _ from 'lodash';
import { dependencies } from "../../dependence/dependencies.js";
const { mimeTypes } = dependencies;

/**
* 获取引用消息
* @param {object} e - 消息事件
* @param {object} options - 可选参数
* @param {boolean} options.img - 是否获取图片直链
* @param {boolean} options.file - 是否获取文件下载链接
* @returns {Promise<Array|string|false>} 获取到的消息链或false
*/
export async function takeSourceMsg(e, { img, file } = {}) {
  let source = ""
  if (e.getReply) {
    source = await e.getReply()
  } else if (e.source) {
    if (e.group?.getChatHistory) {
      source = (await e.group.getChatHistory(e.source.seq, 1)).pop()
    } else if (e.friend?.getChatHistory) {
      source = (await e.friend.getChatHistory(e.source.time, 1)).pop()
    }
  }
  //console.log(source);
  if (!source) return false
  if (img) {
    let imgArr = []
    for (let i of source.message) {
      if (i.type == "image") {
        imgArr.push(i.url)
      }
    }
    return !_.isEmpty(imgArr) && imgArr
  }
  if (file) {
    if (source.message[0].type === "file") {
      let { fid } = source.message[0]
      return fid && e.group_id ? e?.group?.getFileUrl(fid) : e?.friend?.getFileUrl(fid)
    }
    return false
  }
  return source
}

export async function getBufferFile(fileUrl, filename) {
  try {
    const response = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      validateStatus: function (status) {
        return status >= 200 && status <= 500;
      }
    });
    if (response?.status >= 400) {
      return {
        type: null,
        buffer: null
      }
    }
    if (response.headers['content-type'].includes('application/json')) {
      const textDecoder = new TextDecoder('utf-8');
      const jsonStr = textDecoder.decode(response.data);
      const jsonData = JSON.parse(jsonStr);

      if (jsonData.retmsg?.includes('expired')) {
        return {
          type: null,
          buffer: null
        }
      }
    }

    const mimeType = mimeTypes.lookup(filename) || 'application/octet-stream';
    return {
      type: mimeType,
      buffer: Buffer.from(response.data, 'binary').toString('base64')
    }
  } catch (error) {
    console.error('校验失败:', error.message);
    return {
      type: null,
      buffer: null
    }
  }
}
