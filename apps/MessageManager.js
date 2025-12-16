import { MessageManager } from '../utils/MessageManager.js'
import fs from 'fs';
import YAML from 'yaml';
export class MessageRecordPlugin extends plugin {
    constructor() {
        super({
            name: '消息记录',
            dsc: '记录群聊和私聊消息',
            event: 'message',
            priority: -Infinity,
            task: {
                name: 'messageRecord',
                fnc: () => { },
                cron: ''
            },
            rule: [
                {
                    reg: '^#查看(群聊|私聊)记录\\s*(\\d+)?',
                    fnc: 'showHistory'
                },
                {
                    reg: '^#清除(群聊|私聊)记录',
                    fnc: 'clearHistory'
                },
                {
                    reg: '.*',
                    fnc: 'onMessage',
                    log: false
                },
                {
                    reg: '^#全局方案(添加|删除)(白名单群组|Gemini密钥|触发前缀|过滤消息|Gemini工具列表|OpenAI工具列表|OneAPI工具列表|OneAPI密钥|GrokSSO|WorkosCursorToken|Gemini代理列表).*$',
                    fnc: 'modifyArrayConfig',
                    permission: 'master'
                },
            ]
        });
        this.configPath = './plugins/test-plugin/config/message.yaml';
        this.messageManager = new MessageManager();
    }

    async onMessage(e) {
        await this.messageManager.recordMessage(e);
        return false;
    }

    async showHistory(e) {
        const type = e.msg.includes('群聊') ? 'group' : 'private';
        const match = e.msg.match(/(\d+)/);
        let id;

        if (match) {
            id = parseInt(match[1]);
        } else {
            id = type === 'group' ? e.group_id : e.user_id;
        }

        // 权限检查
        if (type === 'group' && !e.group) {
            e.reply('请在群聊中使用群聊记录查询功能');
            return;
        }

        try {
            const messages = await this.messageManager.getMessages(type, id, 20);

            if (!messages || messages.length === 0) {
                await e.reply('暂无消息记录');
                return;
            }

            const forwardMsgs = messages.map(msg => {
                let message;
                if (msg.content.includes('发送了一张图片')) {
                    const match = msg.content.match(/\[(https?:\/\/[^\]]+)\]/);
                    if (match) {
                        message = [
                            segment.image(match[1]),
                            '\n',
                            msg.time
                        ];
                    }
                } else {
                    message = [
                        msg.content,
                        '\n',
                        msg.time
                    ];
                }

                return {
                    user_id: msg.sender.user_id,
                    nickname: msg.sender.nickname,
                    message
                };
            });

            const Summary = type === 'group'
                ? await e.group.makeForwardMsg(forwardMsgs)
                : await e.friend.makeForwardMsg(forwardMsgs);

            await e.reply(Summary);

        } catch (error) {
            logger.error(`获取消息记录失败: ${error}`);
            await e.reply('获取消息记录失败，请查看控制台日志');
        }
    }


    /**
     * 清除消息历史记录
     * @param {Object} e 事件对象
     */
    async clearHistory(e) {
        const type = e.msg.includes('群聊') ? 'group' : 'private';

        // if (!e.isMaster) {
        //     e.reply('只有主人才能清除消息记录哦~');
        //     return;
        // }

        const id = type === 'group' ? e.group_id : e.user_id;

        try {
            await this.messageManager.clearMessages(type, id);
            e.reply(`已清除${type === 'group' ? '群聊' : '私聊'}消息记录`);
        } catch (error) {
            logger.error(`清除消息记录失败: ${error}`);
            e.reply('清除消息记录失败，请查看控制台日志');
        }
    }

    async modifyArrayConfig(e) {
        if (!this.e.isMaster) return false

        const msg = e.msg
        const isAdd = msg.includes('添加')
        const matches = msg.match(/^#全局方案(添加|删除)([\u4e00-\u9fa5a-zA-Z]+)\s*(.+)/)

        if (!matches) {
            e.reply('命令格式错误')
            return false
        }

        const [, action, type, valueStr] = matches
        const configKey = 'allowedGroups'

        const values = valueStr.split(/[,，]\s*/).filter(v => v.trim())

        if (values.length === 0) {
            e.reply('请提供要操作的值')
            return false
        }

        const config = await this.readConfig()
        if (!config) {
            e.reply('读取配置失败')
            return false
        }

        try {
            if (!Array.isArray(config.pluginSettings[configKey])) {
                config.pluginSettings[configKey] = []
            }

            if (isAdd) {
                values.forEach(value => {
                    if (!config.pluginSettings[configKey].includes(value)) {
                        config.pluginSettings[configKey].push(value)
                    }
                })
            } else {
                config.pluginSettings[configKey] = config.pluginSettings[configKey].filter(
                    item => !values.includes(item)
                )
            }

            if (await this.saveConfig(config)) {
                e.reply(`批量${isAdd ? '添加' : '删除'}成功`)
            } else {
                e.reply('保存配置失败')
            }
        } catch (error) {
            logger.error(`修改数组配置失败: ${error}`)
            e.reply('操作失败')
        }
    }

    async readConfig() {
        try {
            const file = fs.readFileSync(this.configPath, 'utf8')
            return YAML.parse(file)
        } catch (error) {
            logger.error(`读取配置文件失败: ${error}`)
            return null
        }
    }

    async saveConfig(config) {
        try {
            const yamlStr = YAML.stringify(config)
            fs.writeFileSync(this.configPath, yamlStr, 'utf8')
            return true
        } catch (error) {
            logger.error(`保存配置文件失败: ${error}`)
            return false
        }
    }
}