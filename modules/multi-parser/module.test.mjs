import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import def, { allowedHere } from './index.mjs'

test('multi-parser：清单与入口契约', () => {
  assert.equal(def.id, 'multi-parser')
  assert.equal(def.version, '1.0.1')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.defaults.enabled, false, '默认关闭')
  // 核心开关都在 defaults 里（面板可改）
  for (const key of ['enabled', 'feedToAi', 'muteAi', 'sendMedia', 'forwardMode', 'imageThreshold', 'maxVideoMB', 'videoOverLimit']) {
    assert.ok(key in def.defaults, `defaults 缺 ${key}`)
  }
})

test('multi-parser：allowedHere 三层判定', () => {
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, {}), true, '群默认开')
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, { inGroups: false }), false, '群关掉则连链接都不碰')
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, { disabledGroups: ['555'] }), false, '按群禁用')
  assert.equal(allowedHere({ kind: 'group', groupId: '555' }, { disabledGroups: ['555'] }), false)
  assert.equal(allowedHere({ kind: 'private', chatId: 'private:1' }, {}), true, '私聊默认开')
  assert.equal(allowedHere({ kind: 'private', chatId: 'private:1' }, { inPrivate: false }), false)
  assert.equal(allowedHere({ kind: 'system' }, {}), false, 'system 后台轮次不解析')
})

// 实现（parser/delivery/douyin-media）留在插件包内，用 lib 桩驱动壳
const libStub = {
  'modules/multi-parser/parser.js': { extractUrls: () => [], parseUrl: async () => null },
  'modules/multi-parser/delivery.js': { deliverParseResult: async () => {} },
  'douyin/media.js': { sweepMediaDir: () => ({ removed: 0, bytes: 0 }) },
}

function mount(cfg) {
  let contextProvider = null
  const routes = new Map()
  const mockApi = {
    lib: (k) => libStub[k] || {},
    config: () => cfg,
    settings: () => ({}),
    context: (fn) => { contextProvider = fn },
    on: () => {},
    every() {},
    workspaceDir: () => '',
    route: (path, fn) => routes.set(path, fn),
    log: { info() {}, debug() {}, warn() {} },
    core: { http: { body: async () => ({}) } },
  }
  return { inst: def.setup(mockApi), context: () => contextProvider, routes }
}

test('multi-parser 壳：feedToAi 开关控制上下文注入', async () => {
  const { context } = mount({ multiParser: { enabled: true, feedToAi: true, sendMedia: false } })
  assert.ok(context(), '必须注册 context provider')
  assert.equal(context()({ chat: { chatId: 'group:1' } }), '', '没有解析记录时不注入')
})

test('multi-parser 壳：专属 Cookie 可复用全局 B站/小黑盒 Cookie', async () => {
  const { routes } = mount({
    bili: { cookie: 'SESSDATA=bili_global' },
    heybox: { cookie: 'pkey=heybox_global' },
    multiParser: { enabled: true, feedToAi: true, cookies: { weibo: 'SUB=weibo_sub' } },
  })
  const status = routes.get('/multi-parser/status')
  assert.ok(status)
  const st = await status()
  assert.equal(st.cookieStatus.bilibili, true, 'B站 Cookie 自动复用全局')
  assert.equal(st.cookieStatus.xiaoheihe, true, '小黑盒 Cookie 自动复用全局')
  assert.equal(st.cookieStatus.weibo, true, '微博 Cookie 由专属配置提供')
  assert.equal(st.cookieStatus.zhihu, false, '知乎未配置')
})

test('multi-parser 壳：视频类结果不注入（她看不到画面），muteAi 语义正确', async () => {
  const src = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
  const ctxBlock = src.slice(src.indexOf('api.context('), src.indexOf('// 监听进站消息'))
  assert.ok(/r\.videoUrl/.test(ctxBlock), '注入判断必须检查 videoUrl')
  assert.ok(/r\.type === 'video'/.test(ctxBlock), '也要检查 type')
  const videoBranch = ctxBlock.slice(ctxBlock.indexOf("r.type === 'video'"), ctxBlock.indexOf('const statLine'))
  assert.ok(!/\$\{r\.title\}/.test(videoBranch), '视频分支不能把标题喂给 AI')
  assert.ok(!/内容摘要/.test(videoBranch), '视频分支不能带摘要')

  const m = src.match(/muteAi: (true|false)/)
  assert.ok(m, 'defaults 里必须有 muteAi')
  assert.equal(m[1], 'false', '默认不开启，避免升级后突然不说话了')
  assert.ok(src.includes('if (handledAny && c.muteAi) return true'), '解析成功且 muteAi 才接管')
  assert.ok(src.includes('handledAny = true'), 'handledAny 在解析成功后置真')
  const tail = src.slice(src.indexOf('if (handledAny && c.muteAi) return true'))
  assert.ok(tail.includes('return false'), '关掉 muteAi 时必须 return false')
})
