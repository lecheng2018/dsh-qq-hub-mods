import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isBotSender, sanitizeHumanMessage } from './filter.mjs'
import { verifyAndCleanRules, isQualityRule, safeParseJsonArray, normalizeStyle } from './verifier.mjs'
import { createDistillStore, areRulesSimilar } from './store.mjs'
import { sampleGroupHistory } from './history-miner.mjs'
import distillModule from './index.mjs'

let tempDir

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'distill-v2-test-'))
})

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

test('filter: 严格拦截自身 Bot、Q群管家、fishGuard、链接广播与长文粘贴', () => {
  const fishGuard = { fishIds: ['90001'], nameSuffixes: ['Ai'] }

  assert.equal(isBotSender({ userId: '', nickname: 'bot', botQQ: '20002', fishGuard }), true)
  assert.equal(isBotSender({ userId: '20002', nickname: '小鱼', botQQ: '20002', fishGuard }), true)
  assert.equal(isBotSender({ userId: '2854196310', nickname: 'Q群管家', botQQ: '20002', fishGuard }), true) // pii-scan:ignore
  assert.equal(isBotSender({ userId: '90001', nickname: '路人', botQQ: '20002', fishGuard }), true)
  assert.equal(isBotSender({ userId: '12345', nickname: '助手Ai', botQQ: '20002', fishGuard }), true)
  assert.equal(isBotSender({ userId: '30001', nickname: '群友甲', botQQ: '20002', fishGuard }), false)

  assert.equal(sanitizeHumanMessage('欢迎欢迎\nwww.example.com\n点链接进来看看'), '')
  assert.equal(sanitizeHumanMessage('[图片]'), '')
  assert.equal(sanitizeHumanMessage('/status'), '')
  assert.equal(sanitizeHumanMessage('TypeError: cannot read properties of undefined'), '')
  assert.equal(sanitizeHumanMessage('一'.repeat(65)), '')
  assert.equal(sanitizeHumanMessage('太难绷了 真离谱'), '太难绷了 真离谱')
})

test('verifier: 放行干净短口癖，拦截具体业务台词/数字价格/元模板，且支持截断 JSON 抢救', () => {
  const lines = [
    { name: '甲', isBot: false, text: '太难绷了' },
    { name: '乙', isBot: false, text: '直接开摆' },
    { name: '丙', isBot: false, text: '确实' },
    { name: '机器人', isBot: true, text: '笑死' },
  ]

  const raw = [
    { situation: '觉得很离谱时', style: '使用“太难绷了”', source_id: 1 },
    { situation: '懒得折腾放弃', style: '直接开摆', source_id: 2 },
    { situation: '觉得很好笑', style: '笑死', source_id: 4 },
    { situation: '吐槽模型降智', style: '模型名加数字 如 可以用200刀', source_id: 1 },
    { situation: '欢迎新人入群', style: '连说欢迎欢迎再补去薅一下', source_id: 2 },
    { situation: '嫌价格太贵', style: '直接报数字 现在最便宜左右', source_id: 3 },
    { situation: '表示附和', style: '确实', source_id: 3 },
  ]

  const cleaned = verifyAndCleanRules(raw, lines)
  assert.equal(cleaned.length, 3)
  assert.deepEqual(cleaned.map(r => r.style), ['太难绷了', '直接开摆', '确实'])
  assert.equal(normalizeStyle('调侃使用“真假的”'), '真假的')
  assert.equal(isQualityRule({ situation: '自嘲自己的bot表现差', style: '我在干正事' }), false)
  assert.equal(isQualityRule({ situation: '觉得离谱', style: '你这个…都是…' }), false)
  assert.equal(safeParseJsonArray('<think>ok</think>[]').length, 0)

  // 截断 JSON 数组抢救
  const truncated = '[{"situation":"觉得离谱","style":"难绷","source_id":1},{"situation":"写了一半'
  const rescued = safeParseJsonArray(truncated)
  assert.equal(rescued.length, 1)
  assert.equal(rescued[0].style, '难绷')
})

