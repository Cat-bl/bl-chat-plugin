export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "表情包系统 (emojiSystem)"
  },

  // ===== 主开关与路径 =====
  {
    field: "emojiSystem.enabled",
    label: "【主开关】表情包系统",
    component: "Switch",
    bottomHelpMessage: "关闭时 sendLocalEmojiTool 不暴露给 LLM、自动收集不工作、维护循环不启动。开启前请先在「AI 模型配置」页填好 analysisAiConfig（VLM 打标）和 embeddingAiConfig（语义召回）"
  },
  {
    field: "emojiSystem.dbPath",
    label: "元数据 ndjson 路径",
    component: "Input",
    bottomHelpMessage: "存放每张表情包的 hash/标签/向量等元数据；相对路径相对 Yunzai 根目录。一般保持默认",
    componentProps: { placeholder: "plugins/bl-chat-plugin/database/emoji-packs.ndjson" }
  },
  {
    field: "emojiSystem.storeDir",
    label: "表情包图片目录",
    component: "Input",
    bottomHelpMessage: "存放表情包图片本体的目录；相对路径相对 Yunzai 根目录。一般保持默认",
    componentProps: { placeholder: "plugins/bl-chat-plugin/database/emoji_files" }
  },
  {
    field: "emojiSystem.maxItems",
    label: "最大存储数量",
    component: "InputNumber",
    bottomHelpMessage: "本地表情包库最多存多少张。超过后新表情包不能入库（除非开启下方的「满额 LLM 替换」）",
    componentProps: { min: 10, max: 2000, placeholder: "200" }
  },

  // ===== 自动收集与打标 =====
  {
    field: "emojiSystem.autoCollect",
    label: "自动收集群里图片",
    component: "Switch",
    bottomHelpMessage: "开启后群里有人发图会自动入库为表情包。默认关，避免收到广告/截图/自拍。开启时强烈建议同时打开下方「内容审查」过滤"
  },
  {
    field: "emojiSystem.visionTagOnAdd",
    label: "VLM 自动打标",
    component: "Switch",
    bottomHelpMessage: "入库时调用视觉大模型自动打 3-5 个情绪标签 + 一句描述。需要在「AI 模型配置」页填好 analysisAiConfig"
  },
  {
    field: "emojiSystem.contentFiltration",
    label: "VLM 内容审查",
    component: "Switch",
    bottomHelpMessage: "入库前调用视觉大模型判断「是否适合作表情包」，挡风景照/截图/广告/二维码。每张图会多消耗 1 次 VLM token。开启自动收集时建议同时开启此项"
  },

  // ===== 选图与召回 =====
  {
    field: "emojiSystem.useEmbedding",
    label: "Embedding 语义召回",
    component: "Switch",
    bottomHelpMessage: "给每张表情生成向量，发表情时按语义相似度匹配（效果远好于关键词）。需要在「AI 模型配置」页填好 embeddingAiConfig。关闭时降级为标签字符串匹配"
  },
  {
    field: "emojiSystem.selectionTopK",
    label: "Top-K 召回数",
    component: "InputNumber",
    bottomHelpMessage: "embedding / 标签匹配时取相关度最高的 K 张作为候选，再按「相关分 × 1/(usedCount+1) × 冷启动 boost」加权抽样。值越大长尾覆盖越好，避免 200 张表情包只反复出现 Top 5",
    componentProps: { min: 1, max: 50, placeholder: "20" }
  },
  {
    field: "emojiSystem.embeddingThreshold",
    label: "相似度阈值",
    component: "InputNumber",
    bottomHelpMessage: "cosine 相似度低于此值的不进入候选。0.3 太宽容易随机，0.5 是中文 embedding 较稳的默认；小库（<50 张）匹配率低时可降到 0.35-0.4",
    componentProps: { min: 0, max: 1, step: 0.05, placeholder: "0.5" }
  },

  // ===== 满额替换与文件维护 =====
  {
    field: "emojiSystem.doReplace",
    label: "满额时 LLM 决策替换",
    component: "Switch",
    bottomHelpMessage: "库满时让 LLM 决定删一张旧的腾位置（按使用次数加权抽 20 张让 LLM 选）。需要在「AI 模型配置」页填好 toolsAiConfig。关闭时库满直接拒绝新图入库"
  },
  {
    field: "emojiSystem.enableMaintenance",
    label: "周期文件巡检",
    component: "Switch",
    bottomHelpMessage: "启动后台定时任务，自动检查文件与 ndjson 记录的一致性（缺失文件标记、孤立文件补登）"
  },
  {
    field: "emojiSystem.checkIntervalMinutes",
    label: "巡检间隔（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "仅在「周期文件巡检」开启时生效",
    componentProps: { min: 1, max: 1440, placeholder: "10" }
  },

  // ===== 反重复挑图 =====
  {
    field: "emojiSystem.avoidRecentEnabled",
    label: "反重复挑图",
    component: "Switch",
    bottomHelpMessage: "开启后避免短时间内重复发同一张图或同一种情绪标签。按群独立记忆，关闭时纯按召回算法选图（可能出现连发同款）"
  },
  {
    field: "emojiSystem.avoidRecentCount",
    label: "记忆最近 N 次发送",
    component: "InputNumber",
    bottomHelpMessage: "每群记忆最近 N 次发过的表情用于过滤。值越大越不重复但候选面越窄",
    componentProps: { min: 1, max: 50, placeholder: "20" }
  },
  {
    field: "emojiSystem.avoidRecentTtlMinutes",
    label: "最近发送记忆 TTL（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "超过 N 分钟的「最近发送」记录失效，相同表情可被重新选中",
    componentProps: { min: 1, max: 120, placeholder: "30" }
  },

  // ===== 文字+表情节奏延迟 =====
  {
    field: "emojiSystem.followUpDelayMinMs",
    label: "节奏延迟最小值（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "LLM 用「文字 + 表情」组合发送时，文字发出后等待的最小毫秒数，模拟人类敲字间隔",
    componentProps: { min: 0, max: 5000, placeholder: "300" }
  },
  {
    field: "emojiSystem.followUpDelayMaxMs",
    label: "节奏延迟最大值（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "实际延迟在 min-max 之间随机取值。范围越大节奏越「不像 AI」",
    componentProps: { min: 0, max: 10000, placeholder: "1200" }
  },

  // ===== 软限流防刷屏 =====
  {
    field: "emojiSystem.rateLimitEnabled",
    label: "软限流防刷屏",
    component: "Switch",
    bottomHelpMessage: "开启后超过频率上限时工具返回 error，LLM 会自然改用文字回复。关闭时无频率限制（活跃群可能刷屏）"
  },
  {
    field: "emojiSystem.rateLimitWindowMinutes",
    label: "限流窗口（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "统计该群在过去 N 分钟内发了多少个表情",
    componentProps: { min: 1, max: 60, placeholder: "1" }
  },
  {
    field: "emojiSystem.rateLimitMaxPerWindow",
    label: "窗口内最大发送次数",
    component: "InputNumber",
    bottomHelpMessage: "窗口内最多发送 N 张表情，超过会拒绝并提示 LLM 改用文字。设 0 视为不限",
    componentProps: { min: 0, max: 100, placeholder: "3" }
  }
]
