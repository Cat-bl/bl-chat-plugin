import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import Qqinfo from "../model/qqinfo.js";
export class QQinfo extends plugin {
    constructor() {
        super({
            name: "进群查询qq信息",
            dsc: "进群查询qq信息",
            event: "notice.group.increase",
            priority: 5000,
            rule: [
                {
                    fnc: "getInfo",
                }
            ]
        })
    }

    async getInfo(e) {
        return
        if (this.e.user_id == this.e.self_id) return
        // 获取用户
        const KEY_DATA = await fetch("http://127.0.0.1:3000/get_credentials", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                domain: "vip.qq.com",
            }),
        }).then(res => res.json())
        // logger.info(KEY_DATA.data.cookies, 666)

        const skeyRegex = /skey=([^;]+)/.exec(KEY_DATA.data.cookies)
        const pSkeyRegex = /p_skey=([^;]+)/.exec(KEY_DATA.data.cookies)
        const uinRegex = /uin=([^;]+)/.exec(KEY_DATA.data.cookies)

        const skey = skeyRegex?.[1] // 输出 @sFOi60Ji4
        const p_skey = pSkeyRegex?.[1] // 输出 RLsR0kc5JtYiGuHxndsBYRQh3ugVWBVvdMstgQXrEdc_
        const url = `http://jiuli.xiaoapi.cn/i/qq/qq_level.php?qq=${e.user_id}&return=json&uin=${uinRegex}&skey=${skey}&pskey=${p_skey}`
        logger.info(url)
        const DATA_JSON = await fetch(url).then(res => res.json())

        DATA_JSON.cardTitle = '来新人啦！欢迎新人！！！'
        logger.info(DATA_JSON, 88)
        // const data = {
        //     saveId: "qqinfo",
        //     tplFile:
        //         "./plugins/test-plugin/resources/html/qqinfo/qqinfo.html",
        //     pluResPath:
        //         "C:/bot/Miao-Yunzai/plugins/test-plugin/resources/",
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
