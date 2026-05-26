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
  }
]
