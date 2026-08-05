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

test("fakeChatTool requires message_ids and accepts an empty array", async () => {
  const tool = new FakeChatTool()
  const messages = [{ qq: "123456", content: "测试内容" }]

  assert.deepEqual(tool.parameters.required, ["messages", "message_ids"])
  assert.equal(
    await tool.execute({ messages }, {}),
    "error: 缺少必填参数: message_ids"
  )
  assert.equal(tool.validateParameters({ messages, message_ids: [] }), true)
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

test("fakeChatTool does not use the account name as a protocol marker", () => {
  const tool = new FakeChatTool()
  assert.equal(tool.getProtocol({
    name: "LLOneBot",
    version: {},
    adapter: { id: "QQ", name: "OneBotv11" }
  }), "unknown")
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

test("fakeChatTool exposes string and OneBot segment-array content in its schema", () => {
  const tool = new FakeChatTool()
  const messagesSchema = tool.parameters.properties.messages
  const contentSchema = tool.parameters.properties.messages.items.properties.content
  const segmentTypes = contentSchema.oneOf[1].items.properties.type.enum

  assert.equal(messagesSchema.minItems, 1)
  assert.equal(messagesSchema.maxItems, 99)
  assert.equal(tool.parameters.properties.message_ids.maxItems, 99)
  assert.equal(tool.parameters.properties.message_ids.uniqueItems, true)
  assert.equal(tool.parameters.properties.message_ids.items.pattern, "^-?\\d+$")
  assert.equal(messagesSchema.items.properties.qq.pattern, "^[1-9]\\d{4,}$")
  assert.equal(messagesSchema.items.properties.time.minimum, 1)
  assert.equal(contentSchema.oneOf[0].type, "string")
  assert.equal(contentSchema.oneOf[1].type, "array")
  assert.equal(contentSchema.oneOf[1].maxItems, 500)
  assert.equal(contentSchema.oneOf[1].items.properties.data.properties.result.minimum, 1)
  assert.equal(contentSchema.oneOf[1].items.properties.data.properties.result.maximum, 6)
  assert.deepEqual(segmentTypes, [
    "text", "at", "face", "image", "video", "file", "dice", "rps",
    "contact", "forward"
  ])
})

test("fakeChatTool no longer parses legacy voice placeholders", () => {
  const tool = new FakeChatTool()
  assert.deepEqual(
    tool.parseContent("voice[https://example.com/a.amr]"),
    [{ type: "text", data: { text: "voice[https://example.com/a.amr]" } }]
  )
})

test("LLOneBot keeps every selected OneBot segment and builds inline nested forwards", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "send_group_forward_msg") {
        forwardPayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const content = [
    { type: "text", data: { text: "混排" } },
    { type: "at", data: { qq: "654321" } },
    { type: "at", data: { qq: "all" } },
    { type: "face", data: { id: "14" } },
    { type: "image", data: { file: "https://example.com/a.jpg", summary: "图片" } },
    { type: "video", data: { file: "https://example.com/a.mp4" } },
    { type: "file", data: { file: "https://example.com/a.zip", name: "a.zip" } },
    { type: "dice", data: { result: 6 } },
    { type: "rps", data: { result: 2 } },
    { type: "contact", data: { type: "qq", id: "654321" } },
    { type: "contact", data: { type: "group", id: "765432" } },
    { type: "forward", data: { id: "existing-res-id" } },
    {
      type: "forward",
      data: {
        messages: [{ qq: "654321", name: "内层", content: "内层文字" }]
      }
    }
  ]

  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "123456", name: "外层", content }],
    message_ids: []
  }, event(bot))

  assert.match(result, /^已发送伪造聊天记录/)
  assert.deepEqual(
    forwardPayload.messages[0].data.content.map(item => item.type),
    [
      "text", "at", "at", "face", "image", "video", "file", "dice", "rps",
      "contact", "contact", "forward"
    ]
  )
  assert.equal(forwardPayload.messages[0].data.content[7].data.result, 6)
  assert.equal(forwardPayload.messages[0].data.content[8].data.result, 2)
  assert.equal(forwardPayload.messages[1].data.content[0].type, "node")
  assert.equal(forwardPayload.messages[1].data.content[0].data.nickname, "内层")
})

test("fakeChatTool preserves the private forward target", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let privatePayload
  const bot = {
    version: { app_name: "NapCat.Onebot" },
    async sendApi(action, params) {
      if (action === "send_private_forward_msg") {
        privatePayload = params
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "123456", name: "测试用户", content: "私聊内容" }],
    message_ids: []
  }, {
    bot,
    user_id: 999999,
    isMaster: true
  })

  assert.match(result, /^已发送伪造聊天记录/)
  assert.equal(privatePayload.user_id, 999999)
  assert.equal(privatePayload.messages[0].data.content[0].data.text, "私聊内容")
})

