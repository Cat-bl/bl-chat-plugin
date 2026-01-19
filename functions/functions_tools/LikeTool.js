import { AbstractTool } from './AbstractTool.js';

// LikeTool.js
export class LikeTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'likeTool';
    this.description = '点赞工具';
    this.keywords = ['点赞', '赞', '给赞'];
    this.intent = '用户请求点赞相关的操作，包括给他人点赞或请求他人给自己点赞';
    this.parameters = {
      type: "object",
      properties: {
        qq: {
          type: 'string',
          description: '目标用户QQ号。留空则使用at或发送者QQ'
        },
        count: {
          type: 'number',
          description: '点赞次数(最多20次)',
          default: 10,
          minimum: 1,
          maximum: 20
        },
        random: {
          type: 'boolean',
          description: '是否随机选择成员点赞',
          default: false
        }
      }
    };
  }

  async func(opts, e) {
    const { qq, count = 10, random = false } = opts;
    const MAX_LIKES = 20;
    const actualCount = Math.min(count, MAX_LIKES);

    try {
      // 确定目标用户
      let targetQQ;

      if (!qq || random) {
        // 如果有at，优先使用at的用户
        if (e.at) {
          targetQQ = e.at;
        } else if (random) {
          // 随机选择一个群成员
          const group = await e.bot.pickGroup(e.group_id);
          const members = await group.getMemberMap();
          const availableMembers = Array.from(members.keys())
            .filter(id => id !== e.bot.uin && id !== e.sender.user_id);

          if (availableMembers.length === 0) {
            return '没有可用的目标用户';
          }

          targetQQ = availableMembers[Math.floor(Math.random() * availableMembers.length)];
        } else {
          // 默认使用发送者QQ
          targetQQ = e.sender.user_id;
        }
      } else {
        targetQQ = qq;
      }

      // 执行点赞
      const targetQQNum = Number(targetQQ);
      const bot = e.bot ?? Bot
      const result = await this.thumbUp(bot, targetQQNum, actualCount)

      if (result.code === 0) {
        return {
          status: 'success',
          target: targetQQ,
          count: actualCount,
          isRandom: random,
          message: result.msg
        };
      } else {
        return {
          status: 'error',
          target: targetQQ,
          error: result.msg || '点赞失败'
        };
      }

    } catch (error) {
      logger.error(`[LikeTool] 点赞失败: ${error}`);
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async thumbUp(bot, uid, times = 1) {
    try {
      let core = bot.icqq?.core
      if (!core) core = (await import("icqq")).core
      if (times > 20) times = 20

      let ReqFavorite
      if (bot.fl.get(uid)) {
        // 好友点赞
        ReqFavorite = core.jce.encodeStruct([
          core.jce.encodeNested([bot.uin, 1, bot.sig.seq + 1, 1, 0, Buffer.from("0C180001060131160131", "hex")]),
          uid, 0, 1, Number(times)
        ])
      } else {
        // 陌生人点赞
        ReqFavorite = core.jce.encodeStruct([
          core.jce.encodeNested([bot.uin, 1, bot.sig.seq + 1, 1, 0, Buffer.from("0C180001060131160135", "hex")]),
          uid, 0, 5, Number(times)
        ])
      }

      const body = core.jce.encodeWrapper({ ReqFavorite }, "VisitorSvc", "ReqFavorite", bot.sig.seq + 1)
      const payload = await bot.sendUni("VisitorSvc.ReqFavorite", body)
      let result = core.jce.decodeWrapper(payload)[0]
      return { code: result[3], msg: result[4] }
    } catch (error) {
      return this.origThumbUp(bot, uid, times)
    }
  }

  async origThumbUp(bot, uid, times) {
    const friend = bot.pickFriend(uid)
    if (!friend?.thumbUp) {
      return { code: 1, msg: "当前协议端不支持点赞" }
    }
    try {
      const res = await friend.thumbUp(times)
      if (typeof res === "boolean") {
        return { code: res ? 0 : 1, msg: res ? "点赞成功" : "点赞失败" }
      }
      return { code: res.code ?? res.retcode ?? 0, msg: res.msg ?? res.message ?? "点赞成功" }
    } catch (err) {
      if (err?.error) {
        return { code: err.error.code ?? err.error.retcode ?? 1, msg: err.error.msg ?? err.error.message ?? "点赞失败" }
      }
      return { code: 1, msg: err?.message ?? "点赞失败" }
    }
  }
}