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
| `botName` | string | `"哈基米"` | **AI 名字**：机器人在聊天中显示的名称 |
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
| `batchJudgmentDelay` | int | `3` | **批量判断延迟（秒）**：收集多少秒内的消息后批量判断，减少API调用 |

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
| `providers` | string | `"oneapi"` | **服务提供商**：通常保持默认值 |
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
```