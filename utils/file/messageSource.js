// 从消息事件中提取图片、文件与引用消息。从 fileUtils.js 拆出（行为等价搬迁）。
import _ from "lodash";
import { refreshTencentImageUrl } from "./tencentImage.js";

/**
 * 获取聊天中的图片链接
 * @param {Object} e - 事件对象
 * @returns {Promise<Array>} - 图片URL数组
 */
export async function TakeImages(e) {
  const getImageUrl = async (message) => {
    for (const { type, url, fid } of message) {
      if ((type === "image" || type === "file") && url) {
        return await refreshTencentImageUrl(url, fid);
      }
    }
    return null;
  };

  let imgurl = e.getReply ? await e.getReply() : null;
  if (!imgurl && e.source) {
    const chatHistory = e.group?.getChatHistory || e.friend?.getChatHistory;
    if (chatHistory) {
      const seq = e.group ? e.source.seq : e.source.time;
      imgurl = (await chatHistory.call(e.group || e.friend, seq, 1)).pop();
    }
  }
  imgurl = imgurl?.message ? await getImageUrl(imgurl.message) : null;
  const img_urls = e.message ? await Promise.all(e.message.map(async (msg) => await getImageUrl([msg]))) : [];
  imgurl = imgurl ? [imgurl] : img_urls.filter(Boolean);
  return imgurl;
}

/**
* 获取引用消息
* @param {object} e - 消息事件
* @param {object} options - 可选参数
* @param {boolean} options.img - 是否获取图片直链
* @param {boolean} options.file - 是否获取文件下载链接
* @returns {Promise<Array|string|false>} 获取到的消息链或false
*/
async function takeSourceMsg(e, { img, file } = {}) {
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

/**
 * 获取文件URL和文件名
 * @param {Object} e - 事件对象
 * @returns {Promise<{fileUrl: string, fileName: string}>}
 */
export async function getFileInfo(e) {
  try {
    const ncResult = await getFileUrl(e);
    if (ncResult?.fileUrl) {
      return {
        fileUrl: ncResult.fileUrl,
        fileName: ncResult.fileName
      };
    }

    const sourceFiles = await takeSourceMsg(e, { file: true });
    if (!sourceFiles) {
      return {};
    }

    let fileName;
    if (e.group?.getChatHistory) {
      const [history] = await e.group.getChatHistory(e.source.seq, 1).then(hist => hist.slice(-1));
      fileName = history?.message[0]?.name;
    } else if (e.friend?.getChatHistory) {
      const [history] = await e.friend.getChatHistory(e.source.time, 1).then(hist => hist.slice(-1));
      fileName = history?.message[0]?.name;
    }

    return {
      fileUrl: sourceFiles,
      fileName
    };
  } catch (error) {
    console.error('获取文件信息失败:', error);
    return {};
  }
}

async function getFileUrl(e) {
  if (!e?.reply_id) return {};

  const replyMsg = await getReplyMsg(e);
  const messages = replyMsg?.message;

  if (!Array.isArray(messages)) return {};

  for (const msg of messages) {
    if (msg.type === 'file') {
      const file_id = msg.data?.file_id;
      const file = msg.data?.file;
      // 判断是群聊还是私聊
      if (e.group_id) {
        // 群聊文件
        const { data: { url } } = await e.bot.sendApi("get_group_file_url", {
          group_id: e.group_id,
          file_id
        });
        return {
          fileUrl: `${url}${file}`,
          fileName: file
        };
      } else {
        // 私聊文件
        const { data: { url } } = await e.bot.sendApi("get_private_file_url", {
          //user_id: e.user_id,
          file_id
        });
        return {
          fileUrl: `${url}${file}`,
          fileName: file
        };
      }
    }
  }

  return {};
}

async function getReplyMsg(e) {
  try {
    let historyResponse;

    // 判断是群聊还是私聊
    if (e.group_id) {
      // 群聊消息历史
      historyResponse = await e.bot.sendApi("get_group_msg_history", {
        group_id: e.group_id,
        count: 1,
      });
    } else {
      // 私聊消息历史（NapCat 名 get_private_msg_history，LLBot 名 get_friend_msg_history，参数响应一致）
      try {
        historyResponse = await e.bot.sendApi("get_private_msg_history", {
          user_id: e.user_id,
          count: 1,
        });
      } catch {
        historyResponse = await e.bot.sendApi("get_friend_msg_history", {
          user_id: e.user_id,
          count: 1,
        });
      }
    }

    if (!historyResponse?.data?.messages || historyResponse.data.messages.length === 0) {
      return null;
    }

    const recentMessage = historyResponse.data.messages[0];
    const messageId = recentMessage?.message?.[0]?.data?.id;

    if (!messageId) {
      return null;
    }

    const messageResponse = await e.bot.sendApi("get_msg", {
      message_id: messageId,
    });

    if (!messageResponse?.data) {
      return null;
    }

    return messageResponse.data;

  } catch (error) {
    console.error("获取引用消息失败:", error);
    return null;
  }
}
