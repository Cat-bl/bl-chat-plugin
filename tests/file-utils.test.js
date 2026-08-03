import test from "node:test"
import assert from "node:assert/strict"
import {
  isTencentImageUrl,
  parseRKeyFromUrl,
  isImageBuffer,
  getRKey,
  extractDomain,
  getNapcatRKeys
} from "../utils/file/tencentImage.js"
import { chunk, removeDuplicates } from "../utils/file/collection.js"

test("isTencentImageUrl：腾讯域名 + 临时参数才判定为真", () => {
  assert.equal(isTencentImageUrl("https://gchat.qpic.cn/img?rkey=abc"), true)
  assert.equal(isTencentImageUrl("https://multimedia.nt.qq.com/download?fileid=1"), true)
  assert.equal(isTencentImageUrl("https://gchat.qpic.cn/img", "fid123"), true)
  assert.equal(isTencentImageUrl("https://gchat.qpic.cn/img"), false)
  assert.equal(isTencentImageUrl("https://example.com/a?rkey=abc"), false)
  assert.equal(isTencentImageUrl("not a url"), false)
})

test("parseRKeyFromUrl：标准 URL 与残缺字符串都能取出 rkey", () => {
  assert.equal(parseRKeyFromUrl("https://a.qq.com/x?rkey=CAQ123&spec=0"), "CAQ123")
  assert.equal(parseRKeyFromUrl("https://a.qq.com/x"), null)
  assert.equal(parseRKeyFromUrl("rkey=abc&x=1"), "abc")
  assert.equal(parseRKeyFromUrl(null), null)
})

test("isImageBuffer：按魔数识别常见图片格式", () => {
  assert.equal(isImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), true) // PNG
  assert.equal(isImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true) // JPEG
  assert.equal(isImageBuffer(Buffer.from([0x47, 0x49, 0x46, 0x38])), true) // GIF
  assert.equal(isImageBuffer(Buffer.from("hello text")), false)
  assert.equal(isImageBuffer(Buffer.alloc(0)), false)
})

test("getRKey：从链接中截取 rkey 参数", async () => {
  assert.equal(await getRKey("https://host/download?appid=1&rkey=XYZ&spec=0"), "XYZ")
  assert.equal(await getRKey("https://host/download?rkey=TAIL"), "TAIL")
  assert.equal(await getRKey("https://host/download?appid=1"), null)
})

test("extractDomain：截取第一个 & 之前的部分", async () => {
  assert.equal(await extractDomain("https://host/download?appid=1&fileid=2"), "https://host/download?appid=1")
  assert.equal(await extractDomain("https://host/plain"), "https://host/plain")
})

test("getNapcatRKeys：兼容 NapCat 数组与 LLBot 对象两种响应，缓存项失败时回退", async () => {
  try {
    // NapCat：nc_get_rkey 返回数组（值带 &rkey= 前缀）
    globalThis.Bot = {
      sendApi: async action => {
        if (action === "nc_get_rkey") return { data: [{ rkey: "&rkey=P1" }, { rkey: "&rkey=G1" }] }
        throw new Error("不支持的 action")
      }
    }
    assert.deepEqual(await getNapcatRKeys(), ["P1", "G1"])

    // 换成 LLBot：缓存的 nc_get_rkey 失败后应回退 get_rkey（对象格式）
    globalThis.Bot = {
      sendApi: async action => {
        if (action === "get_rkey") return { data: { private_key: "P2", group_key: "G2", expired_time: 1 } }
        throw new Error("不支持的 action")
      }
    }
    assert.deepEqual(await getNapcatRKeys(), ["P2", "G2"])

    // 两个接口都失败：返回空数组
    globalThis.Bot = { sendApi: async () => { throw new Error("接口不可用") } }
    assert.deepEqual(await getNapcatRKeys(), [])
  } finally {
    delete globalThis.Bot
  }
})

test("chunk：size 为 1 时逐项分块", () => {
  assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]])
  assert.deepEqual(chunk([], 3), [])
})

test("removeDuplicates：cdn/download 链接在存在非 download 版本时被去除", async () => {
  assert.deepEqual(
    await removeDuplicates(["https://f/cdn/download/1.png", "https://f/cdn/1.png"]),
    ["https://f/cdn/1.png"]
  )
  assert.deepEqual(
    await removeDuplicates(["https://f/cdn/download/2.png"]),
    ["https://f/cdn/download/2.png"]
  )
  assert.deepEqual(
    await removeDuplicates(["https://plain.example/a.png"]),
    ["https://plain.example/a.png"]
  )
})
