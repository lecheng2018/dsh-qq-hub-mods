import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildDistillPrompt } from './prompt.mjs'
import { verifyAndCleanRules, safeParseJsonArray, salvageTruncatedObjects } from './verifier.mjs'
import { createDistillStore } from './store.mjs'
import { scanHistoryGroups, sampleGroupHistory } from './history-miner.mjs'
import distillModule from './index.mjs'

test('prompt: 正确生成带 [id:xx] 的提取提示词', () => {
  const lines = [
    { name: '群友A', text: '这把真的太难了' },
    { name: '群友B', text: '菜就多练，输不起别玩' }
  ]
  const { system, text } = buildDistillPrompt(lines)
  assert.match(text, /当 "AAAAA" 时，可以使用 "BBBBB"/)
  assert.match(text, /\[id:1\] \[name:群友A\]/)
  assert.match(text, /\[id:2\] \[name:群友B\]/)
})

test('verifier: 严格防自投毒（排除 Bot 自己）与排除真实生活经历', () => {
  const lines = [
    { name: 'Bot', isBot: true, text: '你好，我是大肥鱼' },
    { name: '群友A', isBot: false, text: '笑死我了，昨天我被封号了' },
    { name: '群友B', isBot: false, text: '确实有点东西' }
  ]

  const rawRules = [
    { situation: '打招呼', style: '使用 你好呀', source_id: 1 }, // 来源于 Bot -> 必须剔除
    { situation: '倒霉经历', style: '抱怨我被封号了', source_id: 2 }, // 冒充群友经历 -> 必须剔除
    { situation: '表示认可且带调侃', style: '使用 确实有点东西', source_id: 3 }, // 合法群友风格 -> 保留
    { situation: '瞎编的', style: '无源之水', source_id: 99 }, // 越界 ID -> 必须剔除
  ]

  const cleaned = verifyAndCleanRules(rawRules, lines)
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0].situation, '表示认可且带调侃')
  assert.equal(cleaned[0].style, '使用 确实有点东西')
})

