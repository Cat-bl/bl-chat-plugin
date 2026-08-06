import test from "node:test"
import assert from "node:assert/strict"
import { MemoryManager } from "../utils/MemoryManager.js"
import { MemoryExtractor } from "../utils/memory/MemoryExtractor.js"
import { MemoryRetriever } from "../utils/memory/MemoryRetriever.js"
import { MemoryStore } from "../utils/memory/MemoryStore.js"
import { normalizeConfig } from "../utils/memory/helpers.js"

function createManager() {
  return new MemoryManager({
    enabled: true,
    importanceThreshold: 0.5,
    memoryAiConfig: {
      memoryAiUrl: "https://example.com/v1/chat/completions",
      memoryAiApikey: "test"
    }
  })
}

function candidateOperation(messageId, content = "经常熬夜") {
  return {
    operation: "upsert",
    decision: "candidate",
    content,
    category: "habits",
    importance: 0.4,
    confidence: 0.6,
    sourceMessageIds: [messageId],
    sourceUserIds: ["200"]
  }
}

test("stageUserOperations：候选跨两个独立批次后晋升", async () => {
  const manager = createManager()
  let candidates = []
  manager.store = {
    getUserMeta: async () => ({ disabled: false }),
    getUserCandidates: async () => candidates,
    saveUserCandidates: async (groupId, userId, next) => {
      candidates = next
      return next
    }
  }

  const first = await manager.stageUserOperations("100", "200", [candidateOperation("m1")])
  assert.equal(first.operations.length, 0)
  assert.equal(first.candidateAdded, 1)
  assert.equal(candidates.length, 0)
  await manager.finalizeStagedCandidates("100", "200", first, { resolvedCandidateIds: [] })
  assert.equal(candidates.length, 1)

  const secondOperation = candidateOperation("m2", "长期晚睡")
  secondOperation.candidateId = candidates[0].id
  const second = await manager.stageUserOperations("100", "200", [secondOperation])
  assert.equal(second.candidatePromoted, 1)
  assert.equal(second.operations.length, 1)
  assert.equal(second.operations[0].decision, "save")
  assert.equal(second.operations[0].content, "长期晚睡")
  assert.equal(second.operations[0].importance, 0.6)
  assert.deepEqual(second.operations[0].sourceMessageIds, ["m1", "m2"])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].evidenceKeys.length, 1)
  await manager.finalizeStagedCandidates("100", "200", second, {
    resolvedCandidateIds: [second.operations[0].candidateId]
  })
  assert.equal(candidates.length, 0)
})

test("stageUserOperations：同一批证据不重复累计，明确事实清理相似候选", async () => {
  const manager = createManager()
  let candidates = []
  manager.store = {
    getUserMeta: async () => ({ disabled: false }),
    getUserCandidates: async () => candidates,
    saveUserCandidates: async (groupId, userId, next) => {
      candidates = next
      return next
    }
  }

  const first = await manager.stageUserOperations("100", "200", [candidateOperation("m1")])
  await manager.finalizeStagedCandidates("100", "200", first, { resolvedCandidateIds: [] })
  const duplicate = await manager.stageUserOperations("100", "200", [candidateOperation("m1")])
  assert.equal(duplicate.candidateDuplicate, 1)
  assert.equal(candidates[0].evidenceKeys.length, 1)

  const direct = await manager.stageUserOperations("100", "200", [{
    ...candidateOperation("m2"),
    decision: "save",
    importance: 0.8
  }])
  assert.equal(direct.operations.length, 1)
  assert.equal(candidates.length, 1)
  await manager.finalizeStagedCandidates("100", "200", direct, {
    resolvedCandidateIds: [direct.operations[0].candidateId]
  })
  assert.equal(candidates.length, 0)
})

