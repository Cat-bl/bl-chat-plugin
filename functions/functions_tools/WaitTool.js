import { AbstractTool } from "./AbstractTool.js"
import { pluginBridge } from "../../utils/pluginBridge.js"

export class WaitTool extends AbstractTool {
  constructor() {
    super()
    this.name = "waitTool"
    this.description = [
      "在你需要'稍后再说一句'时调用此工具（仅群聊有效）。",
      "适合场景：对方问了需要思考的问题、你刚发完一句话想留点空间、想模拟'打字中...'的停顿。",
      "调用后会等待 N 秒，然后自动给你一次续话机会（你可以选择补充也可以选择沉默）。",
      "注意：等待期间群里可能有新消息进来，续话时请重新判断节奏；续话不是保证的，所以不要把关键信息放在续话里。"
    ].join("\n")
    this.parameters = {
      type: "object",
      properties: {
        seconds: { type: "number", description: "等待秒数，1-60 之间。建议 3-15 秒。" },
        reason: { type: "string", description: "可选，为什么要等待，仅做日志用。" }
      },
      required: ["seconds"],
      additionalProperties: false
    }
  }

  async func(opts, e) {
    const instance = pluginBridge.instance
    const mode = String(instance?.config?.chatTriggerMode || 'strict').toLowerCase()
    if (mode !== 'smart' || !instance?.config?.smartTrigger?.waitToolEnabled) {
      return "error: 当前未启用 wait 工具（需 chatTriggerMode=smart 且 smartTrigger.waitToolEnabled=true）"
    }
    if (!e?.group_id) {
      return "error: wait 工具仅在群聊中有效"
    }
    const seconds = Math.max(1, Math.min(60, Number(opts.seconds) || 5))
    instance.scheduleWaitReply(e, seconds, opts.reason)
    return `已安排 ${seconds} 秒后续话`
  }
}
