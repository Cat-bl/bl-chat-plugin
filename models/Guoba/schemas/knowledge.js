export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "知识库系统 (knowledgeSystem)"
  },
  {
    field: "knowledgeSystem.enabled",
    label: "知识库开关",
    component: "Switch",
    bottomHelpMessage: "开启前需在「AI 模型配置」页填好 embeddingAiConfig。基于 Embedding 向量检索的知识库"
  },
  {
    field: "knowledgeSystem.topN",
    label: "最大返回条数",
    component: "InputNumber",
    bottomHelpMessage: "检索命中后最多返回几条最相关的知识",
    componentProps: { min: 1, max: 50, placeholder: "10" }
  },
  {
    field: "knowledgeSystem.threshold",
    label: "相似度阈值",
    component: "InputNumber",
    bottomHelpMessage: "0~1，只有相似度 ≥ 此值的知识才会被返回，建议 0.3~0.5",
    componentProps: { min: 0, max: 1, step: 0.05, placeholder: "0.35" }
  }
]