test("enqueueGroupEvent：只接收真实群文本并保留消息 ID", async () => {
  const manager = createManager()
  manager.enqueueInteraction = async event => event
  manager.extractAndSaveGroupMemories = async (groupId, messages) => ({ groupId, messages })

  const self = await manager.enqueueGroupEvent({ group_id: 100, user_id: 999, self_id: 999 })
  assert.equal(self.reason, "self-message")

  const image = await manager.enqueueGroupEvent({
    group_id: 100,
    user_id: 200,
    self_id: 999,
    message: [{ type: "image", data: { file: "a.jpg" } }]
  })
  assert.equal(image.reason, "no-text")

  manager.updateConfig({ enableGroupWhitelist: true, allowedGroups: [101] })
  const denied = await manager.enqueueGroupEvent({
    group_id: 100,
    user_id: 200,
    self_id: 999,
    message: [{ type: "text", data: { text: "我是程序员" } }]
  })
  assert.equal(denied.reason, "group-not-allowed")
  manager.updateConfig({ enableGroupWhitelist: false })

  const text = await manager.enqueueGroupEvent({
    group_id: 100,
    user_id: 200,
    self_id: 999,
    message_id: "m1",
    time: 1700000000,
    sender: { nickname: "测试用户" },
    message: [
      { type: "at", data: { qq: "999" } },
      { type: "text", data: { text: "我是程序员" } }
    ]
  })
  assert.equal(text.content, "我是程序员")
  assert.equal(text.messageId, "m1")
  assert.equal(text.senderName, "测试用户")
  assert.equal(text.groupMemory.groupId, 100)
  assert.equal(text.groupMemory.messages[0].messageId, "m1")
})

test("enqueueInteraction：同一用户的相同消息只入队一次", async () => {
  const manager = createManager()
  let calls = 0
  manager.extractAndSaveMemories = async () => {
    calls++
    return { queued: true }
  }

  const event = { groupId: "100", userId: "200", content: "我喜欢打游戏", source: "user", messageId: "m1" }
  await manager.enqueueInteraction(event)
  const duplicate = await manager.enqueueInteraction(event)
  assert.equal(calls, 1)
  assert.equal(duplicate.reason, "duplicate")
})

test("enqueueInteraction：记忆 AI 不可用时不占用去重记录或缓冲区", async () => {
  const manager = new MemoryManager({ enabled: true, memoryAiConfig: null })
  const result = await manager.enqueueInteraction({
    groupId: "100",
    userId: "200",
    content: "我是程序员",
    source: "user",
    messageId: "m1"
  })

  assert.equal(result.reason, "ai-unavailable")
  assert.equal(manager.userSeenMessages.size, 0)
  assert.equal(manager.userBuffers.size, 0)
})

test("用户禁用记忆后不再注入事实或关系熟悉度", async () => {
  const manager = createManager()
  manager.retriever.retrieve = async () => ({
    meta: { disabled: true, relationshipScore: 0.95 },
    facts: [{ content: "不应注入", category: "identity" }]
  })

  assert.equal(await manager.getMemoryPromptForUser("100", "200", "测试"), "")
})

test("adminClearMemories：等待同一用户的在途抽取完成后再清空", async () => {
  const manager = createManager()
  let releaseExtraction
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const blocker = new Promise(resolve => { releaseExtraction = resolve })
  let cleared = false
  manager.store = {
    clearScope: async () => {
      cleared = true
      return 3
    }
  }

  const extraction = manager.enqueueUserTask("100", "200", async () => {
    markStarted()
    await blocker
  })
  await started

  const clearing = manager.adminClearMemories({ scope: "user", groupId: "100", userId: "200" })
  await Promise.resolve()
  assert.equal(cleared, false)

  releaseExtraction()
  await extraction
  const result = await clearing
  assert.equal(cleared, true)
  assert.equal(result.cleared, 3)
})

