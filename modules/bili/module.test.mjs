// B站商店模块：清单契约 + 壳级接线（头像 last 解析、截图库路由/工具固定当前会话）。
// 实现（bili/duty.js 等）留在插件包内，这里用假 api 提供 lib 桩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import def from './index.mjs'

test('bili：清单与入口契约', () => {
  assert.equal(def.id, 'bili')
  assert.equal(def.version, '1.1.1')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'bili')
})

function mount({ enabled = true } = {}) {
  const cfg = { bili: { enabled, shotLibrary: 20 }, dryRun: true }
  const routes = new Map()
  const builders = []
  const events = new Map()
  const sent = []
  const avatars = []
  // 截图路由会真实 readFileSync：给一个真实临时文件
  const tmpDir = mkdtempSync(join(tmpdir(), 'bili-shot-'))
  const shotFile = join(tmpDir, 'a.jpg')
  writeFileSync(shotFile, 'preview')
  const fakeBili = {
    tick() {},
    state: () => ({ day: '', runs: 0 }),
    account: async () => ({ nickname: '' }),
    run: async () => ({ ok: true }),
    checkReplies: async () => ({ ok: true }),
    libraryShots: () => ({ items: [{ file: 'a.jpg' }] }),
    shotFileOf: (f) => (f === '../outside' ? null : shotFile),
    deleteShot: () => ({ ok: true }),
    // 真实实现会自查开关（壳里 qq_send_shot 不复查，靠实现兜底）
    sendShot: async ({ chatId }) => (cfg.bili.enabled ? (sent.push(chatId), { sent: true }) : { ok: false, message: 'B站没打开' }),
    listShots: () => ({ ok: true, items: [] }),
    setAvatar: async (file) => { avatars.push(file); return { ok: true, message: `试运行：${file}` } },
    setSign: async () => ({ ok: true }),
  }
  const libs = {
    'bili/duty.js': { createBili: () => fakeBili },
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
  return { cfg, routes, builders, events, sent, avatars }
}

test('bili 壳：头像 last/最近图片/网址解析，权限与开关在壳内复查', async () => {
  const { builders, events, avatars } = mount()
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
  assert.deepEqual(avatars.slice(-1), ['https://image.example/explicit.png'])
})

test('bili 壳：截图库路由与 qq_send_shot 固定当前会话，关闭后隐藏', async () => {
  const { routes, builders, sent, cfg } = mount()
  const list = await routes.get('/bili/shots')()
  assert.deepEqual(list.items, [{ file: 'a.jpg' }])
  assert.equal(list.limit, 20)
  const image = await routes.get('/bili/shot/image')({ query: { file: 'a.jpg' } }, {})
  assert.equal(image.status, 200)
  assert.equal(image.type, 'image/jpeg')
  assert.equal(image.body.toString(), 'preview')
  assert.equal((await routes.get('/bili/shot/image')({ query: { file: '../outside' } }, {})).status, 404)
  const tools = builders[0]({ chat: { kind: 'group', chatId: 'group:123' } })
  const tool = tools.find((t) => t.name === 'qq_send_shot')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['query'])
  assert.equal((await tool.execute({})).sent, true)
  assert.deepEqual(sent, ['group:123'])
  cfg.bili.enabled = false
  assert.deepEqual(builders[0]({ chat: { kind: 'private' } }), [], '关闭后不挂工具')
  assert.equal((await tool.execute({})).ok, false, '旧工具也复查开关')
})