test('store: 规则存储、频次递增、锁定与容量淘汰机制', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-test-'))
  try {
    const store = createDistillStore(dir)
    const gid = '123456'

    // 1. 添加初始规则
    store.addRules(gid, [
      { situation: '游戏逆风', style: '菜就多练' },
      { situation: '代码报错', style: '重启大法' },
      { situation: '抽卡爆死', style: '好似开香槟' }
    ], 3)

    let rules = store.getRawRules(gid)
    assert.equal(rules.length, 3)

    // 2. 锁定第一条规则
    const ruleA = rules.find(r => r.situation === '游戏逆风')
    const locked = store.toggleLock(gid, ruleA.id)
    assert.equal(locked, true)

    // 3. 重复添加近义规则 -> 频次累加
    store.addRules(gid, [{ situation: '游戏快输了时', style: '调侃 菜就多练' }], 3)
    rules = store.getRawRules(gid)
    const ruleAAfter = rules.find(r => r.id === ruleA.id)
    assert.equal(ruleAAfter.count, 2)

    // 4. 超容量添加情境D（总上限3条）：ruleA被锁定必保留，ruleA频次高（count=2）保留，代码报错最冷门被淘汰
    await new Promise(r => setTimeout(r, 5))
    store.addRules(gid, [{ situation: '吃饭点外卖', style: '直接点疯狂星期四' }], 3)
    rules = store.getRawRules(gid)
    assert.equal(rules.length, 3)
    assert.ok(rules.some(r => r.id === ruleA.id)) // locked A 保留
    assert.ok(rules.some(r => r.situation === '吃饭点外卖')) // 新规则 D 保留

    // 5. 门槛过滤验证：minCount = 2 时，只有 A 生效
    const active = store.getActiveRules(gid, 2)
    assert.equal(active.length, 1)
    assert.equal(active[0].id, ruleA.id)

    // 6. 情境匹配：严格命中
    const matched = store.matchRelevantRules(active, '今天游戏逆风局真难打', 2)
    assert.equal(matched.length, 1)
    assert.equal(matched[0].id, ruleA.id)

    // 7. 未命中时绝不盲目返回
    const noMatch = store.matchRelevantRules(active, '今天天气真不错适合散步', 2)
    assert.equal(noMatch.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history-miner: 正确扫描群聊并采样过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatlog-test-'))
  try {
    const fakeLog = [
      JSON.stringify({ t: 1000, chatId: 'group:999', who: '群友1', uid: '111', text: '群里今天真热闹' }),
      JSON.stringify({ t: 2000, chatId: 'group:999', who: '大肥鱼', uid: '222', text: '大家好呀' }), // Bot -> 应过滤
      JSON.stringify({ t: 3000, chatId: 'group:999', who: '群友2', uid: '333', text: '[图片]' }), // 纯表情 -> 应过滤
      JSON.stringify({ t: 4000, chatId: 'group:999', who: '群友1', uid: '111', text: '确实好活' }),
      JSON.stringify({ t: 5000, chatId: 'group:888', who: '群友3', uid: '444', text: '另一个群的消息' }),
    ].join('\n')
    writeFileSync(join(dir, '2026-11-16.jsonl'), fakeLog)

    const groups = scanHistoryGroups(dir)
    assert.equal(groups.length, 2)
    assert.equal(groups.find(g => g.groupId === '999').totalCount, 4)

    const samples = sampleGroupHistory(dir, '999', { days: 1, sampleSize: 10, botQQ: '222' })
    assert.equal(samples.length, 2)
    assert.equal(samples[0].text, '群里今天真热闹')
    assert.equal(samples[1].text, '确实好活')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('module runtime: 实时消息监听与缓冲累积', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-test-'))
  try {
    const listeners = new Map()
    const routes = new Map()
    let contextFn = null

    const mockApi = {
      dataDir: () => dir,
      settings: () => ({ enabled: true, batchSize: 5, activeGroups: '123' }),
      config: () => ({ botQQ: '10001' }),
      log: { info() {}, warn() {}, debug() {} },
      on: (event, fn) => { listeners.set(event, fn) },
      context: (fn) => { contextFn = fn },
      route: (path, fn) => { routes.set(path, fn) },
      later: (ms, fn) => setTimeout(fn, ms),
      ask: async () => '[]'
    }

    const mod = distillModule.setup(mockApi)
    const onMessage = listeners.get('message')
    assert.ok(typeof onMessage === 'function')

    // 1. 测试私聊消息 -> 被忽略
    const r1 = await onMessage({ kind: 'private', userId: '888', text: '你好' })
    assert.equal(r1, false)

    // 2. 测试 Bot 自身发言 -> 被忽略
    const r2 = await onMessage({ kind: 'group', groupId: '123', userId: '10001', text: '我是Bot' })
    assert.equal(r2, false)

    // 3. 测试未生效群 -> 被忽略
    const r3 = await onMessage({ kind: 'group', groupId: '456', userId: '888', text: '其他群发言' })
    assert.equal(r3, false)

    // 4. 测试合法群友发言 -> 正常接收并进入缓存
    const r4 = await onMessage({ kind: 'group', groupId: '123', userId: '888', nickname: '群友A', text: '第一句' })
    assert.equal(r4, false)

    const statusHandler = routes.get('/status')
    const status = await statusHandler()
    const groupStat = status.list.find(g => g.groupId === '123')
    assert.ok(groupStat)
    assert.equal(groupStat.bufferCount, 1)

    mod.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: 分层规则库（全局共享底座 + 群专属优先覆盖 + 跨群频次累加 + 规则流转）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiered-distill-test-'))
  try {
    const store = createDistillStore(dir)

    // 1. 全局底座添加通用规则（count 初始 1）
    store.addRules('global', [
      { situation: '遇到bug', style: '调侃 重启电脑' },
      { situation: '抽卡出金', style: '发开香槟表情' },
    ], 10, { originGroup: 'groupA' })

    // 2. groupB 再次提炼出相近的全局规则 -> 频次聚类累加且合并来源群
    store.addRules('global', [
      { situation: '遇到代码bug时', style: '说重启电脑' },
    ], 10, { originGroup: 'groupB' })

    const globalRules = store.getRawRules('global')
    const bugRule = globalRules.find(r => r.situation.includes('bug'))
    assert.ok(bugRule)
    assert.equal(bugRule.count, 2)
    assert.deepEqual(bugRule.sourceGroups.sort(), ['groupA', 'groupB'].sort())

    // 3. 群 999 继承全局规则
    let activeIn999 = store.getActiveRules('999', 2, { includeGlobal: true })
    assert.equal(activeIn999.length, 1) // bugRule 频次达到 2
    assert.equal(activeIn999[0].isGlobal, true)

    // 4. 群 999 自定义群专属规则（覆盖全局的 bug 规则）
    store.addRules('999', [
      { situation: '遇到bug', style: '本群专属黑话 找群主修' },
    ], 10)
    store.promoteCandidate('999', store.getRawRules('999')[0].id) // 锁定转正

    // 再次读取群 999 的正式规则：本地近义优先，全局被遮蔽
    activeIn999 = store.getActiveRules('999', 2, { includeGlobal: true })
    const activeBug = activeIn999.find(r => r.situation.includes('bug'))
    assert.equal(activeBug.style, '本群专属黑话 找群主修')
    assert.equal(activeBug.isGlobal, false)

    // 5. 将群 999 的专属规则设为全局共享 (scopeRule)
    const localRuleId = activeBug.id
    const migrated = store.scopeRule('999', 'global', localRuleId)
    assert.equal(migrated, true)
    // 999 本地已移除
    assert.equal(store.getRawRules('999').length, 0)
    // global 已增加/合并
    assert.ok(store.getRawRules('global').some(r => r.id === localRuleId || r.style.includes('找群主修')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('module: 全局共享底座与分层路由与注入验证', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiered-mod-test-'))
  try {
    const listeners = new Map()
    const routes = new Map()
    let contextFn = null

    const mockApi = {
      dataDir: () => dir,
      settings: () => ({ enabled: true, globalSharing: true, minPromotionCount: 2 }),
      config: () => ({ botQQ: '10001' }),
      log: { info() {}, warn() {}, debug() {} },
      on: (event, fn) => { listeners.set(event, fn) },
      context: (fn) => { contextFn = fn },
      route: (path, fn) => { routes.set(path, fn) },
      later: (ms, fn) => setTimeout(fn, ms),
      ask: async () => '[]'
    }

    const mod = distillModule.setup(mockApi)

    // 手动录入一条全局规则
    const addManualHandler = routes.get('/add-manual')
    await addManualHandler({
      scope: 'global',
      situation: '聊到发工资',
      style: '请客吃大餐'
    })

    // 1. 测试 /status 路由：首项为 global，且 isGlobal 为 true
    const statusHandler = routes.get('/status')
    const statusRes = await statusHandler()
    assert.equal(statusRes.ok, true)
    assert.equal(statusRes.list[0].groupId, 'global')
    assert.equal(statusRes.list[0].isGlobal, true)
    assert.equal(statusRes.list[0].activeCount, 1)

    // 2. 测试 /rules 路由：对于新群 777，在 globalSharing 开启时继承 global 规则
    const rulesHandler = routes.get('/rules')
    const rulesRes = await rulesHandler({ url: 'http://localhost/rules?groupId=777' })
    assert.equal(rulesRes.ok, true)
    assert.equal(rulesRes.activeRules.length, 1)
    assert.equal(rulesRes.activeRules[0].isGlobal, true)
    assert.equal(rulesRes.activeRules[0].situation, '聊到发工资')

    // 3. 测试上下文注入命中
    const onMessage = listeners.get('message')
    await onMessage({
      kind: 'group',
      groupId: '777',
      userId: '888',
      nickname: '群友小王',
      text: '今天公司发工资啦！',
    })

    const ctx = contextFn({ chat: { kind: 'group', groupId: '777' } })
    assert.match(ctx, /聊到「发工资」时群友常带的语调：请客吃大餐/)

    mod.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 蒸馏专用模型（1.0.0-beta.6）：提炼负载和群聊回复负载分开挑模型。
// 这里用 /simulate 打通同一条 askDistill 路径，省得再造一份 chatlog。
test('module: 蒸馏专用模型——透传 provider/model，选错自动回退主模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-model-test-'))
  try {
    const routes = new Map()
    const listeners = new Map()
    let settings = { enabled: true, minPromotionCount: 2, modelOverride: 'openai::gpt-5-mini' }
    const calls = []
    let failCustom = false

    const mockApi = {
      dataDir: () => dir,
      settings: () => ({ ...settings }),
      saveSettings: (patch) => { settings = { ...settings, ...patch }; return { ...settings } },
      config: () => ({ botQQ: '10001' }),
      log: { info() {}, warn() {}, debug() {} },
      on: (event, fn) => { listeners.set(event, fn) },
      context: () => {},
      route: (path, fn) => { routes.set(path, fn) },
      later: (ms, fn) => setTimeout(fn, ms),
      core: {
        personas: { currentPersonaText: () => '你是测试人格' },
        listModels: async () => [
          { provider: 'openai', model: 'gpt-5-mini', name: 'GPT-5 mini' },
          { provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat' },
        ],
        defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      },
      ask: async (opts) => {
        calls.push(opts)
        if (failCustom && opts.provider === 'openai') throw new Error('model not found')
        return '好的呀'
      },
    }

    const mod = distillModule.setup(mockApi)
    const modelsHandler = routes.get('/models')
    const saveHandler = routes.get('/save-settings')
    const simulateHandler = routes.get('/simulate')

    // 1. /models 回宿主目录，并标出当前配置与主模型
    let models = await modelsHandler()
    assert.equal(models.ok, true)
    assert.equal(models.list.length, 2)
    assert.ok(models.list.some(m => m.value === 'openai::gpt-5-mini'))
    assert.equal(models.active, 'openai::gpt-5-mini')
    assert.equal(models.defaultModel, 'deepseek::deepseek-chat')

    // 2. 指定模型 -> api.ask 必须拿到 provider/model（否则等于没生效）
    await simulateHandler({ scope: '123', userText: '今天天气不错' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'openai')
    assert.equal(calls[0].model, 'gpt-5-mini')

    // 3. 指定模型挂了 -> 记一条 warn，本次回退主模型（不传 provider/model）
    failCustom = true
    const fallbackRes = await simulateHandler({ scope: '123', userText: '今天天气不错' })
    assert.equal(fallbackRes.ok, true)
    assert.equal(calls.length, 3, '失败一次 + 回退一次，不能把提炼链路拖哑')
    assert.equal(calls[2].provider, undefined)
    assert.equal(calls[2].model, undefined)
    failCustom = false

    // 4. 手填写法也认 provider/模型名（模型 id 自带斜杠时整段留作模型名）
    const saved = await saveHandler({ modelOverride: 'deepseek/deepseek-chat' })
    assert.equal(saved.ok, true)
    assert.equal(saved.modelOverride, 'deepseek/deepseek-chat')
    await simulateHandler({ scope: '123', userText: '再试一句' })
    assert.equal(calls[calls.length - 1].provider, 'deepseek')
    assert.equal(calls[calls.length - 1].model, 'deepseek-chat')

    // 5. 格式不对（没有分隔符）不能瞎猜 provider，按跟随主模型处理并报给面板
    await saveHandler({ modelOverride: 'gpt-5-mini' })
    models = await modelsHandler()
    assert.equal(models.invalid, 'gpt-5-mini')
    await simulateHandler({ scope: '123', userText: '第三句' })
    assert.equal(calls[calls.length - 1].provider, undefined)

    // 6. 清空 = 跟随主模型，面板恢复成默认项
    await saveHandler({ modelOverride: '' })
    models = await modelsHandler()
    assert.equal(models.modelOverride, '')
    assert.equal(models.active, '')

    mod.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 截断抢救（fix/distill-truncated-json）：
// 提炼一次喂 15 条消息、maxTokens 一紧，模型常常写到一半被截停，JSON 数组没有右括号。
// 旧实现严格配对找不到闭合就返回 []，**前面已写完整的规则一起丢**（真机 2026-11-21：
// 当天 21 次「未解析出有效规则」，日志回包里明明有完整对象）。纯损失，不是模型没产出。

test('verifier: 被截断的 JSON 数组要抢救出已写完整的对象，而不是整包丢弃', () => {
  const full = '[{"situation":"遇到反复弹窗等离谱烦恼","style":"开头惊呼wtf加反问为啥","source_id":1},'
    + '{"situation":"追问别人一直没回复","style":"@对方说 你还没回答我呢","source_id":2},'
    + '{"situation":"调侃对方说话太毒舌","style":"用句式 你还真是呢","source_id":3}]'

  // 完整时行为不变（3 条，且不走抢救分支）
  assert.equal(safeParseJsonArray(full).length, 3)

  // 截到第 2 个对象完整、第 3 个写一半：应救回 2 条
  const cut2 = full.slice(0, full.indexOf('"调侃对方说话太毒舌"') + 10)
  assert.equal(safeParseJsonArray(cut2).length, 2, '前两条完整规则不能因为第三条没写完而丢掉')

  // 只截完第 1 个对象：应救回 1 条
  const cut1 = full.slice(0, full.indexOf('"追问别人') + 5)
  assert.equal(safeParseJsonArray(cut1).length, 1)

  // 一个完整对象都没有：不要瞎编
  assert.deepEqual(safeParseJsonArray('[{"situation":"写到一半就'), [])
})

test('verifier: 抢救时字符串里的 ] 与 } 不能被当成数组/对象结束', () => {
  const tricky = '[{"situation":"a b","style":"他说「]」还有 {}","source_id":1},{"situation":"c d","style":"半截'
  const got = salvageTruncatedObjects(tricky)
  assert.equal(got.length, 1)
  assert.equal(got[0].style, '他说「]」还有 {}', '按 JSON 字符串规则跳过括号，不能提前截断')

  // 转义引号同样不能把字符串判定提前结束。
  // 这里必须让回包里是「反斜杠 + 引号」两个字面字符（JSON 的 \" ），不是 JS 先转义成裸引号 ——
  // 裸引号进 JSON 本身就是非法，返回 0 才是对的（第一版用例写成裸引号，误判成函数 bug）。
  const escaped = '[{"situation":"a b","style":"他说 \\"好\\" 然后","source_id":1},{"situation":"x'
  assert.ok(escaped.includes('\\"'), '用例自身先确认回包里确实是转义序列')
  assert.equal(salvageTruncatedObjects(escaped).length, 1)
  assert.equal(salvageTruncatedObjects(escaped)[0].style, '他说 "好" 然后', '转义引号解析回裸引号')
})

test('verifier: 非 JSON 回包抢救也返回空（不许无中生有）', () => {
  assert.deepEqual(salvageTruncatedObjects('模型这次什么都没给'), [])
  assert.deepEqual(salvageTruncatedObjects(''), [])
  assert.deepEqual(salvageTruncatedObjects(null), [])
})