test("MemoryExtractor：保留 candidate 决策并对非法 JSON 修复一次", async t => {
  const previousLogger = globalThis.logger
  globalThis.logger = { warn() {} }
  t.after(() => {
    globalThis.logger = previousLogger
  })

  const extractor = new MemoryExtractor(normalizeConfig({}), {})
  const operations = extractor.normalizeOperations([{
    operation: "upsert",
    decision: "candidate",
    content: "经常熬夜",
    category: "habits",
    importance: 0.4
  }], "user", { sourceMessageIds: ["m1"], sourceUserIds: ["200"] })
  assert.equal(operations[0].decision, "candidate")

  const responses = ["这不是 JSON", "[]"]
  extractor.callChat = async () => responses.shift()
  const parsed = await extractor.parseOperationResponse([], 100)
  assert.equal(parsed.parseStatus, "repaired_empty")
  assert.equal(parsed.repaired, true)
  assert.equal(responses.length, 0)
})

test("MemoryStore：候选使用短期 Redis 存储并可清除", async t => {
  const previousRedis = globalThis.redis
  const values = new Map()
  const expirations = new Map()
  globalThis.redis = {
    async set(key, value) { values.set(key, value) },
    async get(key) { return values.get(key) || null },
    async del(key) { values.delete(key) },
    async expire(key, seconds) { expirations.set(key, seconds) }
  }
  t.after(() => {
    globalThis.redis = previousRedis
  })

  const store = new MemoryStore(normalizeConfig({}))
  await store.saveUserCandidates("100", "200", [{
    content: "经常熬夜",
    category: "habits",
    evidenceKeys: ["batch-1"],
    sourceMessageIds: ["m1"]
  }])
  const candidates = await store.getUserCandidates("100", "200")
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].content, "经常熬夜")
  assert.ok(expirations.get(store.userCandidateKey("100", "200")) > 0)

  await store.clearUserCandidates("100", "200")
  assert.equal((await store.getUserCandidates("100", "200")).length, 0)
})

test("MemoryStore：旧版无 ID 事实使用稳定 ID，避免并发迁移产生孤立键", () => {
  const store = new MemoryStore(normalizeConfig({}))
  const first = store.factFromLegacy("喜欢火锅", "user", "100", "200", "likes")
  const second = store.factFromLegacy("喜欢火锅", "user", "100", "200", "likes")
  assert.equal(first.id, second.id)
})

test("applyOperations：未知 update ID 不新增事实，upsert 不采用模型提供的陌生 ID", async () => {
  const manager = createManager()
  let savedFact = null
  manager.store = {
    getMeta: async () => ({ scope: "user", groupId: "100", userId: "200", disabled: false }),
    getFacts: async () => [],
    normalizeCategory: (scope, category) => category,
    saveFact: async fact => { savedFact = fact; return fact }
  }
  manager.extractor.createEmbedding = async () => ({ embedding: null, embeddingHash: null })

  const update = await manager.applyOperations("user", "100", "200", [{
    operation: "update",
    id: "hallucinated-id",
    content: "喜欢火锅",
    category: "likes",
    importance: 0.8
  }])
  assert.equal(update.saved, 0)
  assert.equal(update.invalid, 1)

  const upsert = await manager.applyOperations("user", "100", "200", [{
    operation: "upsert",
    id: "model-controlled-id",
    content: "喜欢火锅",
    category: "likes",
    importance: 0.8
  }])
  assert.equal(upsert.saved, 1)
  assert.notEqual(savedFact.id, "model-controlled-id")
})

test("群记忆缓冲：倒序批量输入按时间正序分批且不丢消息", async () => {
  const manager = new MemoryManager({
    enabled: true,
    groupExtractMaxBatchMessages: 2,
    groupExtractMinIntervalMinutes: 10,
    memoryAiConfig: { memoryAiUrl: "https://example.com", memoryAiApikey: "test" }
  })
  const batches = []
  manager.extractAndSaveGroupMemoriesNow = async (groupId, messages) => {
    batches.push(messages.map(message => message.messageId))
    return { saved: 0, deleted: 0, skipped: 0 }
  }

  const messages = [5, 4, 3, 2, 1].map(index => ({
    userId: String(100 + index),
    content: `消息${index}`,
    messageId: `m${index}`,
    createdAt: index * 1000,
    source: "user"
  }))
  await manager.extractAndSaveGroupMemories("100", messages)
  await manager.flushGroupBuffer("100")

  assert.deepEqual(batches, [["m1", "m2"], ["m3", "m4"], ["m5"]])
  assert.equal(manager.groupBuffers.size, 0)
})

