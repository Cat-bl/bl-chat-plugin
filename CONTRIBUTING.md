# 贡献指南

## 分支模型

- `main`：稳定分支，供用户 `#bl更新` 拉取
- `dev`：开发分支，功能先进 dev，验证后合入 main

## 提交规范

提交信息使用 `类型: 一句话描述改了什么`，类型取值：

| 类型 | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修 bug（写明修的是什么问题） |
| `refactor` | 重构（行为不变） |
| `chore` | 依赖、配置、构建等杂项 |
| `docs` | 文档 |

避免只写 `fix`、`优化` 这类无信息量的提交信息。

## 提交前检查

```bash
pnpm lint   # ESLint 检查
pnpm test   # 单元测试（node:test，覆盖纯逻辑模块）
```

两者必须通过。CI（GitHub Actions）会在 push/PR 时自动执行同样的检查。

## 真机验证

本插件依赖 Yunzai 运行环境，单测只覆盖纯逻辑层。涉及以下路径的改动必须在真实 bot 环境验证：

- 对话主流程（`apps/chat.js`）：@bot 对话、`#tool` 命令、随机回复
- 工具系统：触发对应工具的对话
- 配置热更：修改 `config/message.yaml` 后确认生效
- MCP：`#mcp 状态`、`#mcp 重载`

## 代码约定

- 用户自定义工具放 `custom_tools/`，**不要修改 `functions/functions_tools/` 内置工具满足私有需求**
- 新增内置工具必须在 `utils/LocalToolRegistry.js` 的 `BUILT_IN_TOOL_FACTORIES` 注册
- 新增配置项必须同步更新 `config_default/message.yaml`
- 不要重命名插件目录或把硬编码的 `plugins/bl-chat-plugin/` 改成相对路径
