export function resolveWaitReplyAction({
  kind,
  scheduledUserVersion,
  currentUserVersion,
  scheduledGroupVersion,
  currentGroupVersion
}) {
  if (kind === 'tool' && currentUserVersion > scheduledUserVersion) return 'cancel'
  if (kind === 'gate' && currentGroupVersion > scheduledGroupVersion) return 'use_latest'
  return 'use_original'
}

export function getSmartEventKey(e) {
  if (e?._smartOriginKey) return e._smartOriginKey
  const messageId = e?.message_id
  if (messageId !== undefined && messageId !== null && messageId !== '') {
    return `${e?.group_id || ''}:message:${messageId}`
  }
  return ''
}

export class CompletedEventCache {
  constructor({ ttlMs = 20 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.items = new Map()
  }

  has(key, now = Date.now()) {
    if (!key) return false
    const completedAt = this.items.get(key)
    if (completedAt === undefined) return false
    if (now - completedAt > this.ttlMs) {
      this.items.delete(key)
      return false
    }
    return true
  }

  add(key, now = Date.now()) {
    if (!key) return
    this.items.delete(key)
    this.items.set(key, now)
    const cutoff = now - this.ttlMs
    for (const [itemKey, completedAt] of this.items) {
      if (completedAt < cutoff || this.items.size > this.maxEntries) this.items.delete(itemKey)
      else break
    }
  }
}
