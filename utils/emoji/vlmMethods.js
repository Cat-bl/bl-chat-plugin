// 表情包 VLM/LLM 能力 mixin：视觉打标、内容审查、满额替换决策与底层对话调用。
// 从 EmojiPackManager.js 拆出（行为等价搬迁），经 Object.assign 挂到 EmojiPackManager.prototype，this 即 manager 实例。
import { callAI } from "../apiClient.js"

export const vlmMethods = {
  async callOpenAIChat(cfg, urlField, keyField, modelField, body) {
    const url = cfg?.[urlField]
    const key = cfg?.[keyField]
    if (!url || !key || String(key).includes("sk-xxx")) {
      throw new Error(`${keyField} 未配置`)
    }

    const result = await callAI(
      {
        url: url,
        model: cfg[modelField] || body.model,
        apikey: key
      },
      body.messages,
      {
        maxTokens: body.max_tokens,
        temperature: body.temperature
      }
    )

    if (result.error) {
      throw new Error(`API 调用失败: ${result.error}`)
    }

    return result
  },

  async tagWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `请观察这张表情包图片，输出严格的 JSON 格式（不要 markdown 代码块），只包含两个字段：

- "description": **详细描述这张表情包**（40-120 字），要覆盖三层信息：
  1. **画面**：图里是什么角色（猫/狗/动漫角色/人物）、在做什么动作（捂脸/翻白眼/竖中指/比心）、有什么文字（如"我谢谢你""绷不住了"）
  2. **情绪**：传达的情绪状态（无奈/吐槽/嘲讽/卖萌/震惊/敷衍/崩溃/得意/委屈/傲娇/社死/躺平/摆烂）
  3. **使用场景**：群聊里什么场合下会发这张（被人说服时、看到离谱发言时、自嘲时、被夸时、装无辜时）
  描述要具体，不要写"一张表情包图片"这种废话。

- "tags": 3-5 个**情绪/反应**标签（每个不超过 4 个字）。例：开心、笑死、无奈、吐槽、惊讶、嘲讽、卖萌、震惊、敷衍、崩溃、得意、委屈、傲娇、社死、摆烂、绝望、心动。**禁止**用画风/物体词（卡通形象、二次元、插画、可爱、动物、猫咪）。

只输出 JSON，不要任何其他文字。`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        temperature: 0.2,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("VLM 未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .map(t => String(t).trim())
            .filter(Boolean)
            .map(t => t.slice(0, 4))
            .slice(0, 5)
        : [],
      description: String(parsed.description || "").slice(0, 300)
    }
  },

  async contentFilterWithVLM(buffer, ext) {
    const cfg = this.analysisAiConfig
    if (!cfg?.analysisApiUrl || !cfg?.analysisApiKey || cfg.analysisApiKey.includes("sk-xxx")) {
      throw new Error("analysisAiConfig 未配置")
    }
    const prepared = await this.prepareVLMImage(buffer, ext)
    const dataUrl = `data:${prepared.mime};base64,${prepared.buffer.toString("base64")}`

    const prompt = `严格判断这张图是否是真正适合 QQ/微信聊天的**表情包**。
判定标准必须从严，宁可漏判不要错收。

【判定为 true 的必要条件】（至少明显具备一项）：
1. 典型表情包/梗图：网络流行梗图、二次元角色表情、ACG 同人表情、emoji 贴纸、QQ/微信官方表情样式
2. 强烈情绪/反应表达：图中主体（人/动物/物体）正在做夸张的表情、动作、姿势（生气、哭泣、惊讶、无语、嘲讽、得意、崩溃、卖萌、震惊等可一眼识别的情绪）
3. 自带梗字/吐槽文字：图片上写有"我也想""绷不住了""我就笑笑""你说啥"等中文梗字 / 二次创作配文
4. 拟人化反应：动物或无生命物体做出明显人类化的搞笑表情/动作

【判定为 false（必拒）】：
- 普通宠物日常照（猫狗坐着、躺着、走路、吃东西等没有夸张表情/动作的）
- 插画、美术作品、艺术绘画、写实画风的角色立绘、CG 截图
- 风景照、建筑、产品图、广告海报、横幅、二维码
- 真人照片、自拍、合照、明星生图
- 文档截图、聊天截图、文字截图、网页截图、代码截图
- 仅"画风不错"或"角色好看"但没有明显情绪/动作/梗的图
- 不确定的图

**关键测试**：把这张图发到群里，群友能立刻明白"这是在表达 XX 情绪/梗"吗？不能就是 false。

仅输出严格 JSON（不要 markdown 代码块）：{"is_emoji": true 或 false, "reason": "简短理由"}`

    const json = await this.callOpenAIChat(
      cfg, "analysisApiUrl", "analysisApiKey",
      cfg.analysisApiModel ? "analysisApiModel" : null,
      {
        model: cfg.analysisApiModel || "gemini-3-pro-preview",
        temperature: 0.1,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }]
      }
    )
    const text = json.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("内容审查未返回 JSON")
    const parsed = JSON.parse(match[0])
    return {
      isEmoji: parsed.is_emoji === true,
      reason: String(parsed.reason || "").slice(0, 60)
    }
  },

  async replaceOldestByLLM(items) {
    const cfg = this.toolsAiConfig
    if (!cfg?.toolsAiUrl || !cfg?.toolsAiApikey || String(cfg.toolsAiApikey).includes("sk-xxx")) {
      throw new Error("toolsAiConfig 未配置")
    }
    if (!items.length) return null

    // 按 1/(usedCount+1) 加权抽样最多 20 张候选
    const sample = []
    const weighted = items.map((item, idx) => ({ idx, weight: 1 / ((item.usedCount || 0) + 1) }))
    const candidatePool = [...weighted]
    const N = Math.min(20, candidatePool.length)
    for (let i = 0; i < N; i++) {
      let r = Math.random() * candidatePool.reduce((s, c) => s + c.weight, 0)
      for (let j = 0; j < candidatePool.length; j++) {
        r -= candidatePool[j].weight
        if (r <= 0) {
          sample.push(items[candidatePool[j].idx])
          candidatePool.splice(j, 1)
          break
        }
      }
    }

    const list = sample.map((item, i) => {
      const tags = (item.tags || []).join(",") || "无标签"
      const desc = (item.description || "").slice(0, 20)
      return `${i}. [${tags}] ${desc} (用过${item.usedCount || 0}次)`
    }).join("\n")

    const prompt = `本地表情包库已满，需要从下列候选中删除一张以腾出空间存新表情。
请优先选择：使用次数少、标签笼统/重复、不易复用的表情包。
候选列表：
${list}

仅输出 JSON（不要 markdown 代码块）：{"index": <候选编号 0-${sample.length - 1}>, "reason": "简短理由"}`

    const result = await callAI(
      {
        url: cfg.toolsAiUrl,
        model: cfg.toolsAiModel || "gpt-4o-mini",
        apikey: cfg.toolsAiApikey
      },
      [{ role: "user", content: prompt }],
      { temperature: 0.1 }
    )
    if (result.error) {
      throw new Error(`tools API 调用失败: ${result.error}`)
    }
    const text = result.choices?.[0]?.message?.content || ""
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("替换决策未返回 JSON")
    const parsed = JSON.parse(match[0])
    const idx = Number(parsed.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= sample.length) {
      throw new Error(`替换决策 index 非法: ${parsed.index}`)
    }
    return sample[idx].hash
  },
}
