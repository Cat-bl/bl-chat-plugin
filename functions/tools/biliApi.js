// B 站 web 接口访问基建：游客 buvid + WBI 签名 + 风控自动重试。
// 供 SearchVideoTool / BilibiliTool 等所有 B 站类工具共享。
// WBI 算法来自 bilibili-API-collect 社区文档。
import fetch from 'node-fetch';
import crypto from 'node:crypto';

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// node-fetch 默认无超时，B 站接口挂起会吊死整个工具调用
const FETCH_TIMEOUT_MS = 15000;
export async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
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

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];
const getMixinKey = orig => mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// B 站标题里带 HTML 实体（&quot; 等）与 <em> 高亮标签，先去标签再解实体
export const cleanTitle = s => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

// 数量格式化：10000 以上折算成"万"
export const formatCount = count => {
  const n = Number(count) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toString();
};

// buvid 与 wbi key 缓存：wbi key 每日轮换，正常情况按 TTL 复用，风控报错时强制刷新
let biliAuthCache = null; // { cookie, imgKey, subKey, at }
const BILI_AUTH_TTL_MS = 60 * 60 * 1000;

export async function getBiliAuth(force = false) {
  if (!force && biliAuthCache && Date.now() - biliAuthCache.at < BILI_AUTH_TTL_MS) {
    return biliAuthCache;
  }
  const headers = { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/' };
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

export function signWbi(params, imgKey, subKey) {
  const withWts = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withWts).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(withWts[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + getMixinKey(imgKey + subKey))}`;
}

/**
 * 通用 GET：返回解析后的 JSON（code 非 0 抛错）。
 * 非 JSON 响应（风控页）或 -403/-412/-352 风控码时刷新凭证重试一次。
 * @param {string} url - 不带 query 的接口地址
 * @param {Object|null} params - query 参数
 * @param {Object} [opts]
 * @param {boolean} [opts.signed=false] - 是否带 WBI 签名
 * @param {boolean} [opts.retried=false] - 内部重试标记
 */
export async function biliGetJson(url, params = null, { signed = false, retried = false } = {}) {
  const auth = await getBiliAuth(retried);
  let full = url;
  if (params) {
    const query = signed
      ? signWbi(params, auth.imgKey, auth.subKey)
      : Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    full = `${url}?${query}`;
  }
  const response = await fetchWithTimeout(full, {
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'user-agent': BILI_UA,
      referer: 'https://www.bilibili.com/',
      cookie: auth.cookie
    }
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (!retried) return biliGetJson(url, params, { signed, retried: true });
    throw new Error(`B站返回了非 JSON 内容（疑似风控），HTTP ${response.status}`);
  }
  // 个别接口（如热搜词）响应无 code 字段，只在有 code 时校验
  if (json.code !== undefined && json.code !== 0) {
    // -403/-412/-352 均为风控拦截码，刷新游客凭证后重试一次
    if (!retried && [-403, -412, -352].includes(json.code)) {
      return biliGetJson(url, params, { signed, retried: true });
    }
    throw new Error(`B站接口错误 code=${json.code} ${json.message || ''}`);
  }
  return json;
}
