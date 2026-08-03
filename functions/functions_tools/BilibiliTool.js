import { AbstractTool } from './AbstractTool.js';
import { biliGetJson, cleanTitle, formatCount } from '../tools/biliApi.js';

/**
 * Bilibili 综合信息查询工具：热门榜 / 热搜词 / 开播查询 / UP主查询 / 番剧时间表。
 * 只返回文本给模型转述，不直接向群里发消息（避免榜单类长内容刷屏）。
 */
export class BilibiliTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'bilibiliTool';
    this.description =
      'B站信息查询工具。查B站热门视频榜、热搜词（用户想吃瓜/问最近有什么热门时）、' +
      '查某个主播是否开播、查UP主信息（粉丝数/签名/认证）、查今天番剧更新时间表时调用。' +
      '查到的内容用你自己的语气转述，不用原样复述全部条目';
    this.keywords = ['B站', '热门', '热搜', '开播', 'UP主', '番剧', '直播'];
    this.intent = '用户想了解B站热门内容、主播开播状态、UP主信息或番剧更新时的意图';
    this.examples = [
      'B站今天有什么热门视频',
      '看看B站热搜',
      '某某主播开播了吗',
      '影视飓风现在多少粉丝',
      '今天更新什么番'
    ];
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['hot', 'hotword', 'live', 'up', 'bangumi'],
          description:
            '查询类型：hot=热门视频榜、hotword=热搜词榜、live=查主播开播状态(需要name)、' +
            'up=查UP主信息(需要name)、bangumi=今日番剧更新时间表'
        },
        name: {
          type: 'string',
          description: '主播名或UP主名，action 为 live/up 时必填'
        }
      },
      required: ['action']
    };
  }

  async func(opts, e) {
    const action = String(opts.action || '').trim();
    const name = String(opts.name || '').trim();
    try {
      switch (action) {
        case 'hot':
          return await this.getHotVideos();
        case 'hotword':
          return await this.getHotwords();
        case 'live':
          if (!name) return 'error: 查开播状态需要提供主播名（name 参数）';
          return await this.getLiveStatus(name);
        case 'up':
          if (!name) return 'error: 查UP主需要提供名字（name 参数）';
          return await this.getUpInfo(name);
        case 'bangumi':
          return await this.getBangumiTimeline();
        default:
          return `error: 未知的查询类型「${action}」，可用：hot/hotword/live/up/bangumi`;
      }
    } catch (err) {
      console.error(err);
      return `error: B站查询失败：${err.message}`;
    }
  }

  async getHotVideos() {
    const json = await biliGetJson('https://api.bilibili.com/x/web-interface/popular', { ps: 10, pn: 1 });
    const list = json.data?.list || [];
    if (!list.length) return 'error: 未获取到热门视频';
    const lines = list.map((v, i) => {
      const reason = v.rcmd_reason?.content ? `，${v.rcmd_reason.content}` : '';
      return `${i + 1}. ${cleanTitle(v.title)} - ${v.owner?.name || '未知UP'}` +
        `（播放${formatCount(v.stat?.view)}${reason}）https://www.bilibili.com/video/${v.bvid}`;
    });
    return `B站当前热门视频榜：\n${lines.join('\n')}`;
  }

  async getHotwords() {
    const json = await biliGetJson('https://s.search.bilibili.com/main/hotword');
    const list = json.list || [];
    if (!list.length) return 'error: 未获取到热搜词';
    const lines = list.slice(0, 10).map((w, i) => `${i + 1}. ${w.show_name || w.keyword}`);
    return `B站当前热搜榜：\n${lines.join('\n')}`;
  }

  /** 按名字搜B站用户，返回最匹配的一个（找不到返回 null） */
  async searchUser(name) {
    const json = await biliGetJson(
      'https://api.bilibili.com/x/web-interface/search/type',
      { keyword: name, search_type: 'bili_user', page: 1 },
      { signed: true }
    );
    return (json.data?.result || [])[0] || null;
  }

  async getLiveStatus(name) {
    const user = await this.searchUser(name);
    if (!user) return `B站上没搜到叫「${name}」的用户`;
    const room = await biliGetJson('https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld', { mid: user.mid });
    const d = room.data || {};
    if (!d.roomStatus) return `${user.uname}（uid ${user.mid}）没有开通直播间`;
    if (d.liveStatus === 1) {
      return `${user.uname} 正在直播：「${cleanTitle(d.title)}」，人气 ${formatCount(d.online)}，直播间 ${d.url}`;
    }
    const statusText = d.liveStatus === 2 ? '在轮播（没真人直播）' : '没开播';
    return `${user.uname} 现在${statusText}，直播间 ${d.url}`;
  }

  async getUpInfo(name) {
    const user = await this.searchUser(name);
    if (!user) return `B站上没搜到叫「${name}」的用户`;
    // 搜索结果的 fans 有缓存延迟，relation/stat 拿实时粉丝数（失败就用搜索结果的）
    let fans = user.fans;
    try {
      const stat = await biliGetJson('https://api.bilibili.com/x/relation/stat', { vmid: user.mid });
      fans = stat.data?.follower ?? fans;
    } catch {}
    const parts = [
      `${user.uname}（uid ${user.mid}）`,
      `粉丝 ${formatCount(fans)}`,
      `投稿 ${user.videos ?? '未知'} 个`
    ];
    if (user.official_verify?.desc) parts.push(`认证：${user.official_verify.desc}`);
    if (user.usign) parts.push(`签名：${user.usign}`);
    return parts.join('，');
  }

  async getBangumiTimeline() {
    const json = await biliGetJson('https://api.bilibili.com/pgc/web/timeline', { types: 1, before: 0, after: 0 });
    const today = (json.result || []).find(d => d.is_today);
    const eps = today?.episodes || [];
    if (!eps.length) return '今天没有番剧更新';
    const lines = eps.map(ep =>
      [ep.pub_time, cleanTitle(ep.title), ep.pub_index].filter(Boolean).join(' ')
    );
    return `今日（${today.date}）番剧更新 ${eps.length} 部：\n${lines.join('\n')}`;
  }
}