test('store: 严格按群隔离（忽略遗留 global）、不乱合并、保留更短口癖与冷却防复读', () => {
  // 模拟旧版遗留 global 数据
  writeFileSync(join(tempDir, 'distill-rules.json'), JSON.stringify({
    groups: {
      global: { rules: [{ id: 'g1', situation: '觉得离谱', style: '全局旧梗', count: 99, locked: true }] },
    },
  }), 'utf8')

  const store = createDistillStore(tempDir)
  assert.deepEqual(store.getAllGroupIds(), [], '不得暴露旧版 global 作用域')
  assert.deepEqual(store.getActiveRules('10001', 1), [], '不得继承旧版 global 规则')

  // 不相关规则绝不合并
  assert.equal(
    areRulesSimilar(
      { situation: '吐槽天气太热', style: '热麻了' },
      { situation: '吐槽排队太久', style: '等麻了' },
    ),
    false,
  )
  // 真正近义才合并
  assert.equal(
    areRulesSimilar(
      { situation: '觉得太离谱', style: '太难绷了' },
      { situation: '觉得很离谱', style: '难绷' },
    ),
    true,
  )

  store.addRules('10001', [{ situation: '觉得太离谱', style: '太难绷了' }], 60)
  store.addRules('10001', [{ situation: '觉得很离谱', style: '难绷' }], 60)
  store.addRules('10001', [{ situation: '觉得太离谱', style: '太难绷了吧这也' }], 60)
  store.addRules('10001', [{ situation: '觉得很离谱', style: '难绷' }], 60)

  // 群 10002 隔离不可见
  assert.equal(store.getActiveRules('10002', 4).length, 0)

  const active = store.getActiveRules('10001', 4)
  assert.equal(active.length, 1)
  assert.equal(active[0].count, 4)
  assert.equal(active[0].style, '难绷')

  assert.equal(store.matchRelevantRules(active, '中午吃点啥外卖呢', 1).length, 0)

  const now = Date.now()
  const hit = store.matchRelevantRules(active, '这操作也太离谱了吧', 1, { now })
  assert.equal(hit.length, 1)
  assert.equal(hit[0].style, '难绷')

  store.recordRuleUsage('10001', [hit[0].id])
  const refreshed = store.getActiveRules('10001', 4)
  assert.equal(store.matchRelevantRules(refreshed, '这操作也太离谱了吧', 1, { now: now + 1000 }).length, 0)

  // purgeDirtyRules 连带清除遗留 global
  const purged = store.purgeDirtyRules()
  assert.equal(purged, 1)
})

test('history-miner: 历史抽样自动跳过 who=bot、Q群管家与广告链接', () => {
  const logFile = join(tempDir, '2026-11-25.jsonl')
  const entries = [
    { t: 1000, chatId: 'group:10001', who: 'bot', uid: null, text: '我是机器人的回复' },
    { t: 2000, chatId: 'group:10001', who: 'Q群管家', uid: '2854196310', text: '欢迎欢迎 www.example.com' }, // pii-scan:ignore
    { t: 3000, chatId: 'group:10001', who: '群友甲', uid: '30001', text: '这也太离谱了吧' },
    { t: 4000, chatId: 'group:10001', who: '群友乙', uid: '30002', text: '直接开摆了' },
  ]
  writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')

  const sampled = sampleGroupHistory(tempDir, '10001', { days: 1, botQQ: '20002' })
  assert.equal(sampled.length, 2)
  assert.deepEqual(sampled.map(x => x.name), ['群友甲', '群友乙'])
})

