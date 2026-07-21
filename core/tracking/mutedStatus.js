// bot 禁言状态查询与短期缓存（strict / smart 两种模式共用）。
// 以 mixin 形式挂到插件原型上，this 指向插件实例。

// 禁言状态短期缓存：避免每条群消息都查一次 ws RPC pickMember.getInfo()。
// smartGate 的 LRU 扫描器会顺带清理本缓存，故连同 TTL 一起导出。
export const mutedStatusCache = new Map() // groupId -> { isMuted, at }
export const MUTED_CACHE_TTL_MS = 30000

export const mutedStatusMethods = {
  /**
   * 判断 bot 是否在该群被禁言（个人禁言或全员禁言）。
   * 兼容两套协议端字段：
   *  - ICQQ：member.shutup_time / group.mute_left / group.info.shutup_time_me / .shutup_time_whole
   *    语义：值 = 剩余禁言秒数（unix 时间戳 - 现在），> 0 即被禁言
   *  - OneBot v11 / Napcat：member.shut_up_timestamp / group.info.group_all_shut 等
   *    语义：shut_up_timestamp 是禁言到期 unix 秒时间戳，需对比当前时间
   * 短期 LRU 缓存（30s）避免每条群消息都发一次 ws RPC；
   * 任何异常都视为"未禁言"，避免误阻塞。
   */
  async isMutedInGroup(e) {
    if (!e?.group_id) return false
    const cached = mutedStatusCache.get(e.group_id)
    if (cached && Date.now() - cached.at < MUTED_CACHE_TTL_MS) return cached.isMuted

    const nowSec = Math.floor(Date.now() / 1000)
    let isMuted = false
    try {
      const grp = e.group
      if (grp) {
        // ICQQ 风格：剩余秒数 / GroupInfo 字段
        if (Number(grp.mute_left) > 0) isMuted = true
        else {
          const gi = grp.info || grp
          if (Number(gi?.shutup_time_whole) > 0) isMuted = true
          else if (Number(gi?.shutup_time_me) > 0) isMuted = true
          // OneBot v11 / Napcat 风格全员禁言字段（不同实现可能用不同名）
          else if (Number(gi?.group_all_shut) > 0) isMuted = true
          else if (Number(gi?.shut_up_timestamp_whole) > nowSec) isMuted = true
        }
      }
      // 个人禁言：拉自己的 member 信息（昂贵的 RPC，仅在群信息没显示已禁言时调）
      if (!isMuted) {
        const selfId = e.self_id || e.bot?.uin || Bot.uin
        const me = await e.group?.pickMember?.(selfId)?.getInfo?.()
        if (me) {
          if (Number(me.shutup_time) > 0) isMuted = true
          else if (Number(me.shut_up_timestamp) > nowSec) isMuted = true
        }
      }
    } catch {}

    mutedStatusCache.set(e.group_id, { isMuted, at: Date.now() })
    return isMuted
  }
}
