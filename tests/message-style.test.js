import test from "node:test"
import assert from "node:assert/strict"
import { FakeChatTool } from "../functions/functions_tools/FakeChatTool.js"

const style = bubbleId => ({
  bubbleId,
  pendantId: 12,
  fontId: 4,
  fontEffectId: 5,
  isCsFontEffectEnabled: true,
  bubbleDiyTextId: 6
})

const expectedStyle = bubbleId => ({
  bubble_id: bubbleId,
  pendant_id: 12,
  font_id: 4,
  font_effect_id: 5,
  is_cs_font_effect_enabled: true,
  bubble_diy_text_id: 6
})

const event = bot => ({
  bot,
  group_id: 654321,
  user_id: 999999,
  isMaster: true
})

test("fakeChatTool queries get_msg on every call using the context message ID", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let getMsgCalls = 0
  const forwardPayloads = []
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        getMsgCalls++
        assert.equal(params.message_id, "42")
        return {
          data: {
            user_id: 123456,
            raw: { msgStyle: style(getMsgCalls === 1 ? 321 : 654) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayloads.push(params)
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  const options = {
    messages: [{ qq: "123456", name: "测试用户", content: "测试内容" }],
    message_ids: ["42"]
  }
  await tool.func(options, event(bot))
  await tool.func(options, event(bot))

  assert.equal(getMsgCalls, 2)
  assert.deepEqual(forwardPayloads[0].messages[0].data.message_style, expectedStyle(321))
  assert.deepEqual(forwardPayloads[1].messages[0].data.message_style, expectedStyle(654))
})

test("fakeChatTool maps a message ID array to different target QQ users", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        const secondUser = params.message_id === "43"
        return {
          data: {
            user_id: secondUser ? 654321 : 123456,
            raw: { msgStyle: style(secondUser ? 654 : 321) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [
      { qq: "123456", name: "用户A", content: "第一条" },
      { qq: "654321", name: "用户B", content: "第二条" }
    ],
    message_ids: ["42", "43"]
  }, event(bot))

  assert.deepEqual(forwardPayload.messages[0].data.message_style, expectedStyle(321))
  assert.deepEqual(forwardPayload.messages[1].data.message_style, expectedStyle(654))
})

test("fakeChatTool queries one style for repeated messages from the same QQ", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let getMsgCalls = 0
  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        getMsgCalls++
        assert.equal(params.message_id, "42")
        return {
          data: {
            user_id: 123456,
            raw: { msgStyle: style(321) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [
      { qq: "123456", name: "测试用户", content: "第一条" },
      { qq: "123456", name: "测试用户", content: "第二条" }
    ],
    message_ids: ["42", "42"]
  }, event(bot))

  assert.equal(getMsgCalls, 1)
  assert.deepEqual(forwardPayload.messages[0].data.message_style, expectedStyle(321))
  assert.deepEqual(forwardPayload.messages[1].data.message_style, expectedStyle(321))
})

test("fakeChatTool keeps the newest style when one QQ has multiple source IDs", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        const newer = params.message_id === "42"
        return {
          data: {
            user_id: 123456,
            time: newer ? 200 : 100,
            raw: { msgStyle: style(newer ? 321 : 111) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [{ qq: "123456", name: "测试用户", content: "测试内容" }],
    message_ids: ["42", "41"]
  }, event(bot))

  assert.deepEqual(forwardPayload.messages[0].data.message_style, expectedStyle(321))
})

test("fakeChatTool ignores a source ID belonging to another QQ", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        return {
          data: {
            user_id: 654321,
            raw: { msgStyle: style(654) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [{ qq: "123456", name: "测试用户", content: "测试内容" }],
    message_ids: ["42"]
  }, event(bot))

  assert.equal("message_style" in forwardPayload.messages[0].data, false)
})

test("fakeChatTool skips style APIs for non-LLOneBot protocols", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "NapCat.Onebot" },
    async sendApi(action, params) {
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [{
      qq: "123456",
      name: "测试用户",
      content: "测试内容"
    }],
    message_ids: ["42"]
  }, event(bot))

  assert.equal("message_style" in forwardPayload.messages[0].data, false)
})

test("fakeChatTool uses the current event message ID when the target is the caller", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        assert.equal(params.message_id, "-99")
        return {
          data: {
            user_id: 123456,
            raw: { msgStyle: style(321) }
          }
        }
      }
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  await tool.func({
    messages: [{ qq: "123456", name: "测试用户", content: "测试内容" }]
  }, {
    ...event(bot),
    user_id: 123456,
    message_id: -99
  })

  assert.deepEqual(forwardPayload.messages[0].data.message_style, expectedStyle(321))
})