test("NapCat receives requested dice/rps values and recursive node payloads", async () => {
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
      name: "外层",
      content: [
        { type: "dice", data: { result: 5 } },
        { type: "rps", data: { result: 3 } },
        {
          type: "video",
          data: {
            file: "https://example.com/a.mp4",
            cover: "https://example.com/cover.jpg"
          }
        },
        {
          type: "forward",
          data: { messages: [{ qq: "654321", name: "内层", content: "内容" }] }
        }
      ]
    }],
    message_ids: []
  }, event(bot))

  assert.deepEqual(forwardPayload.messages[0].data.content, [
    { type: "dice", data: { result: 5 } },
    { type: "rps", data: { result: 3 } },
    {
      type: "video",
      data: {
        file: "https://example.com/a.mp4",
        cover: "https://example.com/cover.jpg",
        thumb: "https://example.com/cover.jpg"
      }
    }
  ])
  assert.equal(forwardPayload.messages[1].data.content[0].type, "node")
})

test("unknown OneBot implementations receive conservative readable fallbacks", async () => {
  globalThis.logger = { warn() {}, error() {} }

  const calls = []
  let forwardPayload
  const bot = {
    version: { app_name: "Other.OneBot" },
    async sendApi(action, params) {
      calls.push(action)
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
      name: "外层",
      content: [
        { type: "contact", data: { type: "group", id: "765432" } },
        { type: "forward", data: { id: "existing-res-id" } },
        {
          type: "forward",
          data: { messages: [{ qq: "654321", name: "内层", content: "内层" }] }
        }
      ]
    }],
    message_ids: []
  }, event(bot))

  assert.deepEqual(calls, ["send_group_forward_msg"])
  assert.deepEqual(
    forwardPayload.messages[0].data.content.map(segment => segment.type),
    ["text", "text"]
  )
  assert.equal(forwardPayload.messages[1].data.nickname, "内层")
})

test("fakeChatTool validates protocol-specific segment parameters", async t => {
  globalThis.logger = { warn() {}, error() {} }
  const cases = [
    ["unsupported type", { type: "json", data: {} }, /type .*不受支持/],
    ["object text", { type: "text", data: { text: { value: "内容" } } }, /data.text 必须是字符串或数字/],
    ["boolean text", { type: "text", data: { text: true } }, /data.text 必须是字符串或数字/],
    ["zero at QQ", { type: "at", data: { qq: "00000" } }, /合法的数字QQ号/],
    ["removed reply type", { type: "reply", data: { id: "42" } }, /type "reply" 不受支持/],
    ["removed record type", { type: "record", data: { file: "a.amr" } }, /type "record" 不受支持/],
    ["removed music type", { type: "music", data: { type: "qq", id: "1" } }, /type "music" 不受支持/],
    ["negative face ID", { type: "face", data: { id: -1 } }, /必须是 0-/],
    ["blank face ID", { type: "face", data: { id: "   " } }, /data.id 不能为空/],
    ["invalid dice", { type: "dice", data: { result: 7 } }, /必须是 1-6/],
    ["boolean dice", { type: "dice", data: { result: true } }, /必须是 1-6/],
    ["invalid rps", { type: "rps", data: { result: 0 } }, /必须是 1-3/],
    [
      "unsafe at integer",
      { type: "at", data: { qq: "99999999999999999999" } },
      /合法的数字QQ号/
    ],
    [
      "unsafe contact integer",
      { type: "contact", data: { type: "group", id: "99999999999999999999" } },
      /合法的数字QQ号或群号/
    ],
    [
      "object media value",
      { type: "image", data: { file: { url: "https://example.com/a.jpg" } } },
      /data.file 必须是字符串或数字/
    ],
    [
      "ambiguous forward",
      { type: "forward", data: { id: "res", messages: [] } },
      /只能填写 id 或 messages/
    ]
  ]

  for (const [name, segment, expected] of cases) {
    await t.test(name, async () => {
      const tool = new FakeChatTool()
      const result = await tool.func({
        messages: [{ qq: "123456", content: [segment] }],
        message_ids: []
      }, {})
      assert.match(result, expected)
    })
  }
})

test("fakeChatTool rejects a blank message time", async () => {
  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "123456", content: "内容", time: "   " }],
    message_ids: []
  }, {})

  assert.match(result, /messages\[0\]\.time 不能为空/)
})

test("fakeChatTool rejects a sender QQ with leading zeroes", async () => {
  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "012345", content: "内容" }],
    message_ids: []
  }, {})

  assert.match(result, /不是合法QQ号/)
})

