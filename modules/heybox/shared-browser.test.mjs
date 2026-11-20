// 小黑盒 → 共享浏览器适配层：锁住上游 browser 连接对象的形状。
// 全部假 service，不真起浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBrowserAdapter, HEYBOX_HOSTS } from './shared-browser.mjs';

function fakeLease(state = { cookies: [] }) {
  return {
    state,
    goto: async (url) => { state.lastUrl = url },
    evaluate: async () => '',
    waitFor: async () => ({ x: 1, y: 2 }),
    setCookies: async (list) => { state.setCookies = list },
    cookies: async () => state.cookies,
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

test('适配器形状 = 上游 browser 连接对象（verify/qr/webpost 用到的全都有）', () => {
  const a = createSharedBrowserAdapter({ service: fakeService(), fallback: noFallback })
  for (const k of ['open', 'connected', 'evaluate', 'goto', 'waitFor', 'setCookies', 'cookies', 'screenshot', 'show', 'close']) {
    assert.equal(typeof a[k], 'function', `缺 ${k}`)
  }
})

test('open 拿的是 heybox 的租约；close 还租约且幂等', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback })
  await a.open()
  assert.equal(svc.leases[0].id, 'heybox')
  const lease = svc.leases[0].lease
  a.close()
  assert.equal(lease.state.released, 1)
  a.close()
  assert.equal(lease.state.released, 1, '幂等')
})

test('cookies() 无参 = 全量（verify.mjs 要自己按 xiaoheihe.cn 域过滤）', async () => {
  const a = createSharedBrowserAdapter({ service: fakeService(fakeLease({ cookies: [
    { name: 'pkey', domain: '.xiaoheihe.cn' },
    { name: 'BDUSS', domain: '.baidu.com' },
  ] })), fallback: noFallback })
  await a.open()
  const got = await a.cookies()
  assert.equal(got.length, 2, '不做域过滤——过滤是 verify.mjs 自己的事')
})

test('setCookies 透传（qr 的 fetchWebToken 用）', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback })
  await a.open()
  await a.setCookies([{ name: 'pkey', value: 'v' }])
  assert.deepEqual(svc.leases[0].lease.state.setCookies, [{ name: 'pkey', value: 'v' }])
})

test('老宿主（service=null）走 fallback，行为与原版一致', () => {
  let used = false
  const sentinel = { open: async () => ({ ok: true }), connected: () => false }
  const a = createSharedBrowserAdapter({
    service: null,
    fallback: () => { used = true; return sentinel },
  })
  assert.equal(used, true)
  assert.equal(a.connected(), false)
})

test('域名白名单常量', () => {
  assert.deepEqual(HEYBOX_HOSTS, ['xiaoheihe.cn'])
})
