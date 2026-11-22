// B 站接口层（api.mjs）：WBI 签名、Cookie / 链接解析、playurl、发评论、改签名、换头像。
// 全部用假 fetch，不连外网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UA, parseCookie, wbiSign, findVideoId, sniffImageType, createBiliApi,
} from './api.mjs'

test('WBI 签名和文档里的例子一致', () => {
  const q = wbiSign({ foo: '114', bar: '514', zab: 1919810 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169 * 1000)
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('解析：Cookie 只取有用的；认出视频号、av 号、短链', () => {
  assert.deepEqual(parseCookie('SESSDATA=abc; bili_jct=x1; foo=bar; buvid3=b3'), { SESSDATA: 'abc', bili_jct: 'x1', buvid3: 'b3' })
  assert.deepEqual(findVideoId('看这个 https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), { bvid: 'BV1GJ411x7h7' })
  assert.deepEqual(findVideoId('av170001'), { aid: '170001' })
  assert.deepEqual(findVideoId('https://b23.tv/abc123 哈哈'), { short: 'https://b23.tv/abc123' })
  assert.equal(findVideoId('没有链接'), null)
})

test('playurl：WBI 签名一次要全格式，DASH 和 durl 都带出来', async () => {
  let request
  const client = createBiliApi({ getCookie: () => 'buvid3=test', fetchImpl: async (url) => {
    if (url.includes('/nav')) {
      return { json: async () => ({ data: { wbi_img: { img_url: 'https://i.example/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png' } } }) }
    }
    request = new URL(url)
    return { json: async () => ({ code: 0, data: {
      dash: {
        video: [{ base_url: 'https://cdn.example/1', codecs: 'avc1', height: 480 }, { baseUrl: 'https://cdn.example/2' }, {}],
        audio: [{ baseUrl: 'https://cdn.example/audio' }],
      },
      durl: [{ order: 1, url: 'https://cdn.example/p1.mp4', length: 60000, size: 123 }, { order: 2, url: '' }],
    } }) }
  } })
  const r = await client.playurl({ bvid: 'BV1aaaaaaaaa', cid: 9 })
  assert.equal(request.pathname, '/x/player/wbi/playurl')
  assert.equal(request.searchParams.get('fnval'), '4048', '要全格式，不然拿不到 DASH')
  assert.equal(request.searchParams.get('fourk'), '1')
  assert.equal(request.searchParams.get('cid'), '9')
  assert.equal(request.searchParams.get('bvid'), 'BV1aaaaaaaaa')
  assert.match(request.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
  assert.equal(r.video.length, 2)
  assert.equal(r.video[0].baseUrl, 'https://cdn.example/1')
  assert.equal(r.audio.length, 1)
  assert.deepEqual(r.durl, [{ order: 1, url: 'https://cdn.example/p1.mp4', length: 60000, size: 123 }], 'durl 作为没有 DASH 时的回退，空地址过滤掉')
})

test('B 站返回非 0 时抛错并带 code（风控判定靠它）', async () => {
  const client = createBiliApi({ getCookie: () => '', fetchImpl: async () => ({ json: async () => ({ code: -352, message: '风控校验失败' }) }) })
  await assert.rejects(client.popular({ ps: 1 }), (error) => {
    assert.equal(error.code, -352)
    assert.match(error.message, /-352/)
    return true
  })
})

test('改签名：发对接口和 csrf；没登录直接拒', async () => {
  const reqs = []
  const real = createBiliApi({ getCookie: () => 'SESSDATA=x; bili_jct=tok', log: { debug() {}, warn() {} }, fetchImpl: async (url, o) => { reqs.push({ url, ...o }); return { status: 200, json: async () => ({ code: 0, data: {} }) } } })
  await real.setSign('今天也很开心')
  assert.equal(reqs[0].url, 'https://api.bilibili.com/x/member/web/sign/update')
  assert.equal(reqs[0].method, 'POST')
  const form = new URLSearchParams(reqs[0].body)
  assert.equal(form.get('user_sign'), '今天也很开心')
  assert.equal(form.get('csrf'), 'tok')
  assert.match(reqs[0].headers['user-agent'], new RegExp(UA.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await assert.rejects(createBiliApi({ getCookie: () => '', log: {} }).setSign('x'), /没登录/)
})

test('换头像：先下载图片再 multipart 上传；超 2MB / 非图片 / 没登录都不发', async () => {
  const reqs = []
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const mk = (img) => async (url, o = {}) => {
    reqs.push({ url, ...o })
    if (/^https:\/\/(img\.example|multimedia\.nt\.qq\.com)\//.test(url)) return { ok: true, status: 200, headers: { get: () => img.type }, arrayBuffer: async () => img.buf }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }
  }
  const real = createBiliApi({ getCookie: () => 'SESSDATA=x; bili_jct=tok', log: { debug() {}, warn() {} }, fetchImpl: mk({ type: 'image/png', buf: png.buffer }) })
  await real.setFace('https://img.example/a.png')
  const up = reqs[1]
  assert.equal(up.url, 'https://api.bilibili.com/x/member/web/face/update?csrf=tok')
  assert.equal(up.method, 'POST')
  assert.ok(up.body instanceof FormData)
  assert.equal(up.body.get('dopost'), 'save')
  assert.equal(up.body.get('face').size, png.length)
  assert.equal(up.body.get('face').type, 'image/png')

  const big = createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'image/jpeg', buf: new ArrayBuffer(2 * 1024 * 1024 + 1) }) })
  await assert.rejects(big.setFace('https://img.example/b.jpg'), /2MB/)
  const html = createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'text/html', buf: new TextEncoder().encode('<html>hi</html>').buffer }) })
  await assert.rejects(html.setFace('https://img.example/c'), /不是图片/)
  // QQ 图床常回 application/octet-stream：按 PNG/JPEG/GIF/WebP 文件头认
  const qq = createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'application/octet-stream', buf: png.buffer }) })
  reqs.length = 0
  await qq.setFace('https://multimedia.nt.qq.com/v1/foo')
  assert.equal(reqs[1].body.get('face').type, 'image/png')
  await assert.rejects(createBiliApi({ getCookie: () => '', log: {} }).setFace('https://img.example/a.png'), /没登录/)
})

test('图片类型按文件头识别', () => {
  assert.equal(sniffImageType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png')
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x01])), 'image/jpeg')
  assert.equal(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  assert.equal(sniffImageType(new Uint8Array([1, 2, 3])), '')
})
