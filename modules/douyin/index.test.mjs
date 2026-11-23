// 刷抖音模块的接线契约：setup 只用注入的宿主能力，注册工具 / 路由 / 定时器 / 收尾，
// 缺能力时明确报错。不启动浏览器、不连网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import def from './index.mjs'

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { return fallback }
}
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data))

function makeConfig(over = {}) {
  return {
    enabled: true,
    dryRun: false,
    ownerQQ: '10000001',
    botQQ: '10000002',
    ownerName: '主人',
    files: { maxMB: 50 },
    security: { identityGuard: { mode: 'block' } },
    speakUp: { awakeFrom: 8, awakeTo: 23 },
    profilePerms: { douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner' },
    ext: { douyin: {} },
    douyin: {
      enabled: true, autoBrowse: true, intervalHours: 4, maxRunsPerDay: 3, perRun: 5, maxWatchPerDay: 30,
      dwellMin: 8, dwellMax: 40, shareBias: 'proactive', ownerDm: true, dmPollMinutes: 3,
      shareTo: 'douyin', commentReply: false, commentReplyPollMinutes: 5,
      owner: { input: '', secUid: '', uid: '', nickname: '', confirmedInput: '' },
      caps: { like: 30, comment: 3, share: 5, atOwner: 3 },
      gate: { maxWritesPerDay: 40, minWriteGapSec: 20, newAccountDays: 3 },
      ...(over.douyin || {}),
    },
  }
}

function fakeHost({ cfg = makeConfig(), drop = [], noBrowser = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-douyin-index-'))
  const libs = {
    'core/store.js': { dataDir: (...p) => join(dir, ...p), readJson, writeJson },
    'chat/reply.js': { isSilence: (t) => !String(t ?? '').trim() },
    'chat/access.js': { permOf: () => 'owner', profileToolVisible: () => true, profilePermits: () => ({ ok: true }) },
    'chat/identity-guard.js': { guardOutbound: (text, { ids = [] } = {}) => ({ ok: ![...ids].some((id) => String(text || '').includes(String(id))), hits: [] }) },
    'tools/tools.js': { defineTool: (t) => t, str: (description) => ({ type: 'string', description }) },
  }
  for (const path of drop) delete libs[path]
  const state = { tools: [], routes: new Map(), timers: [], disposers: [], sent: [] }
  const api = {
    config: () => cfg,
    settings: () => ({}),
    setConfig: (patch) => { Object.assign(cfg, typeof patch === 'function' ? patch(cfg) : patch) },
    lib: (path) => {
      if (!(path in libs)) throw new Error(`no ${path}`)
      return libs[path]
    },
    core: {
      hub: {
        turnHasOwner: () => true,
        turnSendersAllOwner: () => true,
        sendText: async (chatId, text) => { state.sent.push([chatId, text]); return { message_id: 1 } },
        pushToSession: async () => {},
        runSystemTurn: async () => '',
      },
      http: { body: async () => ({}) },
    },
    lazy: () => ({}),
    log: { info() {}, warn() {}, debug() {} },
    workspaceDir: (...p) => join(dir, 'workspace', ...p),
    every: (ms, fn, name) => { state.timers.push({ ms, fn, name }) },
    tool: (fn) => { state.tools.push(fn) },
    route: (path, handler) => { state.routes.set(path, handler) },
    onDispose: (fn) => { state.disposers.push(fn) },
  }
  if (!noBrowser) api.browser = () => null
  return { api, state }
}

test('接线：注册 7 个工具、8 条面板路由、1 个定时任务和收尾钩子', async () => {
  const { api, state } = fakeHost()
  const dy = await def.setup(api)
  assert.deepEqual(Object.keys(dy).sort(), ['account', 'browse', 'checkCommentReplies', 'checkOwnerDms', 'commentVideo', 'confirmOwner', 'directDm', 'dispose', 'likeVideo', 'loginStep', 'recentVideos', 'run', 'shareVideo', 'showWindow', 'state', 'tick', 'watch'])
  const tools = state.tools[0]({ chat: { chatId: 'private:10000001', kind: 'private', userId: '10000001' }, sessionId: 's1' })
  assert.deepEqual(tools.map((t) => t.name), ['douyin_watch', 'douyin_recent', 'douyin_browse', 'douyin_share_owner', 'douyin_send_dm', 'douyin_like', 'douyin_comment'])
  assert.deepEqual([...state.routes.keys()].sort(), [
    '/douyin/account', '/douyin/confirm-owner', '/douyin/dms', '/douyin/login', '/douyin/login/status',
    '/douyin/run', '/douyin/state', '/douyin/window',
  ])
  assert.equal(state.timers.length, 1)
  assert.equal(state.timers[0].ms, 60_000)
  assert.equal(state.timers[0].name, '刷抖音')
  assert.equal(state.disposers.length, 1)
})

test('接线：抖音关着时不注册工具；系统会话也不注册', async () => {
  const off = fakeHost({ cfg: makeConfig({ douyin: { enabled: false } }) })
  await def.setup(off.api)
  assert.deepEqual(off.state.tools[0]({ chat: { chatId: 'private:1', kind: 'private' }, sessionId: 's' }), [])
  const sys = fakeHost()
  await def.setup(sys.api)
  assert.deepEqual(sys.state.tools[0]({ chat: { chatId: 'system:x', kind: 'system' }, sessionId: 's' }), [])
})

test('接线：面板状态只读文件，不启动浏览器（dispose 之后 run 直接拒绝）', async () => {
  const { api, state } = fakeHost()
  const dy = await def.setup(api)
  const st = await state.routes.get('/douyin/state')()
  assert.equal(st.ok, true)
  assert.equal(st.watched, 0)
  state.disposers[0]()
  const r = await dy.run({ force: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /停用/)
})

test('接线：缺宿主能力时 setup 明确报错，不静默半死', () => {
  const { api } = fakeHost({ drop: ['chat/identity-guard.js'] })
  assert.throws(() => def.setup(api), /identity-guard/)
  const old = fakeHost({ noBrowser: true })
  assert.throws(() => def.setup(old.api), /api\.browser|共享浏览器/)
})
