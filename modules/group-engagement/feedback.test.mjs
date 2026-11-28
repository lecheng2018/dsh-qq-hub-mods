// T3.5 反馈引擎真实行为测试：真实 store（内存 fs 边界）+ 真实 engine，
// 覆盖去重、pending 创建规则、unknown 谨慎计数、message 观察/排除、一次性结算、bias 钳制、
// feedbackBiasEnabled=false 只统计、重启恢复按 expiresAt 结算不重复调 bias。
import test from 'node:test'
import assert from 'node:assert/strict'

const FILE = '/data/group-engagement/feedback.json'

async function mkStore(fsOps, errors = []) {
  const { createGroupEngagementStore } = await import('./store.mjs')
  return createGroupEngagementStore(FILE, { onError: (m) => errors.push(m), fsOps })
}
const mkEngine = async (store, over = {}) => {
  const { createFeedbackEngine } = await import('./feedback.mjs')
  return createFeedbackEngine({ store, settings: () => ({ feedbackWindowMs: 180000, feedbackBiasStep: 0.02, feedbackBiasLimit: 0.1, feedbackBiasEnabled: true, maxRecentTurnIdsPerGroup: 128, ...over }), enabled: true })
}
const memoryFs = (initial = {}) => {
  const files = new Map(Object.entries(initial))
  return { existsSync: (p) => files.has(String(p)), readFileSync: (p) => files.get(String(p)), writeFileSync: (p, t) => files.set(String(p), t), renameSync: (a, b) => { files.set(String(b), files.get(String(a))); files.delete(String(a)) }, mkdirSync: () => {} }
}
const result = (over = {}) => ({
  turnId: 't1', chatId: 'group:30001', topicMode: 'interject', participation: 'text_lite',
  triggerMessageIds: ['10001'], state: 'sent', sourceModuleId: 'group-engagement', deliveryId: '', reason: '', at: Date.now(),
  ...over,
})
const message = (over = {}) => ({ chatId: 'group:30001', messageId: '20001', userId: '555', ...over })

test('group/result 去重：同一条结果绝不重复结算', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  fb.onGroupResult(result())
  fb.onGroupResult(result())
  fb.onGroupResult(result())
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.pending.length, 1, '去重后只建一个 pending')
  assert.equal(bucket.resultCounts.sent, 1, '结果计数同样去重')
  await store.dispose()
})

test('pending 创建规则：仅 sent/partial + interject；failed/unknown/cancelled/skipped 只计数', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  fb.onGroupResult(result({ turnId: 'f1', state: 'failed' }))
  fb.onGroupResult(result({ turnId: 'u1', state: 'unknown' }))
  fb.onGroupResult(result({ turnId: 'c1', state: 'cancelled', topicMode: 'must' }))
  fb.onGroupResult(result({ turnId: 's1', state: 'skipped', topicMode: 'must' }))
  fb.onGroupResult(result({ turnId: 'm1', topicMode: 'must' })) // sent 但 must：不建 pending
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.pending.length, 0, '非 sent/partial+interject 一律不建 pending')
  assert.equal(bucket.resultCounts.failed, 1)
  assert.equal(bucket.resultCounts.unknown, 1)
  assert.equal(bucket.resultCounts.cancelled, 1)
  assert.equal(bucket.resultCounts.skipped, 1)
  assert.equal(bucket.resultCounts.sent, 1, 'must 的 sent 只计数')
  assert.equal(bucket.reactUnknownCount, 1, 'unknown 额外谨慎计数')
  await store.dispose()
})

test('message 观察：同群 pending 统计 followup；始终返回 undefined；排除触发消息与重复 messageId', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  assert.equal(fb.onGroupResult(result({ triggerMessageIds: ['10001'] })), undefined)
  // 触发消息本身：不计 followup
  fb.onMessage(message({ messageId: '10001', userId: '555' }))
  // 机器人自己：不计
  fb.onMessage(message({ messageId: '20002', userId: '20002', self: true }))
  // 首条后续：计数 +1、speaker 记录
  assert.equal(fb.onMessage(message({ messageId: '20003', userId: '556' })), undefined, '始终返回 undefined')
  // 重复 messageId：不重复计数
  fb.onMessage(message({ messageId: '20003', userId: '556' }))
  // 另一位群友：第二条 → 满足 extended 的两个条件之一
  fb.onMessage(message({ messageId: '20004', userId: '557' }))
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.pending.length, 1)
  assert.equal(bucket.pending[0].followupCount, 2, '触发消息/机器人自己/重复 messageId 都被排除')
  assert.deepEqual(bucket.pending[0].followupSpeakerIds, ['556', '557'])
  await store.dispose()
})

