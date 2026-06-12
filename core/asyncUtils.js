import pLimit from "p-limit"

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function getOrCreateGroupLimiter(limitersMap, groupId, concurrency) {
  const entry = limitersMap.get(groupId)
  if (entry && entry.concurrency === concurrency) {
    return entry.limiter
  }
  const limiter = pLimit(concurrency)
  limitersMap.set(groupId, { limiter, concurrency })
  return limiter
}