test("群记忆缓冲：调度元数据读取失败后仍保留消息并安排重试", async () => {
  const manager = createManager()
  manager.store.getGroupMeta = async () => { throw new Error("redis unavailable") }

  await assert.rejects(manager.extractAndSaveGroupMemories("100", [{
    userId: "200",
    content: "这是普通聊天",
    messageId: "m1",
    createdAt: 1,
    source: "user"
  }]), /redis unavailable/)

  const buffer = manager.groupBuffers.get("100")
  assert.deepEqual(buffer.messages.map(message => message.messageId), ["m1"])
  assert.ok(buffer.timer)
  manager.discardGroupBuffer("100")
})

test("群记忆执行：并发期间的第二批仍遵守群最小整理间隔", async () => {
  const manager = createManager()
  const lastAttemptAt = Date.now() - 1_000
  manager.store = {
    getGroupMeta: async () => ({
      scope: "group",
      groupId: "100",
      factIds: [],
      disabled: false,
      lastAttemptAt,
      nextRetryAt: 0
    })
  }

  const result = await manager.extractAndSaveGroupMemoriesNow("100", [{
    userId: "200",
    content: "这是第二批消息",
    messageId: "m2",
    createdAt: 2,
    source: "user"
  }])

  assert.equal(result.reason, "interval")
  assert.ok(result.retryAt > Date.now())
})

test("用户记忆缓冲：退避结果会恢复原批次而不是丢弃", async () => {
  const manager = createManager()
  manager.extractAndSaveMemoriesNow = async () => ({
    saved: 0,
    deleted: 0,
    skipped: 1,
    reason: "backoff",
    retryAt: Date.now() + 60_000
  })
  const key = manager.getUserBufferKey("100", "200")
  manager.userBuffers.set(key, {
    groupId: "100",
    userId: "200",
    messages: [{ userId: "200", content: "我是程序员", messageId: "m1", createdAt: 1 }],
    firstBufferedAt: 1,
    timer: null
  })

  await manager.flushUserBuffer(key)
  assert.deepEqual(manager.userBuffers.get(key).messages.map(message => message.messageId), ["m1"])
  manager.discardUserBuffer("100", "200")
})

test("热关闭记忆：清空缓冲并取消正在进行的请求", () => {
  const manager = createManager()
  let aborted = 0
  manager.extractor.abortActiveRequests = () => { aborted++ }
  manager.userBuffers.set("100:200", { timer: setTimeout(() => {}, 60_000), messages: [{}] })
  manager.groupBuffers.set("100", { groupId: "100", timer: setTimeout(() => {}, 60_000), messages: [{}] })

  manager.updateConfig({ enabled: false })
  assert.equal(manager.userBuffers.size, 0)
  assert.equal(manager.groupBuffers.size, 0)
  assert.equal(aborted, 1)
})

test("MemoryExtractor：缺失 decision 保守进入候选，并按 sourceIndexes 绑定证据", () => {
  const extractor = new MemoryExtractor(normalizeConfig({}), {})
  const operations = extractor.normalizeOperations([{
    operation: "upsert",
    content: "喜欢火锅",
    category: "likes",
    importance: 0.8,
    sourceIndexes: [2]
  }, {
    operation: "unknown",
    content: "不应保存",
    category: "identity"
  }], "user", {
    messages: [
      { messageId: "m1", userId: "200" },
      { messageId: "m2", userId: "200" }
    ]
  })

  assert.equal(operations.length, 1)
  assert.equal(operations[0].decision, "candidate")
  assert.deepEqual(operations[0].sourceMessageIds, ["m2"])
})