test('一次性结算：ignored/connected/extended；每 turnId 至多一次结算与一次 bias 调整', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  const now = Date.now()
  // ignored：已过期（触发消息也无法计入——过期 pending 由结算负责）
  fb.onGroupResult(result({ turnId: 'i1', at: now - 200000 }))
  fb.settleExpired(now) // 顺手扫描：i1 结算
  assert.equal(store.getBucket('group:30001').feedbackCounts.ignored, 1)
  assert.equal(store.getBucket('group:30001').recentTurnIds.includes('i1'), true, '结算账记录 i1')
  // connected：窗口内的 pending + 一条后续消息 → 先结算（避免同群后续消息串到别的 pending）
  const tConnected = Date.now()
  fb.onGroupResult(result({ turnId: 'c1', triggerMessageIds: [], at: tConnected - 100000 }))
  fb.onMessage(message({ messageId: '30001', userId: '556' })) // c1 → followup 1
  const settledConnected = fb.settleExpired(tConnected + 90000)
  assert.deepEqual(settledConnected.map((s) => s.outcome), ['connected'])
  // extended：两条后续消息（两条 + 两 speaker → extended）
  const tExtended = Date.now()
  fb.onGroupResult(result({ turnId: 'e1', triggerMessageIds: [], at: tExtended - 100000 }))
  fb.onMessage(message({ messageId: '30002', userId: '556' }))
  fb.onMessage(message({ messageId: '30003', userId: '557' }))
  const settledExtended = fb.settleExpired(tExtended + 90000)
  assert.deepEqual(settledExtended.map((s) => s.outcome), ['extended'])
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.pending.length, 0, '全部结算出列')
  assert.equal(bucket.recentTurnIds.length, 3, '结算账记录 3 个 turnId')
  // bias：+0.02（connected）+0.02（extended）-0.02（ignored）= 0.02
  assert.ok(Math.abs(bucket.bias - 0.02) < 1e-9, `bias = 0.02（实际 ${bucket.bias}）`)
  // 再结算一次：同 turnId 不重复
  const again = fb.settleExpired(tExtended + 100000)
  assert.equal(again.length, 0, '每 turnId 至多结算一次')
  assert.equal(bucket.feedbackCounts.ignored, 1)
  assert.equal(bucket.feedbackCounts.connected, 1)
  assert.equal(bucket.feedbackCounts.extended, 1)
  assert.ok(Math.abs(bucket.bias - 0.02) < 1e-9, 'bias 只调整一次')
  await store.dispose()
})

test('bias 钳制在 ±feedbackBiasLimit；feedbackBiasEnabled=false 只统计不调整', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  const now = Date.now()
  // 连续 ignored 100 次 → bias 最多 -0.1
  for (let i = 0; i < 100; i++) fb.onGroupResult(result({ turnId: `n${i}`, at: now - 1_000_000, triggerMessageIds: [] }))
  fb.settleExpired(now)
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.bias, -0.1, '钳制在下限')
  await store.dispose()

  const store2 = await mkStore(memoryFs())
  const fb2 = await mkEngine(store2, { feedbackBiasEnabled: false })
  const now2 = Date.now()
  fb2.onGroupResult(result({ turnId: 'x1', at: now2 - 1_000_000, triggerMessageIds: [] }))
  fb2.settleExpired(now2)
  await store2.flush()
  const b2 = store2.getBucket('group:30001')
  assert.equal(b2.feedbackCounts.ignored, 1, '仍然统计')
  assert.equal(b2.bias, 0, 'feedbackBiasEnabled=false 不调整 bias')
  await store2.dispose()
})

test('重启恢复：持久化的 pending 按 expiresAt 结算，不重复调 bias；未落盘事件不重放', async () => {
  const ops = memoryFs()
  const errors = []
  const store1 = await mkStore(ops, errors)
  const fb1 = await mkEngine(store1)
  const now = Date.now()
  fb1.onGroupResult(result({ turnId: 'r1', at: now - 200_000, triggerMessageIds: [] })) // 已过期但未结算
  assert.ok(errors.length === 0, `无写盘错误（${JSON.stringify(errors)}）`)
  await store1.flush()
  await store1.dispose()

  // 重启：新 store 从文件恢复 pending，新引擎按 expiresAt 结算一次
  const store2 = await mkStore(ops)
  assert.equal(store2.getBucket('group:30001').pending.length, 1, 'pending 从磁盘恢复')
  const fb2 = await mkEngine(store2)
  const settled = fb2.settleExpired(Date.now())
  assert.equal(settled.length, 1)
  assert.equal(settled[0].outcome, 'ignored')
  await store2.flush()
  await store2.dispose()

  // 再次重启：recentTurnIds 已持久化 → 不重复结算、不重复调 bias
  const store3 = await mkStore(ops)
  const fb3 = await mkEngine(store3)
  assert.equal(fb3.settleExpired(Date.now()).length, 0, 'recentTurnIds 去重：不重复结算')
  await store3.flush()
  const b3 = store3.getBucket('group:30001')
  assert.equal(b3.feedbackCounts.ignored, 1)
  assert.equal(b3.bias, -0.02, 'bias 只调整一次')
  await store3.dispose()
})

test('跨群隔离：另一群的 message 不计入本群 pending', async () => {
  const store = await mkStore(memoryFs())
  const fb = await mkEngine(store)
  fb.onGroupResult(result({ turnId: 'k1' }))
  fb.onMessage(message({ chatId: 'group:30002', messageId: '40001', userId: '556' }))
  await store.flush()
  const bucket = store.getBucket('group:30001')
  assert.equal(bucket.pending[0].followupCount, 0, '跨群消息不计 followup')
  await store.dispose()
})
