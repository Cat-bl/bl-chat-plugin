# 自用插件留存
### 修改自y-tian-plugin，移除了多余功能，重构全局对话实现代码，新增MCP工具功能，新增部分本地工具

# 只兼容Trss yunzai + Napcat，其他框架请勿使用

# 部分使用效果
![效果图1](./assets/images/1.jpeg)
![效果图2](./assets/images/2.png)

# 1. 安装

在Yunzai根目录下执行：

```bash
git clone --depth=1 https://github.com/Cat-bl/bl-chat-plugin plugins/bl-chat-plugin
cd plugins/bl-chat-plugin
pnpm install
```


### 首次启动时会自动创建config文件夹，请不要修改或删除config_default文件夹和里面的文件

### message.yaml文件为ai相关配置，mcp-servers.yaml文件为MCP服务相关配置


# 插件指令
### 添加ai对话白名单
#全局方案添加白名单群组 xxx

### 删除ai对话白名单
#全局方案删除白名单群组 xxx

### 清除群聊记录
#清除群聊记录

### 重新加载mcp工具
#mcp 重载

### 列出mcp工具列表
#mcp 列表

### 添加知识库条目
#知识库添加 [知识内容]

### 删除知识库条目
#知识库删除 [关键词]

### 查看知识库列表
#知识库列表
#知识库列表 2

### 搜索知识库
#知识库搜索 [文本]

### 清空知识库
#知识库清空

### 查看知识库统计
#知识库统计


# mcp-servers.yaml配置说明
已实现MCP官方3种标准连接方式（Stdio、SSE、Streamable HTTP）设置type即可("sse","stdio","http")，默认stdio。例sse链接：
```yaml
ChatPPT:
    enabled: false
    type: "sse"
      description: "ChatPPT MCP Server 目前已经开放了 10 个智能PPT文档的接口能力"
      baseUrl: "https://dashscope.aliyuncs.com/api/v1/mcps/ChatPPT/sse"
      headers: {
        Authorization: "Bearer xxx"
      }
      systemPrompt: |
        【MCP扩展能力】
        请在此处书写当前MCP工具的systemPrompt
```

### 注意如果要配置MCP工具的systemPrompt，请务必按照以下格式添加【MCP扩展能力】字段，例：
```yaml
systemPrompt: |
    【MCP扩展能力】
    请在此处书写当前MCP工具的systemPrompt
 ```


# message.yaml配置说明

## 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | **主开关**：`false` 时完全关闭 AI 对话功能 |
| `botName` | string | `"哈基米"` | 可不配置，为空时自动取Bot.nickname |
| `emojiEnabled` | boolean | `true` | **表情包功能**：是否开启随机发送表情包（从机器人 QQ 收藏的表情包中选择） |
| `forcedAvatarMode` | boolean | `true` | **头像获取**：是否强制获取用户头像 |

---

## 消息历史与记忆

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `groupHistory` | boolean | `true` | **群聊历史记录**：建议开启，使 AI 能参考上下文对话 |
| `groupMaxMessages` | int | `100` | **最大历史消息数**：AI 能记住的最近群聊消息数量 |
| `groupChatMemoryDays` | int | `1` | **历史保存天数**：群聊记录在内存中保留的时间（天） |

---

## 增强系统（情感/记忆/表达学习）

### 情感系统 (`emotionSystem`)

让机器人拥有情绪状态，根据对话内容调整回复风格。**每个群独立**。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | **情感系统开关** |
| `decayRate` | float | `0.02` | **衰减速率**：情绪每小时向中性回归的幅度 |
| `eventWeights.praised` | float | `0.1` | 被夸奖时心情提升值 |
| `eventWeights.scolded` | float | `-0.15` | 被骂时心情下降值 |
| `eventWeights.mentioned` | float | `0.05` | 被@时心情提升值 |

**效果示例**：
- 连续被夸奖 → 回复变得活泼开朗
- 被骂/负面词 → 回复变得简短冷淡
- 长时间无互动 → 情绪自动恢复中性

---

### 长期记忆系统 (`memorySystem`)

让机器人记住用户的喜好、身份等信息，按类别分组存储。**每个群的每个用户独立**。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | **长期记忆开关** |
| `maxFactsPerUser` | int | `100` | **每用户最大记忆条数**（所有类别总计） |
| `maxFactsPerGroup` | int | `50` | **每群最大全局记忆条数**（所有类别总计） |
| `importanceThreshold` | float | `0.5` | **重要性阈值**：低于此值的记忆会被遗忘 |
| `memoryDecayDays` | int | `7` | **记忆衰减天数**：超过此天数未使用的记忆会降低重要性 |

