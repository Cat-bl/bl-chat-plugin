export default [
  {
    field: "enableGroupWhitelist",
    label: "群聊白名单开关",
    component: "Switch",
    bottomHelpMessage: "建议开启防止滥用。关闭时所有群都可使用 AI 对话功能"
  },
  {
    field: "allowedGroups",
    label: "白名单群号",
    component: "GTags",
    bottomHelpMessage: "允许使用 AI 功能的群组 ID（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  }
]
