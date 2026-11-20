// 共享浏览器适配层：锁住 renderPage 契约（tieba.mjs 消费的字段）。
// 全部用假 service，不真起浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBrowserReader, parseCookieString, COOKIE_NAMES, TIEBA_HOSTS } from './shared-browser.mjs';

function fakeLease(overrides = {}) {
  const state = { cookies: [], cleared: 0, pages: [], html: '<html><body>贴吧页面</body></html>' }
  return {
    state,
    goto: async (url) => { state.pages.push(url) },
    content: async () => ({ html: state.html, url: state.pages.at(-1) || '', title: '百度贴吧' }),
    setCookies: async (list) => { state.cookies.push(...list) },
    clearCookies: async () => { state.cleared++; state.cookies = [] },
    evaluate: overrides.evaluate || (async () => ({})),
    release() {},
    ...overrides,
  }
}

function fakeService() {
  const leases = []
  return {
    leases,
    acquire: async (id) => { const l = fakeLease(); leases.push({ id, lease: l }); return l },
  }
}

test('renderPage(home) 返回 { html, url, title } —— tieba.mjs parseHome 吃这个', async () => {
  const svc = fakeService()
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => '' })
  const page = await reader.renderPage('https://tieba.baidu.com/', 'home')
  assert.equal(typeof page.html, 'string')
  assert.ok(page.html.includes('贴吧页面'))
  assert.equal(page.title, '百度贴吧')
  assert.match(page.url, /^https:\/\/tieba\.baidu\.com/)
})

test('read/search/browse 也走同一契约', async () => {
  const reader = createSharedBrowserReader({ service: fakeService(), getCookie: () => '' })
  for (const [url, kind] of [
    ['https://tieba.baidu.com/p/123', 'read'],
    ['https://tieba.baidu.com/f/search/res?ie=utf-8&qw=x', 'search'],
    ['https://tieba.baidu.com/f?kw=x', 'browse'],
  ]) {
    const page = await reader.renderPage(url, kind)
    assert.equal(typeof page.html, 'string', kind)
  }
})

test('配置了 Cookie 就会写进浏览器，只留白名单名字', async () => {
  const svc = fakeService()
  const raw = 'BDUSS=abc123; STOKEN=t9; JUNK=bad; BDUSS2=x; PSTM=1'
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => raw })
  await reader.renderPage('https://tieba.baidu.com/', 'home')
  const lease = svc.leases[0].lease
  const names = lease.state.cookies.map((c) => c.name)
  assert.deepEqual(names.sort(), ['BDUSS', 'PSTM', 'STOKEN'].sort())
  assert.ok(lease.state.cookies.every((c) => c.domain === '.baidu.com'))
})

test('没配 Cookie 不写 Cookie（匿名读）', async () => {
  const svc = fakeService()
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => '' })
  await reader.renderPage('https://tieba.baidu.com/', 'home')
  assert.equal(svc.leases[0].lease.state.cookies.length, 0)
})

test('换 Cookie 会先清旧会话（不能带别人的登录态）', async () => {
  const svc = fakeService()
  let round = 0
  const reader = createSharedBrowserReader({
    service: svc,
    getCookie: () => (round++ === 0 ? 'BDUSS=old' : 'BDUSS=new'),
    timing: { pollMs: 10, loginTimeoutMs: 300 }, // 有 timing 才不会等真机的 10 分钟轮询
  })
  await reader.renderPage('https://tieba.baidu.com/', 'home')
  // login 流程里 resetSession = clearCookies + 写入
  await reader.renderPage('https://tieba.baidu.com/', 'login')
  const lease = svc.leases.at(-1).lease
  assert.ok(lease.state.cleared >= 1, 'login 前要先清')
  assert.equal(lease.state.cookies.at(-1).value, 'new')
})

test('login：页面报登录成功 → 返回 { loggedIn:true, name }', async () => {
  const svc = fakeService()
  let n = 0
  const lease = {
    goto: async () => {}, setCookies: async () => {}, clearCookies: async () => {}, content: async () => ({ html: '', url: '', title: '' }),
    evaluate: async () => (++n >= 2 ? { loggedIn: true, name: '小贴' } : {}),
    release() {},
  }
  svc.acquire = async () => lease
  // 缩短轮询：直接把时间推进交给 evaluate 计数
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => '', timing: { pollMs: 10, loginTimeoutMs: 5000 } })
  const r = await Promise.race([
    reader.renderPage('https://tieba.baidu.com/', 'login'),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 15000)),
  ])
  assert.equal(r.timeout, undefined, '10 分钟轮询太长，登录成功应立即返回')
  assert.equal(r.loggedIn, true)
  assert.equal(r.name, '小贴')
})

test('login 进行中，别的读操作要被挡住', async () => {
  const svc = fakeService()
  let releaseGate
  const gate = new Promise((r) => { releaseGate = r })
  svc.acquire = async () => ({ goto: async () => {}, setCookies: async () => {}, clearCookies: async () => {},
    content: async () => ({ html: '', url: '', title: '' }),
    evaluate: async () => { await gate; return { loggedIn: true, name: 'x' } }, release() {} })
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => '', timing: { pollMs: 10, loginTimeoutMs: 5000 } })
  const loginPromise = reader.renderPage('https://tieba.baidu.com/', 'login')
  await new Promise((r) => setTimeout(r, 100)) // 让 loginPending 置位
  await assert.rejects(() => reader.renderPage('https://tieba.baidu.com/', 'read'), /登录窗口仍然打开/)
  releaseGate()
  await loginPromise
})

test('status / openLogin / recordAccount 的形状', async () => {
  // openLogin 里 renderPage('login') 是故意 fire-and-forget 的（面板立刻要返回值），
  // 注入小超时让它自己收尾，别让进程里悬着一个无主 Promise。
  const reader = createSharedBrowserReader({
    service: fakeService(),
    getCookie: () => '',
    timing: { pollMs: 10, loginTimeoutMs: 300 },
  })
  const st = reader.status()
  assert.equal(st.available, true)
  assert.equal(st.loginPending, false)
  const r = reader.openLogin()
  assert.equal(r.ok, true)
  reader.recordAccount({ loggedIn: true, name: 'x' })
  assert.equal(reader.status().account.loggedIn, true)
  // 等 fire-and-forget 的登录轮询自然结束（300ms 超时 + 余量）
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(reader.status().loginPending, false, '超时后应退出登录流程')
})

test('reader 本身可调用 —— tieba.mjs 的契约是 renderPage(url,kind) 直接调（旧 Electron 就是函数）', async () => {
  const svc = fakeService()
  const reader = createSharedBrowserReader({ service: svc, getCookie: () => '' })
  assert.equal(typeof reader, 'function', 'reader 必须是函数，否则 tieba.mjs 里 renderPage(url, kind) 会 TypeError')
  const page = await reader('https://tieba.baidu.com/', 'home')
  assert.ok(page.html.includes('贴吧页面'))
})

test('cookie 解析：只留白名单名字，坏行跳过', () => {
  const out = parseCookieString('BDUSS=a; STOKEN=b; JUNK=c; nodengood;  =empty; BDUSS_BFESS=d', COOKIE_NAMES)
  assert.deepEqual(out.map((x) => x.name).sort(), ['BDUSS', 'BDUSS_BFESS', 'STOKEN'].sort())
})

test('域名白名单常量与宿主 strategies 一致', () => {
  assert.deepEqual(TIEBA_HOSTS, ['tieba.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'baidu.com'])
})
