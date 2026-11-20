// 小红书 → 共享浏览器适配层：锁住上游 lib/browser.mjs 的对象形状。
// 全部假 service，不真起浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBrowserAdapter, XHS_HOSTS } from './shared-browser.mjs';

function fakeLease(state = { cookies: [] }) {
  return {
    state,
    goto: async (url) => { state.lastUrl = url },
    content: async () => ({ html: '<html>xhs</html>', url: state.lastUrl || '', title: '小红书' }),
    evaluate: async () => ({}),
    waitFor: async () => ({ x: 1, y: 2, left: 0, top: 0, w: 10, h: 10, text: '按钮' }),
    setCookies: async (list) => { state.cookies.push(...list) },
    clearCookies: async () => { state.cleared = (state.cleared || 0) + 1 },
    cookies: async () => state.cookies,
    setFiles: async (sel, files) => { state.files = { sel, files: [...files] }; return true },
    click: async () => {}, press: async () => true, type: async () => {},
    clearFocused: async () => {}, pressEnter: async () => {},
    waitResponse: async () => ({ status: 200 }),
    screenshot: async () => 'data:image/png;base64,x',
    show: async () => ({ ok: false, message: '虚拟屏' }),
    release() { state.released = (state.released || 0) + 1 },
  }
}

function fakeService(lease) {
  const leases = []
  return { leases, acquire: async (id) => { const l = lease || fakeLease(); leases.push({ id, lease: l }); return l } }
}

const noFallback = () => { throw new Error('fallback 不该被调到') }

test('适配器形状 = 上游 lib/browser.mjs 的返回（方法一个不少）', () => {
  const a = createSharedBrowserAdapter({ service: fakeService(), fallback: noFallback, getConfig: () => ({}), getSettings: () => ({}) })
  for (const k of ['open', 'connected', 'evaluate', 'goto', 'waitFor', 'click', 'press', 'type', 'clearFocused', 'pressEnter', 'waitResponse', 'screenshot', 'show', 'close', 'setFiles', 'cookies']) {
    assert.equal(typeof a[k], 'function', `缺 ${k}`)
  }
})

test('open(source, canStart)：开关关着时不启动；开着走 acquire', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback, getConfig: () => ({}), getSettings: () => ({ enabled: false }) })
  const blocked = await a.open('主人要求', () => false)
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /已关闭/)
  assert.equal(svc.leases.length, 0, '被拒就不能碰浏览器')

  const okOpen = await a.open('主人要求', () => true)
  assert.equal(okOpen.ok, true)
  assert.equal(svc.leases[0].id, 'xhs')
})

test('close 是还租约，不是关浏览器（共享层里别的模块可能还要用）', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback, getConfig: () => ({}), getSettings: () => ({}) })
  await a.open()
  const lease = svc.leases[0].lease
  a.close()
  assert.equal(lease.state.released, 1, 'release 要被调')
  a.close() // 幂等
  assert.equal(lease.state.released, 1)
})

test('cookies(domainRe) 按域过滤', async () => {
  const a = createSharedBrowserAdapter({ service: fakeService(fakeLease({ cookies: [
    { name: 'web_session', domain: '.xiaohongshu.com' },
    { name: 'BDUSS', domain: '.baidu.com' },
  ] })), fallback: noFallback, getConfig: () => ({}), getSettings: () => ({}) })
  await a.open()
  const got = await a.cookies(/xiaohongshu\.com/)
  assert.deepEqual(got.map((c) => c.name), ['web_session'])
})

test('setFiles 透传（发帖传图）', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback, getConfig: () => ({}), getSettings: () => ({}) })
  await a.open()
  const ok = await a.setFiles('input[type=file]', ['/tmp/a.jpg', '/tmp/b.jpg'])
  assert.equal(ok, true)
  assert.deepEqual(svc.leases[0].lease.state.files.files, ['/tmp/a.jpg', '/tmp/b.jpg'])
})

test('老宿主（service=null）走 fallback，行为与原版一致', () => {
  let fallbackUsed = false
  const sentinel = { open: async () => ({ ok: true }), connected: () => false }
  const a = createSharedBrowserAdapter({
    service: null,
    fallback: () => { fallbackUsed = true; return sentinel },
    getConfig: () => ({}), getSettings: () => ({}),
  })
  assert.equal(fallbackUsed, true, 'service 为空就该走 fallback')
  assert.equal(a.connected(), false)
})

test('域名白名单常量', () => {
  assert.deepEqual(XHS_HOSTS, ['xiaohongshu.com', 'xhscdn.com', 'xhslink.com'])
})