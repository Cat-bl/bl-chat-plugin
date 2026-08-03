// 腾讯图片直链处理：rkey 解析/刷新、链接可用性探测、Napcat/LLBot rkey 获取。
// 从 fileUtils.js 拆出（行为等价搬迁）。
import axios from "axios";
import _ from "lodash";

const TENCENT_IMAGE_APPIDS = [1408, 1407, 1406, 1405, 1404, 1403];

export function isTencentImageUrl(url, fid = null) {
  try {
    const parsed = new URL(String(url));
    const hostMatched = parsed.hostname.endsWith('qq.com.cn') || parsed.hostname.endsWith('qq.com') || parsed.hostname.endsWith('qpic.cn');
    const hasTemporaryParams = Boolean(fid) || parsed.searchParams.has('rkey') || parsed.searchParams.has('fileid') || parsed.searchParams.has('fid');
    return hostMatched && hasTemporaryParams;
  } catch {
    return false;
  }
}

function normalizeRKeyValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/(?:^|[?&])rkey=([^&]+)/);
  return match ? match[1] : raw.replace(/^rkey=/, '').replace(/^&rkey=/, '');
}

export function parseRKeyFromUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.searchParams.get('rkey') || null;
  } catch {
    const match = String(url || '').match(/(?:^|[?&])rkey=([^&]+)/);
    return match?.[1] || null;
  }
}

function getImageSignatures() {
  return [
    ['FF', 'D8'],
    ['89', '50', '4E', '47'],
    ['47', '49', '46'],
    ['52', '49', '46', '46'],
    ['42', '4D']
  ];
}

export function isImageBuffer(buffer) {
  const header = [...Buffer.from(buffer || []).slice(0, 8)]
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase());
  return getImageSignatures().some(signature =>
    signature.every((byte, index) => header[index] === byte)
  );
}

async function callOneBotApi(action, params = {}) {
  if (typeof Bot !== 'undefined' && Bot.sendApi) {
    return await Bot.sendApi(action, params);
  }
  if (typeof globalThis.bot !== 'undefined' && globalThis.bot.sendApi) {
    return await globalThis.bot.sendApi(action, params);
  }
  if (typeof globalThis.Bot !== 'undefined' && globalThis.Bot.sendApi) {
    return await globalThis.Bot.sendApi(action, params);
  }
  throw new Error('找不到 OneBot API 调用接口');
}

// 记住上次成功的 rkey action，避免换协议端后每次都先打一发不存在的接口；
// 缓存仅决定尝试顺序，缓存项失败仍会回退另一个（协议端可能运行中更换）
let preferredRKeyAction = null;

export async function getNapcatRKeys() {
  // NapCat 的 nc_get_rkey 返回数组 [{rkey: "&rkey=xxx"}...]；
  // LLBot(LuckyLilliaBot) 的 get_rkey 返回对象 { private_key, group_key }
  const actions = [...new Set([preferredRKeyAction, 'nc_get_rkey', 'get_rkey'])].filter(Boolean);
  for (const action of actions) {
    try {
      const response = await callOneBotApi(action);
      const data = response?.data ?? response;
      const values = Array.isArray(data)
        ? data.map(item => item?.rkey || item?.value || item)
        : [data?.private_key, data?.group_key];
      const rkeys = values.map(normalizeRKeyValue).filter(Boolean);
      if (rkeys.length) {
        preferredRKeyAction = action;
        return rkeys;
      }
    } catch (error) {
      globalThis.logger?.debug?.(`[fileUtils] ${action} 获取失败: ${error.message}`);
    }
  }
  return [];
}

export async function isTencentImageUrlAvailable(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      maxRedirects: 5,
      maxBodyLength: 15 * 1024 * 1024,
      validateStatus: status => status >= 200 && status <= 500
    });

    if (response?.status >= 400) return false;

    const contentType = response.headers?.['content-type'] || '';
    if (contentType.includes('application/json') || contentType.includes('text/')) {
      const text = Buffer.from(response.data || []).toString();
      if (/retcode|retmsg|expired|error|not\s*found/i.test(text)) return false;
    }

    return isImageBuffer(response.data);
  } catch {
    return false;
  }
}

function buildTencentImageCandidates(url, fid, rkeys = []) {
  const candidates = [];
  const add = candidate => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return candidates;
  }

  const originalAppid = parsed.searchParams.get('appid');
  const fileId = parsed.searchParams.get('fileid') || fid;
  const appids = [
    ...(originalAppid ? [Number(originalAppid)] : []),
    ...TENCENT_IMAGE_APPIDS
  ].filter((appid, index, arr) => Number.isFinite(appid) && arr.indexOf(appid) === index);

  const allRKeys = [...rkeys, parseRKeyFromUrl(url)].map(normalizeRKeyValue).filter(Boolean);
  if (!allRKeys.length) return candidates;

  if (fileId) {
    for (const rkey of allRKeys) {
      for (const appid of appids) {
        const next = new URL(parsed.origin + '/download');
        next.searchParams.set('appid', String(appid));
        next.searchParams.set('fileid', fileId);
        if (parsed.searchParams.has('spec')) next.searchParams.set('spec', parsed.searchParams.get('spec'));
        else next.searchParams.set('spec', '0');
        next.searchParams.set('rkey', rkey);
        add(next.toString());
      }
    }
  }

  for (const rkey of allRKeys) {
    const next = new URL(parsed.toString());
    next.searchParams.set('rkey', rkey);
    add(next.toString());
  }

  return candidates;
}

export async function refreshTencentImageUrl(url, fid = null) {
  if (!url || !isTencentImageUrl(url, fid)) return url;

  const rkeys = await getNapcatRKeys();
  const candidates = buildTencentImageCandidates(url, fid, rkeys);
  if (!candidates.length) return url;

  // 并行探测所有候选，取第一个可用的。
  // 原实现是 for 串行 await，rkey 过期时每个候选各超时 5s，7+ 个候选串行累加可达 35~56s，
  // 是 "@ 带图消息回复慢一分钟" 的主因。并行后最坏耗时 = 单个超时（5s）。
  const probes = candidates.map(candidate =>
    isTencentImageUrlAvailable(candidate).then(ok => {
      if (ok) return candidate
      throw new Error('unavailable')
    })
  );
  try {
    return await Promise.any(probes);
  } catch {
    return url;
  }
}

export async function normalizeImageUrls(urls = []) {
  const list = Array.isArray(urls) ? urls : typeof urls === 'string' ? [urls] : [];
  return (await Promise.all(list.filter(Boolean).map(url => refreshTencentImageUrl(url))))
    .filter(Boolean);
}

/**
 * 获取rkey参数
 * @param {string} url - URL字符串
 * @returns {Promise<string|null>} - rkey值或null
 */
export async function getRKey(url) {
  const rkeyParam = 'rkey=';
  const rkeyStartIndex = url.indexOf(rkeyParam);
  if (rkeyStartIndex === -1) return null;
  const actualStartIndex = rkeyStartIndex + rkeyParam.length;
  const rkeyEndIndex = url.indexOf('&', actualStartIndex);
  const rkey = rkeyEndIndex === -1
    ? url.substring(actualStartIndex)
    : url.substring(actualStartIndex, rkeyEndIndex);
  return rkey;
}

/**
 * 提取URL的域名部分
 * @param {string} url - URL字符串
 * @returns {Promise<string>} - 域名
 */
export async function extractDomain(url) {
  const ampIndex = url.indexOf('&');
  if (ampIndex !== -1) {
    return url.slice(0, ampIndex);
  }
  return url;
}
