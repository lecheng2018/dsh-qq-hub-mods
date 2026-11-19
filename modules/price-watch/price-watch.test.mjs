// 价格监控 qq-hub 版集成测试：假 api + 假 fetch + 假记忆，不打真网络、不发真消息。
// 覆盖：注册面、查价写记忆与到期清理、加监控 / 降价提醒 / 冷却、群友命令接管、白名单。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import def, { linkKind, parseGroupIds } from './index.mjs'

// ---- 假什么值得买接口 ----
function smzdmRows (rows) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data: { rows } }) }
}
function row (over = {}) {
  return {
    article_id: String(over.id || 1000 + Math.floor(Math.random() * 100000)),
    article_title: over.title || '拓竹 A1 3D打印机 899元',
    article_price: over.price || '899元',
    article_mall: over.mall || '京东',
    article_url: over.url || 'https://www.smzdm.com/p/100001/',
    article_channel_type: 'faxian',
    tongji_hudong: over.tongji || '评论_25,收藏_15,值_30,不值_1',
    article_is_sold_out: 0,
    article_is_timeout: 0,
    publish_date_lt: Math.floor(Date.now() / 1000),
    ...over,
  }
}

// ---- 假记忆（模拟 qq-hub 记忆模块导出：方法都是同步的，和真实总线一致）----
function fakeMemory () {
  const items = []
  let seq = 0
  return {
    items,
    add: (entry) => {
      const dup = items.find((x) => x.text === entry.text)
      if (dup) return { ok: true, message: '✓', updated: dup.id }
      const item = { id: 'm' + (++seq), text: entry.text, tags: entry.tags || [], importance: entry.importance || 0.5, at: Date.now(), chatId: entry.chatId || '' }
      items.push(item)
      return { ok: true, id: item.id }
    },
    update: (id, patch) => {
      const m = items.find((x) => x.id === id)
      if (!m) return { ok: false, message: '没有这条' }
      for (const k of ['text', 'tags', 'importance']) if (patch[k] !== undefined) m[k] = patch[k]
      return { ok: true, item: m }
    },
    remove: (id) => {
      const before = items.length
      const idx = items.findIndex((x) => x.id === id)
      if (idx >= 0) items.splice(idx, 1)
      return { ok: true, removed: before - items.length }
    },
    list: () => items.map((x) => ({ ...x })),
  }
}

