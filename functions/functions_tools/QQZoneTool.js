import { AbstractTool } from './AbstractTool.js';
import { QQApi } from '../../utils/QQApi.js';
// QqZone.js
export class QQZoneTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'qqZoneTool';
    this.description = '这是一个可以实现你发送或者删除qq空间说说的工具，当你觉得对话很有趣或者值得记录的时候可以调用实现发送说说(对话时主动调用可以稍微积极一些)，用户明确提出删除qq空间说说时你可以调用该工具删除说说，但是用户主动提出发送说说时你不能调用(发送说说只能你自己觉的可以调用时再主动调用)';
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: 'string',
          description: '你将要发送到qq空间说说的内容(以发送者的角度生成流畅通顺的内容)',
        },
        type: {
          type: 'boolean',
          description: '是否是删除说说',
          default: false
        },
        pos: {
          type: 'number',
          description: '删除第几个说说',
          default: 1
        },
      },
      required: [],
    };

  }

  async func(opts, e) {
    const { text, type = false, pos = 1} = opts;
    if (!type) {
      try {
        if (!text) return {
          status: 'error',
          message: "发送说说失败，没有要发送的内容"
        };
        const result = await new QQApi(e).setQzone(text, e.img)
        if (result.code != 0) return {
          status: 'error',
          message: `❎ 说说发表失败\n${JSON.stringify(result)}`
        };
        return {
          status: 'success',
          message: `✅ 说说发表成功，内容：\n", ${result.content}`
        };
      }
      catch (error) {
        return {
          status: 'error',
          message: `发送说说失败，${error}`
        };
      }
    } else {
      if (!pos) return "❎ 请描述要删除第几个说说"
      // 获取说说列表
      let list = await new QQApi(e).getQzone(1, pos - 1)

      if (!list?.msglist) return "❎ 未获取到该说说"

      // 要删除的说说
      let domain = list.msglist[0]
      // 请求接口
      let result = await new QQApi(e).delQzone(domain.tid, domain.t1_source)
      if (!result) return "❎删除说说失败"

      if (result.subcode != 0) return "❎ 未知错误" + JSON.parse(result)
      // 发送结果
      return `✅ 删除说说成功：\n ${pos}.${domain.content} \n - [${domain.secret ? "私密" : "公开"}]${domain.commentlist?.length || 0} 条评论`

    }

  }
}