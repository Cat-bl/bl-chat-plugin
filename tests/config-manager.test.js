import test from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { configManagerMethods } from "../core/configManager.js"

// mergeConfig 内部用 this 递归，绑定到方法集合对象上调用
const cm = { ...configManagerMethods }

test("mergeConfig：用户值覆盖默认值（包括空值）", () => {
  const defaults = { a: 1, b: "默认", c: true }
  const user = { a: 2, b: "" }
  assert.deepEqual(cm.mergeConfig(defaults, user), { a: 2, b: "", c: true })
})

test("mergeConfig：嵌套对象递归合并并补全新增字段", () => {
  const defaults = { sys: { x: 1, y: 2 }, top: "t" }
  const user = { sys: { x: 9 } }
  assert.deepEqual(cm.mergeConfig(defaults, user), { sys: { x: 9, y: 2 }, top: "t" })
})

test("mergeConfig：数组按用户值整体替换而不是合并", () => {
  const defaults = { list: [1, 2, 3] }
  const user = { list: [9] }
  assert.deepEqual(cm.mergeConfig(defaults, user), { list: [9] })
})

test("mergeConfig：用户多出的字段不进入结果（以默认结构为准）", () => {
  const defaults = { a: 1 }
  const user = { a: 2, extra: "x" }
  assert.deepEqual(cm.mergeConfig(defaults, user), { a: 2 })
})

test("mergeConfigPreserveUser：保留用户多出的字段", () => {
  const defaults = { a: 1, nested: { x: 1 } }
  const user = { a: 2, extra: "保留我", nested: { x: 9, y: "也保留" } }
  assert.deepEqual(cm.mergeConfigPreserveUser(defaults, user), {
    a: 2,
    extra: "保留我",
    nested: { x: 9, y: "也保留" }
  })
})

test("mergeConfigPreserveUser：非对象输入的边界行为", () => {
  assert.equal(cm.mergeConfigPreserveUser("默认", "用户"), "用户")
  assert.equal(cm.mergeConfigPreserveUser("默认", undefined), "默认")
  assert.deepEqual(cm.mergeConfigPreserveUser({ a: 1 }, null), { a: 1 })
})

test("mergeMCPConfig：用户 servers 整体保留，默认中存在的同名 server 递归合并", () => {
  const defaults = {
    settings: { timeout: 30, legacyAliasEnabled: true },
    servers: { foo: { url: "http://default", retry: 3 } }
  }
  const user = {
    servers: {
      foo: { url: "http://user" },
      bar: { url: "http://user-only" }
    }
  }
  const merged = cm.mergeMCPConfig(defaults, user)
  assert.deepEqual(merged.servers.foo, { url: "http://user", retry: 3 })
  assert.deepEqual(merged.servers.bar, { url: "http://user-only" })
  // legacyAliasEnabled 是已废弃字段，合并时强制移除
  assert.equal("legacyAliasEnabled" in merged.settings, false)
  assert.equal(merged.settings.timeout, 30)
})

test("applyDefaultArrayAdditions：默认新增条目追加，用户删除的条目不回加", () => {
  const snapshot = { pluginSettings: { oneapi_tools: ["aTool", "bTool", "cTool"] } }
  const defaults = { pluginSettings: { oneapi_tools: ["aTool", "bTool", "cTool", "newTool"] } }
  // 用户删掉了 bTool（表示禁用），merged 的数组即用户值
  const merged = { pluginSettings: { oneapi_tools: ["aTool", "cTool"] } }
  cm.applyDefaultArrayAdditions(merged, defaults, snapshot)
  assert.deepEqual(merged.pluginSettings.oneapi_tools, ["aTool", "cTool", "newTool"])
})

test("applyDefaultArrayAdditions：条目仅 (标记) 变化不视为新增，不产生重复", () => {
  const snapshot = { list: ["bananaTool", "xTool"] }
  const defaults = { list: ["bananaTool(dedupe)", "xTool"] }
  const merged = { list: ["bananaTool", "xTool"] }
  cm.applyDefaultArrayAdditions(merged, defaults, snapshot)
  assert.deepEqual(merged.list, ["bananaTool", "xTool"])
})

test("applyDefaultArrayAdditions：对象数组与快照缺失字段都不做增量", () => {
  const snapshot = { rules: [{ v: 1 }] }
  const defaults = { rules: [{ v: 1 }, { v: 2 }], fresh: ["a", "b"] }
  const merged = { rules: [{ v: 1 }], fresh: ["a"] }
  cm.applyDefaultArrayAdditions(merged, defaults, snapshot)
  assert.deepEqual(merged.rules, [{ v: 1 }])
  // fresh 在快照里不存在（无基线）：不追加，交给 mergeConfig 的整字段补全逻辑
  assert.deepEqual(merged.fresh, ["a"])
})

test("默认配置快照：写入读回与损坏降级", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-chat-snapshot-"))
  try {
    assert.equal(cm.readDefaultsSnapshot(dir), null)
    const defaults = { pluginSettings: { oneapi_tools: ["aTool"] } }
    cm.writeDefaultsSnapshot(dir, defaults)
    assert.deepEqual(cm.readDefaultsSnapshot(dir), defaults)
    // 内容被破坏成非对象时降级为无快照
    fs.writeFileSync(path.join(dir, ".defaults-snapshot.yaml"), "只是一个字符串")
    assert.equal(cm.readDefaultsSnapshot(dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("快照三方合并多轮启动：升级建基线 → 默认新增同步 → 用户删除不回加", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-chat-flow-"))
  try {
    // 存量用户：早已删掉 bTool
    let defaults = { pluginSettings: { oneapi_tools: ["aTool", "bTool"] } }
    const userTools = () => ({ pluginSettings: { oneapi_tools: ["aTool"] } })

    // 第一轮（升级后首启）：无快照，只建基线，配置与旧版行为完全一致
    let snapshot = cm.readDefaultsSnapshot(dir)
    let merged = cm.mergeConfig(defaults, userTools())
    if (snapshot) merged = cm.applyDefaultArrayAdditions(merged, defaults, snapshot)
    cm.writeDefaultsSnapshot(dir, defaults)
    assert.deepEqual(merged.pluginSettings.oneapi_tools, ["aTool"])

    // 第二轮（插件更新默认新增 newTool）：只有 newTool 被追加，bTool 仍不回加
    defaults = { pluginSettings: { oneapi_tools: ["aTool", "bTool", "newTool"] } }
    snapshot = cm.readDefaultsSnapshot(dir)
    merged = cm.applyDefaultArrayAdditions(cm.mergeConfig(defaults, userTools()), defaults, snapshot)
    cm.writeDefaultsSnapshot(dir, defaults)
    assert.deepEqual(merged.pluginSettings.oneapi_tools, ["aTool", "newTool"])

    // 第三轮（用户又删掉了 newTool，默认未变）：不回加
    snapshot = cm.readDefaultsSnapshot(dir)
    merged = cm.applyDefaultArrayAdditions(cm.mergeConfig(defaults, userTools()), defaults, snapshot)
    assert.deepEqual(merged.pluginSettings.oneapi_tools, ["aTool"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
