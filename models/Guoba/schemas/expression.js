export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "表达学习系统 (expressionLearning)"
  },
  {
    field: "expressionLearning.enabled",
    label: "表达学习开关",
    component: "Switch",
    bottomHelpMessage: "让机器人学习群友的说话风格（每群独立）"
  },
  {
    field: "expressionLearning.minWordFrequency",
    label: "最小词频",
    component: "InputNumber",
    bottomHelpMessage: "词汇出现至少几次才记录",
    componentProps: { min: 1, max: 50, placeholder: "3" }
  },
  {
    field: "expressionLearning.maxWords",
    label: "最大词汇数",
    component: "InputNumber",
    bottomHelpMessage: "每群最多记录多少个高频词",
    componentProps: { min: 5, max: 500, placeholder: "50" }
  },
  {
    field: "expressionLearning.blockedWords",
    label: "屏蔽词列表",
    component: "GTags",
    bottomHelpMessage: "不学习这些词（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "expressionLearning.aiLearningEnabled",
    label: "AI 场景化学习开关",
    component: "Switch",
    bottomHelpMessage: "使用 AI 提取表达模式（复用「AI 模型配置」页的 memoryAiConfig），未配置时降级为词频统计"
  },
  {
    field: "expressionLearning.aiLearningMessageThreshold",
    label: "AI 学习消息阈值",
    component: "InputNumber",
    bottomHelpMessage: "积累多少条消息后触发一次 AI 学习",
    componentProps: { min: 10, max: 500, placeholder: "50" }
  }
]
