import { AbstractTool } from './AbstractTool.js';

/**
 * 伪造聊天记录工具
 * 通过 OneBot v11 的合并转发接口（send_group_forward_msg / send_private_forward_msg）
 * 构造并发送一段自定义的"聊天记录"
 */

// 旧版字符串占位写法继续兼容；复杂消息使用标准 OneBot v11 消息段数组。
const MEDIA_RE = /(pic|file|video)\[([^\]]+)\]/g;
const TYPE_MAP = {
  pic: 'image',
  file: 'file',
  video: 'video'
};
const MAX_NODES = 99;
const MAX_SEGMENTS = 500;
const MAX_NICKNAME_CONCURRENCY = 8;
// NapCat Packet 模式在递归深度达到 3 时停止解析；两层嵌套是两端共同可靠上限。
const MAX_FORWARD_DEPTH = 2;
const SEGMENT_TYPES = [
  'text',
  'at',
  'face',
  'image',
  'video',
  'file',
  'dice',
  'rps',
  'contact',
  'forward'
];
const UNKNOWN_PROTOCOL_FALLBACK_TYPES = new Set([
  'video',
  'file',
  'dice',
  'rps',
  'contact',
  'forward'
]);

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: SEGMENT_TYPES,
      description: 'OneBot v11 消息段类型'
    },
    data: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        qq: { type: 'string', description: '@目标QQ号，或字符串 all 表示@全体' },
        id: { type: 'string', description: '表情ID、联系人ID或已有转发ID，按type使用' },
        file: { type: 'string', description: '图片、视频或文件的URL、本地路径或base64' },
        name: { type: 'string', description: '文件名或@显示名' },
        summary: { type: 'string', description: '图片说明' },
        result: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          description: '期望结果：骰子为1-6，猜拳为1-3；协议端可能忽略并随机'
        },
        type: { type: 'string', description: '联系人类型qq/group' },
        url: { type: 'string', description: '图片、视频或文件链接，file的兼容别名' },
        cover: { type: 'string', description: '视频封面链接（可选）' },
        thumb: { type: 'string', description: '视频封面链接，cover的兼容别名（可选）' },
        messages: {
          type: 'array',
          items: { type: 'object' },
          minItems: 1,
          maxItems: MAX_NODES,
          description: '凭空构造嵌套转发时填写，元素格式与顶层messages完全相同'
        }
      },
      required: []
    }
  },
  required: ['type', 'data']
};

