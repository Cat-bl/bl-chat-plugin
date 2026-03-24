/**
 * 知识库批量导入脚本
 *
 * 支持格式:
 *   .txt  - 每行一条知识
 *   .json - 字符串数组 ["知识1", "知识2"] 或 CHIME 格式 [{meme, meaning, origin, type_cn}]
 *
 * 用法:
 *   node plugins/bl-chat-plugin/scripts/import-knowledge.js <文件路径>
 *
 * 示例:
 *   node plugins/bl-chat-plugin/scripts/import-knowledge.js ./my-knowledge.txt
 *   node plugins/bl-chat-plugin/scripts/import-knowledge.js C:/bot/chime/data/chime_full.json
 */

import { readFile } from 'fs/promises'
import path from 'path'
import fs from 'fs'
import YAML from 'yaml'
import KnowledgeExpander from '../functions/KnowledgeExpander.js'

// 检查命令行参数
const inputFile = process.argv[2]
if (!inputFile) {
  console.log(`知识库批量导入脚本

用法: node plugins/bl-chat-plugin/scripts/import-knowledge.js <文件路径>

支持格式:
  .txt  - 每行一条知识（空行自动跳过）
  .json - 字符串数组 或 CHIME 格式对象数组

示例:
  node plugins/bl-chat-plugin/scripts/import-knowledge.js ./my-knowledge.txt
  node plugins/bl-chat-plugin/scripts/import-knowledge.js C:/bot/chime/data/chime_full.json`)
  process.exit(0)
}

// 解析文件路径
const filePath = path.resolve(inputFile)
if (!fs.existsSync(filePath)) {
  console.error(`文件不存在: ${filePath}`)
  process.exit(1)
}

// 读取配置
const _path = process.cwd()
const configPath = path.join(_path, 'plugins/bl-chat-plugin/config/message.yaml')
const defaultPath = path.join(_path, 'plugins/bl-chat-plugin/config_default/message.yaml')
const cfgPath = fs.existsSync(configPath) ? configPath : defaultPath
const config = YAML.parse(fs.readFileSync(cfgPath, 'utf8')).pluginSettings

const embeddingConfig = config.embeddingAiConfig
if (!embeddingConfig?.embeddingApiUrl || !embeddingConfig?.embeddingApiKey) {
  console.error('请先在 config/message.yaml 中配置 embeddingAiConfig（embeddingApiUrl 和 embeddingApiKey）')
  process.exit(1)
}

// 读取并解析文件
const raw = await readFile(filePath, 'utf-8')
const ext = path.extname(filePath).toLowerCase()
let texts = []

if (ext === '.txt') {
  texts = raw.split('\n').map(l => l.trim()).filter(Boolean)
} else if (ext === '.json') {
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) {
    console.error('JSON 文件必须是数组格式')
    process.exit(1)
  }
  if (data.length === 0) {
    console.error('JSON 数组为空')
    process.exit(1)
  }
  // 判断格式：字符串数组 or CHIME 对象数组
  if (typeof data[0] === 'string') {
    texts = data.filter(Boolean)
  } else if (data[0].meme) {
    // CHIME 格式: {meme, meaning, origin, type_cn}
    texts = data.map(item => {
      const parts = [`「${item.meme}」`]
      if (item.meaning) parts.push(item.meaning)
      if (item.origin) parts.push(`来源：${item.origin}`)
      if (item.type_cn) parts.push(`类型：${item.type_cn}`)
      return parts.join(' ')
    })
  } else {
    console.error('JSON 格式不支持，需要字符串数组或 CHIME 格式对象数组')
    process.exit(1)
  }
} else {
  console.error(`不支持的文件格式: ${ext}（支持 .txt 和 .json）`)
  process.exit(1)
}

console.log(`文件: ${filePath}`)
console.log(`共 ${texts.length} 条，开始导入...\n`)

// 确保 data 目录存在
const dataDir = path.join(_path, 'plugins/bl-chat-plugin/data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'knowledge-db.ndjson')
const expander = new KnowledgeExpander({
  apiKey: embeddingConfig.embeddingApiKey,
  apiUrl: embeddingConfig.embeddingApiUrl,
  dbPath,
  model: embeddingConfig.embeddingApiModel || 'text-embedding-3-small'
})

// 分批导入，每批 50 条
const batchSize = 50
let totalAdded = 0
let totalSkipped = 0

for (let i = 0; i < texts.length; i += batchSize) {
  const batch = texts.slice(i, i + batchSize)
  const batchNum = Math.floor(i / batchSize) + 1
  const totalBatches = Math.ceil(texts.length / batchSize)

  console.log(`[${batchNum}/${totalBatches}] 正在导入第 ${i + 1}-${i + batch.length} 条...`)

  try {
    const result = await expander.expand(batch)
    totalAdded += result.added
    totalSkipped += batch.length - result.added
    console.log(`  新增 ${result.added} 条，跳过重复 ${batch.length - result.added} 条`)
  } catch (err) {
    console.error(`  批次 ${batchNum} 导入失败: ${err.message}`)
    console.log('  等待 5 秒后重试...')
    await new Promise(r => setTimeout(r, 5000))
    try {
      const result = await expander.expand(batch)
      totalAdded += result.added
      totalSkipped += batch.length - result.added
      console.log(`  重试成功：新增 ${result.added} 条`)
    } catch (retryErr) {
      console.error(`  重试也失败: ${retryErr.message}，跳过该批次`)
    }
  }

  if (i + batchSize < texts.length) {
    await new Promise(r => setTimeout(r, 1000))
  }
}

console.log(`\n导入完成！`)
console.log(`新增：${totalAdded} 条`)
console.log(`跳过重复：${totalSkipped} 条`)
console.log(`知识库文件：${dbPath}`)
