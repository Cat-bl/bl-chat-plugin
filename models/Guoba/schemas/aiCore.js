export default [
  {
    field: "systemContent",
    label: "系统提示词（人设）",
    component: "InputTextArea",
    bottomHelpMessage: "定义 AI 的个性、行为准则和回答风格。这是决定 bot 性格的核心字段",
    componentProps: { rows: 8, placeholder: "你的名字叫哈基米..." }
  },
  {
    field: "useTools",
    label: "工具调用开关",
    component: "Switch",
    bottomHelpMessage: "是否启用扩展功能工具（搜索、点赞、戳一戳、表情包等）"
  },
  {
    field: "maxToolRounds",
    label: "最大工具调用轮次",
    component: "InputNumber",
    bottomHelpMessage: "单次对话中允许 LLM 连续调用工具的最大轮数，防止死循环",
    componentProps: { min: 1, max: 20, placeholder: "5" }
  }
]
