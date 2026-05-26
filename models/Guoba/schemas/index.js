import { readUserSettings, applyFlatUpdates } from "../../../utils/configWriter.js"

import basic from "./basic.js"
import permission from "./permission.js"
import aiCore from "./aiCore.js"
import tracking from "./tracking.js"
import emotion from "./emotion.js"
import memory from "./memory.js"
import expression from "./expression.js"
import knowledge from "./knowledge.js"
import emoji from "./emoji.js"
import aiModels from "./aiModels.js"
import tools from "./tools.js"

export const schemas = [
  basic,
  aiCore,
  permission,
  tracking,
  aiModels,
  emotion,
  memory,
  expression,
  knowledge,
  emoji,
  tools
].flat()

export function getConfigData() {
  return readUserSettings()
}

export function setConfigData(data, { Result }) {
  try {
    applyFlatUpdates(data || {})
    return Result.ok({}, "保存成功 (´。• ᵕ •。`)")
  } catch (err) {
    return Result.error?.(`保存失败: ${err.message}`) || Result.ok({}, `保存失败: ${err.message}`)
  }
}
