import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 无需任何 globalThis.aurabot 垫片，完全自包含加载
const { default: def } = await import('./index.mjs')
const { createHeybox } = await import('./lib/site.mjs')

test('heybox：清单与入口契约', () => {
  assert.equal(def.id, 'heybox')
  assert.equal(def.version, '1.7.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'heybox')
  // 入口与清单必须同步（MOD-02）
  const manifest = JSON.parse(readFileSync(new URL('./module.json', import.meta.url)))
  assert.equal(def.version, manifest.version)
})

test('heybox：模块 setup 装配契约与注入', () => {
  const routes = new Map()
  const tools = []
  let scheduled = null

  const fakeApi = {
    core: { hub: {}, http: { body: async () => ({}) } },
    config: () => ({
      ownerQQ: '10001',
      botQQ: '20002',
      heybox: { enabled: true, cookie: 'pkey=test-cookie' },
    }),
    lazy: () => null,
    use: () => null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...p) => join('/tmp/hb-test-data', ...p),
    every: (interval, fn, name) => { scheduled = { interval, fn, name } },
    tool: (fn) => { tools.push(...(fn({ chat: { kind: 'private', chatId: 'private:10001' }, sessionId: 's1' }) || [])) },
    route: (path, handler) => { routes.set(path, handler) },
    rule: () => {},
    lib: () => ({
      defineTool: (t) => t,
      str: (d) => ({ type: 'string', description: d }),
      profileToolVisible: () => true,
      profilePermits: () => ({ ok: true }),
      guardOutbound: () => ({ ok: true, hits: [], message: '' }),
    }),
    setConfig: () => {},
  }

  def.setup(fakeApi)

  assert.ok(routes.has('/heybox/state'), '应注册 /heybox/state')
  assert.ok(routes.has('/heybox/topics'), '应注册 /heybox/topics')
  assert.ok(routes.has('/heybox/run'), '应注册 /heybox/run')
  assert.ok(scheduled, '应注册定时逛任务')
  assert.equal(scheduled.name, '刷小黑盒')

  const toolNames = tools.map((t) => t.name)
  assert.ok(toolNames.includes('heybox_feed'), '应有 heybox_feed')
  assert.ok(toolNames.includes('heybox_watch'), '应有 heybox_watch')
  assert.ok(toolNames.includes('heybox_comment'), '应有 heybox_comment')
  assert.ok(toolNames.includes('heybox_post'), '应有 heybox_post')
})

test('出站身份闸（guardOutbound）：小黑盒发帖与评论泄露账号标识时拦截', async () => {
  let guardCalledWith = null
  let guardAllowed = true

  const testDir = mkdtempSync(join(tmpdir(), 'hb-guard-test-'))
  const hb = createHeybox({
    getConfig: () => ({
      ownerQQ: '10001',
      botQQ: '20002',
      heybox: { enabled: true, cookie: 'pkey=valid-cookie' },
    }),
    hub: {},
    memory: null,
    log: null,
    dataDir: (...p) => join(testDir, ...p),
    guardOutbound: (text, { surface }) => {
      guardCalledWith = { text, surface }
      if (!guardAllowed) {
        return { ok: false, hits: ['10001'], message: '包含账号标识' }
      }
      return { ok: true, hits: [], message: '' }
    },
  })

  // 1. guard 判定包含敏感标识时，comment 立即拦截
  guardAllowed = false
  const commentRes = await hb.comment('https://www.xiaoheihe.cn/app/bbs/link/123456', '我的QQ是10001')
  assert.equal(commentRes.ok, false)
  assert.match(commentRes.message, /账号标识/)
  assert.equal(guardCalledWith.surface, '小黑盒评论')

  // 2. guard 判定包含敏感标识时，post 立即拦截
  const postRes = await hb.post({ title: '测试标题', text: '内容包含10001' })
  assert.equal(postRes.ok, false)
  assert.match(postRes.message, /账号标识/)
  assert.equal(guardCalledWith.surface, '小黑盒帖子')
})

test('配图安全：魔数校验与工作区目录限制', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'hb-sec-test-'))
  const workspace = join(testDir, 'workspace')
  const outside = join(testDir, 'outside')

  const hb = createHeybox({
    getConfig: () => ({ workspaceDir: workspace, heybox: {} }),
    dataDir: (...p) => join(testDir, 'data', ...p),
  })

  // 1. 魔数判断
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const textBuffer = Buffer.from('this is not an image at all!')
  assert.equal(hb.isImageBuffer(pngHeader), true, 'PNG 魔数应识别')
  assert.equal(hb.isImageBuffer(textBuffer), false, '普通文本应被拒绝')

  // 2. 目录判断
  assert.equal(hb.imagePathAllowed(join(workspace, 'pic.png')), true, '工作区图片应允许')
  assert.equal(hb.imagePathAllowed(join(testDir, 'data', 'pic.png')), true, '数据目录图片应允许')
  assert.equal(hb.imagePathAllowed(join(outside, 'pic.png')), false, '外部目录图片应拒绝')
  assert.equal(hb.imagePathAllowed('/etc/passwd'), false, '系统敏感文件应拒绝')
})