test("MemoryExtractor：切换 embedding 服务后旧向量不会被误认为当前向量", () => {
  const config = normalizeConfig({
    semanticRecallEnabled: true,
    embeddingAiConfig: {
      embeddingApiUrl: "https://one.example/embeddings",
      embeddingApiKey: "test",
      embeddingApiModel: "same-model"
    }
  })
  const extractor = new MemoryExtractor(config, {})
  const first = extractor.embeddingHashFor("喜欢火锅")
  config.embeddingAiConfig.embeddingApiUrl = "https://two.example/embeddings"
  assert.notEqual(first, extractor.embeddingHashFor("喜欢火锅"))
})

test("MemoryRetriever：召回纯读、使用 semanticRecallTopK 并忽略旧模型向量", async () => {
  const facts = [
    { id: "a", content: "当前相关", importance: 0.6, confidence: 0.8, updatedAt: Date.now(), embedding: [1, 0], embeddingHash: "hash:当前相关" },
    { id: "b", content: "次要相关", importance: 1, confidence: 1, updatedAt: Date.now(), embedding: [0.8, 0.2], embeddingHash: "hash:次要相关" },
    { id: "c", content: "旧模型向量", importance: 1, confidence: 1, updatedAt: Date.now(), embedding: [1, 0], embeddingHash: "old-hash" }
  ].map(fact => ({ ...fact, scope: "user", groupId: "100", userId: "200", category: "identity" }))
  const store = {
    getMeta: async () => ({ disabled: false }),
    getFacts: async () => facts,
    setJson: async () => { throw new Error("召回不应写 Redis") }
  }
  const extractor = {
    canUseEmbedding: () => true,
    createEmbedding: async () => ({ embedding: [1, 0] }),
    embeddingHashFor: text => `hash:${text}`
  }
  const retriever = new MemoryRetriever(normalizeConfig({
    semanticRecallEnabled: true,
    semanticRecallTopK: 1
  }), store, extractor)

  const result = await retriever.retrieve({ groupId: "100", userId: "200", query: "相关", limit: 3 })
  assert.deepEqual(result.facts.map(fact => fact.id), ["a"])
})

test("MemoryStore：显式删除可审计，清空会删除活动、删除和孤立事实", async t => {
  const previousRedis = globalThis.redis
  const values = new Map()
  globalThis.redis = {
    async set(key, value) { values.set(key, value) },
    async get(key) { return values.get(key) || null },
    async del(key) { values.delete(key) },
    async *scanIterator({ MATCH }) {
      const prefix = MATCH.replace(/\*$/, "")
      for (const key of [...values.keys()]) {
        if (key.startsWith(prefix)) yield key
      }
    }
  }
  t.after(() => { globalThis.redis = previousRedis })

  const store = new MemoryStore(normalizeConfig({ maxFactsPerUser: 10 }))
  await store.saveFact({
    id: "fact-0001",
    scope: "user",
    groupId: "100",
    userId: "200",
    content: "喜欢火锅",
    category: "likes"
  })
  const meta = await store.getUserMeta("100", "200")
  await store.deleteFact(meta, "fact-0001")
  const deletedMeta = await store.getUserMeta("100", "200")
  assert.deepEqual(deletedMeta.factIds, [])
  assert.deepEqual(deletedMeta.deletedFactIds, ["fact-0001"])
  assert.equal((await store.getFacts(deletedMeta, true))[0].status, "deleted")

  const orphanKey = store.factKey("user", store.userScopeId("100", "200"), "orphan")
  values.set(orphanKey, JSON.stringify({ id: "orphan" }))
  await store.clearScope("user", "100", "200")
  assert.equal([...values.keys()].some(key => key.includes("fact:user:100:200:")), false)
})

test("adminDeleteMemory：拒绝过短和不唯一的 ID 前缀", async () => {
  const manager = createManager()
  manager.store = {
    getMeta: async () => ({ factIds: ["12345678-a", "12345678-b"] }),
    deleteFact: async () => true
  }

  assert.equal((await manager.adminDeleteMemory({ scope: "user", groupId: "100", userId: "200", id: "1234" })).reason, "id-too-short")
  assert.equal((await manager.adminDeleteMemory({ scope: "user", groupId: "100", userId: "200", id: "12345678" })).reason, "ambiguous-id")
})
