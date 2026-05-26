function makeAiBlock(displayName, prefix, urlField, modelField, keyField, urlPlaceholder, modelPlaceholder, usageHint) {
  return [
    {
      field: `${prefix}.${urlField}`,
      label: `${displayName} · URL`,
      component: "Input",
      bottomHelpMessage: `${usageHint}。完整 endpoint URL（含 /v1/chat/completions）`,
      componentProps: { placeholder: urlPlaceholder }
    },
    {
      field: `${prefix}.${modelField}`,
      label: "┗ 模型名",
      component: "Input",
      bottomHelpMessage: "模型名称（OneAPI/中转站按自身路由表填写）",
      componentProps: { placeholder: modelPlaceholder }
    },
    {
      field: `${prefix}.${keyField}`,
      label: "┗ API Key",
      component: "InputPassword",
      bottomHelpMessage: "OpenAI 兼容的 Bearer Token",
      componentProps: { placeholder: "sk-xxxxx" }
    }
  ]
}

export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "AI 模型配置"
  },
  ...makeAiBlock(
    "对话追踪 trackAiConfig",
    "trackAiConfig",
    "trackAiUrl", "trackAiModel", "trackAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gpt-4o-mini",
    "用于会话追踪时判断用户是否在和 bot 继续对话，推荐快速小模型"
  ),
  ...makeAiBlock(
    "工具决策 toolsAiConfig",
    "toolsAiConfig",
    "toolsAiUrl", "toolsAiModel", "toolsAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-2.5-flash",
    "用于工具决策（何时调工具、表情包满额替换决策等），推荐中等模型"
  ),
  ...makeAiBlock(
    "主对话 chatAiConfig",
    "chatAiConfig",
    "chatApiUrl", "chatApiModel", "chatApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-2.5-pro",
    "主对话使用的模型，决定 bot 回复质量，推荐强模型"
  ),
  ...makeAiBlock(
    "图像编辑 imageEditAiConfig",
    "imageEditAiConfig",
    "imageEditApiUrl", "imageEditApiModel", "imageEditApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-3-pro-image-preview",
    "用于 googleImageEditTool（图生图）、bananaTool（文生图）等图片生成工具"
  ),
  ...makeAiBlock(
    "图像识别/VLM analysisAiConfig",
    "analysisAiConfig",
    "analysisApiUrl", "analysisApiModel", "analysisApiKey",
    "https://api.openai.com/v1/chat/completions",
    "gemini-3-pro-preview",
    "用于 googleImageAnalysisTool 识图、表情包系统 VLM 打标和内容审查。必须使用支持视觉输入的多模态模型"
  ),
  ...makeAiBlock(
    "联网搜索 searchAiConfig",
    "searchAiConfig",
    "searchApiUrl", "searchApiModel", "searchApiKey",
    "https://api.openai.com/v1/chat/completions",
    "deepseek-r1-search",
    "用于 searchInformationTool 联网搜索，建议使用带搜索能力的模型"
  ),
  ...makeAiBlock(
    "记忆提取 memoryAiConfig",
    "memoryAiConfig",
    "memoryAiUrl", "memoryAiModel", "memoryAiApikey",
    "https://api.openai.com/v1/chat/completions",
    "gpt-4o-mini",
    "用于长期记忆提取、表达学习的 AI 场景化学习，推荐小模型省钱"
  ),
  ...makeAiBlock(
    "Embedding embeddingAiConfig",
    "embeddingAiConfig",
    "embeddingApiUrl", "embeddingApiModel", "embeddingApiKey",
    "https://api.openai.com/v1/embeddings",
    "text-embedding-3-small",
    "用于知识库语义检索、表情包系统 embedding 召回。注意 URL 是 /v1/embeddings 不是 chat/completions"
  )
]
