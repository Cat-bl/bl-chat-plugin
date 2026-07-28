import test from "node:test"
import assert from "node:assert/strict"
import { selectionMethods } from "../utils/emoji/selectionMethods.js"

const { cosineSimilarity, weightedSampleByUsage } = selectionMethods

function fakeManager(config = {}) {
  return {
    config,
    recentPicksByGroup: new Map(),
    recentSendsByGroup: new Map(),
    ...selectionMethods
  }
}

test("cosineSimilarity：同向 1、正交 0、长度不等 0", () => {
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1], [1, 0]), 0)
  assert.equal(cosineSimilarity("x", [1]), 0)
})

test("recordPick + getRecentExclusions：记录并按 hash/tag 排除", () => {
  const m = fakeManager({ avoidRecentCount: 20, avoidRecentTtlMinutes: 30 })
  m.recordPick("g1", "hash1", ["开心", "猫"])
  m.recordPick("g1", "hash2", [])
  const { hashes, tags } = m.getRecentExclusions("g1")
  assert.deepEqual([...hashes].sort(), ["hash1", "hash2"])
  assert.equal(tags.has("开心"), true)
  assert.equal(tags.has("猫"), true)
})

test("recordPick：超出 avoidRecentCount 时淘汰最旧记录", () => {
  const m = fakeManager({ avoidRecentCount: 2 })
  m.recordPick("g1", "h1", [])
  m.recordPick("g1", "h2", [])
  m.recordPick("g1", "h3", [])
  const { hashes } = m.getRecentExclusions("g1")
  assert.equal(hashes.has("h1"), false)
  assert.deepEqual([...hashes].sort(), ["h2", "h3"])
})

test("getRecentExclusions：无 groupId 返回空集合", () => {
  const m = fakeManager()
  const { hashes, tags } = m.getRecentExclusions(null)
  assert.equal(hashes.size, 0)
  assert.equal(tags.size, 0)
})

test("checkRateLimit：窗口内达到上限后拒绝", () => {
  const m = fakeManager({ rateLimitEnabled: true, rateLimitWindowMinutes: 5, rateLimitMaxPerWindow: 2 })
  assert.equal(m.checkRateLimit("g1").allowed, true)
  m.recordSend("g1")
  assert.equal(m.checkRateLimit("g1").allowed, true)
  m.recordSend("g1")
  const blocked = m.checkRateLimit("g1")
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.count, 2)
  assert.equal(blocked.max, 2)
})

test("checkRateLimit：关闭开关或无 groupId 时直接放行", () => {
  const off = fakeManager({ rateLimitEnabled: false })
  assert.equal(off.checkRateLimit("g1").allowed, true)
  const on = fakeManager({ rateLimitMaxPerWindow: 3 })
  assert.equal(on.checkRateLimit(null).allowed, true)
})

test("weightedSampleByUsage：空候选返回 null、单候选必中", () => {
  assert.equal(weightedSampleByUsage(null), null)
  assert.equal(weightedSampleByUsage([]), null)
  const only = { item: { hash: "a" }, score: 0.9 }
  assert.equal(weightedSampleByUsage([only]), only)
})

test("weightedSampleByUsage：始终从候选池中取样", () => {
  const candidates = [
    { item: { hash: "a", usedCount: 0 }, score: 0.9 },
    { item: { hash: "b", usedCount: 5 }, score: 0.85 },
    { item: { hash: "c", usedCount: 2 }, score: 0.3 }
  ]
  for (let i = 0; i < 20; i++) {
    const picked = weightedSampleByUsage(candidates)
    assert.ok(candidates.includes(picked))
  }
})
