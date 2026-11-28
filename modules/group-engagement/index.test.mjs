// T3.6 组合入口真实行为测试：真实模块 setup + 桩 api（监听/路由/定时器/设置），
// 覆盖 Shadow 零副作用、REACT 声明与熔断、质量门、反馈结算、/state 脱敏、dispose 完整性。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import module from './index.mjs'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

function mkApi(settingsOver = {}) {
  const listeners = new Map() // event -> [fn]
  const routes = new Map()
  const timers = []
  const dataDir = mkdtempSync(join(tmpdir(), 'b3-index-'))
  const settings = { ...module.defaults, ...settingsOver }
  const api = {
    log: noopLog,
    settings: () => settings,
    dataDir: (...parts) => join(dataDir, ...parts),
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => { const list = listeners.get(event) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
    },
    route: (path, handler) => { routes.set(path, handler); return () => routes.delete(path) },
    every: (ms, fn, label) => { timers.push({ ms, fn, label }); return () => {} },
    // 测试驱动
    fire: (event, ...args) => (listeners.get(event) || []).map((fn) => fn(...args)),
    fireAsync: async (event, ...args) => { for (const fn of (listeners.get(event) || [])) await fn(...args) },
    routeHandler: (path) => routes.get(path),
    timerCount: () => timers.length,
    fireTimers: () => timers.forEach((t) => t.fn()),
    listenerCount: (event) => (listeners.get(event) || []).length,
  }
  return { api, dataDir }
}

const interjectDecision = { reply: true, mode: 'interject', reason: '话题相关，插一句' }
const msg = (over = {}) => ({ chatId: 'group:30001', groupId: '30001', messageId: '10001', text: '哈哈这个太可爱了吧', userId: '555', ...over })
const groupResult = (over = {}) => ({
  turnId: 't1', chatId: 'group:30001', topicMode: 'interject', participation: 'react',
  triggerMessageIds: ['10001'], state: 'sent', sourceModuleId: 'group-engagement', deliveryId: 'group-react:t1', reason: '', at: Date.now(),
  ...over,
})

