// B站商店模块：清单契约 + 模块级接线（api.lib 注入、头像 last 解析、截图库路由/工具、单独选模型的 model 事件）。
// 实现是本模块自带的 api.mjs / duty.mjs / vision.mjs / shots.mjs；插件只提供通用能力，这里用假 api 提供 lib 桩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import def from './index.mjs'

test('bili：清单与入口契约', () => {
  assert.equal(def.id, 'bili')
  assert.equal(def.version, '1.2.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'bili')
})

function mount({ enabled = true, model = { provider: '', model: '', reasoningEffort: '' } } = {}) {
  const cfg = { enabled: true, dryRun: true, ownerQQ: '10000001', bili: { enabled, shotLibrary: 20, shotChance: 0, perRun: 1, model } }
  const routes = new Map()
  const builders = []
  const events = new Map()
  const sent = []
  // 截图库：真临时目录 + 一条合法索引项（路由会真的 readFileSync）
  const root = mkdtempSync(join(tmpdir(), 'bili-module-'))
  const shotsDir = join(root, 'bili-shots')
  mkdirSync(shotsDir, { recursive: true })
  const shotFile = 'aaaaaaaaaaaa.jpg'
  writeFileSync(join(shotsDir, shotFile), 'preview')
  writeFileSync(join(shotsDir, 'index.json'), JSON.stringify({ items: [{ file: shotFile, md5: 'aaaaaaaaaaaa', at: 1, bytes: 7, bvid: 'BV1', title: '测试视频', sec: 65, note: '' }] }))
  const store = {
    dataDir: (...parts) => join(root, ...parts),
    ensureDir: (p) => mkdirSync(p, { recursive: true }),
    existsSync: () => true,
    readJson: (p, fallback) => {
      try { return JSON.parse(readFileSync(p, 'utf8')) } catch (error) { return typeof fallback === 'function' ? fallback() : fallback }
    },
    writeJson: (p, value) => writeFileSync(p, JSON.stringify(value)),
  }
  const libs = {
    'core/store.js': store,
    'core/llm.js': { askModel: async () => '', canSeeImages: async () => true, modelVision: async () => null },
    'core/img.js': { findFfmpeg: () => '' },
    'core/net.js': { assertPublicUrl: async () => {} },
    'chat/reply.js': { isSilence: (t) => /^\s*\[沉默\]\s*$/.test(String(t || '')) },
    'chat/identity-guard.js': { guardOutbound: () => ({ ok: true, hits: [], message: '' }) },
    // 与主仓 defineTool 同形：{name, description, parameters:{type:'object', properties, required}, execute}
    'tools/tools.js': {
      defineTool: (t) => ({ name: t.name, description: t.description, parameters: { type: 'object', properties: t.properties || {}, required: t.required || [] }, execute: t.execute }),
      str: (d) => ({ type: 'string', description: d }),
    },
    'chat/access.js': { profileToolVisible: () => true, profilePermits: () => ({ ok: true }) },
    // 与主仓 profile.avatarSource 同语义（纯函数）：只收 http(s)
    'modules/profile/index.js': { avatarSource: (s) => (/^https?:\/\//i.test(String(s || '').trim()) ? { ok: true, file: String(s).trim() } : { ok: false, message: '头像只能用网址图片' }) },
  }
  const api = {
    lib: (k) => libs[k] || {},
    config: () => cfg,
    lazy: () => null,
    log: { info() {}, warn() {}, debug() {} },
    on: (kind, fn) => events.set(kind, fn),
    every() {},
    tool: (build) => builders.push(build),
    route: (path, handler) => routes.set(path, handler),
    core: {
      hub: { sendImage: async (chatId, src) => { sent.push({ chatId, src }); return { message_id: 1 } }, turnHasOwner: () => true, turnSendersAllOwner: () => true, chatOfSession: () => '' },
      http: { query: (req) => req.query, body: async (req) => req.body, send: (_res, status, body, type) => ({ status, body, type }) },
    },
  }
  def.setup(api)
  return { cfg, routes, builders, events, sent, root, shotFile }
}

test('bili 模块：头像 last/最近图片/网址解析，权限与开关在模块内复查', async () => {
  const { builders, events } = mount()
  const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
  const tools = builders[1]({ chat, sessionId: 'owner' })
  const avatar = tools.find((t) => t.name === 'bili_set_avatar')
  assert.ok(avatar)
  assert.match((await avatar.execute({ image: 'last' })).message, /还没人发过/)
  events.get('message')({ chatId: chat.chatId, images: [{ data: { url: 'https://image.example/owner.png' } }] })
  for (const image of ['last', '刚才那张图', '最近的图片']) {
    const r = await avatar.execute({ image })
    assert.equal(r.ok, true, r.message)
    assert.match(r.message, /https:\/\/image\.example\/owner\.png/)
  }
  const explicit = await avatar.execute({ image: 'https://image.example/explicit.png' })
  assert.match(explicit.message, /explicit\.png/)
})

test('bili 模块：截图库路由与 qq_send_shot 固定当前会话，关闭后隐藏', async () => {
  const { routes, builders, sent, cfg, shotFile } = mount()
  const list = await routes.get('/bili/shots')()
  assert.deepEqual(list.items.map((i) => i.file), [shotFile])
  assert.equal(list.limit, 20)
  const image = await routes.get('/bili/shot/image')({ query: { file: shotFile } }, {})
  assert.equal(image.status, 200)
  assert.equal(image.type, 'image/jpeg')
  assert.equal(image.body.toString(), 'preview')
  assert.equal((await routes.get('/bili/shot/image')({ query: { file: '../outside' } }, {})).status, 404)
  const tools = builders[0]({ chat: { kind: 'group', chatId: 'group:123' } })
  const tool = tools.find((t) => t.name === 'qq_send_shot')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query'])
  assert.equal((await tool.execute({})).ok, true, '库里有一张就能发（试运行不发，但结果照常）')
  assert.equal((await tool.execute({})).sent, false, '试运行不真的发')
  assert.equal(sent.length, 0)
  cfg.bili.enabled = false
  assert.deepEqual(builders[0]({ chat: { kind: 'private' } }), [], '关闭后不挂工具')
  assert.equal((await tool.execute({})).ok, false, '旧工具也复查开关')
})

test('bili 模块：单独选模型只改刷 B 站的后台会话', () => {
  const { events } = mount({ model: { provider: 'fast', model: 'fast-chat', reasoningEffort: 'high' } })
  const hook = events.get('model')
  assert.equal(typeof hook, 'function', '要注册 model 事件')
  const out = hook({ provider: 'main', model: 'main-chat', reasoningEffort: 'low' }, { kind: 'system', chatId: 'system:bili' })
  assert.deepEqual(out, { provider: 'fast', model: 'fast-chat', reasoningEffort: 'high' })
  // 带 scope 的后台会话（system:bili:xxx）也认
  assert.equal(hook(null, { kind: 'system', chatId: 'system:bili:watch' }).provider, 'fast')
  // 聊天 / 别的模块的后台回合一律不管
  assert.equal(hook({ provider: 'main', model: 'main-chat' }, { kind: 'private', chatId: 'private:1' }), undefined)
  assert.equal(hook({ provider: 'main', model: 'main-chat' }, { kind: 'system', chatId: 'system:douyin' }), undefined)
})

test('bili 模块：没选模型时不拦 model 事件（跟随全局）', () => {
  const { events, cfg } = mount()
  const hook = events.get('model')
  assert.equal(hook({ provider: 'main', model: 'main-chat' }, { kind: 'system', chatId: 'system:bili' }), undefined)
  cfg.bili.model = { provider: 'fast', model: 'fast-chat' }
  assert.equal(hook({ provider: 'main', model: 'main-chat' }, { kind: 'system', chatId: 'system:bili' }).model, 'fast-chat')
  cfg.bili.model = { provider: 'fast', model: '' }
  assert.equal(hook({ provider: 'main', model: 'main-chat' }, { kind: 'system', chatId: 'system:bili' }), undefined, '只填一半当没选')
})
