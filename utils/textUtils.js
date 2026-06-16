/**
 * 从消息列表中移除工具相关的系统提示词
 * @param {Array} messages - 消息列表
 * @param {boolean} hasExecutedTools - 是否有工具被执行(决定是否保留收尾提示)
 * @returns {Array} 处理后的消息列表
 */
export const removeToolPromptsFromMessages = (messages = [], hasExecutedTools = false) => {
    return messages.map(msg => {
        // 处理 assistant 消息中的【系统提示】
        if (msg.role === "assistant" && msg.content?.includes("【系统提示】")) {
            if (hasExecutedTools) {
                // 有工具执行:改写成要求忠实于结果的提示
                const content = "【系统提示】: 工具已全部执行完成，请直接用自然口语回复用户结果，你只负责自然口语对话没有调用工具的功能。回复语气可以符合人设，但内容必须与上面工具的实际执行结果一致：已成功执行的，不得声称你没做、拒绝做或做不到；执行失败的，如实说明没成功。禁止输出任何代码格式如print()、tool_name()、|*...*|等。"
                return { ...msg, role: "system", content }
            } else {
                // 没有工具执行:直接删除此消息
                return null
            }
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

            // 移除【工具调用】整个段落(含【工具调用】+【工具调用判断原则】)，匹配到【工具使用隐藏规则】才停
            content = content.replace(/\n*【工具调用】[\s\S]*?(?=\n【工具使用隐藏规则】|$)/g, "")

            // 清理多余空行
            content = content.replace(/\n{3,}/g, "\n\n").trim()

            return { ...msg, content }
        }

        return msg
    }).filter(Boolean)  // 过滤掉被标记为 null 的消息
}
