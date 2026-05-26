import { Guoba } from "./models/Guoba/index.js"

export function supportGuoba() {
  return {
    pluginInfo: Guoba.pluginInfo,
    configInfo: Guoba.configInfo
  }
}
