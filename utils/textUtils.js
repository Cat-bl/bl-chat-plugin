/**
 * 从消息列表中移除工具相关的系统提示词
 * @param {Array} messages - 消息列表
 * @returns {Array} 处理后的消息列表
 */
export const removeToolPromptsFromMessages = (messages = []) => {
    return messages.map(msg => {
        // 处理 assistant 消息中的【系统提示】
        if (msg.role === "assistant" && msg.content?.includes("【系统提示】")) {
            let content = "【系统提示】: 工具已全部执行完成，请直接用自然口语回复用户结果，你只负责自然口语对话没有调用工具的功能。禁止输出任何代码格式如print()、tool_name()、|*...*|等。"

            // // 移除 "需要时调用工具" 相关文字
            // content = content.replace(/[，,]?\s*需要\s*时?\s*调用工具/g, "")

            // // 清理末尾可能残留的标点和空格
            // content = content.replace(/[，,\s]+$/g, "").trim()

            return { ...msg, content }
        }

        // 处理 system 消息
        if (msg.role === "system") {
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

            // 移除 工具调用 部分
            content = content.replace(/\n*【工具调用】[\s\S]*?(?=\n【|$)/g, "")

            // 清理多余空行
            content = content.replace(/\n{3,}/g, "\n\n").trim()

            return { ...msg, content }
        }

        return msg
    })
}
