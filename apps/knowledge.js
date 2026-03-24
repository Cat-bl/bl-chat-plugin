import KnowledgeSearcher from "../functions/KnowledgeSearcher.js"
import KnowledgeExpander from "../functions/KnowledgeExpander.js"
import common from '../../../lib/common/common.js'
import { readFile, writeFile, access, mkdir } from 'fs/promises'
import path from 'path'
import fs from 'fs'
import YAML from 'yaml'

const _path = process.cwd()

function getKnowledgeConfig() {
  const configPath = path.join(_path, 'plugins/bl-chat-plugin/config/message.yaml')
  const defaultPath = path.join(_path, 'plugins/bl-chat-plugin/config_default/message.yaml')
  const cfgPath = fs.existsSync(configPath) ? configPath : defaultPath
  const config = YAML.parse(fs.readFileSync(cfgPath, 'utf8')).pluginSettings
  return config
}

function getDbPath() {
  return path.join(_path, 'plugins/bl-chat-plugin/data/knowledge-db.ndjson')
}

function createExpander(config) {
  return new KnowledgeExpander({
    apiKey: config.embeddingAiConfig?.embeddingApiKey,
    apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
    dbPath: getDbPath(),
    model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small'
  })
}

function createSearcher(config) {
  return new KnowledgeSearcher({
    apiKey: config.embeddingAiConfig?.embeddingApiKey,
    apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
    dbPath: getDbPath(),
    model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
    topN: config.knowledgeSystem?.topN || 4,
    threshold: config.knowledgeSystem?.threshold || 0.6
  })
}

async function ensureDataDir() {
  const dataDir = path.join(_path, 'plugins/bl-chat-plugin/data')
  try {
    await access(dataDir)
  } catch {
    await mkdir(dataDir, { recursive: true })
  }
}

