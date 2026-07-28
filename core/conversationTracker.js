// 会话追踪与 smart 触发模式的聚合出口。实现按职责拆在 core/tracking/：
// - strictTracking：strict 模式跟进窗口（activeConversations + 定时器）、回复去抖、
//   批量"是否在和 bot 说话"AI 判断
// - smartGate：smart 模式每群频率状态机、时机 Gate、wait/deferred 续话定时器、LRU 淘汰
// - smartRate：smart 模式频率/节奏度量（消息速率、限流守卫、talk 档位、回复延迟统计）
// - repeatDetection：群复读检测与跟读（两种模式共用）
// - mutedStatus：bot 禁言状态查询与短期缓存
// 对外接口不变：conversationTrackerMethods 仍以 mixin 挂到插件原型（this 指向插件实例），
// activeConversations / trackingThrottle / trackingLastMsgAt 仍从本模块导出。
import { strictTrackingMethods } from "./tracking/strictTracking.js"
import { smartGateMethods } from "./tracking/smartGate.js"
import { smartRateMethods } from "./tracking/smartRate.js"
import { repeatDetectionMethods } from "./tracking/repeatDetection.js"
import { mutedStatusMethods } from "./tracking/mutedStatus.js"

export { activeConversations, trackingThrottle, trackingLastMsgAt } from "./tracking/strictTracking.js"

export const conversationTrackerMethods = {
  ...strictTrackingMethods,
  ...smartGateMethods,
  ...smartRateMethods,
  ...repeatDetectionMethods,
  ...mutedStatusMethods
}
