import { getRedBagType, isExclusiveForUser } from "../utils/redBagUtils.js"
import { toolConfigHasName } from "./toolConfig.js"

// 自动抢红包配置
export const RED_BAG_CONFIG = {
  enabled: true, // 是否启用自动抢红包
  minProbability: 0.3, // 最小触发概率
  maxProbability: 0.8, // 最大触发概率
  cooldownTime: 60000 // 冷却时间（毫秒），同一个群60秒内不重复触发
}

const redBagCooldowns = new Map() // 红包冷却记录: key: groupId, value: lastGrabTime

/**
 * 检测红包消息并随机触发抢红包（strict / smart 两种模式都生效）。
 * 返回 null 表示本条消息没有被红包分支消化，调用方继续走后续对话流程；
 * 返回 { value } 表示红包分支已处理，调用方直接 return value。
 */
export async function tryAutoGrabRedBag(e, plugin) {
  const walletSeg = e.message?.find(m => m.type == 'wallet')
  if (!(walletSeg && RED_BAG_CONFIG.enabled && toolConfigHasName(plugin.config.oneapi_tools, 'grabRedBagTool'))) {
    return null
  }

  const wallet = walletSeg.data || walletSeg
  const redBagType = getRedBagType(wallet)
  const botId = e.bot?.uin || Bot.uin

  // 专属红包：判断是否给机器人
  if (redBagType.type === 'exclusive') {
    if (!isExclusiveForUser(wallet, botId)) {
      logger.info(`[自动抢红包] 专属红包不是给机器人的，跳过`)
      return { value: false }
    }
    // 专属红包给机器人，直接触发
    logger.info(`[自动抢红包] 检测到给机器人的专属红包，直接触发抢红包`)
    e.forceGrabRedBag = true
    return { value: await plugin.handleTool(e) }
  }

  const now = Date.now()
  const lastGrabTime = redBagCooldowns.get(e.group_id) || 0

  // 检查冷却时间
  if (now - lastGrabTime >= RED_BAG_CONFIG.cooldownTime) {
    // 随机概率
    const probability = RED_BAG_CONFIG.minProbability +
      Math.random() * (RED_BAG_CONFIG.maxProbability - RED_BAG_CONFIG.minProbability)

    if (Math.random() < probability) {
      redBagCooldowns.set(e.group_id, now)
      logger.info(`[自动抢红包] 检测到${redBagType.name}，触发概率 ${(probability * 100).toFixed(1)}%，执行抢红包`)
      e.forceGrabRedBag = true // 标记强制抢红包
      return { value: await plugin.handleTool(e) }
    } else {
      logger.info(`[自动抢红包] 检测到${redBagType.name}，未命中概率 ${(probability * 100).toFixed(1)}%，跳过`)
    }
  }

  return null
}
