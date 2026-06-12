import test from "node:test"
import assert from "node:assert/strict"
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