// ---- 假 api ----
function makeApi ({ owner = '100', groups = [], guestQuery = true, guestWatch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'price-watch-'))
  const handlers = {}
  const routes = {}
  const commands = []
  const tools = []
  const timers = []
  const sent = []
  const rules = []
  const settings = { enabled: true, guestQuery, guestWatch, whitelistGroups: groups.join(','), memorySync: true, memoryTtlMinutes: 30 }
  const memory = fakeMemory()
  const api = {
    settings: () => ({ ...settings }),
    saveSettings: (patch) => { Object.assign(settings, patch) },
    config: () => ({ ownerQQ: owner, allow: { groups: groups.map((g) => String(g).replace('group:', '')) }, enabled: true, dryRun: false, memory: { enabled: true } }),
    dataDir: (...parts) => (parts.length ? join(dir, ...parts) : dir),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); return () => {} },
    route: (path, fn) => { routes[path] = fn },
    command: (c) => { commands.push(c) },
    tool: (builder) => { tools.push(builder) },
    rule: (fn) => { rules.push(fn) },
    every: (ms, fn) => { timers.push({ ms, fn }); return () => {} },
    later: () => () => {},
    isOwner: (uid) => String(uid) === String(owner),
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true } },
    reply: async (msg, text) => { sent.push({ chatId: msg.chatId, text }); return { ok: true } },
    defineTool: (t) => t,
    onDispose: () => {},
    use: (id) => (id === 'memory' ? memory : null),
    core: {
      // req.__body 允许测试塞 POST 内容
      http: { body: async (req) => (req && req.__body) || {}, query: (req) => Object.fromEntries(new URL('http://x' + String(req && req.url || '/'), 'http://x').searchParams), send: () => {} },
      hub: { turnHasOwner: () => true },
      onebot: { state: 'connected' },
    },
  }
  return { api, handlers, routes, commands, tools, timers, sent, rules, settings, memory, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const realFetch = globalThis.fetch

test('模块元信息', () => {
  assert.equal(def.id, 'price-watch')
  assert.equal(def.api, 1)
  assert.ok(def.settings.some((s) => s.key === 'enabled'), 'qq-hub 版用标准 enabled 开关')
  assert.equal(def.defaults.enabled, true)
})

test('注册了命令 / 路由 / 定时器 / 工具 / 规则', () => {
  const { api, commands, routes, timers, tools, rules, cleanup } = makeApi()
  try {
    def.setup(api)
    const names = commands.map((c) => c.name)
    for (const n of ['价格监控帮助', '监控价格', '查询价格', '价格列表', '取消监控', '价格记忆', '忘掉价格']) assert.ok(names.includes(n), '缺少命令 ' + n)
    for (const p of ['/state', '/search', '/add', '/remove', '/check', '/memory']) assert.equal(typeof routes[p], 'function', '缺少路由 ' + p)
    assert.equal(timers.length, 1, '一个 60 秒定时器')
    assert.equal(timers[0].ms, 60000)
    assert.equal(tools.length, 1, '工具工厂')
    const list = tools[0]({ chat: { chatId: 'private:100', kind: 'private', userId: '100' } })
    assert.equal(list.length, 4)
    assert.deepEqual(list.map((t) => t.name), ['price_query', 'price_watch_add', 'price_watch_list', 'price_watch_check'])
    assert.ok(rules.length >= 1, '至少一条 rule')
  } finally { cleanup() }
})

test('查价 → 记录最低 → 写记忆 → 到期清理', async () => {
  const { api, routes, memory, cleanup } = makeApi()
  globalThis.fetch = async () => smzdmRows([row({ title: '拓竹 A1 3D打印机 899元', price: '899元' })])
  try {
    const mod = def.setup(api)
    const body = await routes['/search']({ method: 'POST', url: '/search', headers: {}, __body: { query: '拓竹 A1' } })
    assert.equal(body.ok, true)
    assert.match(body.message, /拓竹 A1/)
    assert.equal(memory.items.length, 1, '查到的价格写了一条记忆')
    assert.match(memory.items[0].text, /价格：拓竹 A1/)
    assert.equal(memory.items[0].tags.includes('价格监控'), true)
    assert.ok(body.memory && body.memory.ok, '返回里带记忆结果')

    // 到期清理：把活状态里的过期时间拨到过去（state() 返回的就是内存里的 records），
    // 跑一轮手动检查应删掉记忆、摘掉本地指向
    const recs = mod.state().records
    const key = Object.keys(recs)[0]
    assert.ok(key, '本地记录里有这条商品的指纹')
    recs[key].memoryExpiresAt = Date.now() - 60000
    globalThis.fetch = async () => { throw new Error('offline') }
    await mod.check()
    assert.equal(memory.items.length, 0, '过期价格记忆被清掉')
    assert.equal(recs[key].memoryId, undefined, '本地指向也摘掉了')
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('加监控 → 降价提醒（带 @）→ 冷却内不重发', async () => {
  const { api, commands, sent, cleanup } = makeApi({ owner: '100', groups: ['88888'] })
  let price = '899元'
  let articleId = 1000
  globalThis.fetch = async () => smzdmRows([row({ title: '拓竹 A1 3D打印机 899元', price, id: articleId })])
  try {
    const mod = def.setup(api)
    const cmdWatch = commands.find((c) => c.name === '监控价格')
    const added = await cmdWatch.run('拓竹 A1', { chatId: 'group:88888', userId: '100' })
    assert.match(added, /开始监控/)
    assert.equal(sent.length, 0, '加监控回执由宿主发（命令返回值），模块自己不发')

    // setup 的返回值就是模块导出：check() 是手动「立即检查全部」
    price = '799元'
    articleId = 1001 // 同款商品的新爆料，标题指纹一致
    globalThis.fetch = async () => smzdmRows([row({ title: '拓竹 A1 3D打印机 899元', price, id: articleId })])
    assert.equal(typeof mod.check, 'function', 'setup 返回 check()')
    const checked = await mod.check()
    assert.equal(checked.ok, true)
    assert.equal(checked.checked, 1)
    assert.equal(checked.alerts, 1, '降价 100 元应提醒')
    const alertMsg = sent[sent.length - 1]
    assert.match(alertMsg.text, /【价格提醒】/)
    assert.match(alertMsg.text, /¥799/)
    assert.match(alertMsg.text, /<at:100>/, '提醒 @ 发起人')
    assert.equal(alertMsg.chatId, 'group:88888')

    // 同价再查：没有新的降价，也不该有新提醒
    const again = await mod.check()
    assert.equal(again.alerts, 0, '同价不重发')

    // 再降一点（仍在冷却内）：提示被冷却挡住
    price = '789元'
    articleId = 1002
    globalThis.fetch = async () => smzdmRows([row({ title: '拓竹 A1 3D打印机 899元', price, id: articleId })])
    const third = await mod.check()
    assert.equal(third.alerts, 0, '冷却期内不重发')
    assert.equal(sent.length, 1, '只有一条降价提醒')
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('群友命令被接管；白名单外的群被拒', async () => {
  const { api, handlers, sent, cleanup } = makeApi({ owner: '100', groups: ['88888'], guestQuery: true })
  globalThis.fetch = async () => smzdmRows([row({ title: '红米 K80 Pro 2999元', price: '2999元' })])
  try {
    def.setup(api)
    const hook = handlers.message[0]
    assert.equal(typeof hook, 'function')
    // 白名单外的群：接管并提示
    const handled = await hook({ chatId: 'group:99999', groupId: '999', userId: '200', text: '/查询价格 红米K80', nickname: '路人' })
    assert.equal(handled, true)
    assert.match(sent[sent.length - 1].text, /白名单/)
    // 白名单内：真查
    const ok = await hook({ chatId: 'group:88888', groupId: '88888', userId: '200', text: '/查询价格 红米 K80 Pro', nickname: '路人' })
    assert.equal(ok, true)
    assert.match(sent[sent.length - 1].text, /红米 K80 Pro/)
    // 非命令消息不接管
    assert.equal(await hook({ chatId: 'group:88888', groupId: '88888', userId: '200', text: '今天天气不错' }), false)
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('guestQuery 关闭时群友查价被拒', async () => {
  const { api, handlers, sent, cleanup } = makeApi({ owner: '100', groups: ['88888'], guestQuery: false })
  globalThis.fetch = async () => smzdmRows([row()])
  try {
    def.setup(api)
    const hook = handlers.message[0]
    const handled = await hook({ chatId: 'group:88888', groupId: '88888', userId: '200', text: '/查询价格 红米K80', nickname: '路人' })
    assert.equal(handled, true)
    assert.match(sent[sent.length - 1].text, /只有主人/)
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('价格记忆命令：列表与删除', async () => {
  const { api, routes, commands, memory, cleanup } = makeApi()
  globalThis.fetch = async () => smzdmRows([row({ title: '索尼 WH-1000XM5 耳机 1999元', price: '1999元' })])
  try {
    def.setup(api)
    await routes['/search']({ method: 'POST', url: '/search', headers: {}, __body: { query: '索尼 WH-1000XM5' } })
    assert.equal(memory.items.length, 1)
    const cmdMem = commands.find((c) => c.name === '价格记忆')
    const text = await cmdMem.run('', { chatId: 'private:100', userId: '100' })
    assert.match(text, /记忆里存了 1 条价格/)
    const cmdForget = commands.find((c) => c.name === '忘掉价格')
    const forgotten = await cmdForget.run('', { chatId: 'private:100', userId: '100' })
    assert.match(forgotten, /清掉 1 条/)
    assert.equal(memory.items.length, 0)
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('parseGroupIds 只认纯数字群号', () => {
  assert.deepEqual([...parseGroupIds('123456, abc\n7890123')], ['123456', '7890123'])
  assert.deepEqual([...parseGroupIds('')], [])
})
