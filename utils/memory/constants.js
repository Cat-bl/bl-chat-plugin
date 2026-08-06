// 长期记忆系统共享常量。从 MemoryManager.js 拆出（行为等价搬迁）。
export const USER_CATEGORIES = ["identity", "likes", "dislikes", "relationship", "habits", "skills", "experience"]
export const GROUP_CATEGORIES = ["topic", "rule", "meme", "event", "member"]

export const USER_CATEGORY_LABELS = {
  identity: "身份信息",
  likes: "偏好",
  dislikes: "反感",
  relationship: "关系",
  habits: "习惯",
  skills: "技能",
  experience: "经历"
}

export const GROUP_CATEGORY_LABELS = {
  topic: "群话题",
  rule: "群规则",
  meme: "群梗",
  event: "群事件",
  member: "成员共识"
}

export const DEFAULT_CONFIG = {
  enabled: true,
  maxFactsPerUser: 100,
  maxFactsPerGroup: 50,
  importanceThreshold: 0.5,
  memoryDecayDays: 7,
  userExtractDebounceSeconds: 45,
  userExtractMaxBatchMessages: 6,
  groupExtractMinIntervalMinutes: 10,
  groupExtractMaxBatchMessages: 12,
  promptMaxUserFacts: 8,
  promptMaxGroupFacts: 6,
  promptMaxChars: 1200,
  semanticRecallEnabled: false,
  semanticRecallTopK: 20,
  memoryAiConfig: null,
  embeddingAiConfig: null,
  minFactsPerCategory: 2
}

export const LEGACY_MEMORY_ROLLBACK_DAYS = 30
export const DELETED_MEMORY_RETENTION_DAYS = 30
export const MAX_DELETED_FACTS_PER_SCOPE = 200

// 推测性用户事实不会直接进入长期记忆。它们先短期保留，跨两个独立
// 抽取批次重复出现后再晋升，避免把单次闲聊误判成稳定偏好或习惯。
export const USER_CANDIDATE_TTL_DAYS = 7
export const USER_CANDIDATE_PROMOTION_COUNT = 2
export const MAX_USER_CANDIDATES = 30

export const TOOL_FEEDBACK_MARKERS = [
  "[tool_request]",
  "[tool_result]",
  "[tool_execution]",
  "系统反馈信息",
  "工具已全部执行完成",
  "此处为调用工具的结果",
  "调用工具:",
  "调用结果:",
  "tool_calls",
  "role: 'tool'",
  'role: "tool"'
]
