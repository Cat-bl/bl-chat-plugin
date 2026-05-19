export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "长期记忆系统 (memorySystem)"
  },
  {
    field: "memorySystem.enabled",
    label: "长期记忆开关",
    component: "Switch",
    bottomHelpMessage: "开启前需在「AI 模型配置」页填好 memoryAiConfig。每个群的每个用户独立记忆，群记忆作为群共识独立维护"
  },
  {
    field: "memorySystem.maxFactsPerUser",
    label: "每用户最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个用户在每个群最多保存多少条记忆（所有类别总计），超过会按重要性淘汰",
    componentProps: { min: 10, max: 1000, placeholder: "100" }
  },
  {
    field: "memorySystem.maxFactsPerGroup",
    label: "每群最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个群的全局共识记忆最多保存多少条（所有类别总计）",
    componentProps: { min: 10, max: 1000, placeholder: "50" }
  },
  {
    field: "memorySystem.importanceThreshold",
    label: "重要性阈值",
    component: "InputNumber",
    bottomHelpMessage: "低于此值的事实不会保存",
    componentProps: { min: 0, max: 1, step: 0.05, placeholder: "0.5" }
  },
  {
    field: "memorySystem.memoryDecayDays",
    label: "记忆参考时效（天）",
    component: "InputNumber",
    bottomHelpMessage: "记忆召回时参考的时效天数，越远的记忆权重越低",
    componentProps: { min: 1, max: 365, placeholder: "7" }
  },
  {
    field: "memorySystem.userExtractDebounceSeconds",
    label: "用户记忆提取防抖（秒）",
    component: "InputNumber",
    bottomHelpMessage: "用户对话结束后，等待 N 秒再触发记忆提取，避免短时间重复调用",
    componentProps: { min: 0, max: 600, placeholder: "90" }
  },
  {
    field: "memorySystem.userExtractMaxBatchMessages",
    label: "用户记忆批量大小",
    component: "InputNumber",
    bottomHelpMessage: "用户记忆每次提取时一次性分析的消息条数",
    componentProps: { min: 1, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.groupExtractMinIntervalMinutes",
    label: "群记忆最小整理间隔（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "群记忆两次整理之间至少间隔 N 分钟",
    componentProps: { min: 1, max: 120, placeholder: "10" }
  },
  {
    field: "memorySystem.groupExtractMaxBatchMessages",
    label: "群记忆触发条数",
    component: "InputNumber",
    bottomHelpMessage: "群累计多少条消息后立即整理一次",
    componentProps: { min: 1, max: 100, placeholder: "12" }
  },
  {
    field: "memorySystem.promptMaxUserFacts",
    label: "注入用户记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每次对话时注入 prompt 的用户记忆条数上限",
    componentProps: { min: 0, max: 50, placeholder: "8" }
  },
  {
    field: "memorySystem.promptMaxGroupFacts",
    label: "注入群记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每次对话时注入 prompt 的群共识记忆条数上限",
    componentProps: { min: 0, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.promptMaxChars",
    label: "记忆 prompt 字符上限",
    component: "InputNumber",
    bottomHelpMessage: "记忆部分注入 system prompt 的总字符上限，控制 token 消耗",
    componentProps: { min: 100, max: 8000, placeholder: "1200" }
  },
  {
    field: "memorySystem.semanticRecallEnabled",
    label: "语义召回开关",
    component: "Switch",
    bottomHelpMessage: "开启前需在「AI 模型配置」页填好 embeddingAiConfig，默认关闭即可"
  },
  {
    field: "memorySystem.semanticRecallTopK",
    label: "语义召回候选数",
    component: "InputNumber",
    bottomHelpMessage: "仅在开启语义召回时生效，先筛选多少条候选记忆",
    componentProps: { min: 1, max: 100, placeholder: "20" }
  }
]
