// Redis key 批量扫描/删除的共享实现（apps/chat.js 与 utils/MessageManager.js 共用）：
// SCAN 优先（scanIterator / scan 两种客户端 API），异常时回退 KEYS；删除按 200 个一批。
export async function scanRedisKeys(pattern, logLabel = "Redis") {
  try {
    if (typeof redis.scanIterator === "function") {
      const keys = []
      for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        if (Array.isArray(key)) keys.push(...key)
        else keys.push(key)
      }
      return keys
    }

    if (typeof redis.scan === "function") {
      const keys = []
      let cursor = "0"
      do {
        const [nextCursor, batch = []] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200)
        cursor = String(nextCursor)
        keys.push(...batch)
      } while (cursor !== "0")
      return keys
    }
  } catch (error) {
    logger.warn(`[${logLabel}] SCAN 扫描失败，回退使用 KEYS：${pattern}，原因：${error.message}`)
  }

  return await redis.keys(pattern)
}

export async function deleteRedisKeys(keys = []) {
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200).filter(Boolean)
    if (chunk.length) {
      await redis.del(...chunk)
    }
  }
}
