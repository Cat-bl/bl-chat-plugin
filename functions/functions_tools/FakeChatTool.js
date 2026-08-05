import { AbstractTool } from './AbstractTool.js';

/**
 * 伪造聊天记录工具
 * 通过 OneBot v11 的合并转发接口（send_group_forward_msg / send_private_forward_msg）
 * 构造并发送一段自定义的"聊天记录"
 */

// content 中的媒体占位写法：pic[链接] / file[链接] / video[链接]
const MEDIA_RE = /(?:pic|file|video)\[([^\]]+)\]/g;
const TYPE_MAP = { p: 'image', f: 'file', v: 'video' };
const MAX_NODES = 99;

function toForwardMessageStyle(msgStyle) {
  if (!msgStyle || typeof msgStyle !== 'object') return null;

  const result = {
    bubble_id: Number(msgStyle.bubbleId ?? 0),
    pendant_id: Number(msgStyle.pendantId ?? 0),
    font_id: Number(msgStyle.fontId ?? 0),
    font_effect_id: Number(msgStyle.fontEffectId ?? 0),
    is_cs_font_effect_enabled: msgStyle.isCsFontEffectEnabled ?? false,
    bubble_diy_text_id: Number(msgStyle.bubbleDiyTextId ?? 0)
  };
  for (const key of ['bubble_id', 'pendant_id', 'font_id', 'font_effect_id', 'bubble_diy_text_id']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) return null;
  }
  if (typeof result.is_cs_font_effect_enabled !== 'boolean') return null;
  return result;
}

let masterCache = null;

/**
 * 读取 Yunzai 主人 QQ 列表（懒加载，失败不缓存）
 * @returns {Promise<Set<string>>}
 */
async function loadMasterQQs() {
  if (masterCache) return masterCache;

  const result = new Set();
  const collect = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(collect);
      return;
    }
    // 兼容 "botUin:masterQQ" 形式
    const qq = String(value).trim().split(':').pop().trim();
    if (/^\d{5,}$/.test(qq)) result.add(qq);
  };

  try {
    const mod = await import('../../../../lib/config/config.js');
    const cfg = mod.default || mod;
    collect(cfg.masterQQ);
    collect(cfg.master);
  } catch (error) {
    logger?.warn?.(`[fakeChatTool] 读取主人配置失败，跳过主人保护: ${error.message}`);
    return result;
  }

  masterCache = result;
  return masterCache;
}