test('module lifecycle: 过滤管家、无全局底座、冷却生效、专用模型覆盖与失败回退', async () => {
  let onMessage = null
  let contextFn = null
  const routes = new Map()
  const askCalls = []
  const settings = {
    ...distillModule.defaults,
    enabled: true,
    minPromotionCount: 2,
    injectChance: 1,
    injectCooldownSec: 180,
    modelOverride: 'custom::bad-model',
  }

  const api = {
    dataDir: () => tempDir,
    settings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ botQQ: '20002', group: { fishGuard: { fishIds: ['90001'], nameSuffixes: ['Ai'] } } }),
    core: {
      listModels: async () => [{ provider: 'openai', model: 'gpt-5-mini', name: 'GPT-5 mini' }],
      defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
    log: { info() {}, debug() {}, warn() {} },
    on: (ev, fn) => { if (ev === 'message') onMessage = fn },
    context: (fn) => { contextFn = fn },
    route: (path, fn) => routes.set(path, fn),
    later: () => {},
    ask: async (opts) => {
      askCalls.push(opts)
      if (opts.model === 'bad-model') throw new Error('model unavailable')
      return '回退主模型回复'
    },
  }

  const inst = distillModule.setup(api)

  await routes.get('/add-manual')({ body: { groupId: '10001', situation: '觉得离谱', style: '太难绷了' } })

  // Q群管家发广告 -> 不进入缓存也不触发匹配
  await onMessage({ kind: 'group', groupId: '10001', userId: '2854196310', nickname: 'Q群管家', text: '离谱 欢迎欢迎 www.example.com' }) // pii-scan:ignore
  assert.equal(contextFn({ chat: { kind: 'group', groupId: '10001' } }), '')

  // 真实群友发言 -> 命中并输出轻量提示
  await onMessage({ kind: 'group', groupId: '10001', userId: '30001', nickname: '群友甲', text: '这也太离谱了吧' })
  const hint1 = contextFn({ chat: { kind: 'group', groupId: '10001' } })
  assert.match(hint1, /顺嘴参考.*太难绷了/)

  // 冷却内不重复注入
  assert.equal(contextFn({ chat: { kind: 'group', groupId: '10001' } }), '')

  // /status 不包含任何 global 项
  const status = await routes.get('/status')({})
  assert.equal(status.ok, true)
  assert.equal(status.list.some(x => x.groupId === 'global'), false)

  // 通用设置不再重复暴露 modelOverride（避免与面板下拉互相覆盖）
  assert.equal(distillModule.settings.some(s => s.key === 'modelOverride'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(distillModule.defaults, 'modelOverride'), true)

  // /models & /save-settings
  const modelsRes = await routes.get('/models')({})
  assert.equal(modelsRes.ok, true)
  assert.equal(modelsRes.list.length, 1)
  assert.equal(modelsRes.defaultModel, 'deepseek::deepseek-chat')

  // 配置了 QQ Hub 主模型时 /models 优先显示它，而不是宿主默认模型
  api.config = () => ({ botQQ: '20002', model: { provider: 'custom', model: 'chat-main' }, group: { fishGuard: { fishIds: ['90001'], nameSuffixes: ['Ai'] } } })
  const modelsWithCfg = await routes.get('/models')({})
  assert.equal(modelsWithCfg.defaultModel, 'custom::chat-main')

  // /simulate 验证专用模型失败自动回退主模型
  const sim = await routes.get('/simulate')({ body: { groupId: '10001', userText: '这也太离谱了' } })
  assert.equal(sim.ok, true)
  assert.equal(sim.hit, true)
  assert.equal(sim.reply, '回退主模型回复')
  assert.equal(askCalls.length, 2, '指定模型失败后必须自动回退主模型')
  assert.equal(askCalls[0].model, 'bad-model')
  assert.equal(askCalls[1].model, undefined)

  // 保存新模型
  const saveRes = await routes.get('/save-settings')({ body: { modelOverride: 'openai::gpt-5-mini' } })
  assert.equal(saveRes.ok, true)
  assert.equal(settings.modelOverride, 'openai::gpt-5-mini')

  inst.dispose()
})
