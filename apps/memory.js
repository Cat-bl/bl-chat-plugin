import { getSharedState } from "../core/sharedState.js"
import common from "../../../lib/common/common.js"

/**
 * 记忆管理命令插件：查看 / 搜索 / 删除 / 清空 / 启停长期记忆。
 * 数据由 core/sharedState 的 memoryManager 提供（由对话主插件初始化），
 * 这里通过 getter 懒加载，避免 apps 加载顺序问题。
 * priority 9998：先于对话主插件（9999）处理命令，与拆分前
 * "命令规则排在万能触发规则之前"的语义一致。
 */
export class MemoryCommands extends plugin {
  constructor() {
    super({
      name: "记忆管理",
      dsc: "长期记忆查看与管理命令",
      event: "message",
      priority: 9998,
      rule: [
        { reg: "^#记忆状态$", fnc: "memoryStatus" },
        { reg: "^#我的记忆$", fnc: "listMyMemory" },
        { reg: "^#群记忆$", fnc: "listGroupMemory" },
        { reg: "^#搜索记忆\\s+[\\s\\S]+$", fnc: "searchMemory" },
        { reg: "^#删除记忆\\s+\\S+$", fnc: "deleteMemory" },
        { reg: "^#清空我的记忆$", fnc: "clearMyMemory" },
        { reg: "^#清空群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#清除群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#禁用我的记忆$", fnc: "disableMyMemory" },
        { reg: "^#启用我的记忆$", fnc: "enableMyMemory" }
      ]
    })
  }

  get memoryManager() {
    return getSharedState()?.memoryManager
  }

  isGroupMemoryAdmin(e) {
    return Boolean(e.isMaster || ["owner", "admin"].includes(e.sender?.role))
  }

  formatMemoryTime(timestamp) {
    if (!timestamp) return "无"
    return new Date(timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  }

  formatMemoryFactLines(facts = []) {
    return facts.map(fact => {
      const shortId = String(fact.id).slice(0, 8)
      const score = Number(fact.score ?? fact.importance ?? 0).toFixed(2)
      return `ID:${shortId} [${fact.category}] ${fact.content} (${score})`
    })
  }

  formatMemoryFacts(title, facts = []) {
    if (!facts.length) return `${title}\n暂无记忆`
    const lines = this.formatMemoryFactLines(facts)
    return `${title}\n${lines.join("\n")}\n\n删除单条记忆可发送：#删除记忆 <ID>`.slice(0, 4500)
  }

  async replyMemoryForward(e, title, sections = []) {
    const msgs = []
    for (const section of sections) {
      const facts = section.facts || []
      if (!facts.length) {
        msgs.push(`${section.title}\n暂无记忆`)
        continue
      }

      const lines = this.formatMemoryFactLines(facts)
      for (let i = 0; i < lines.length; i += 12) {
        const page = Math.floor(i / 12) + 1
        const total = Math.ceil(lines.length / 12)
        const header = total > 1 ? `${section.title} (${page}/${total})` : section.title
        msgs.push(`${header}\n${lines.slice(i, i + 12).join("\n")}`)
      }
    }

    msgs.push("删除单条记忆可发送：#删除记忆 <ID>")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await e.reply(forwardMsg)
    } catch (error) {
      logger.warn("[记忆管理] 转发消息发送失败，回退为普通文本:", error)
      await e.reply(msgs.join("\n\n").slice(0, 4500))
    }
  }

  async memoryStatus(e) {
    try {
      const status = await this.memoryManager.adminStatus({
        groupId: e.group_id,
        userId: e.user_id
      })
      const lines = [
        `记忆系统：${status.enabled ? "开启" : "关闭"}`,
        `用户记忆：${status.user?.disabled ? "已禁用" : "启用"}，${status.user?.factCount || 0} 条，关系分 ${Number(status.user?.relationshipScore ?? 0.5).toFixed(2)}`,
        `群记忆：${status.group?.disabled ? "已禁用" : "启用"}，${status.group?.factCount || 0} 条`,
        `用户上次抽取：${this.formatMemoryTime(status.user?.lastAttemptAt)}`,
        `群上次抽取：${this.formatMemoryTime(status.group?.lastAttemptAt)}`,
        `阈值：${status.config.importanceThreshold}，语义召回：${status.config.semanticRecallEnabled ? "开启" : "关闭"}`
      ]
      await e.reply(lines.join("\n"))
    } catch (error) {
      logger.error("[记忆管理] 读取记忆状态失败:", error)
      await e.reply("记忆状态读取失败，请看日志")
    }
    return true
  }

  async listMyMemory(e) {
    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "我的记忆", [
        { title: "我的记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取我的记忆失败:", error)
      await e.reply("读取我的记忆失败，请看日志")
    }
    return true
  }

  async listGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }

    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "group",
        groupId: e.group_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "群记忆", [
        { title: "群记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取群记忆失败:", error)
      await e.reply("读取群记忆失败，请看日志")
    }
    return true
  }

  async searchMemory(e) {
    const query = String(e.msg || "").replace(/^#搜索记忆\s+/, "").trim()
    if (!query) {
      await e.reply("请输入要搜索的关键词")
      return true
    }

    try {
      const myResult = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        query,
        limit: 10
      })
      const groupResult = e.group_id
        ? await this.memoryManager.adminListMemories({
            scope: "group",
            groupId: e.group_id,
            query,
            limit: 10
          })
        : { facts: [] }
      await this.replyMemoryForward(e, "搜索记忆", [
        { title: "我的匹配记忆", facts: myResult.facts },
        { title: "群匹配记忆", facts: groupResult.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 搜索记忆失败:", error)
      await e.reply("搜索记忆失败，请看日志")
    }
    return true
  }

  async deleteMemory(e) {
    const id = String(e.msg || "").replace(/^#删除记忆\s+/, "").trim()
    if (!id) {
      await e.reply("请输入要删除的记忆 id")
      return true
    }

    try {
      let result = await this.memoryManager.adminDeleteMemory({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        id
      })

      if (!result.deleted && this.isGroupMemoryAdmin(e)) {
        result = await this.memoryManager.adminDeleteMemory({
          scope: "group",
          groupId: e.group_id,
          id
        })
      }

      await e.reply(result.deleted ? `已删除记忆 ${id}` : "没有找到可删除的记忆，普通用户只能删除自己的记忆")
    } catch (error) {
      logger.error("[记忆管理] 删除记忆失败:", error)
      await e.reply("删除记忆失败，请看日志")
    }
    return true
  }

  async clearMyMemory(e) {
    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id
      })
      await e.reply(`已清空我的记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空我的记忆失败:", error)
      await e.reply("清空我的记忆失败，请看日志")
    }
    return true
  }

  async clearGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }
    if (!this.isGroupMemoryAdmin(e)) {
      await e.reply("只有群主、管理员或主人可以清空群记忆")
      return true
    }

    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "group",
        groupId: e.group_id
      })
      await e.reply(`已清空本群群记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空群记忆失败:", error)
      await e.reply("清空群记忆失败，请看日志")
    }
    return true
  }

  async disableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: false
      })
      await e.reply("已禁用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 禁用我的记忆失败:", error)
      await e.reply("禁用失败，请看日志")
    }
    return true
  }

  async enableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: true
      })
      await e.reply("已启用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 启用我的记忆失败:", error)
      await e.reply("启用失败，请看日志")
    }
    return true
  }
}
