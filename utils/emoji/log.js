// EmojiPackManager 日志助手（主类与各 mixin 共用）。
export function logInfo(msg) { globalThis.logger?.info?.(`[EmojiPackManager] ${msg}`) }
export function logWarn(msg) { globalThis.logger?.warn?.(`[EmojiPackManager] ${msg}`) }
