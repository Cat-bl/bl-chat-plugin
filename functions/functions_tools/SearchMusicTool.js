import { AbstractTool } from './AbstractTool.js';
import fetch from 'node-fetch';
import md5 from 'md5';
import YAML from "yaml";
import path from "path";

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
  }

  async func(opts, e) {
    const { keyword, isArtistOnly = false } = opts;
    const config = this.loadConfig();
    const { qqMusicToken } = config || {};
    if (qqMusicToken) this.musicCookies.qqmusic = qqMusicToken
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
    const configPath = path.join(process.cwd(), 'plugins/test-plugin/config/message.yaml');
    return YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings;
  }
}
