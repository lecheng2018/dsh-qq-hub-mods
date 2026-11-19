// 注册与路由单测 + 抓取→提炼→拼装全链路：用假的 api 对象和假 fetch，不联网、不发真消息。
// 移植自 aureth-labs/dsh-aurabot-qq-mods ai-brief 的 setup 测试，按 qq-hub 版（无论坛节点）改写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import def from './index.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'aibrief-'))

// ---- 离线环境：默认 fetch 一律报错，个别用例自己临时替换 ----
const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('offline') }

const handlers = {}
const routes = {}
const commands = []
const timers = []
const sent = []

const api = {
  settings: () => ({}),
  config: () => ({ allow: { groups: ['10001'] }, ownerQQ: '1', botQQ: '2' }),
  dataDir: () => dataDir,
  log: { info() {}, warn() {}, debug() {} },
  on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn) },
  route: (path, fn) => { routes[path] = fn },
  command: (c) => { commands.push(c) },
  tool: () => {},
  every: (ms, fn) => { timers.push({ ms, fn }) },
  use: () => null,
  ask: async () => '{"picks":[]}',
  sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  send: async (chatId, text) => { sent.push({ chatId, text }) },
  reply: async (msg, text) => { sent.push({ chatId: msg.chatId, text }) },
  defineTool: (tool) => tool,
  core: { http: { query: (req) => Object.fromEntries(new URL(String(req && req.url || 'http://x/'), 'http://x').searchParams), body: async () => ({}) } },
  lib: () => ({}),
}

def.setup(api)

test('注册了全部 HTTP 路由（qq-hub 版没有论坛路由）', () => {
  for (const p of ['/preview', '/sources', '/send', '/status', '/manual']) {
    assert.equal(typeof routes[p], 'function', '缺少路由 ' + p)
  }
  for (const p of ['/forum/preview', '/forum/send', '/forum/search']) {
    assert.equal(routes[p], undefined, '论坛路由不该存在：' + p)
  }
})

test('注册了命令', () => {
  const names = commands.map((c) => c.name)
  for (const n of ['早报', '晚报']) assert.ok(names.includes(n), '缺少命令 ' + n)
  assert.equal(names.includes('论坛速报'), false, 'qq-hub 版没有论坛速报命令')
})

test('注册了 30 秒定时器', () => {
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 30000)
})

test('状态接口报早报 / 晚报两个节点', async () => {
  const st = await routes['/status']({})
  assert.equal(st.ok, true)
  assert.deepEqual(Object.keys(st.nodes), ['morning', 'evening'])
  assert.equal(st.nodes.morning.time, '09:31')
  assert.equal(st.nodes.evening.time, '21:30')
})

test('消息钩子只接管口令，不拦普通聊天', async () => {
  const hook = handlers.message[0]
  assert.equal(typeof hook, 'function')
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '今天吃啥' }), undefined)
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '早报' }), true)
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '来份晚报' }), true)
})

test('消息钩子发的是当天缓存的同一份简报', async () => {
  const hook = handlers.message[0]
  // 这条用例要真的发出一份简报：临时给 fetch / ask 上 mock，跑完恢复离线
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: [{ target: { type: 'question', id: 7700000000000000777, title: 'AI 芯片新进展' }, card_id: 'Q_7700000000000000777', detail_text: '1' }] }),
    headers: { get: () => 'application/json' },
  })
  api.ask = async () => '{"picks":[]}'
  try {
    sent.length = 0
    // 用例独占一个 chatId：上一个钩子用例已经给 group:10001 记了冷却
    await hook({ chatId: 'group:20002', userId: '2', text: '早报' })
    await hook({ chatId: 'group:20002', userId: '2', text: '再来一份早报' }) // 3 分钟冷却内
    assert.equal(sent.length, 1, '冷却期内不重发')
    assert.match(sent[0].text, /【AI 早报】/)
  } finally {
    globalThis.fetch = async () => { throw new Error('offline') }
    api.ask = async () => '{"picks":[]}'
  }
})

test('抓取→提炼→拼装全链路（mock fetch + mock ask）', async () => {
  // 知乎热榜返回一条；ask 挑第 1 条并给吐槽
  const zhihuBody = {
    data: [
      { target: { type: 'question', id: 1, title: 'DeepSeek 新模型开源了' }, card_id: 'Q_2103486193320949335', detail_text: '500 万热度' },
      { target: { type: 'article', id: 2, title: '不是问题的文章' } },
    ],
  }
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify(zhihuBody), headers: { get: () => 'application/json' } }
  }
  api.ask = async () => JSON.stringify({ picks: [{ id: 1, tag: '模型', comment: '这下有的玩了' }], tomorrow: '看看社区评测' })
  try {
    const r = await routes['/preview']({ url: '/preview?kind=morning' })
    assert.equal(r.ok, true)
    assert.ok(calls.some((u) => u.includes('api.zhihu.com/topstory/hot-lists/total')), '该抓知乎热榜')
    assert.match(r.text, /【AI 早报】/)
    assert.match(r.text, /【模型】DeepSeek 新模型开源了/)
    assert.match(r.text, /这下有的玩了/)
    assert.match(r.text, /2103486193320949335/, '知乎链接要用真实问题 ID')
    assert.equal(r.text.includes('明天可以留意'), false, '「明天留意」只在晚报里')
  } finally {
    globalThis.fetch = async () => { throw new Error('offline') }
    api.ask = async () => '{"picks":[]}'
  }
})

test('ask 挂了也能降级成原始标题清单', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: [{ target: { type: 'question', id: 9000000000000000999, title: '某大厂发布 AI 大模型' }, card_id: 'Q_9000000000000000999', detail_text: '1' }] }),
    headers: { get: () => 'application/json' },
  })
  api.ask = async () => { throw new Error('模型不可用') }
  try {
    const r = await routes['/preview']({ url: '/preview?kind=evening' })
    assert.equal(r.ok, true)
    assert.match(r.text, /【AI 晚报】/)
    assert.match(r.text, /某大厂发布 AI 大模型/)
  } finally {
    globalThis.fetch = async () => { throw new Error('offline') }
    api.ask = async () => '{"picks":[]}'
  }
})
