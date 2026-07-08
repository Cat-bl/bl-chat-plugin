import test from "node:test"
import assert from "node:assert/strict"
import { EmotionManager } from "../utils/EmotionManager.js"

// EmotionManager 依赖全局 redis / logger（Yunzai 运行时注入），测试内打桩。
// 方法体在调用时才读全局，所以静态导入 + 调用前打桩即可。
function stubGlobals() {
  globalThis.redis = { get: async () => null, set: async () => {} }
  globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} }
}

test("getEmotion：不同群的默认状态各自独立，recentEvents 不共享引用", async () => {
  stubGlobals()
  const mgr = new EmotionManager({})
  const s1 = await mgr.getEmotion("group1")
  // 模拟 A 群产生情绪事件
  s1.recentEvents.push({ event: "praised", delta: 0.1, time: Date.now() })
  assert.equal(s1.recentEvents.length, 1)

  // B 群取默认状态，recentEvents 必须是空的独立数组
  const s2 = await mgr.getEmotion("group2")
  assert.equal(s2.recentEvents.length, 0)
  assert.notEqual(s1.recentEvents, s2.recentEvents)
})

test("getEmotion：同一群多次取默认状态也不串数据", async () => {
  stubGlobals()
  const mgr = new EmotionManager({})
  const a = await mgr.getEmotion("group1")
  a.recentEvents.push({ event: "scolded", delta: -0.15, time: Date.now() })
  const b = await mgr.getEmotion("group1")
  assert.equal(b.recentEvents.length, 0)
})