test('Shadow：group/participate 返回 undefined（零接管零副作用），/state 只报统计', async () => {
  const { api, dataDir } = mkApi({ enabled: true, mode: 'shadow', allowedGroupIds: '30001' })
  const exports = module.setup(api)
  const declared = api.fire('group/participate', interjectDecision, { msg: msg(), recentTexts: [] })
  assert.equal(declared.length, 1)
  assert.equal(declared[0], undefined, 'Shadow 绝不返回接管对象（宿主保持 FULL）')
  const state = api.routeHandler('/state')()
  assert.equal(state.ok, true)
  assert.equal(state.mode, 'shadow')
  assert.equal(state.shadowStats.total, 1, '建议计数在内存里')
  assert.equal(state.shadowStats.react, 1)
  assert.equal(JSON.stringify(state).includes('哈哈'), false, '/state 绝不返回聊天正文')
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('engage + react：声明 REACT 且 emoji 来自 settings；熔断后停声明', async () => {
  const { api, dataDir } = mkApi({ enabled: true, mode: 'engage', allowedGroupIds: '30001', reactEnabled: true })
  const exports = module.setup(api)
  const declared = api.fire('group/participate', interjectDecision, { msg: msg(), recentTexts: [] })
  assert.deepEqual(declared[0], { level: 'react', reaction: { messageId: '10001', emojiId: '66' } })
  // 熔断：连续 3 次 failed（sourceModuleId 必须是本模块）
  for (let i = 0; i < 3; i++) await api.fireAsync('group/result', groupResult({ state: 'failed', deliveryId: '' }))
  const bucket = api.routeHandler('/state')()
  const g = bucket.groups.find((x) => x.chatId === 'group:30001')
  assert.equal(g.circuitUntil > Date.now(), true, '连续失败达阈值 → 熔断')
  // 熔断期间不再声明 REACT
  const after = api.fire('group/participate', interjectDecision, { msg: msg(), recentTexts: [] })
  assert.notEqual(after[0]?.level, 'react', '熔断中停声明 REACT')
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('unknown 谨慎计数 / sent 清零连败并更新 lastReactAt', async () => {
  const { api, dataDir } = mkApi({ enabled: true, mode: 'engage', allowedGroupIds: '30001', reactEnabled: true })
  const exports = module.setup(api)
  await api.fireAsync('group/result', groupResult({ turnId: 'u0', state: 'unknown' }))
  await api.fireAsync('group/result', groupResult({ turnId: 'f0', state: 'failed' }))
  await api.fireAsync('group/result', groupResult({ turnId: 'f1', state: 'failed' }))
  let state = api.routeHandler('/state')()
  let g = state.groups.find((x) => x.chatId === 'group:30001')
  assert.equal(g.reactUnknownCount, 1, 'unknown 独立谨慎计数')
  assert.equal(g.consecutiveFailures, 2, 'failed 连败计数')
  await api.fireAsync('group/result', groupResult({ turnId: 's1', state: 'sent' }))
  state = api.routeHandler('/state')()
  g = state.groups.find((x) => x.chatId === 'group:30001')
  assert.equal(g.consecutiveFailures, 0, 'sent 清零连败')
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('质量门： meaningless/重复 → null；group/result sent/partial 进缓存、其余清候选', async () => {
  const { api, dataDir } = mkApi({ enabled: true, guardEnabled: true })
  const exports = module.setup(api)
  const info = { chatId: 'group:30001', turnId: 't1', topicMode: 'interject', participation: 'full' }
  assert.equal(api.fire('reply', '确实', info)[0], null)
  assert.equal(api.fire('reply', '这是一条有实际内容的插话句子。', info)[0], undefined)
  await api.fireAsync('group/result', groupResult({ state: 'sent' }))
  // 已进缓存 → 同文本再插话被拦
  assert.equal(api.fire('reply', '这是一条有实际内容的插话句子。', info)[0], null, 'sent 后同文本判重')
  // skipped 终态不清缓存也不污染
  await api.fireAsync('group/result', groupResult({ turnId: 't2', state: 'skipped' }))
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('反馈：sent/partial + interject 建 pending；message 计 followup；结算调 bias（feedbackBiasEnabled）', async () => {
  const { api, dataDir } = mkApi({ enabled: true, feedbackEnabled: true, feedbackBiasEnabled: true, feedbackWindowMs: 1000 })
  const exports = module.setup(api)
  await api.fireAsync('group/result', groupResult({ state: 'sent', participation: 'text_lite', triggerMessageIds: ['10001'], at: Date.now() }))
  let state = api.routeHandler('/state')()
  assert.equal(state.pendingCount, 1, 'pending 已建')
  await api.fireAsync('message', msg({ messageId: '20001', userId: '556', text: '后续消息一' }))
  await api.fireAsync('message', msg({ messageId: '20002', userId: '557', text: '后续消息二' }))
  await new Promise((r) => setTimeout(r, 1100)) // 越过 feedbackWindowMs
  api.fireTimers() // api.every 的定期结算（桩手动触发）
  state = api.routeHandler('/state')()
  assert.equal(state.pendingCount, 0, '结算后 pending 出列')
  const g = state.groups.find((x) => x.chatId === 'group:30001')
  assert.equal(g.feedbackCounts.extended, 1, '两条后续 + 两 speaker → extended')
  assert.equal(g.bias, 0.02, 'bias 加步长')
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('dispose：撤销全部监听与路由；重复 dispose 幂等；重 setup 不重复注册', async () => {
  const { api, dataDir } = mkApi({ enabled: true, mode: 'engage', allowedGroupIds: '30001', reactEnabled: true })
  const exports1 = module.setup(api)
  const countBefore = {
    participate: api.listenerCount('group/participate'),
    reply: api.listenerCount('reply'),
    message: api.listenerCount('message'),
    result: api.listenerCount('group/result'),
  }
  assert.equal(countBefore.participate, 1)
  exports1.dispose()
  exports1.dispose() // 幂等
  assert.equal(api.listenerCount('group/participate'), 0, '监听已撤销')
  assert.equal(api.listenerCount('reply'), 0)
  assert.equal(api.listenerCount('message'), 0)
  assert.equal(api.listenerCount('group/result'), 0)
  assert.equal(api.routeHandler('/state'), undefined, '路由已撤销')
  // fire 不再触发任何处理器
  const fired = api.fire('group/participate', interjectDecision, { msg: msg() })
  assert.equal(fired.length, 0)
  // 重新 setup：正常工作且不重复
  const exports2 = module.setup(api)
  assert.equal(api.listenerCount('group/participate'), 1, '重新 setup 只注册一份')
  const declared = api.fire('group/participate', interjectDecision, { msg: msg(), recentTexts: [] })
  assert.equal(declared[0].level, 'react')
  exports2.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

test('/state 脱敏：绝不返回正文 / turnId / 完整 triggerMessageIds', async () => {
  const { api, dataDir } = mkApi({ enabled: true, feedbackEnabled: true, feedbackBiasEnabled: true })
  const exports = module.setup(api)
  await api.fireAsync('group/result', groupResult({ state: 'sent', triggerMessageIds: ['10001', '10002'] }))
  await api.fireAsync('message', msg({ messageId: '20001', userId: '556', text: '包含正文的后续消息' }))
  const raw = JSON.stringify(api.routeHandler('/state')())
  assert.equal(raw.includes('哈哈'), false)
  assert.equal(raw.includes('后续消息'), false)
  assert.equal(raw.includes('turnId'), false)
  assert.equal(raw.includes('triggerMessageIds'), false)
  exports.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})
