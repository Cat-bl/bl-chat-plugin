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
    bottomHelpMessage: "smart 模式: Gate 判 no_action 后多久内不再请求 Gate（默认 5 秒，活跃群更频繁评估）",
    componentProps: { min: 1, max: 60, placeholder: "5" }
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

  // ===== 智能模式 - 对话焦点状态机 (FOCUS/FADING/COLD) =====
  { component: "Divider", label: "智能模式 - 对话焦点状态机" },
  {
    field: "smartTrigger.focusDurationMs",
    label: "FOCUS 持续时长 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: bot 主动回复后进入 FOCUS 状态的持续时间，期间每条新消息都强制走 Gate（保守默认 180000 = 3 分钟）",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.fadingDurationMs",
    label: "FADING 余热时长 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: FOCUS 降级后 FADING 余热持续时间，期间触发阈值减半（默认 90000 = 1.5 分钟）",
    componentProps: { min: 0, max: 600000, step: 30000, placeholder: "90000" }
  },
  {
    field: "smartTrigger.focusMaxReplies",
    label: "FOCUS 内最大回复次数",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 一轮 FOCUS 内 bot 最多主动回复次数，超过强制降级 FADING 防连刷（默认 4）。force 路径不计入",
    componentProps: { min: 1, max: 10, placeholder: "4" }
  },
  {
    field: "smartTrigger.focusMaxNoAction",
    label: "FOCUS 内连续 no_action 上限",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: FOCUS 期内 Gate 连续判 no_action 多少次后降级 FADING（保守默认 2）",
    componentProps: { min: 1, max: 10, placeholder: "2" }
  },
  {
    field: "smartTrigger.fadingForceGate",
    label: "FADING 期强制走 Gate",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 关闭=FADING 期仅靠阈值减半，保守（默认）；开启=FADING 期也强制每条走 Gate，激进但更不容易冷场"
  },

  // ===== 智能模式 - "等 bot 回应"识别 =====
  { component: "Divider", label: "智能模式 - 等 bot 回应本地识别 (R1-R4)" },
  {
    field: "smartTrigger.quickResponseMs",
    label: "R1 秒回反应窗口 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: R1 规则 - bot 发言后此时间内的任何消息都视为接续话题（人类秒回几乎必然在回应 bot）",
    componentProps: { min: 0, max: 120000, step: 5000, placeholder: "30000" }
  },
  {
    field: "smartTrigger.continuationLookbackMs",
    label: "R2/R3/R4 识别时间窗 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 关键词/问句/反馈词识别仅在 bot 上次发言后此时间窗内生效",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.continuationKeywordMatch",
    label: "启用关键词匹配 (R2)",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 消息含 bot 上次发言的关键词时视为接续话题，强制走 Gate"
  },
  {
    field: "smartTrigger.continuationQuestionMatch",
    label: "启用问句识别 (R3)",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 消息含 ?/？ 或末尾 5 字含 吗/呢/啊/么/嘛 时视为问句，强制走 Gate"
  },
  {
    field: "smartTrigger.continuationFeedbackMatch",
    label: "启用反馈词识别 (R4)",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 消息以 嗯/对/真的/是吗/好的/我也/那你 等反馈词开头时视为接续，强制走 Gate"
  },
  {
    field: "smartTrigger.continuationKeywordMaxCount",
    label: "关键词数量上限",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 每次从 bot 上次发言提取保留的关键词数量上限（给 R2 用）",
    componentProps: { min: 1, max: 20, placeholder: "5" }
  },

  // ===== 智能模式 - 速率硬上限（防刷屏）=====
  { component: "Divider", label: "智能模式 - 速率硬上限（防刷屏最终防线）" },
  {
    field: "smartTrigger.maxRepliesPer10Min",
    label: "10 分钟内最多回复次数",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 10 分钟滑动窗口内 bot 最多主动回复次数（默认 8）。force 路径（@/前缀）不受限，确保被点名一定能回",
    componentProps: { min: 1, max: 30, placeholder: "8" }
  },
  {
    field: "smartTrigger.rateLimitCooldownMs",
    label: "速率超限冷却时长 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 触发速率上限后强制降级 FADING 的持续时长（默认 300000 = 5 分钟）",
    componentProps: { min: 60000, max: 1800000, step: 60000, placeholder: "300000" }
  },

  // ===== 智能模式 - Deferred Timer =====
  { component: "Divider", label: "智能模式 - 冷群空窗主动唤醒 (Deferred Timer)" },
  {
    field: "smartTrigger.deferredGateEnabled",
    label: "Deferred Timer 总开关",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 仅 phase=cold 时排定时器，按 (threshold - 当前等效消息数) × avgMs 估算未来某时点主动唤醒 Gate。关掉则冷群空窗 bot 不主动思考"
  },
  {
    field: "smartTrigger.minDeferredMs",
    label: "最短延迟 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: Deferred timer 最短延迟（保守默认 120000 = 2 分钟），避免过密唤醒",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "120000" }
  },
  {
    field: "smartTrigger.maxDeferredMs",
    label: "最长延迟 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: Deferred timer 最长延迟（默认 900000 = 15 分钟），兜底防止永远不唤醒",
    componentProps: { min: 60000, max: 3600000, step: 60000, placeholder: "900000" }
  },

  // ===== 智能模式 - 本地预筛 =====
  { component: "Divider", label: "智能模式 - 本地预筛（毫秒级跳过无关消息）" },
  {
    field: "smartTrigger.skipWhenAddressedOther",
    label: "@ 别人时跳过 Gate",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 消息 @ 了非 bot 的某人时直接跳过 Gate，不消耗 LLM 调用（推荐开）"
  },
  {
    field: "smartTrigger.skipWhenEmptyText",
    label: "空文本消息跳过 Gate",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 纯表情/图片/转账等无文本内容的消息跳过 Gate"
  },

  // ===== 智能模式 - Gate prompt 信号阈值 =====
  { component: "Divider", label: "智能模式 - Gate prompt 信号阈值（保守倾向沉默）" },
  {
    field: "smartTrigger.promptHintBusyGroupRate",
    label: "群热闹消息数阈值",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 群最近 5min 消息数 ≥ 此值时，Gate prompt 提示「群里热闹倾向沉默」（默认 30，正常活跃群聊不会触发；调低则 bot 在热闹群更克制）",
    componentProps: { min: 1, max: 100, placeholder: "30" }
  },
  {
    field: "smartTrigger.promptHintRateLimitWarn",
    label: "刷屏警告阈值 (次/10min)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: bot 最近 10min 已回复 ≥ 此值时，Gate prompt 强烈提示「避免刷屏」（默认 5）",
    componentProps: { min: 1, max: 30, placeholder: "5" }
  },

  // ===== 智能模式 - 复读跟读 =====
  { component: "Divider", label: "智能模式 - 复读跟读（看到群里复读按概率参与）" },
  {
    field: "smartTrigger.repeatJoinEnabled",
    label: "复读跟读总开关",
    component: "Switch",
    bottomHelpMessage: "smart 模式: 检测到群里多人复读同一内容时，按概率让 bot 直接复读原文（绕过 Gate / LLM 改写），仍占用速率配额"
  },
  {
    field: "smartTrigger.repeatDetectionWindow",
    label: "复读检测窗口",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 看最近 N 条群消息判断是否在复读",
    componentProps: { min: 2, max: 20, placeholder: "5" }
  },
  {
    field: "smartTrigger.repeatMinCount",
    label: "复读最少人数",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 至少 N 个不同用户发了相同内容才算复读（含当前发言者）。3 较准确，2 偏松易把偶发同词误判",
    componentProps: { min: 2, max: 10, placeholder: "3" }
  },
  {
    field: "smartTrigger.repeatJoinProbability",
    label: "参与复读概率",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 命中复读后 bot 参与的概率，0-1。设为 1 永远参与，0 永不参与",
    componentProps: { min: 0, max: 1, step: 0.1, placeholder: "0.6" }
  },
  {
    field: "smartTrigger.repeatJoinCooldownMs",
    label: "跟读后冷却 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: bot 参与复读后多久内不再跟读，防同一波内反复跟（默认 180000 = 3 分钟；总量靠 maxRepliesPer10Min 兜底）",
    componentProps: { min: 0, max: 3600000, step: 60000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.repeatMaxTextLength",
    label: "复读文本最大长度",
    component: "InputNumber",
    bottomHelpMessage: "smart 模式: 单条复读文本超过此长度（字符数）则不参与，避免跟长发言",
    componentProps: { min: 1, max: 200, placeholder: "30" }
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
