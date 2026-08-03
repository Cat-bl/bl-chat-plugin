import { AbstractTool } from './AbstractTool.js';
import { sendvideos } from '../tools/sendvideos.js';
import { biliGetJson, cleanTitle } from '../tools/biliApi.js';

/**
 * SearchVideo 工具类，用于搜索 Bilibili 视频
 */
export class SearchVideoTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'searchVideoTool';
    this.description = '搜索视频并返回详细信息，当用户想要查找视频、了解视频内容时使用，或当前对话场景需要查找视频时你可以主动调用此工具。';
    this.keywords = ['搜视频', '找视频', 'B站搜索', '视频搜索', '查找视频'];
    this.intent = '用户想要搜索或查找B站视频相关内容时的意图';
    this.examples = [
      '帮我搜索原神视频',
      '找一个关于编程的视频',
      '搜索最新的美食视频'
    ];
    this.parameters = {
      type: "object",
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词，可以是视频标题、主题或任何相关内容',
          example: '原神'
        },
        order: {
          type: 'string',
          enum: ['totalrank', 'pubdate', 'click', 'dm', 'stow'],
          description:
            '可选。结果排序：totalrank=综合排序(默认)、pubdate=最新发布、click=最多播放、' +
            'dm=最多弹幕、stow=最多收藏。用户要"最新的"用 pubdate，要"最火的"用 click'
        }
      },
      required: ['keyword']
    };
  }

  /**
   * 带 WBI 签名请求搜索接口（风控重试在 biliApi.biliGetJson 内处理）
   * @param {string} name - 搜索关键词
   * @param {string} [order] - 排序方式（totalrank/pubdate/click/dm/stow）
   * @returns {Promise<Object>} - 接口 JSON（code=0）
   */
  async requestSearch(name, order = '') {
    const params = { keyword: name, search_type: 'video', page: 1 };
    // 参数校验层不查 enum，非法排序值这里静默忽略（按综合排序处理）
    if (['pubdate', 'click', 'dm', 'stow'].includes(order)) params.order = order;
    return await biliGetJson('https://api.bilibili.com/x/web-interface/search/type', params, { signed: true });
  }

  /**
   * 执行Bilibili视频搜索
   * @param {string} name - 视频关键词
   * @param {string} [order] - 排序方式
   * @returns {Promise<string>} - 搜索结果或错误信息
   */
  async searchBilibili(name, order = '') {
    try {
      const json = await this.requestSearch(name, order);

      if (json.data?.result?.length > 0) {
        // 从相关性/排序靠前的 10 条里随机选一个（全量随机容易抽到边角结果）
        const pool = json.data.result.slice(0, 10);
        const randomVideo = pool[Math.floor(Math.random() * pool.length)];

        // 格式化数据（字段缺失时兜底，避免 undefined 上的方法调用炸掉）
        const formatData = {
          // 格式化播放量
          formatPlay: (count) => {
            const n = Number(count) || 0;
            if (n >= 10000) {
              return `${(n / 10000).toFixed(1)}万`;
            }
            return n.toString();
          },
          // 格式化时间
          formatDate: (timestamp) => {
            return new Date(timestamp * 1000).toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit'
            });
          }
        };

        // 构建返回结果
        const pic = String(randomVideo.pic || '');
        return `🎬 随机推荐视频：

📺 ${cleanTitle(randomVideo.title)}
👤 UP主：${randomVideo.author || '未知UP主'}
🔢 BV号：${randomVideo.bvid}
🎯 分区：${randomVideo.typename || '未知分区'}
⏱️ 时长：${randomVideo.duration || '未知'}
👁️ 播放：${formatData.formatPlay(randomVideo.play)}
💖 点赞：${formatData.formatPlay(randomVideo.like)}
📅 发布：${formatData.formatDate(randomVideo.pubdate)}

🔗 视频链接：https://www.bilibili.com/video/${randomVideo.bvid}
🖼️ 封面：${pic.startsWith('//') ? 'https:' + pic : pic}`;
      } else {
        return `未找到与"${name}"相关的视频`;
      }
    } catch (err) {
      console.error(err);
      return `搜索失败：${err.message}`;
    }
  }

  /**
   * 执行搜索视频操作
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   * @returns {Promise<string>} - 搜索结果或错误信息
   */
  async func(opts, e) {
    let { keyword, order } = opts;
    // 参数校验层只查字段存在，空串会穿透到接口打出 -400，这里拦下
    if (!String(keyword || '').trim()) {
      return 'error: 搜索关键词不能为空';
    }
    try {
      const result = await this.searchBilibili(String(keyword).trim(), order);

      // 如果结果中包含封面链接，先发送格式化的文本信息（不包含封面链接）
      if (result.includes('🖼️ 封面：')) {
        // 分离文本信息和封面链接（详情停发后暂不使用，恢复发送时一并取消注释）
        // const [textInfo, coverInfo] = result.split('🖼️ 封面：');
        // 清理封面链接（个别条目无封面，空链接就只发文本）
        // const coverUrl = coverInfo.trim();

        // 封面+详情消息已停发（内容太长刷屏），只发视频本体；详情文本仍返回给模型。
        // 需要恢复时取消下面注释（合并转发形式，失败回退普通消息）：
        // const detailMsg = coverUrl ? [segment.image(coverUrl), textInfo.trim()] : textInfo.trim();
        // try {
        //   const { default: common } = await import('../../../../lib/common/common.js');
        //   const forwardMsg = await common.makeForwardMsg(e, [detailMsg], 'B站视频搜索结果');
        //   await e.reply(forwardMsg);
        // } catch (error) {
        //   console.error('合并转发发送失败，回退普通消息:', error.message);
        //   await e.reply(detailMsg);
        // }
        // 发送视频链接
        await sendvideos(result, e);
        return { result: result };
      }

      // 搜索失败/无结果：不把报错原文发到群里，交给模型用自然语气回复
      return `error: ${result}`;

    } catch (err) {
      console.error(err);
      return `error: 搜索视频失败：${err.message || err}`;
    }
  }
}