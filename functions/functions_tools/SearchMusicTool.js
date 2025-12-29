import { AbstractTool } from './AbstractTool.js';
import fetch from 'node-fetch';
import md5 from 'md5';
import YAML from "yaml";
import path from "path";
import fs from "fs";

const NO_PIC = '';

export class SearchMusicTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'searchMusicTool';
    this.description = '根据关键词搜索QQ音乐的歌曲信息,或者有用户想听歌时，又或者时机合适时调用';
    this.parameters = {
      type: "object",
      properties: {
        keyword: {
          type: 'string',
          description: '音乐的标题或关键词, 可以是歌曲名或歌曲名+歌手名的组合'
        },
        isArtistOnly: {
          type: 'boolean',
          description: '是否只搜索歌手（当用户只提供歌手名，没有指定具体歌曲时为true）',
          default: false
        }
      },
      required: ['keyword']
    };
    this.musicCookies = {
      netease: '',
      qqmusic: ''
    };
    this.highQuality = true;
    this.randomPoolSize = 20; // 随机池大小
    this.updateTime = 0;      // 上次检查刷新时间
    this.refreshNum = 0;      // 刷新失败次数
    this.ckInit = false;      // 是否已初始化
  }

  async func(opts, e) {
    const { keyword, isArtistOnly = false } = opts;
    const config = this.loadConfig();
    const { qqMusicToken } = config || {};
    if (qqMusicToken) this.musicCookies.qqmusic = qqMusicToken;
    await this.updateQQMusicCk();
    try {
      // 根据是否只搜歌手决定搜索数量
      const searchCount = isArtistOnly ? this.randomPoolSize : 1;
      const result = await this.searchQQMusic(keyword, 1, searchCount);

      if (!result?.data?.length) {
        return '未找到相关的音乐。';
      }

      // 如果是歌手搜索，随机选一首；否则选第一首
      let selectedData;
      if (isArtistOnly && result.data.length > 1) {
        const randomIndex = Math.floor(Math.random() * result.data.length);
        selectedData = result.data[randomIndex];
      } else {
        selectedData = result.data[0];
      }

      const song = await this.parseSongData(selectedData, e);

      await Bot.sendApi('send_group_msg', {
        group_id: e.group_id,
        message: [{
          type: "music",
          data: {
            type: "custom",
            url: song.link,
            audio: song.url,
            title: song.name,
            image: song.pic,
            singer: song.artist
          }
        }]
      });

      const modeText = isArtistOnly ? `（从${result.data.length}首歌中随机选择）` : '';
      return `点歌成功了${modeText}，这是发送的数据:\nid: ${song.id}, name: ${song.name}, artists: ${song.artist}, audio: ${song.url}`;
    } catch (error) {
      logger.error('执行过程中发生错误:', error);
      return `音乐搜索失败: ${error.message}`;
    }
  }

  async parseSongData(data, e) {
    const name = data.title.replace(/<\/?em>/g, '');
    const artist = data.singer?.map(s => s.name).join('/') || '';
    const albumMid = data.album?.mid || '';
    const singerMid = data.singer?.[0]?.mid || '';

    const picPath = data.vs?.[1]
      ? `T062R150x150M000${data.vs[1]}`
      : albumMid ? `T002R150x150M000${albumMid}`
        : singerMid ? `T001R150x150M000${singerMid}` : '';

    return {
      id: data.mid,
      name,
      artist,
      pic: picPath ? `http://y.gtimg.cn/music/photo_new/${picPath}.jpg` : NO_PIC,
      link: `https://y.qq.com/n/yqq/song/${data.mid}.html`,
      url: await this.getPlayUrl(data, e)
    };
  }

  async getPlayUrl(data, e) {
    const code = md5(`${data.mid}q;z(&l~sdf2!nK`).substring(0, 5).toUpperCase();
    let playUrl = `http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songid=&songmid=${data.mid}&songtype=1&fromtag=50&uin=${e?.self_id || e.bot?.uin}&code=${code}`;

    if ((data.sa === 0 && data.pay?.price_track === 0) || data.pay?.pay_play === 1 || this.highQuality) {
      try {
        const quality = [
          ['size_flac', 'F000', 'flac'],           // FLAC 无损 (约 800-1000kbps)
          ['size_hires', 'RS01', 'flac'],          // Hi-Res 高解析度 (24bit)
          ['size_96ogg', 'O800', 'ogg'],           // 96k OGG (如果有)
          ['size_320mp3', 'M800', 'mp3'],          // 320kbps MP3
          ['size_192ogg', 'O600', 'ogg'],          // 192kbps OGG
          ['size_128mp3', 'M500', 'mp3'],          // 128kbps MP3
          ['size_96aac', 'C400', 'm4a']            // 96kbps AAC
        ];

        const mediaMid = data.file?.media_mid;
        const songmid = [], filename = [], songtype = [];

        for (const [sizeKey, prefix, ext] of quality) {
          if (data.file?.[sizeKey] > 0) {
            songmid.push(data.mid);
            songtype.push(0);
            filename.push(`${prefix}${mediaMid}.${ext}`);
          }
        }

        if (!songmid.length) songmid.push(data.mid);

        const body = {
          ...this.getCommBody(),
          req_0: {
            module: "vkey.GetVkeyServer",
            method: "CgiGetVkey",
            param: {
              guid: md5(String(Date.now())),
              songmid,
              songtype: songtype.length ? songtype : [0],
              uin: "0",
              ctx: 1,
              ...(filename.length && { filename })
            }
          }
        };
        // logger.error(JSON.stringify(body))
        const res = await this.postJson('https://u.y.qq.com/cgi-bin/musicu.fcg', body);
        const purl = res?.req_0?.data?.midurlinfo?.find(m => m.purl)?.purl;
        if (purl) playUrl = `http://ws.stream.qqmusic.qq.com/${purl}`;
      } catch (err) {
        logger.error(err);
      }
    }
    return playUrl;
  }

  async searchQQMusic(query, page = 1, pageSize = 1) {
    try {
      const body = {
        comm: { uin: "0", authst: "", ct: 29 },
        search: {
          method: "DoSearchForQQMusicMobile",
          module: "music.search.SearchCgiService",
          param: {
            grp: 1,
            num_per_page: pageSize,
            page_num: page,
            query,
            remoteplace: "miniapp.1109523715",
            search_type: 0,
            searchid: String(Date.now())
          }
        }
      };
      const res = await this.postJson('https://u.y.qq.com/cgi-bin/musicu.fcg', body, {
        Cookie: Bot?.cookies?.['y.qq.com'] || this.musicCookies.qqmusic || ''
      });

      if (res?.code !== 0) return null;
      const songBody = res.search?.data?.body || {};
      return { page, data: songBody.song?.list || songBody.item_song || [] };
    } catch {
      return null;
    }
  }

  async postJson(url, body, extraHeaders = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  getCommBody() {
    const ckMap = this.getCookieMap();
    return {
      comm: {
        _channelid: "19",
        _os_version: "6.2.9200-2",
        authst: ckMap.get('qm_keyst') || ckMap.get('music_key') || '',
        ct: "19",
        cv: "1891",
        guid: md5(String(Bot?.uin || '000000') + 'music'),
        patch: "118",
        psrf_access_token_expiresAt: 0,
        psrf_qqaccess_token: '',
        psrf_qqopenid: '',
        psrf_qqunionid: ckMap.get('psrf_qqunionid') || '',
        tmeAppID: "qqmusic",
        tmeLoginType: 2,
        uin: ckMap.get('uin') || '',
        wid: "0"
      }
    };
  }

  getCookieMap() {
    const cookie = this.musicCookies.qqmusic || '';
    const map = new Map();
    cookie.replace(/\s/g, '').split(';').forEach(item => {
      const [key, val] = item.split('=');
      if (key) map.set(key, val);
    });
    return map;
  }

  // 加载配置
  loadConfig() {
    const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
  }

  // 保存配置
  saveConfig(newToken) {
    try {
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      config.pluginSettings.qqMusicToken = newToken;
      fs.writeFileSync(configPath, YAML.stringify(config), 'utf8');
    } catch (err) {
      logger.error('[SearchMusicTool] 保存配置失败:', err);
    }
  }

  // 检查并刷新QQ音乐cookie
  async updateQQMusicCk() {
    try {
      // 每10分钟检查一次
      if ((Date.now() - this.updateTime) < (1000 * 60 * 10)) {
        return;
      }
      this.updateTime = Date.now();

      const ckMap = this.getCookieMap();
      let type = -1; // QQ:0, 微信:1

      if (ckMap.get('wxunionid')) {
        type = 1;
      } else if (ckMap.get('psrf_qqunionid')) {
        type = 0;
      } else {
        if (!this.ckInit) {
          this.ckInit = true;
          logger.info('[SearchMusicTool] 未设置QQ音乐ck');
        }
        return;
      }

      const authst = ckMap.get('qqmusic_key') || ckMap.get('qm_keyst');
      const createTime = Number(ckMap.get('psrf_musickey_createtime') || 0) * 1000;

      // 如果cookie创建时间超过12小时或没有authst则刷新
      if (((Date.now() - createTime) > (1000 * 60 * 60 * 12) || !authst)) {
        const result = await this.refreshQQMusicToken(ckMap, type);
        if (result.code === 1) {
          this.musicCookies.qqmusic = result.data;
          this.refreshNum = 0;
          this.saveConfig(result.data);
          logger.info('[SearchMusicTool] QQ音乐ck已刷新');
        } else {
          this.refreshNum++;
          this.ckInit = false;
          logger.error('[SearchMusicTool] QQ音乐ck刷新失败');
        }
      } else if (this.refreshNum >= 3) {
        if (!this.ckInit) {
          this.ckInit = true;
          logger.error('[SearchMusicTool] QQ音乐ck已失效');
        }
      }
    } catch (err) {
      logger.error('[SearchMusicTool] 更新ck出错:', err);
    }
  }

  // 刷新QQ音乐token
  async refreshQQMusicToken(ckMap, type) {
    const result = { code: -1 };
    const body = {
      comm: {
        _channelid: "19",
        _os_version: "6.2.9200-2",
        authst: "",
        ct: "19",
        cv: "1891",
        guid: md5(String(ckMap.get('uin') || ckMap.get('wxuin')) + 'music'),
        patch: "118",
        psrf_access_token_expiresAt: 0,
        psrf_qqaccess_token: "",
        psrf_qqopenid: "",
        psrf_qqunionid: "",
        tmeAppID: "qqmusic",
        tmeLoginType: 2,
        uin: "0",
        wid: "0"
      },
      req_0: {
        method: "Login",
        module: "music.login.LoginServer",
        param: {
          access_token: "",
          expired_in: 0,
          forceRefreshToken: 0,
          musicid: 0,
          musickey: "",
          onlyNeedAccessToken: 0,
          openid: "",
          refresh_token: "",
          unionid: ""
        }
      }
    };

    const param = body.req_0.param;
    if (type === 0) {
      // QQ登录
      param.appid = 100497308;
      param.access_token = ckMap.get('psrf_qqaccess_token') || '';
      param.musicid = Number(ckMap.get('uin') || '0');
      param.openid = ckMap.get('psrf_qqopenid') || '';
      param.refresh_token = ckMap.get('psrf_qqrefresh_token') || '';
      param.unionid = ckMap.get('psrf_qqunionid') || '';
    } else if (type === 1) {
      // 微信登录
      param.strAppid = "wx48db31d50e334801";
      param.access_token = ckMap.get('wxaccess_token') || '';
      param.str_musicid = ckMap.get('wxuin') || '0';
      param.openid = ckMap.get('wxopenid') || '';
      param.refresh_token = ckMap.get('wxrefresh_token') || '';
      param.unionid = ckMap.get('wxunionid') || '';
    } else {
      return result;
    }
    param.musickey = (ckMap.get('qqmusic_key') || ckMap.get('qm_keyst')) || '';

    try {
      const res = await this.postJson('https://u.y.qq.com/cgi-bin/musicu.fcg', body);
      if (res?.req_0?.code === 0) {
        const data = res.req_0.data;
        const cookies = [];

        if (type === 0) {
          cookies.push(`psrf_qqopenid=${data.openid}`);
          cookies.push(`psrf_qqrefresh_token=${data.refresh_token}`);
          cookies.push(`psrf_qqaccess_token=${data.access_token}`);
          cookies.push(`uin=${data.str_musicid || data.musicid || '0'}`);
          cookies.push(`qqmusic_key=${data.musickey}`);
          cookies.push(`qm_keyst=${data.musickey}`);
          cookies.push(`psrf_musickey_createtime=${data.musickeyCreateTime}`);
          cookies.push(`psrf_qqunionid=${data.unionid}`);
          cookies.push(`euin=${data.encryptUin}`);
          cookies.push(`login_type=1`);
          cookies.push(`tmeLoginType=2`);
        } else if (type === 1) {
          cookies.push(`wxopenid=${data.openid}`);
          cookies.push(`wxrefresh_token=${data.refresh_token}`);
          cookies.push(`wxaccess_token=${data.access_token}`);
          cookies.push(`wxuin=${data.str_musicid || data.musicid || '0'}`);
          cookies.push(`qqmusic_key=${data.musickey}`);
          cookies.push(`qm_keyst=${data.musickey}`);
          cookies.push(`psrf_musickey_createtime=${data.musickeyCreateTime}`);
          cookies.push(`wxunionid=${data.unionid}`);
          cookies.push(`euin=${data.encryptUin}`);
          cookies.push(`login_type=2`);
          cookies.push(`tmeLoginType=1`);
        }

        result.code = 1;
        result.data = cookies.join(';');
      }
    } catch (err) {
      logger.error('[SearchMusicTool] 刷新token出错:', err);
    }
    return result;
  }
}
