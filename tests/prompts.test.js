import test from "node:test"
import assert from "node:assert/strict"
import { buildChatSystemPrompt } from "../core/prompts.js"

const baseParams = {
  systemContent: "你是测试人设",
  botCardInGroup: "基基",
  botUin: 12345,
  botRoleInGroup: "admin",
  groupContext: { groupId: "888", groupName: "测试群", groupNotice: "群公告内容" },
  administrators: "管理A(QQ号: 1)[群身份: admin]",
  localTime: "北京时间: 2026/7/8 12:00:00",
  enhancedPrompts: "",
  mcpPrompts: "",
  toolHistoryPrompt: ""
}

test("buildChatSystemPrompt：包含人设与固定段落", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes("【认知系统初始化】\n你是测试人设"))
  assert.ok(prompt.includes("【核心身份原则】"))
  assert.ok(prompt.includes("【工具调用判断原则】"))
  assert.ok(prompt.includes("【回复格式规则 - 极其重要】"))
})

test("buildChatSystemPrompt：机器人身份正确插值", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes('你在本群的当前显示名称（群名片）是"基基"，QQ号 12345，群身份 admin'))
})

test("buildChatSystemPrompt：实时数据 JSON 包含群信息与时间", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes('"group_id": "888"'))
  assert.ok(prompt.includes('"group_name": "测试群"'))
  assert.ok(prompt.includes('"group_notice": "群公告内容"'))
  assert.ok(prompt.includes('"local_time": "北京时间: 2026/7/8 12:00:00"'))
})

test("buildChatSystemPrompt：角色状态段随 enhancedPrompts 出现/消失", () => {
  const without = buildChatSystemPrompt(baseParams)
  assert.ok(!without.includes("【角色状态】"))

  const withPrompts = buildChatSystemPrompt({ ...baseParams, enhancedPrompts: "当前情绪：开心" })
  assert.ok(withPrompts.includes("【角色状态】\n当前情绪：开心"))
})

test("buildChatSystemPrompt：工具历史段可选且位于消息记录段之前", () => {
  const prompt = buildChatSystemPrompt({ ...baseParams, toolHistoryPrompt: "【工具调用历史】\n- pokeTool ✓" })
  const historyIndex = prompt.indexOf("【工具调用历史】")
  const recordIndex = prompt.indexOf("【群聊消息记录】")
  assert.ok(historyIndex > -1)
  assert.ok(historyIndex < recordIndex)
})

test("buildChatSystemPrompt：以群聊消息记录段结尾", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.endsWith("【群聊消息记录】\n"))
})
