import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 插件内部相对引用完整性检查：
// 扫描所有 .js 的 import/export ... from "./xxx" 与 "../xxx"，
// 凡是不跳出插件根目录的相对路径，目标文件必须存在。
// 背景：删除 utils/request.js 时靠 grep 路径漏掉了同目录 "./request.js"
// 形式的引用，导致真机加载失败——node --check 和 ESLint 都查不出这类问题。

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCAN_DIRS = ["apps", "core", "utils", "functions", "model", "models", "scripts", "dependence"]
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

function collectJsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectJsFiles(full))
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

test("所有插件内部相对 import 的目标文件都存在", () => {
  const files = [path.join(pluginRoot, "index.js")]
  for (const dir of SCAN_DIRS) {
    const full = path.join(pluginRoot, dir)
    if (fs.existsSync(full)) files.push(...collectJsFiles(full))
  }

  const broken = []
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8")
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1] || match[2]
      if (!spec || !spec.startsWith(".")) continue
      const resolved = path.resolve(path.dirname(file), spec)
      // 跳出插件根目录的引用（Yunzai 本体 ../../../lib 等）无法在此校验
      if (!resolved.startsWith(pluginRoot)) continue
      // node_modules 深路径引用（如 ../../node_modules/axios/index.js）单测环境可能未安装，跳过
      if (resolved.includes("node_modules")) continue
      if (!fs.existsSync(resolved)) {
        broken.push(`${path.relative(pluginRoot, file)} -> ${spec}`)
      }
    }
  }

  assert.deepEqual(broken, [], `存在指向不存在文件的相对引用：\n${broken.join("\n")}`)
})
