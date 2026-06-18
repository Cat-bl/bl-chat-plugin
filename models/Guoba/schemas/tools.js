export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "工具与 Token"
  },
  {
    field: "oneapi_tools",
    label: "启用工具列表",
    component: "GTags",
    bottomHelpMessage: "在 oneapi 模式下暴露给 LLM 的工具名。可在工具名后追加 (dedupe) 防止重复调用",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "githubToken",
    label: "GitHub Token",
    component: "InputPassword",
    bottomHelpMessage: "githubRepoTool 解析 git 仓库时使用",
    componentProps: { placeholder: "ghp_xxx" }
  },
  {
    field: "qqMusicToken",
    label: "QQ 音乐 Token",
    component: "InputPassword",
    bottomHelpMessage: "searchMusicTool 发送音乐卡片时使用，未配置发送试听版",
    componentProps: { placeholder: "未配置时使用试听版" }
  },
  {
    field: "toolHistorySystem.enabled",
    label: "工具调用历史开关",
    component: "Switch",
    bottomHelpMessage: "开启后会按群保留最近 N 条用户消息触发的工具调用记录，注入到 system，让 AI 跨对话也能记得做过什么"
  },
  {
    field: "toolHistorySystem.maxItems",
    label: "工具调用历史·保留条数",
    component: "InputNumber",
    bottomHelpMessage: "每群最多保留多少条用户消息触发的工具调用记录（同一条消息触发的多个工具算 1 条）",
    componentProps: { min: 1, max: 50, placeholder: "10" }
  },
  {
    field: "toolHistorySystem.maxResultLength",
    label: "工具调用历史·单条结果截断长度",
    component: "InputNumber",
    bottomHelpMessage: "单个工具结果在历史里展示时的最大字符数，超出会被截断",
    componentProps: { min: 20, max: 2000, placeholder: "150" }
  },
  {
    field: "toolHistorySystem.ttlDays",
    label: "工具调用历史·保留天数",
    component: "InputNumber",
    bottomHelpMessage: "redis 中工具调用历史的过期天数，超过会自动清理",
    componentProps: { min: 1, max: 30, placeholder: "7" }
  }
]
