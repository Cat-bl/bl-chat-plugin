/**
 * 从消息列表中移除工具相关的系统提示词
 * @param {Array} messages - 消息列表
 * @returns {Array} 处理后的消息列表
 */
export const removeToolPromptsFromMessages = (messages = []) => {
    return messages.map(msg => {
        if (msg.role !== "system") return msg

        let content = msg.content

        // 移除 MCP 扩展能力部分
        content = content.replace(/\n*【MCP扩展能力】[\s\S]*?(?=\n【|$)/g, "")

        // 移除记忆系统部分
        content = content.replace(/\n*【记忆系统】[\s\S]*?(?=\n【|$)/g, "")

        // 移除可用工具部分
        content = content.replace(/\n*【可用工具】[\s\S]*?(?=\n【|$)/g, "")

        // 移除本地工具部分
        content = content.replace(/\n*【本地工具】[\s\S]*?(?=\n【|$)/g, "")

        // 移除 MCP工具 部分
        content = content.replace(/\n*【MCP工具】[\s\S]*?(?=\n【|$)/g, "")

        // 清理多余空行
        content = content.replace(/\n{3,}/g, "\n\n").trim()

        return { ...msg, content }
    })
};