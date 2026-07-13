import test from 'node:test'
import assert from 'node:assert/strict'
import { CompletedEventCache, getSmartEventKey, resolveWaitReplyAction } from '../core/waitReplyPolicy.js'

test('waitTool 仅在同一用户发来新消息时取消', () => {
  assert.equal(resolveWaitReplyAction({ kind: 'tool', scheduledUserVersion: 1, currentUserVersion: 2, scheduledGroupVersion: 1, currentGroupVersion: 3 }), 'cancel')
  assert.equal(resolveWaitReplyAction({ kind: 'tool', scheduledUserVersion: 1, currentUserVersion: 1, scheduledGroupVersion: 1, currentGroupVersion: 3 }), 'use_original')
})

test('Gate wait 在群上下文变化后改用最新事件', () => {
  assert.equal(resolveWaitReplyAction({ kind: 'gate', scheduledUserVersion: 1, currentUserVersion: 1, scheduledGroupVersion: 4, currentGroupVersion: 5 }), 'use_latest')
  assert.equal(resolveWaitReplyAction({ kind: 'gate', scheduledUserVersion: 1, currentUserVersion: 1, scheduledGroupVersion: 4, currentGroupVersion: 4 }), 'use_original')
})

test('smart 合成事件使用群号和 message_id 识别同一原始消息', () => {
  assert.equal(getSmartEventKey({ group_id: 123, message_id: 456 }), '123:message:456')
  assert.equal(getSmartEventKey({ group_id: 123, _smartOriginKey: '123:event:7' }), '123:event:7')
  assert.equal(getSmartEventKey({ group_id: 123, message_id: 456, _smartOriginKey: '123:proactive:x' }), '123:proactive:x')
  assert.equal(getSmartEventKey({ group_id: 123 }), '')
})

test('wait/rerun 继承原事件键，主动任务可以覆盖为新来源', () => {
  const original = { _smartOriginKey: 'group:event:1' }
  const rerun = Object.create(original)
  assert.equal(getSmartEventKey(rerun), 'group:event:1')
  rerun._smartOriginKey = 'group:proactive:2'
  assert.equal(getSmartEventKey(rerun), 'group:proactive:2')
})

test('完成事件缓存按 TTL 失效并限制容量', () => {
  const cache = new CompletedEventCache({ ttlMs: 1000, maxEntries: 2 })
  cache.add('a', 1000)
  cache.add('b', 1100)
  cache.add('c', 1200)
  assert.equal(cache.has('a', 1200), false)
  assert.equal(cache.has('b', 1200), true)
  assert.equal(cache.has('b', 2201), false)
})
