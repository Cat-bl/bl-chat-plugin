// 表情包批量导入文件名解析：「描述文字[tag1,tag2]」→ { description, tags }。
// 纯函数无 IO，配套单测 tests/emoji-import-name.test.js。

const MAX_DESC_LEN = 300
// 只识别「结尾处」成对的半角 [] 或全角 【】 标签组，不跨风格匹配
const TRAILING_TAGS_RE = /(?:\[([^\][]*)\]|【([^【】]*)】)\s*$/

/**
 * @param {string} baseName 文件名去掉扩展名后的部分（调用方用 path.parse(f).name 取得）
 * @returns {{ description: string, tags: string[] }} 两者皆空时由调用方拒绝该文件
 */
export function parseImportFileName(baseName) {
  const raw = String(baseName ?? "").trim()
  let description = raw
  let tags = []
  const m = raw.match(TRAILING_TAGS_RE)
  if (m) {
    description = raw.slice(0, m.index).trim()
    const tagStr = m[1] ?? m[2] ?? ""
    tags = [...new Set(tagStr.split(/[,，、]/).map(t => t.trim()).filter(Boolean))]
  }
  return { description: description.slice(0, MAX_DESC_LEN), tags }
}
