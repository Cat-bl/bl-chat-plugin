export default [
  // 整组配置都在"对话追踪"这一个 tab 内；内部用 Divider 做小节分隔
  {
    component: "SOFT_GROUP_BEGIN",
    label: "对话追踪"
  },

  // ===== 严格模式追踪（strict）=====
  { component: "Divider", label: "严格模式追踪 (strict)" },
  {
    field: "conversationTrackingEnabled",
    label: "会话追踪开关",
    component: "Switch",
    bottomHelpMessage: "仅 strict 模式生效。开启后会增加 token 消耗。用户触发对话后自动追踪后续消息判断是否继续对话"
  },
  {
    field: "conversationTrackingTimeout",
    label: "追踪超时（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "strict 模式: 用户触发对话后，追踪其后续消息的时间窗口",
    componentProps: { min: 1, max: 30, placeholder: "2" }
  },
  {
    field: "conversationTrackingThrottle",
    label: "节流时间（秒）",
    component: "InputNumber",
    bottomHelpMessage: "strict 模式: 同一用户连续发消息时，间隔多少秒才调用 AI 判断",
    componentProps: { min: 1, max: 60, placeholder: "3" }
  },
  {
    field: "batchJudgmentDelay",
    label: "批量判断延迟（秒）",
    component: "InputNumber",
    bottomHelpMessage: "strict 模式: 收集多少秒内的消息后批量判断，减少 API 调用次数",
    componentProps: { min: 1, max: 60, placeholder: "10" }
  },

  // ===== 触发模式切换 =====
  { component: "Divider", label: "对话触发模式切换" },
  {
    field: "chatTriggerMode",
    label: "对话触发模式",
    component: "Select",
    bottomHelpMessage: "strict=严格模式（必须 @/前缀才回，现状）；smart=智能模式（群里按频率自动让小模型判断要不要插话）。⚠️ 切到 smart 前请确保已在「AI 模型配置」页配置 trackAiConfig，Gate 子代理会复用此模型做决策；未配置时 Gate 永远返回 no_action，bot 不会主动接话",
    componentProps: {
      options: [
        { label: "严格模式（默认，必须 @/前缀触发）", value: "strict" },
        { label: "智能模式（自动判断要不要插话，需配置 trackAiConfig）", value: "smart" }
      ]
    }
  },

  // ===== 智能模式 - 频率与阈值 =====
  { component: "Divider", label: "智能模式 - 频率与阈值 (smart)  ⚠ 依赖 trackAiConfig" },
  {
    field: "smartTrigger.talkValue",
    label: "talkValue（频率）",
    component: "InputNumber",
    bottomHelpMessage: "⚠️ smart 模式依赖 trackAiConfig 作为 Gate 子代理；未配置时 Gate 永远 no_action，bot 不会主动接话。仅 smart 模式生效。1=每条消息都跑 Gate（token 消耗大），0.15=约 7 条触发一次（推荐折中），0.1=10 条触发一次。取值 0.01-1.0",
    componentProps: { min: 0.01, max: 1, step: 0.05, placeholder: "0.15" }
  },
  {
    field: "smartTrigger.idleCompensationEnabled",
    label: "冷群空窗补偿",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 群冷下来时按时间折算等效消息数凑触发条件，避免冷群永远不触发"
  },
  {
    field: "smartTrigger.avgLatencyDefaultMs",
    label: "平均延迟初始值 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 冷启动 fallback 用，回复延迟滚动 deque 为空时取此值",
    componentProps: { min: 5000, max: 600000, step: 5000, placeholder: "60000" }
  },
  {
    field: "smartTrigger.timingGateCooldownSeconds",
    label: "Gate 冷却（秒）",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: Gate 判 no_action 后多久内不再请求 Gate，防 LLM 被刷爆",
    componentProps: { min: 1, max: 60, placeholder: "15" }
  },
  {
    field: "smartTrigger.gateContextSize",
    label: "Gate 上下文条数",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 喂给 Timing Gate 的群历史条数（越大决策越准但 token 越贵）",
    componentProps: { min: 5, max: 100, placeholder: "10" }
  },

  // ===== 智能模式 - 强制触发 =====
  { component: "Divider", label: "智能模式 - 强制触发" },
  {
    field: "smartTrigger.inevitableAtReply",
    label: "触发关键词必回",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 消息含 @bot 或 triggerPrefixes 任一关键词时强制回复（跳过 Gate/cooldown/threshold/debounce）。关闭后 @/前缀也走普通阈值流程"
  },
  {
    field: "smartTrigger.mentionedNameReply",
    label: "机器人昵称提及必回",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 非 @ 且不在 triggerPrefixes 里、但消息含机器人昵称（取 Bot.nickname）时也强制触发"
  },

  // ===== 智能模式 - 时段化频率 =====
  { component: "Divider", label: "智能模式 - 时段化频率" },
  {
    field: "smartTrigger.enableTalkValueRules",
    label: "启用时段化频率",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 按时段覆盖 talkValue（夜间安静 / 白天活跃）"
  },
  {
    field: "smartTrigger.talkValueRules",
    label: "时段频率规则",
    component: "GSubForm",
    componentProps: {
      multiple: true,
      modalProps: { title: "时段频率规则" },
      schemas: [
        { field: "range", label: "时段", component: "Input", componentProps: { placeholder: "00:00-08:59" }, required: true },
        { field: "value", label: "talkValue", component: "InputNumber", componentProps: { min: 0.01, max: 1, step: 0.05 }, required: true }
      ]
    },
    bottomHelpMessage: "smart 模式: 每条规则一个时段，HH:MM-HH:MM 格式（支持跨夜如 23:00-06:59）；命中第一条匹配的为准；都不命中用全局 talkValue"
  },

  // ===== 智能模式 - 打断保护与拟人化 =====
  { component: "Divider", label: "智能模式 - 打断保护与拟人化" },
  {
    field: "smartTrigger.replyDebounceMs",
    label: "新消息打断静默 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 准备回复前先等待这么久看有没有新消息，避免抢答；0=关闭",
    componentProps: { min: 0, max: 5000, step: 100, placeholder: "1500" }
  },
  {
    field: "smartTrigger.maxConsecutiveInterrupts",
    label: "连续打断上限 (次)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 同一群被新消息连续打断的最大次数，超过后强制走完不再让步；0=每次都让步",
    componentProps: { min: 0, max: 10, placeholder: "3" }
  },
  {
    field: "smartTrigger.activeChatTtlHours",
    label: "群活跃 TTL (小时)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 群超过这么多小时没新消息就从内存状态淘汰",
    componentProps: { min: 1, max: 168, placeholder: "24" }
  },
  {
    field: "smartTrigger.proactiveReplyNoQuote",
    label: "主动搭话不引用",
    component: "Switch",
    bottomHelpMessage: "smart 模式: Gate 主动触发的回复（非 @/前缀）不带'引用消息'格式，bot 像群友自然插话而不是'回复某人'。@/前缀触发仍按正常引用概率"
  },
  {
    field: "smartTrigger.typingSpeed",
    label: "拟人化打字速度 (字符/秒)",
    component: "InputNumber",
    bottomHelpMessage: "调节分段回复的段间延迟（两种模式都生效）；0=默认公式（1s起步+字符延展），>0=按字符/秒计算延迟，建议 8-25",
    componentProps: { min: 0, max: 100, placeholder: "0" }
  },
  {
    field: "smartTrigger.waitToolEnabled",
    label: "启用 wait 工具",
    component: "Switch",
    bottomHelpMessage: "smart 模式: LLM 可调 waitTool 主动安排 N 秒后续话（拟人化打字停顿）"
  },

  // ===== 对方画像注入 =====
  { component: "Divider", label: "对方画像注入（两种模式都生效）" },
  {
    field: "personProfileInjection.enabled",
    label: "对方画像注入开关",
    component: "Switch",
    bottomHelpMessage: "两种模式都生效。每次回复前自动注入对方昵称/长期记忆/最近发言到 system prompt，增强'熟人感'"
  },
  {
    field: "personProfileInjection.maxRecentMessages",
    label: "注入近期发言条数上限",
    component: "InputNumber",
    componentProps: { min: 0, max: 20, placeholder: "3" }
  }
]