async function loadNdjson(dbPath) {
  try {
    await access(dbPath)
    const data = await readFile(dbPath, 'utf-8')
    return data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

async function sendForward(e, msgs, title = '知识库') {
  try {
    const forwardMsg = await common.makeForwardMsg(e, msgs, title)
    await e.reply(forwardMsg)
  } catch {
    await e.reply(msgs.join('\n'))
  }
}

export class KnowledgePlugin extends plugin {
  constructor() {
    super({
      name: '知识库管理',
      dsc: '知识库增删改查管理',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#知识库添加\\s+[\\s\\S]+', fnc: 'addKnowledge', permission: 'master' },
        { reg: '^#知识库删除\\s+.+', fnc: 'deleteKnowledge', permission: 'master' },
        { reg: '^#知识库列表(\\s+\\d+)?$', fnc: 'listKnowledge', permission: 'master' },
        { reg: '^#知识库搜索\\s+.+', fnc: 'searchKnowledge', permission: 'master' },
        { reg: '^#知识库清空$', fnc: 'clearKnowledge', permission: 'master' },
        { reg: '^#知识库统计$', fnc: 'knowledgeStats', permission: 'master' }
      ]
    })
  }

  async addKnowledge(e) {
    const text = e.msg.replace(/^#知识库添加\s+/, '').trim()
    if (!text) return e.reply('请提供要添加的知识内容')

    await ensureDataDir()
    e.reply('正在添加知识条目...')

    try {
      const config = getKnowledgeConfig()
      const expander = createExpander(config)
      const result = await expander.expand(text)

      const msgs = []
      if (result.added > 0) {
        msgs.push(`添加成功，新增 ${result.added} 条知识`)
        msgs.push(`内容：${text}`)
      } else {
        msgs.push('该知识已存在，未重复添加')
      }
      await sendForward(e, msgs, '知识库添加')
    } catch (err) {
      e.reply(`添加失败: ${err.message}`)
    }
    return true
  }

  async deleteKnowledge(e) {
    const keyword = e.msg.replace(/^#知识库删除\s+/, '').trim()
    if (!keyword) return e.reply('请提供要删除的关键词')

    const dbPath = getDbPath()

    try {
      const entries = await loadNdjson(dbPath)
      if (!entries.length) return e.reply('知识库为空')

      const toDelete = entries.filter(item => item.text.includes(keyword))
      if (toDelete.length === 0) return e.reply(`未找到包含「${keyword}」的知识条目`)

      const remaining = entries.filter(item => !item.text.includes(keyword))
      const newContent = remaining.map(item => JSON.stringify(item)).join('\n') + (remaining.length ? '\n' : '')
      await writeFile(dbPath, newContent, 'utf-8')

      const msgs = [`已删除 ${toDelete.length} 条包含「${keyword}」的知识条目`, '删除的内容：']
      toDelete.forEach((item, i) => msgs.push(`${i + 1}. ${item.text}`))
      await sendForward(e, msgs, '知识库删除')
    } catch (err) {
      e.reply(`删除失败: ${err.message}`)
    }
    return true
  }

  async listKnowledge(e) {
    const dbPath = getDbPath()
    const entries = await loadNdjson(dbPath)
    if (!entries.length) return e.reply('知识库为空')

    const pageMatch = e.msg.match(/(\d+)/)
    const page = pageMatch ? parseInt(pageMatch[1]) : 1
    const pageSize = 10
    const totalPages = Math.ceil(entries.length / pageSize)
    const start = (page - 1) * pageSize
    const pageEntries = entries.slice(start, start + pageSize)

    if (!pageEntries.length) return e.reply(`第${page}页没有数据，共${totalPages}页`)

    const msgs = [`知识库列表 (第${page}/${totalPages}页，共${entries.length}条)`]
    pageEntries.forEach((item, i) => {
      msgs.push(`${start + i + 1}. ${item.text}`)
    })
    if (totalPages > 1) {
      msgs.push(`\n提示：发送 #知识库列表 页码 查看其他页`)
    }
    await sendForward(e, msgs, '知识库列表')
    return true
  }

  async searchKnowledge(e) {
    const query = e.msg.replace(/^#知识库搜索\s+/, '').trim()
    if (!query) return e.reply('请提供搜索关键词')

    e.reply('正在检索...')

    try {
      const config = getKnowledgeConfig()
      const searcher = createSearcher(config)
      const result = await searcher.search(query)

      if (!result) return e.reply('未找到相关知识')

      const msgs = [`搜索关键词：${query}`, result.knowledgeContext]
      await sendForward(e, msgs, '知识库搜索')
    } catch (err) {
      e.reply(`检索失败: ${err.message}`)
    }
    return true
  }

  async clearKnowledge(e) {
    e.reply('确认清空知识库？所有知识条目将被删除。\n发送「确认清空」继续，其他内容取消')
    this.setContext('confirmClear')
    return true
  }

  async confirmClear() {
    const e = this.e
    this.finish('confirmClear')

    if (e.msg !== '确认清空') return e.reply('已取消清空操作')

    try {
      const dbPath = getDbPath()
      await writeFile(dbPath, '', 'utf-8')
      e.reply('知识库已清空')
    } catch (err) {
      e.reply(`清空失败: ${err.message}`)
    }
    return true
  }

  async knowledgeStats(e) {
    const dbPath = getDbPath()

    try {
      await access(dbPath)
      const entries = await loadNdjson(dbPath)
      const stats = fs.statSync(dbPath)
      const sizeKB = (stats.size / 1024).toFixed(1)

      const config = getKnowledgeConfig()
      const msgs = [
        `知识库统计`,
        `条目数：${entries.length}`,
        `文件大小：${sizeKB} KB`,
        `功能状态：${config.knowledgeSystem?.enabled ? '已启用' : '未启用'}`,
        `检索阈值：${config.knowledgeSystem?.threshold || 0.6}`,
        `最大返回数：${config.knowledgeSystem?.topN || 4}`,
        `Embedding模型：${config.embeddingAiConfig?.embeddingApiModel || '未配置'}`
      ]
      await sendForward(e, msgs, '知识库统计')
    } catch {
      e.reply('知识库文件不存在，尚未添加任何知识')
    }
    return true
  }
}
