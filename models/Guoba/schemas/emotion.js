export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "情感系统 (emotionSystem)"
  },
  {
    field: "emotionSystem.enabled",
    label: "情感系统开关",
    component: "Switch",
    bottomHelpMessage: "让机器人拥有情绪状态，根据对话内容调整回复风格（每个群独立）"
  },
  {
    field: "emotionSystem.decayRate",
    label: "情绪衰减速率",
    component: "InputNumber",
    bottomHelpMessage: "情绪每小时向中性回归的幅度",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.02" }
  },
  {
    field: "emotionSystem.eventWeights.praised",
    label: "被夸奖权重",
    component: "InputNumber",
    bottomHelpMessage: "被夸奖时心情提升值",
    componentProps: { min: -1, max: 1, step: 0.01, placeholder: "0.1" }
  },
  {
    field: "emotionSystem.eventWeights.scolded",
    label: "被骂权重",
    component: "InputNumber",
    bottomHelpMessage: "被骂时心情下降值",
    componentProps: { min: -1, max: 1, step: 0.01, placeholder: "-0.15" }
  },
  {
    field: "emotionSystem.eventWeights.ignored",
    label: "被忽略权重",
    component: "InputNumber",
    bottomHelpMessage: "被忽略时心情下降值",
    componentProps: { min: -1, max: 1, step: 0.01, placeholder: "-0.05" }
  },
  {
    field: "emotionSystem.eventWeights.mentioned",
    label: "被@权重",
    component: "InputNumber",
    bottomHelpMessage: "被@时心情提升值",
    componentProps: { min: -1, max: 1, step: 0.01, placeholder: "0.05" }
  }
]
