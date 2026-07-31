import { AbstractTool } from './AbstractTool.js';
import { sendvideos } from '../tools/sendvideos.js';
import fetch from 'node-fetch';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// node-fetch 默认无超时，B 站接口挂起会吊死整个工具调用
const FETCH_TIMEOUT_MS = 15000;
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw err?.name === 'AbortError' ? new Error(`B站接口请求超时（${timeoutMs}ms）`) : err;
  } finally {
    clearTimeout(timer);
  }
}

// B 站 web 接口 WBI 签名（无签名/无有效 buvid 会被风控网关拦截返回 HTML 页）
// 算法来自 bilibili-API-collect 社区文档
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];
const getMixinKey = orig => mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// B 站标题里带 HTML 实体（&quot; 等）与 <em> 高亮标签，先去标签再解实体
const cleanTitle = s => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

// buvid 与 wbi key 缓存：wbi key 每日轮换，正常情况按 TTL 复用，风控报错时强制刷新
let biliAuthCache = null; // { cookie, imgKey, subKey, at }
const BILI_AUTH_TTL_MS = 60 * 60 * 1000;

async function getBiliAuth(force = false) {
  if (!force && biliAuthCache && Date.now() - biliAuthCache.at < BILI_AUTH_TTL_MS) {
    return biliAuthCache;
  }
  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };
  const spi = await (await fetchWithTimeout('https://api.bilibili.com/x/frontend/finger/spi', { headers })).json();
  if (!spi?.data?.b_3) throw new Error('获取 buvid 失败');
  const cookie = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4 || ''}`;
  const nav = await (await fetchWithTimeout('https://api.bilibili.com/x/web-interface/nav', { headers: { ...headers, cookie } })).json();
  const imgUrl = nav?.data?.wbi_img?.img_url || '';
  const subUrl = nav?.data?.wbi_img?.sub_url || '';
  if (!imgUrl || !subUrl) throw new Error('获取 wbi 签名密钥失败');
  const keyOf = u => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  biliAuthCache = { cookie, imgKey: keyOf(imgUrl), subKey: keyOf(subUrl), at: Date.now() };
  return biliAuthCache;
}

function signWbi(params, imgKey, subKey) {
  const withWts = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withWts).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(withWts[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + getMixinKey(imgKey + subKey))}`;
}

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
   * 带 WBI 签名请求搜索接口；风控（HTML 响应 / -403 / -412）时刷新凭证重试一次
   * @param {string} name - 搜索关键词
   * @param {string} [order] - 排序方式（totalrank/pubdate/click/dm/stow）
   * @param {boolean} retried - 是否已重试
   * @returns {Promise<Object>} - 接口 JSON（code=0）
   */
  async requestSearch(name, order = '', retried = false) {
    const auth = await getBiliAuth(retried);
    const params = { keyword: name, search_type: 'video', page: 1 };
    // 参数校验层不查 enum，非法排序值这里静默忽略（按综合排序处理）
    if (['pubdate', 'click', 'dm', 'stow'].includes(order)) params.order = order;
    const query = signWbi(params, auth.imgKey, auth.subKey);
    const response = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/search/type?${query}`, {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        cookie: auth.cookie
      }
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (!retried) return this.requestSearch(name, order, true);
      throw new Error(`B站返回了非 JSON 内容（疑似风控），HTTP ${response.status}`);
    }
    if (json.code !== 0) {
      if (!retried && (json.code === -403 || json.code === -412)) {
        return this.requestSearch(name, order, true);
      }
      throw new Error(`B站接口错误 code=${json.code} ${json.message || ''}`);
    }
    return json;
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