test("fakeChatTool limits concurrent nickname lookups", async () => {
  let activeLookups = 0
  let maxActiveLookups = 0
  let lookupCount = 0
  const bot = {
    version: { app_name: "NapCat.Onebot" },
    async sendApi(action, params) {
      if (action === "get_group_member_info") {
        lookupCount++
        activeLookups++
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups)
        await new Promise(resolve => setTimeout(resolve, 5))
        activeLookups--
        return { data: { card: `用户${params.user_id}` } }
      }
      if (action === "send_group_forward_msg") {
        return { status: "ok", data: { message_id: 1 } }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: Array.from({ length: 24 }, (_, index) => ({
      qq: String(100000 + index),
      content: "内容"
    })),
    message_ids: []
  }, event(bot))

  assert.match(result, /^已发送伪造聊天记录/)
  assert.equal(lookupCount, 24)
  assert.equal(maxActiveLookups, 8)
})

test("fakeChatTool treats non-throwing OneBot failure responses as send failures", async () => {
  delete globalThis.logger

  const bot = {
    version: { app_name: "NapCat.Onebot" },
    async sendApi(action) {
      if (action === "send_group_forward_msg") {
        return { status: "failed", retcode: 1200, message: "bad payload" }
      }
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "123456", name: "测试", content: "内容" }],
    message_ids: []
  }, event(bot))

  assert.match(result, /^error: 发送失败:/)
  assert.match(result, /bad payload/)
})

test("fakeChatTool preserves non-Error transport failure details", async () => {
  delete globalThis.logger
  const bot = {
    version: { app_name: "NapCat.Onebot" },
    async sendApi(action) {
      if (action === "send_group_forward_msg") throw "transport down"
      throw new Error(`unexpected action: ${action}`)
    }
  }

  const tool = new FakeChatTool()
  const result = await tool.func({
    messages: [{ qq: "123456", name: "测试", content: "内容" }],
    message_ids: []
  }, event(bot))

  assert.match(result, /^error: 发送失败:/)
  assert.match(result, /transport down/)
})

test("fakeChatTool rejects unknown failure statuses but accepts OneBot async responses", () => {
  const tool = new FakeChatTool()

  assert.throws(
    () => tool.assertApiSuccess({ status: "error", retcode: 0, wording: "bad status" }, "send"),
    /bad status/
  )
  assert.doesNotThrow(
    () => tool.assertApiSuccess({ status: "async", retcode: 1 }, "send")
  )
})

test("fakeChatTool enforces recursive depth and total-node limits", async () => {
  const tool = new FakeChatTool()
  let nested = [{ qq: "123456", content: "底层" }]
  for (let i = 0; i < 3; i++) {
    nested = [{
      qq: "123456",
      content: [{ type: "forward", data: { messages: nested } }]
    }]
  }

  assert.match(
    await tool.func({ messages: nested, message_ids: [] }, {}),
    /嵌套层数超过 2 层/
  )
  assert.match(
    await tool.func({
      messages: Array.from({ length: 100 }, () => ({ qq: "123456", content: "内容" })),
      message_ids: []
    }, {}),
    /合计不能超过 99 条/
  )
  assert.match(
    await tool.func({
      messages: [{
        qq: "123456",
        content: Array.from({ length: 501 }, () => ({ type: "text", data: { text: "内容" } }))
      }],
      message_ids: []
    }, {}),
    /消息段合计不能超过 500 个/
  )
  assert.match(
    await tool.func({
      messages: [{ qq: "123456", content: "内容" }],
      message_ids: Array.from({ length: 100 }, (_, index) => String(index + 1))
    }, {}),
    /message_ids 不能超过 99 个/
  )
  assert.match(
    await tool.func({
      messages: [{ qq: "123456", content: "内容" }],
      message_ids: [Number.MAX_SAFE_INTEGER + 1]
    }, {}),
    /安全整数范围/
  )
  assert.match(
    await tool.execute({
      messages: [{ qq: "123456", content: "内容" }],
      message_ids: [Number.MAX_SAFE_INTEGER + 1]
    }, {}),
    /安全整数范围/
  )
})

test("nested users receive only their own LLOneBot message style", async () => {
  globalThis.logger = { warn() {}, error() {} }

  let forwardPayload
  const bot = {
    version: { app_name: "LLOneBot" },
    async sendApi(action, params) {
      if (action === "get_msg") {
        assert.equal(params.message_id, "43")
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
    messages: [{
      qq: "123456",
      name: "外层",
      content: [{
        type: "forward",
        data: { messages: [{ qq: "654321", name: "内层", content: "内容" }] }
      }]
    }],
    message_ids: ["43"]
  }, event(bot))

  assert.equal("message_style" in forwardPayload.messages[0].data, false)
  assert.deepEqual(
    forwardPayload.messages[0].data.content[0].data.message_style,
    expectedStyle(654)
  )
})