class FakeChatInputError extends Error {}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

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
    globalThis.logger?.warn?.(`[fakeChatTool] 读取主人配置失败，跳过主人保护: ${getErrorMessage(error)}`);
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
      'content既可直接填写字符串，也可填写OneBot v11消息段数组；支持文字、@、QQ表情、图片、视频、文件、骰子、猜拳、联系人名片和嵌套合并转发。',
      '已有转发只能使用聊天上下文中真实存在的ID，禁止编造；@在聊天记录卡片内只负责显示，不会真的通知对方。',
      '骰子和猜拳可填写期望结果，但QQ协议端可能仍会随机展示。',
      '调用时必须提供message_ids数组：从聊天上下文中为每个被伪造QQ选取最新一条[消息ID:xxx]以自动复用真实气泡；某个QQ没有可用ID时不要为其填写，完全没有可用ID时传[]，禁止编造。',
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
                pattern: '^[1-9]\\d{4,}$',
                description: '这条消息的发送者QQ号（必填），决定卡片里显示的头像'
              },
              name: {
                type: 'string',
                description: '显示的昵称（可选）。不填则自动查询该QQ的群名片或昵称'
              },
              content: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'array',
                    items: SEGMENT_SCHEMA,
                    minItems: 1,
                    maxItems: MAX_SEGMENTS
                  }
                ],
                description: [
                  '消息内容（必填）。普通文字直接传字符串；旧占位写法pic[]、video[]、file[]仍可用。',
                  '复杂内容传OneBot v11消息段数组，例如text.data.text、at.data.qq、face.data.id、',
                  'image/video/file.data.file、dice/rps.data.result、contact、forward。',
                  '已有合并转发用forward.data.id；凭空嵌套用forward.data.messages，内部元素格式与顶层messages相同。',
                  `最多嵌套 ${MAX_FORWARD_DEPTH} 层，所有层合计最多 ${MAX_NODES} 个节点、${MAX_SEGMENTS} 个消息段。`
                ].join('')
              },
              time: {
                type: 'integer',
                minimum: 1,
                description: '消息的发送时间（可选，Unix秒级时间戳）。可以自定义任意历史时间，比如伪造2005年的聊天记录。不填则自动使用当前时间附近的时间戳'
              }
            },
            required: ['qq', 'content']
          },
          minItems: 1,
          maxItems: MAX_NODES,
          description: `聊天记录的消息列表，按先后顺序排列，最多 ${MAX_NODES} 条`
        },
        message_ids: {
          type: 'array',
          items: { type: 'string', pattern: '^-?\\d+$' },
          maxItems: MAX_NODES,
          uniqueItems: true,
          description: '被伪造QQ的最近真实消息ID数组，必须始终提供。从聊天历史记录中的[消息ID:xxx]获取，每个QQ最多取最新一条；完全没有可用ID时传[]，禁止编造'
        },
        title: {
          type: 'string',
          description: '合并转发卡片的外显描述（可选），例如 "群友的深夜发言"。不填则用QQ默认样式'
        }
      },
      required: ['messages', 'message_ids']
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
   * 把旧版 content 字符串解析成 OneBot 消息段数组。
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
      segments.push({ type: TYPE_MAP[match[1]], data: { file: match[2].trim() } });
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

  async resolveNicknames(bot, e, messages) {
    const pending = new Map();
    for (const item of messages) {
      const key = `${item.qq}|${String(item.name ?? '').trim()}`;
      if (!pending.has(key)) pending.set(key, item);
    }

    const cache = new Map();
    const entries = [...pending.entries()];
    for (let index = 0; index < entries.length; index += MAX_NICKNAME_CONCURRENCY) {
      const batch = entries.slice(index, index + MAX_NICKNAME_CONCURRENCY);
      await Promise.all(batch.map(async ([key, item]) => {
        cache.set(key, await this.resolveNickname(bot, e, item.qq, item.name));
      }));
    }
    return cache;
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

  readNonEmpty(value, path) {
    if (value === undefined || value === null) {
      throw new FakeChatInputError(`${path} 不能为空`);
    }
    if (!['string', 'number'].includes(typeof value)) {
      throw new FakeChatInputError(`${path} 必须是字符串或数字`);
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new FakeChatInputError(`${path} 数值超出安全整数范围，请改用字符串`);
    }
    const result = String(value ?? '').trim();
    if (!result) throw new FakeChatInputError(`${path} 不能为空`);
    return result;
  }

  readOptionalString(value, path) {
    if (value === undefined || value === null || value === '') return '';
    if (!['string', 'number'].includes(typeof value)) {
      throw new FakeChatInputError(`${path} 必须是字符串或数字`);
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new FakeChatInputError(`${path} 数值超出安全整数范围，请改用字符串`);
    }
    return String(value).trim();
  }

  readInteger(value, path, minimum, maximum, required = true) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      if (required) throw new FakeChatInputError(`${path} 不能为空`);
      return undefined;
    }

    let result;
    if (typeof value === 'number') {
      result = value;
    } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      result = Number(value.trim());
    } else {
      throw new FakeChatInputError(`${path} 必须是 ${minimum}-${maximum} 的整数`);
    }

    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
      throw new FakeChatInputError(`${path} 必须是 ${minimum}-${maximum} 的整数`);
    }
    return result;
  }

  readQQNumber(value, path, allowAll = false) {
    const result = this.readNonEmpty(value, path).toLowerCase();
    if (allowAll && result === 'all') return result;
    if (!/^[1-9]\d{4,}$/.test(result) || !Number.isSafeInteger(Number(result))) {
      throw new FakeChatInputError(`${path} 必须是合法的数字QQ号或群号${allowAll ? '，或 all' : ''}`);
    }
    return result;
  }

  normalizeSegment(segment, path, depth, state) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      throw new FakeChatInputError(`${path} 应为 { type, data } 对象`);
    }

    const type = String(segment.type ?? '').trim().toLowerCase();
    if (!SEGMENT_TYPES.includes(type)) {
      throw new FakeChatInputError(`${path}.type "${type}" 不受支持`);
    }
    const data = segment.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new FakeChatInputError(`${path}.data 必须是对象`);
    }

    if (type === 'text') {
      if (!['string', 'number'].includes(typeof data.text)) {
        throw new FakeChatInputError(`${path}.data.text 必须是字符串或数字`);
      }
      if (typeof data.text === 'number' && !Number.isSafeInteger(data.text)) {
        throw new FakeChatInputError(`${path}.data.text 数值超出安全整数范围，请改用字符串`);
      }
      const text = String(data.text).replaceAll('\\n', '\n');
      if (!text.trim()) throw new FakeChatInputError(`${path}.data.text 不能为空`);
      return { type, data: { text } };
    }

    if (type === 'at') {
      const qq = this.readQQNumber(data.qq, `${path}.data.qq`, true);
      const normalized = { qq };
      const name = this.readOptionalString(data.name, `${path}.data.name`);
      if (name) normalized.name = name;
      return { type, data: normalized };
    }

    if (type === 'face') {
      const id = this.readInteger(data.id, `${path}.data.id`, 0, Number.MAX_SAFE_INTEGER);
      return { type, data: { id: String(id) } };
    }

    if (type === 'image') {
      const file = this.readNonEmpty(data.file ?? data.url, `${path}.data.file`);
      const normalized = { file };
      const summary = this.readOptionalString(data.summary, `${path}.data.summary`);
      if (summary) normalized.summary = summary;
      return { type, data: normalized };
    }

    if (type === 'video') {
      const file = this.readNonEmpty(data.file ?? data.url, `${path}.data.file`);
      const normalized = { file };
      const cover = this.readOptionalString(data.cover ?? data.thumb, `${path}.data.cover`);
      if (cover) {
        normalized.cover = cover;
        normalized.thumb = cover;
      }
      return { type, data: normalized };
    }

    if (type === 'file') {
      const file = this.readNonEmpty(data.file ?? data.url, `${path}.data.file`);
      const normalized = { file };
      const name = this.readOptionalString(data.name, `${path}.data.name`);
      if (name) normalized.name = name;
      return { type, data: normalized };
    }

    if (type === 'dice') {
      const result = this.readInteger(data.result, `${path}.data.result`, 1, 6, false);
      return { type, data: result === undefined ? {} : { result } };
    }

    if (type === 'rps') {
      const result = this.readInteger(data.result, `${path}.data.result`, 1, 3, false);
      return { type, data: result === undefined ? {} : { result } };
    }

    if (type === 'contact') {
      const contactType = this.readNonEmpty(data.type, `${path}.data.type`).toLowerCase();
      if (!['qq', 'group'].includes(contactType)) {
        throw new FakeChatInputError(`${path}.data.type 仅支持 qq 或 group`);
      }
      const id = this.readQQNumber(data.id, `${path}.data.id`);
      return { type, data: { type: contactType, id } };
    }

    const id = this.readOptionalString(data.id, `${path}.data.id`);
    const hasMessages = data.messages !== undefined;
    if (Boolean(id) === hasMessages) {
      throw new FakeChatInputError(`${path}.data 必须且只能填写 id 或 messages 其中一个`);
    }
    if (id) return { type, data: { id } };

    const messages = this.normalizeMessageList(
      data.messages,
      depth + 1,
      `${path}.data.messages`,
      state
    );
    return { type, data: { messages } };
  }

  normalizeContent(content, path, depth, state) {
    const segments = typeof content === 'string'
      ? this.parseContent(content)
      : content;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new FakeChatInputError(`${path} 必须是非空字符串或OneBot消息段数组`);
    }
    state.segmentCount = (state.segmentCount ?? 0) + segments.length;
    if (state.segmentCount > MAX_SEGMENTS) {
      throw new FakeChatInputError(`所有层的消息段合计不能超过 ${MAX_SEGMENTS} 个`);
    }
    return segments.map((segment, index) => (
      this.normalizeSegment(segment, `${path}[${index}]`, depth, state)
    ));
  }

  normalizeMessageList(raw, depth = 0, path = 'messages', state = { count: 0, segmentCount: 0 }) {
    if (depth > MAX_FORWARD_DEPTH) {
      throw new FakeChatInputError(`${path} 的嵌套层数超过 ${MAX_FORWARD_DEPTH} 层`);
    }
    const list = this.normalizeMessages(raw);
    if (!list.length) throw new FakeChatInputError(`${path} 不能为空`);

    return list.map((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new FakeChatInputError(`${itemPath} 应为 { qq, name, content } 对象`);
      }

      const qq = String(item.qq ?? '').trim();
      if (!/^[1-9]\d{4,}$/.test(qq) || !Number.isSafeInteger(Number(qq))) {
        throw new FakeChatInputError(`${itemPath}.qq "${qq}" 不是合法QQ号`);
      }

      state.count += 1;
      if (state.count > MAX_NODES) {
        throw new FakeChatInputError(`所有层的消息节点合计不能超过 ${MAX_NODES} 条`);
      }

      const name = this.readOptionalString(item.name, `${itemPath}.name`);
      const normalized = {
        qq,
        name: name || undefined,
        content: this.normalizeContent(item.content, `${itemPath}.content`, depth, state)
      };
      if (item.time !== undefined && item.time !== null && item.time !== '') {
        normalized.time = this.readInteger(
          item.time,
          `${itemPath}.time`,
          1,
          Number.MAX_SAFE_INTEGER
        );
      }
      return normalized;
    });
  }

  collectMessages(messages, result = []) {
    for (const message of messages) {
      result.push(message);
      for (const segment of message.content) {
        if (segment.type === 'forward' && segment.data.messages) {
          this.collectMessages(segment.data.messages, result);
        }
      }
    }
    return result;
  }

  normalizeMessageIds(raw) {
    const values = raw === undefined
      ? []
      : (Array.isArray(raw) ? raw : [raw]);
    if (values.length > MAX_NODES) {
      throw new FakeChatInputError(`message_ids 不能超过 ${MAX_NODES} 个`);
    }
    const result = new Set();
    for (const [index, value] of values.entries()) {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new FakeChatInputError(`第 ${index + 1} 个 message_ids 数值超出安全整数范围，请改用字符串`);
      }
      const messageId = String(value).trim();
      if (!/^-?\d+$/.test(messageId)) {
        throw new FakeChatInputError(`第 ${index + 1} 个 message_ids 格式错误`);
      }
      result.add(messageId);
    }
    return result;
  }

  getProtocol(bot) {
    const markers = [];
    const version = bot?.version;
    if (typeof version === 'string') markers.push(version);
    else if (version && typeof version === 'object') markers.push(...Object.values(version));
    markers.push(bot?.adapter?.name, bot?.adapter?.id);
    const text = markers.filter(value => value !== undefined && value !== null).join(' ').toLowerCase();

    if (text.includes('llonebot') || text.includes('luckylillia')) return 'llonebot';
    if (text.includes('napcat')) return 'napcat';
    return 'unknown';
  }

  isLLOneBot(bot) {
    return this.getProtocol(bot) === 'llonebot';
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

  toFallbackTextSegment(segment) {
    const { data } = segment;
    let text;
    switch (segment.type) {
      case 'video':
        text = `[视频: ${data.file}]`;
        break;
      case 'file':
        text = data.name ? `[文件: ${data.name} (${data.file})]` : `[文件: ${data.file}]`;
        break;
      case 'dice':
        text = `[骰子: ${data.result ?? '随机'}]`;
        break;
      case 'rps':
        text = `[猜拳: ${data.result ?? '随机'}]`;
        break;
      case 'contact':
        text = data.type === 'group'
          ? `[群聊名片: ${data.id}]`
          : `[QQ联系人名片: ${data.id}]`;
        break;
      case 'forward':
        text = `[合并转发: ${data.id}]`;
        break;
      default:
        return segment;
    }
    return { type: 'text', data: { text } };
  }

  adaptSegmentForProtocol(segment, protocol) {
    if (protocol === 'unknown' && UNKNOWN_PROTOCOL_FALLBACK_TYPES.has(segment.type)) {
      return this.toFallbackTextSegment(segment);
    }
    return segment;
  }

  async resolveNodeBase(item, index, total, context) {
    const key = `${item.qq}|${String(item.name ?? '').trim()}`;
    if (!context.nicknameCache.has(key)) {
      context.nicknameCache.set(
        key,
        this.resolveNickname(context.bot, context.e, item.qq, item.name)
      );
    }
    const nickname = await context.nicknameCache.get(key);
    const qqNum = Number(item.qq);
    const nodeData = {
      user_id: qqNum,
      nickname,
      uin: qqNum,
      name: nickname,
      time: item.time ?? (context.now - (total - index - 1))
    };
    const messageStyle = context.automaticStyles.get(item.qq);
    if (messageStyle) nodeData.message_style = { ...messageStyle };
    return nodeData;
  }

  buildNode(nodeBase, content, context) {
    context.compiledNodeCount += 1;
    if (context.compiledNodeCount > MAX_NODES) {
      throw new FakeChatInputError(`按当前协议拆分后不能超过 ${MAX_NODES} 个消息节点`);
    }
    return {
      type: 'node',
      data: {
        ...nodeBase,
        content,
        ...(nodeBase.message_style
          ? { message_style: { ...nodeBase.message_style } }
          : {})
      }
    };
  }

  assertApiSuccess(response, action) {
    if (response === undefined || response === null) {
      throw new Error(`${action} 未返回结果`);
    }
    const status = String(response?.status ?? '').toLowerCase();
    const retcode = response?.retcode;
    const failedStatus = Boolean(status) && !['ok', 'async'].includes(status);
    const numericRetcode = Number(retcode);
    const failedRetcode = retcode !== undefined
      && (!Number.isFinite(numericRetcode) || numericRetcode !== 0)
      && status !== 'async';
    if (failedStatus || failedRetcode) {
      const detail = response?.message || response?.wording || `retcode=${retcode ?? 'unknown'}`;
      throw new Error(`${action} 返回失败: ${detail}`);
    }
  }

  async compileMessage(item, index, total, context) {
    const result = [];
    const nodeBase = await this.resolveNodeBase(item, index, total, context);
    let mixedSegments = [];
    const flushMixed = () => {
      if (!mixedSegments.length) return;
      result.push(this.buildNode(nodeBase, mixedSegments, context));
      mixedSegments = [];
    };

    for (const rawSegment of item.content) {
      const nestedMessages = rawSegment.type === 'forward' && rawSegment.data.messages;
      if (nestedMessages) {
        flushMixed();
        const innerNodes = await this.compileMessages(nestedMessages, context);
        if (context.protocol === 'llonebot' || context.protocol === 'napcat') {
          result.push(this.buildNode(nodeBase, innerNodes, context));
        } else {
          result.push(...innerNodes);
        }
        continue;
      }

      const segment = this.adaptSegmentForProtocol(rawSegment, context.protocol);
      mixedSegments.push(segment);
    }

    flushMixed();
    return result;
  }

  async compileMessages(messages, context) {
    const nodes = [];
    for (const [index, item] of messages.entries()) {
      nodes.push(...await this.compileMessage(item, index, messages.length, context));
    }
    return nodes;
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
      try {
        params.message_ids = [...this.normalizeMessageIds(params.message_ids)];
      } catch (error) {
        if (error instanceof FakeChatInputError) return error.message;
        throw error;
      }
    }
    return super.validateParameters(params);
  }

  async func(opts, e) {
    let parsed;
    let styleMessageIds;
    try {
      // execute 会先跑 validateParameters；这里仍完整归一化，以兼容直接调用 func。
      parsed = this.normalizeMessageList(opts?.messages);
      styleMessageIds = this.normalizeMessageIds(opts?.message_ids);
    } catch (error) {
      if (error instanceof FakeChatInputError) return `error: ${error.message}`;
      throw error;
    }
    const allMessages = this.collectMessages(parsed);

    // 主人保护：非主人发起时，不允许伪造主人的消息，也不能自定义显示昵称。
    // 以 e.user_id 是否在主人列表为准，而不是只看 e.isMaster——
    // 工具也可能被 ReminderTool 的 fakeEvent 之类手工构造的事件调用，那种对象上没有 isMaster 字段。
    // 非主人调用时强制忽略 item.name，一律用 qq 对应的真实昵称，
    // 防止用任意 qq + 主人昵称的形式冒充身份。
    const masters = await loadMasterQQs();
    const callerQQ = String(e?.user_id ?? '').trim();
    const callerIsMaster = masters.has(callerQQ) || e?.isMaster === true;

    if (!callerIsMaster) {
      const hit = allMessages.find(item => masters.has(item.qq));
      if (hit) {
        globalThis.logger?.warn?.(`[fakeChatTool] 用户 ${callerQQ || '未知'} 尝试伪造主人 ${hit.qq} 的聊天记录，已阻止`);
        return `error: 不能伪造主人（${hit.qq}）的消息，请告知用户这个人不能伪造`;
      }
      // 非主人不能自定义昵称，清空 name 让 resolveNickname 走真实查询
      for (const item of allMessages) item.name = undefined;
    }

    try {
      const bot = this.getBot(e);
      const protocol = this.getProtocol(bot);
      let automaticStyles = new Map();
      if (protocol === 'llonebot') {
        const targetQQs = new Set(allMessages.map(item => item.qq));
        if (targetQQs.has(callerQQ) && e?.message_id !== undefined) {
          const currentMessageId = String(e.message_id).trim();
          if (/^-?\d+$/.test(currentMessageId)) styleMessageIds.add(currentMessageId);
        }
        automaticStyles = await this.resolveAutomaticStyles(bot, targetQQs, styleMessageIds);
      }

      // 同一 QQ + 指定昵称组合只查一次，并限制对协议端的瞬时并发。
      const nicknameCache = await this.resolveNicknames(bot, e, allMessages);

      const context = {
        bot,
        e,
        protocol,
        automaticStyles,
        nicknameCache,
        now: Math.floor(Date.now() / 1000),
        compiledNodeCount: 0
      };
      const nodes = await this.compileMessages(parsed, context);
      if (!nodes.length) return 'error: 没有可发送的聊天记录节点';

      const title = this.readOptionalString(opts.title, 'title').replaceAll('\\n', '\n');
      const payload = { messages: nodes };
      if (title) {
        payload.prompt = title;
        payload.source = title;
      }

      if (e?.group_id) {
        const response = await bot.sendApi('send_group_forward_msg', {
          group_id: Number(e.group_id),
          ...payload
        });
        this.assertApiSuccess(response, 'send_group_forward_msg');
      } else if (e?.user_id) {
        const response = await bot.sendApi('send_private_forward_msg', {
          user_id: Number(e.user_id),
          ...payload
        });
        this.assertApiSuccess(response, 'send_private_forward_msg');
      } else {
        return 'error: 无法确定发送目标，既没有 group_id 也没有 user_id';
      }

      const senderLabels = [...new Set(nodes.map(node => (
        `${node.data.nickname}(${node.data.user_id})`
      )))];
      const styledCount = allMessages.filter(item => automaticStyles.has(item.qq)).length;
      return [
        `已发送伪造聊天记录（${nodes.length} 条）：`,
        senderLabels.join('、'),
        `；气泡样式已匹配 ${styledCount}/${allMessages.length} 条。`,
        '卡片已经发出去了，回复时只需简短说一句，不要把伪造的内容再复述一遍。'
      ].join('');
    } catch (error) {
      if (error instanceof FakeChatInputError) return `error: ${error.message}`;
      globalThis.logger?.error?.('[fakeChatTool] 发送伪造聊天记录失败:', error);
      return `error: 发送失败: ${getErrorMessage(error)}（图片/文件直链过期或协议端不支持合并转发都会导致失败）`;
    }
  }
}

export default FakeChatTool;
