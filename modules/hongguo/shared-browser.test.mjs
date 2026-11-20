// 红果 → 共享浏览器适配层：锁住上游 lib/browser.mjs 的对象形状。
// 全部假 service，不真起浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedBrowserAdapter, HONGGUO_HOSTS } from './shared-browser.mjs';

function fakeLease(state = { cookies: [] }) {
  return {
    state,
    goto: async (url) => { state.lastUrl = url },
    content: async () => ({ html: '<html>红果</html>', url: state.lastUrl || '', title: '红果短剧' }),
    evaluate: async () => ({}),
    waitFor: async () => ({ x: 1, y: 2 }),
    setCookies: async (list) => { state.cookies.push(...list) },
    clearCookies: async () => {},
    cookies: async (urls) => {
      // 模拟宿主 lease：按 URL 域名过滤
      const hosts = (urls || []).map((u) => { try { return new URL(u).hostname.replace(/^\./, '') } catch { return '' } })
      return state.cookies.filter((c) => hosts.some((h) => String(c.domain).replace(/^\./, '').endsWith(h)))
    },
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

test('适配器形状 = 上游 lib/browser.mjs 的返回（hongguo 没有 setFiles）', () => {
  const a = createSharedBrowserAdapter({ service: fakeService(), fallback: noFallback, log: undefined })
  for (const k of ['open', 'connected', 'evaluate', 'goto', 'waitFor', 'click', 'press', 'type', 'clearFocused', 'pressEnter', 'waitResponse', 'screenshot', 'show', 'close', 'cookies']) {
    assert.equal(typeof a[k], 'function', `缺 ${k}`)
  }
  assert.equal(a.setFiles, undefined, 'hongguo 上游没有 setFiles，别多给')
})

test('open(source, canStart)：开关关着时不启动', async () => {
  let touched = false
  const svc = { acquire: async () => { touched = true; return fakeLease() } }
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback })
  const blocked = await a.open('定时', () => false)
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /红果没打开/)
  assert.equal(touched, false)
})

test('close 是还租约（closeAfterRun 的省内存目标由宿主空闲超时达成）', async () => {
  const svc = fakeService()
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback })
  await a.open()
  const lease = svc.leases[0].lease
  a.close()
  assert.equal(lease.state.released, 1)
  a.close()
  assert.equal(lease.state.released, 1, '幂等')
})

test('cookies：上游传域名数组 → 转 URL 走 lease → 过滤回来', async () => {
  const lease = fakeLease({ cookies: [
    { name: 'sessionid', domain: '.hongguoduanju.com' },
    { name: 'BDUSS', domain: '.baidu.com' },
  ] })
  const svc = fakeService(lease)
  const a = createSharedBrowserAdapter({ service: svc, fallback: noFallback })
  await a.open()
  const got = await a.cookies(['hongguoduanju.com'])
  assert.deepEqual(got.map((c) => c.name), ['sessionid'])
})

test('老宿主（service=null）走 fallback', () => {
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
  assert.deepEqual(HONGGUO_HOSTS, ['hongguoduanju.com', 'hongguo.com', 'hgsnss.com'])
})