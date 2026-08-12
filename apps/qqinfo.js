import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import Qqinfo from "../model/qqinfo.js";
export class QQinfo extends plugin {
    constructor() {
        super({
            name: "进群查询qq信息",
            dsc: "进群查询qq信息",
            event: "message",
            priority: 5000,
            rule: [
                {
                    reg: '#查询qq.*$',
                    fnc: "getInfo",
                }
            ]
        })
    }

    async getInfo(e) {
        const bot = e.bot ?? Bot
        let atMsg
        atMsg = e.message?.filter(msg => {
            return msg.type == "at"
        })[0]
        let mid = atMsg?.qq || e.msg.replace(/#| |查询qq/g, "")
        if (mid == "" || !/^\d+$/.test(mid)) {
            return e.reply("请输入qq号或者直接艾特再发送命令", true)
        }

        // 判断协议端类型：NapCat 用 get_credentials，LLBot 等 OneBot 11 标准用 get_cookies
        const isNapCat = bot.version?.name?.toLowerCase().includes('napcat') ||
                         bot.adapter?.name?.toLowerCase().includes('napcat')
        const apiName = isNapCat ? 'get_credentials' : 'get_cookies'

        let KEY_DATA
        try {
            KEY_DATA = await bot.sendApi(apiName, { domain: "vip.qq.com" })
        } catch (err) {
            return e.reply(`获取 QQ 凭证失败：${apiName} 接口调用异常`, true)
        }

        const cookies = (KEY_DATA?.data ?? KEY_DATA)?.cookies || ""
        if (!cookies) {
            return e.reply("获取 QQ 凭证失败：返回数据为空", true)
        }

        // p_skey 在部分协议端返回为 skey 同名前缀（p_skey / pskey），uin 可能带 o 前缀
        // 注意：必须先匹配 p_skey 再匹配 skey，否则 skey 正则会误匹配到 "p_skey" 里的 "skey"
        const p_skey = /(?:^|;)\s*p_?skey=([^;]+)/.exec(cookies)?.[1]
        const skey = /(?:^|;)\s*skey=([^;]+)/.exec(cookies)?.[1]
        const uin = /(?:^|;)\s*uin=o?0*([^;]+)/.exec(cookies)?.[1] || bot.uin

        if (!skey || !p_skey) {
            return e.reply("获取 QQ 凭证不完整（缺少 skey/p_skey），该协议端可能不支持 vip.qq.com 域名的 Cookie", true)
        }

        const url = `http://jiuli.xiaoapi.cn/i/qq/qq_level.php?qq=${mid}&return=json&uin=${uin}&skey=${skey}&pskey=${p_skey}`
        const DATA_JSON = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(res => res.json())
        if (DATA_JSON?.code === -1) {
            return e.reply(`查询失败：${DATA_JSON.msg || "接口返回异常"}`, true)
        }

        DATA_JSON.cardTitle = '信息查询成功！！！'
        logger.info(DATA_JSON, 88)
        // const data = {
        //     saveId: "qqinfo",
        //     tplFile:
        //         "./plugins/bl-chat-plugin/resources/html/qqinfo/qqinfo.html",
        //     pluResPath:
        //         "C:/bot/Miao-Yunzai/plugins/bl-chat-plugin/resources/",
        //     ...DATA_JSON
        // }
        const data = await new Qqinfo(e).getData(DATA_JSON);
        logger.error(JSON.stringify(data, 77))
        // const msg = await e.reply(
        //     [
        //         segment.image(DATA_JSON.headimg),
        //         `\n头像最后修改时间:${DATA_JSON.sFaceTime}\n账号: ${DATA_JSON.qq}\nQID: ${DATA_JSON.qid}\n昵称: ${DATA_JSON.name}\n等级: ${DATA_JSON.icon}(${DATA_JSON.level})\n点赞量: ${DATA_JSON.like}\n活跃时长: ${DATA_JSON.iTotalActiveDay}天\n下个等级需要天数: ${DATA_JSON.iNextLevelDay}\n会员等级: ${DATA_JSON.iVipLevel}\nVIP到期时间: ${DATA_JSON.sVipExpireTime}\nSVIP到期时间: ${DATA_JSON.sSVipExpireTime}\n年费到期时间: ${DATA_JSON.sYearExpireTime}\n注册时间: ${DATA_JSON.RegistrationTime}\nQ龄: ${DATA_JSON.RegTimeLength}\n地区: ${DATA_JSON.ip_city}\n机型: ${DATA_JSON.device}\n账号状态: ${DATA_JSON.status}\n个性签名: ${DATA_JSON.sign}`,
        //     ],
        //     true,
        // )
        let img = await puppeteer.screenshot("qqinfo", data, 2);
        return e.reply(img);
    }
}
