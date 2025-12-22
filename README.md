### 自用插件留存
修改自y-tian-plugin，移除了多余功能，重构全局对话实现代码，新增MCP工具功能，新增部分本地工具

### 1. 安装

在Yunzai根目录下执行：

```bash
git clone --depth=1 https://github.com/Cat-bl/test-plugin plugins/test-plugin
cd plugins/test-plugin
pnpm install
```


### 首次启动时会自动创建config文件夹，请不要修改或删除config_default文件夹和里面的文件

### message.yaml文件为ai相关配置，mcp-servers.yaml文件为MCP服务相关配置


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