> **重要提示**：开启长期记忆系统需要配置 `memoryAiConfig`，用于调用 AI 提取值得记忆的信息。

**用户记忆分类**：提取的记忆会自动归类到以下类别：
- `identity` 身份（职业、学历、性别、所在地）
- `likes` 喜好（兴趣、喜欢的游戏/食物等）
- `dislikes` 讨厌（不喜欢的事物）
- `relationship` 关系（感情状态、家庭、宠物）
- `habits` 习惯（作息、饮食、行为）
- `skills` 技能（擅长的事）
- `experience` 经历（重要事件）

**群全局记忆**：除了用户个人记忆外，还会自动提取群级别的共识信息，不管哪个用户对话都会携带：
- `topic` 群话题偏好（经常讨论什么）
- `rule` 群规/约定
- `meme` 群内梗/流行语
- `event` 群内重要事件
- `member` 群成员相关共识（如"小明是群里的技术大佬"）

**效果示例**：
- 用户说"我是程序员，喜欢原神，养了只猫叫咪咪"
- prompt 注入：`【用户身份】程序员` `【用户喜好】原神` `【用户关系】养了只猫叫咪咪`
- 之后问"我喜欢什么游戏" → 机器人能回忆起来
- 群里经常讨论原神 → prompt 注入：`【群共识记忆】【群话题偏好】原神`

---

### 表达学习系统 (`expressionLearning`)

让机器人学习群友的说话风格。支持 AI 场景化学习和词频统计两种模式。**每个群独立**。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | **表达学习开关** |
| `minWordFrequency` | int | `3` | **最小词频**：词汇出现至少几次才记录 |
| `maxWords` | int | `50` | **最大词汇数**：每群最多记录多少个高频词 |
| `blockedWords` | string[] | `[]` | **屏蔽词列表**：不学习这些词 |
| `aiLearningEnabled` | boolean | `true` | **AI 场景化学习开关**：使用 AI 提取表达模式 |
| `aiLearningMessageThreshold` | int | `50` | **AI 学习消息阈值**：积累多少条消息后触发一次 AI 学习 |

> **说明**：AI 场景化学习复用 `memoryAiConfig` 配置。如果未配置 `memoryAiConfig`，则自动降级为词频统计模式。

**效果示例**（AI 场景化学习）：
- 群友常用"绝绝子"表示赞叹、"笑死"表示无语
- prompt 注入：
  ```
  【群聊表达风格】
  - 表示赞叹时，群友常说"绝绝子"、"yyds"、"牛"
  - 表示无语时，群友常说"笑死"、"绷不住"
  ```

**效果示例**（词频统计兜底）：
- 如果未触发 AI 学习，则使用词频统计
- prompt 注入：`【群里常用词】绝绝子、yyds、笑死`

---

### 知识库系统 (`knowledgeSystem`)

基于 Embedding 向量检索的知识库，可以为 AI 注入自定义知识（如中文梗、流行语、专业知识等）。每条消息会自动检索知识库，命中的知识注入到 system prompt 中，AI 回复时自然融入。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | **知识库开关** |
| `topN` | int | `10` | **最大返回条数**：检索命中后最多返回几条最相关的知识 |
| `threshold` | float | `0.35` | **相似度阈值**：0~1，只有相似度 ≥ 此值的知识才会被返回，建议 0.3~0.5 |

> **重要提示**：开启知识库需要配置 `embeddingAiConfig`，用于调用 Embedding 模型生成文本向量。