export class FakeChatTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'fakeChatTool';
    this.description = [
      '伪造/编造一段QQ聊天记录，以合并转发（聊天记录卡片）的形式发送到当前会话。',
      '适合场景：用户要求"伪造聊天记录"、"编一段对话"、玩梗整活、模拟某人说话，你也可以主动调用来整蛊某人。',
      '每条消息都可以指定任意QQ号和昵称，卡片内会显示对应的头像与名字。',
      '若聊天记录中有被伪造QQ的[消息ID:xxx]，将每个QQ最新的一条ID放入message_ids以自动复用真实气泡；没有则省略，禁止编造。',
      '注意：这是纯娱乐功能，不要用来伪造涉及金钱、诈骗、造谣的内容。'
    ].join('\n');
    this.parameters = {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              qq: {
                type: 'string',
                description: '这条消息的发送者QQ号（必填），决定卡片里显示的头像'
              },
              name: {
                type: 'string',
                description: '显示的昵称（可选）。不填则自动查询该QQ的群名片或昵称'
              },
              content: {
                type: 'string',
                description: [
                  '消息内容（必填）。纯文本直接写；',
                  '需要插入图片/文件/视频时用占位写法：pic[图片直链]、file[文件直链]、video[视频直链]，',
                  '可与文字混排，例如 "你看这个 pic[https://xxx.jpg] 好看吗"'
                ].join('')
              },
              time: {
                type: 'integer',
                description: '消息的发送时间（可选，Unix秒级时间戳）。可以自定义任意历史时间，比如伪造2005年的聊天记录。不填则自动使用当前时间附近的时间戳'
              }
            },
            required: ['qq', 'content']
          },
          description: `聊天记录的消息列表，按先后顺序排列，最多 ${MAX_NODES} 条`
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '被伪造QQ的最近真实消息ID列表，可从聊天历史记录中的[消息ID:xxx]获取；每个QQ最多一条，没有则省略，禁止编造'
        },
        title: {
          type: 'string',
          description: '合并转发卡片的外显描述（可选），例如 "群友的深夜发言"。不填则用QQ默认样式'
        }
      },
      required: ['messages']
    };
  }

  /**
   * 取当前事件对应的 bot 实例（多 bot 场景优先用 e.bot）
   */
  getBot(e) {
    if (e?.bot?.sendApi) return e.bot;
    if (typeof Bot !== 'undefined' && Bot.sendApi) return Bot;
    throw new Error('找不到 OneBot v11 API 调用接口');
  }

  /**
   * 把 content 字符串解析成 OneBot 消息段数组
   */
  parseContent(content) {
    const text = String(content ?? '');
    const segments = [];
    let lastIndex = 0;

    for (const match of text.matchAll(MEDIA_RE)) {
      if (match.index > lastIndex) {
        const plain = text.substring(lastIndex, match.index).replaceAll('\\n', '\n').trim();
        if (plain) segments.push({ type: 'text', data: { text: plain } });
      }
      segments.push({ type: TYPE_MAP[match[0][0]], data: { file: match[1] } });
      lastIndex = match.index + match[0].length;
    }

    const tail = text.substring(lastIndex).replaceAll('\\n', '\n').trim();
    if (tail) segments.push({ type: 'text', data: { text: tail } });

    if (segments.length) return segments;
    return [{ type: 'text', data: { text: text.replaceAll('\\n', '\n') } }];
  }

  /**
   * 解析显示昵称：入参 name > 群名片 > 陌生人昵称 > QQ号
   */
  async resolveNickname(bot, e, qq, provided) {
    const given = String(provided ?? '').trim();
    if (given) return given;

    if (e?.group_id) {
      try {
        const res = await bot.sendApi('get_group_member_info', {
          group_id: Number(e.group_id),
          user_id: Number(qq),
          no_cache: false
        });
        const data = res?.data || res;
        const name = data?.card || data?.nickname;
        if (name) return String(name);
      } catch {
        // 不是群成员，继续走陌生人查询
      }
    }

    try {
      const res = await bot.sendApi('get_stranger_info', { user_id: Number(qq) });
      const data = res?.data || res;
      const name = data?.nickname || data?.nick;
      if (name) return String(name);
    } catch {
      // 查不到就用QQ号兜底
    }

    return String(qq);
  }

  /**
   * 归一化 messages 参数。
   * LLM 经常把数组整体输出成 JSON 字符串（"[{...}]"），而基类的
   * validateParameters 遇到 array 类型的字符串值会包成 ["[{...}]"]，
   * 这里把这种情况还原回对象数组；单个元素是 JSON 字符串时同样处理。
   */
  normalizeMessages(raw) {
    let list = raw;

    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        return [];
      }
    }

    // 基类包装后的 ["[{...}]"] / ['{"qq":...}']
    if (Array.isArray(list) && list.length === 1 && typeof list[0] === 'string') {
      const single = list[0].trim();
      if (single.startsWith('[') || single.startsWith('{')) {
        try {
          list = JSON.parse(single);
        } catch {
          // 解析失败就保持原样，交给后续校验报错
        }
      }
    }

    if (!Array.isArray(list)) list = [list];

    return list.map(item => {
      if (typeof item !== 'string') return item;
      const text = item.trim();
      if (!text.startsWith('{')) return item;
      try {
        return JSON.parse(text);
      } catch {
        return item;
      }
    });
  }

  isLLOneBot(bot) {
    return bot?.version?.app_name === 'LLOneBot';
  }

  async resolveAutomaticStyles(bot, targetQQs, styleMessageIds) {
    const result = new Map();
    const styleTimes = new Map();
    if (!this.isLLOneBot(bot)) return result;

    for (const messageId of styleMessageIds) {
      try {
        const response = await bot.sendApi('get_msg', { message_id: messageId });
        const message = response?.data;
        const qq = message?.user_id === undefined ? '' : String(message.user_id);
        if (!targetQQs.has(qq)) continue;
        const style = toForwardMessageStyle(message?.raw?.msgStyle);
        if (!style) continue;

        const messageTime = Number(message?.time ?? message?.raw?.msgTime ?? 0) || 0;
        const previousTime = styleTimes.get(qq);
        if (previousTime === undefined || (messageTime > 0 && messageTime > previousTime)) {
          result.set(qq, style);
          styleTimes.set(qq, messageTime);
        }
      } catch {
        // 气泡属于可选增强能力，查询失败时保持普通合并转发。
      }
    }
    return result;
  }

  /**
   * 先归一化 messages 再走基类校验。
   * 基类对 array 类型的校验会直接拦掉"单个对象"和"元素是JSON字符串"两种
   * LLM 常见输出，导致 func 里的归一化没机会执行，这里提前处理。
   */
  validateParameters(params) {
    if (params && typeof params === 'object' && params.messages !== undefined) {
      params.messages = this.normalizeMessages(params.messages);
    }
    if (params && typeof params === 'object' && params.message_ids !== undefined) {
      const list = Array.isArray(params.message_ids) ? params.message_ids : [params.message_ids];
      params.message_ids = list.map(value => String(value).trim());
    }
    return super.validateParameters(params);
  }

  async func(opts, e) {
    // validateParameters 已归一化过；这里再走一次是为了兼容直接调用 func 的场景
    const rawMessages = this.normalizeMessages(opts.messages);
    if (!rawMessages.length) {
      return 'error: messages 不能为空，至少需要一条消息';
    }
    if (rawMessages.length > MAX_NODES) {
      return `error: 消息条数过多（${rawMessages.length} 条），最多 ${MAX_NODES} 条`;
    }

    // 归一化并校验每条消息
    const parsed = [];
    for (const [index, item] of rawMessages.entries()) {
      if (!item || typeof item !== 'object') {
        return `error: 第 ${index + 1} 条消息格式错误，应为 { qq, name, content } 对象`;
      }
      const qq = String(item.qq ?? '').trim();
      if (!/^\d{5,}$/.test(qq)) {
        return `error: 第 ${index + 1} 条消息的 qq "${qq}" 不是合法QQ号`;
      }
      const content = String(item.content ?? '').trim();
      if (!content) {
        return `error: 第 ${index + 1} 条消息的 content 不能为空`;
      }

      parsed.push({ qq, name: item.name, content, time: item.time });
    }

    // 主人保护：非主人发起时，不允许伪造主人的消息，也不能自定义显示昵称。
    // 以 e.user_id 是否在主人列表为准，而不是只看 e.isMaster——
    // 工具也可能被 ReminderTool 的 fakeEvent 之类手工构造的事件调用，那种对象上没有 isMaster 字段。
    // 非主人调用时强制忽略 item.name，一律用 qq 对应的真实昵称，
    // 防止用任意 qq + 主人昵称的形式冒充身份。
    const masters = await loadMasterQQs();
    const callerQQ = String(e?.user_id ?? '').trim();
    const callerIsMaster = masters.has(callerQQ) || e?.isMaster === true;

    if (!callerIsMaster) {
      const hit = parsed.find(item => masters.has(item.qq));
      if (hit) {
        logger?.warn?.(`[fakeChatTool] 用户 ${callerQQ || '未知'} 尝试伪造主人 ${hit.qq} 的聊天记录，已阻止`);
        return `error: 不能伪造主人（${hit.qq}）的消息，请告知用户这个人不能伪造`;
      }
      // 非主人不能自定义昵称，清空 name 让 resolveNickname 走真实查询
      for (const item of parsed) item.name = undefined;
    }

    try {
      const bot = this.getBot(e);
      let automaticStyles = new Map();
      if (this.isLLOneBot(bot)) {
        const targetQQs = new Set(parsed.map(item => item.qq));
        const styleMessageIds = new Set();
        if (targetQQs.has(callerQQ) && e?.message_id !== undefined) {
          styleMessageIds.add(String(e.message_id));
        }
        const rawMessageIds = opts.message_ids === undefined
          ? []
          : (Array.isArray(opts.message_ids) ? opts.message_ids : [opts.message_ids]);
        for (const [index, value] of rawMessageIds.entries()) {
          const messageId = String(value).trim();
          if (!/^-?\d+$/.test(messageId)) {
            return `error: 第 ${index + 1} 个 message_ids 格式错误`;
          }
          styleMessageIds.add(messageId);
        }
        automaticStyles = await this.resolveAutomaticStyles(bot, targetQQs, styleMessageIds);
      }

      // 同一QQ只查一次昵称
      const nicknameCache = new Map();
      const nodes = await Promise.all(parsed.map(async (item, index) => {
        const key = `${item.qq}|${String(item.name ?? '').trim()}`;
        if (!nicknameCache.has(key)) {
          nicknameCache.set(key, this.resolveNickname(bot, e, item.qq, item.name));
        }
        const nickname = await nicknameCache.get(key);
        const qqNum = Number(item.qq);

        // 构造 node，兼容 NapCat 和 LLOneBot
        const nodeData = {
          user_id: qqNum,    // NapCat 标准字段
          nickname,          // NapCat 标准字段
          uin: qqNum,        // LLOneBot 标准字段
          name: nickname,    // LLOneBot 标准字段
          content: this.parseContent(item.content)
        };

        // time: 控制卡片里显示的消息时间
        // 如果 LLM 传了 time 就用它的，否则按当前时间倒序排列（模拟历史消息从旧到新）
        if (item.time && typeof item.time === 'number' && item.time > 0) {
          nodeData.time = item.time;
        } else {
          nodeData.time = Math.floor(Date.now() / 1000) - (parsed.length - index - 1);
        }

        const messageStyle = automaticStyles.get(item.qq);
        if (messageStyle) nodeData.message_style = { ...messageStyle };

        // 注意：id 字段会导致协议端报 1200 错误，暂不添加

        return {
          type: 'node',
          data: nodeData
        };
      }));

      const title = String(opts.title ?? '').trim().replaceAll('\\n', '\n');
      const payload = { messages: nodes };
      if (title) {
        payload.prompt = title;
        payload.source = title;
      }

      if (e?.group_id) {
        await bot.sendApi('send_group_forward_msg', {
          group_id: Number(e.group_id),
          ...payload
        });
      } else if (e?.user_id) {
        await bot.sendApi('send_private_forward_msg', {
          user_id: Number(e.user_id),
          ...payload
        });
      } else {
        return 'error: 无法确定发送目标，既没有 group_id 也没有 user_id';
      }

      return [
        `已发送伪造聊天记录（${nodes.length} 条）：`,
        nodes.map(n => `${n.data.nickname}(${n.data.user_id})`).join('、'),
        `；气泡样式已匹配 ${nodes.filter(n => n.data.message_style).length}/${nodes.length} 条。`,
        '卡片已经发出去了，回复时只需简短说一句，不要把伪造的内容再复述一遍。'
      ].join('');
    } catch (error) {
      logger?.error?.('[fakeChatTool] 发送伪造聊天记录失败:', error);
      return `error: 发送失败: ${error.message}（图片/文件直链过期或协议端不支持合并转发都会导致失败）`;
    }
  }
}

export default FakeChatTool;
