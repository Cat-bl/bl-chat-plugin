import fs from "fs"
import path from "path"
import YAML from "yaml"

const _path = process.cwd()
const USER_CONFIG_PATH = path.join(_path, "plugins/bl-chat-plugin/config/message.yaml")
const DEFAULT_CONFIG_PATH = path.join(_path, "plugins/bl-chat-plugin/config_default/message.yaml")

export function readUserSettings() {
  const file = fs.existsSync(USER_CONFIG_PATH) ? USER_CONFIG_PATH : DEFAULT_CONFIG_PATH
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, "utf8"))?.pluginSettings || {}
  } catch (err) {
    globalThis.logger?.warn?.(`[configWriter] 读取用户配置失败: ${err.message}`)
    return {}
  }
}

function loadDocument() {
  if (fs.existsSync(USER_CONFIG_PATH)) {
    return YAML.parseDocument(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  }
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"))
  }
  return YAML.parseDocument("pluginSettings:\n")
}

export function applyFlatUpdates(updates) {
  const doc = loadDocument()
  for (const [flatKey, value] of Object.entries(updates || {})) {
    if (!flatKey) continue
    const segments = ["pluginSettings", ...String(flatKey).split(".")]
    doc.setIn(segments, value)
  }
  const dir = path.dirname(USER_CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(USER_CONFIG_PATH, doc.toString(), "utf8")
}