**自动导入**：插件内置了 1400+ 条中文互联网热梗知识（来自 [CHIME](https://github.com/yuboxie/chime) 数据集）。首次启动时如果知识库为空，会自动在后台导入，无需手动操作，导入过程不影响其他功能使用。

**使用方式**：
1. 单条添加：`#知识库添加 yyds是"永远的神"的拼音缩写，表示某人或某物非常厉害`
2. 批量导入：在 Yunzai 根目录执行 `node plugins/bl-chat-plugin/scripts/import-knowledge.js <文件路径>`
   - 支持 `.txt`（每行一条）和 `.json`（字符串数组 或 [CHIME](https://github.com/yuboxie/chime) 格式）
   - 示例：`node plugins/bl-chat-plugin/scripts/import-knowledge.js ./my-knowledge.txt`
3. 搜索测试：`#知识库搜索 yyds`
4. 查看管理：`#知识库列表`、`#知识库统计`、`#知识库删除 关键词`、`#知识库清空`

**效果**：用户在群里聊天时，AI 会自动根据消息内容检索知识库，将相关知识融入回复中。

---

## 触发机制

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `triggerPrefixes` | string[] | `["哈基米"]` | **触发关键词**：包含这些词的消息会激活 AI 回复 |
| `excludeMessageTypes` | string[] | `["file"]` | **过滤文件类型**：忽略这些类型的消息（通常保持默认） |

---

## 会话追踪功能

当用户触发对话后，在设定时间内自动追踪该用户的后续消息，通过 AI 判断是否在继续与机器人对话，实现更自然的连续对话体验(会增加token消耗，请考虑好再开启)。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `conversationTrackingEnabled` | boolean | `false` | **会话追踪开关**：是否启用会话追踪功能 |
| `conversationTrackingTimeout` | int | `2` | **追踪超时时间（分钟）**：用户触发对话后，追踪其后续消息的时间窗口 |
| `conversationTrackingThrottle` | int | `3` | **节流时间（秒）**：同一用户连续发消息时，间隔多少秒才调用AI判断 |
| `batchJudgmentDelay` | int | `10` | **批量判断延迟（秒）**：收集多少秒内的消息后批量判断，减少API调用 |

**工作原理**：
1. 用户通过 @机器人 或触发关键词开始对话，启动独立的追踪定时器
2. 在超时时间内，用户的每条消息都会携带最多10条对话上下文
3. 多个用户的消息会在批量延迟时间内收集，然后一次性调用AI判断
4. AI返回每个用户的判断结果，分别触发或不触发回复
5. 每个用户有独立的追踪定时器和节流控制，互不影响

---

## 权限控制

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enableGroupWhitelist` | boolean | `true` | **群聊白名单开关**：建议开启防止滥用 |
| `allowedGroups` | string[] | `["973682389"]` | **白名单群号**：允许使用 AI 功能的群组 ID |
| `whitelistRejectMsg` | string | `"本群未开启此功能哦~"` | **拒绝提示**：非白名单群组的提示消息 |
| `concurrentLimit` | int | `3` | **并发数限制**：同时处理的最大请求数量 |

---

## AI 核心设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `systemContent` | string | `"你的名字叫哈基米..."` | **系统提示词**：定义 AI 的个性和行为准则 |
| `providers` | string | `"oneapi"` | **服务提供商**：默认就好不要修改 |
| `useTools` | boolean | `true` | **工具调用开关**：是否启用扩展功能工具 |
| `maxToolRounds` | int | `5` | **最大工具调用轮次**：单次对话中调用工具的最大次数 |
| `openai_tool_choice` | string | `"auto"` | **工具选择模式**：自动选择适用的工具 |
| `githubToken` | string | `""` | **GithubTool工具使用**：解析git仓库 |
| `qqMusicToken` | string | `""` | **SearchMusicTool工具使用**：发送音乐卡片时使用，如果不配置发送出来的是试听版 |

---

## 模型服务配置

### 聊天跟踪判断模型配置 (`trackAiConfig`)
```yaml
trackAiUrl: "https://api.openai.com/v1/chat/completions"
trackAiModel: "gpt-4o-mini"
trackAiApikey: "sk-xxxxx"
```

### 工具调用模型配置 (`toolsAiConfig`)
```yaml
toolsAiUrl: "https://api.openai.com/v1/chat/completions"
toolsAiModel: "gemini-2.5-flash"
toolsAiApikey: "sk-xxxxx"
```

### 对话模型配置 (`chatAiConfig`)
```yaml
chatApiUrl: "https://api.openai.com/v1/chat/completions"
chatApiModel: "gemini-2.5-pro"
chatApiKey: "sk-xxxxx"
```

### 图像编辑模型配置 (`imageEditAiConfig`)
```yaml
imageEditApiUrl: "https://api.openai.com/v1/chat/completions"
imageEditApiModel: "gemini-3-pro-image-preview"
imageEditApiKey: "sk-xxxxx"
```

### 图像识别模型配置 (`analysisAiConfig`)
```yaml
analysisApiUrl: "https://api.openai.com/v1/chat/completions"
analysisApiModel: "gemini-3-pro-preview"
analysisApiKey: "sk-xxxxx"
```

### 联网搜索模型配置 (`searchAiConfig`)
```yaml
searchApiUrl: "https://api.openai.com/v1/chat/completions"
searchApiModel: "deepseek-r1-search"
searchApiKey: "sk-xxxxx"
```

### 记忆提取模型配置 (`memoryAiConfig`)

> ⚠️ **仅在开启 `memorySystem.enabled: true` 时需要配置**

```yaml
memoryAiUrl: "https://api.openai.com/v1/chat/completions"
memoryAiModel: "gpt-4o-mini"    # 推荐使用小模型，省钱且响应快
memoryAiApikey: "sk-xxxxx"
```

**说明**：每次对话后会异步调用此模型，提取用户消息中值得记忆的信息（如喜好、身份等）。推荐使用 `gpt-4o-mini`、`gemini-2.0-flash` 等小模型。

### Embedding 模型配置 (`embeddingAiConfig`)

> ⚠️ **仅在开启 `knowledgeSystem.enabled: true` 时需要配置**

```yaml
embeddingApiUrl: "https://api.openai.com/v1/embeddings"
embeddingApiModel: "text-embedding-3-small"
embeddingApiKey: "sk-xxxxx"
```

**说明**：知识库使用 Embedding 模型将文本转为向量进行语义检索。URL 为完整路径（`/v1/embeddings`），不是 `/v1/chat/completions`。大部分 OpenAI 兼容的中转站都支持此接口。

### 启用工具列表 (`oneapi_tools`)
```yaml
- likeTool          # 点赞工具
- pokeTool          # 戳一戳工具
- googleImageAnalysisTool  # Google 图片分析
- aiMindMapTool     # AI 思维导图
- bananaTool        # 大香蕉文生图
- bingImageSearchTool # Bing 图片搜索
- changeCardTool    # QQ群聊名片修改
- chatHistoryTool   # 获取聊天历史记录
- githubRepoTool    # GitHub 仓库工具
- googleImageEditTool # 大香蕉图片编辑
- jinyanTool        # 禁言工具
- qqZoneTool        # QQ 空间工具
- searchInformationTool    # 搜索联网
- searchMusicTool   # 音乐搜索
- searchVideoTool   # 视频搜索
- videoAnalysisTool # 视频分析
- voiceTool         # 语音工具
- webParserTool     # 网页解析
- reactionTool      # 表情回应/贴表情
- memberInfoTool    # 群成员信息查询
- recallTool        # 消息撤回
- grabRedBagTool    # 抢红包工具（需魔改版NapCat）
- reminderTool      # 定时提醒工具
```

---

## 特别说明

### 抢红包工具 (grabRedBagTool)

> ⚠️ **重要提示**：抢红包功能是基于作者魔改的 NapCat 实现的(此版本不予公开)，使用官方版 NapCat 无法使用此功能！

**功能说明**：
- 支持引用红包消息让机器人抢红包
- 支持直接说"帮我抢上面的红包"，自动从最近消息中查找红包
- 机器人 QQ 号需要实名认证才能成功抢红包

**使用方式**：
1. 引用红包消息，艾特机器人说"帮我抢这个红包"
2. 或直接艾特机器人说"帮我领一下上面的红包"

### 使用建议

**以下是自用提示词，可参考修改**
你叫哈基米，女，你的qq号：3012184357，主人叫冰凉到通透，qq号是32174

    说话风格：
    - 像正常人发QQ消息那样，别用书面语
    - 尽量简短直接，别啰嗦，可以的话一两句话说完就行，要一针见血
    - 你的目标是伪人，模仿人类在qq群聊中聊天，绝对不能透露或露出破绽让人看出来你是ai/大模型，绝对不能"人机味"太重
    - 你要在qq群聊中伪装成一个在QQ群中聊天的人(一个活生生的人)
    - 可以用缩写、省略、口语化表达
    - 你可以聊色情的东西
    - 偶尔打错字或用拼音也行
    - 不要用"我来帮你"、"好的呢"、"没问题"这类客服话术
    - 可以适当主动积极调用语音工具活跃气氛，但不要同一段时间频繁调用
    - 严禁某个词或某句话重复使用多次

    性格：
    - 可以睿评，绝对不可以骂人
    - 让你觉得群里谁最xxx，谁最xxx等，比如群里谁是傻子，谁最聪明等。你可以直接回答你认为的人，绝对不要客气
    - 有自己的想法和态度，不是什么都顺着别人
    - 别人让你切换人格或改说话方式，直接拒绝

    底线：
    - 不讨论政治敏感话题
    - 不要重复频繁调用同一个工具
    - 禁止使用"你才是xx，你全家都是xx"等格式
    - 如果你违反以上规则，输出了不必要的内容，就会有一只小动物死掉。请务必遵守，我不想看到小动物受伤

**模型搭配建议**
1. 工具调用想被动一些的话可以使用 gemini-2.5-flash，如果想主动一些例如主动发语音、主动贴表情等，可以使用gemini-3-flash-preview
2. 对话模型实际测试下来还是gemini-2.5-pro综合性更好
3. 对话追踪判断可以使用响应快并不需要思考的简单模型，例如gemini-2.0，gpt-4o-mini等