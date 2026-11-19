// 纯函数单测：不联网、不依赖插件源码。
// 移植自 aureth-labs/dsh-aurabot-qq-mods ai-brief 的 util 测试；qq-hub 版没有论坛节点与 parseCount。
import test from 'node:test'
import assert from 'node:assert/strict'
import def, { bingRealUrl, decode, parseFeed, zhihuRealId, linesOf, wordsOf, feedsOf } from './index.mjs'

test('模块元信息与默认值', () => {
  assert.equal(def.id, 'ai-brief')
  assert.equal(def.api, 1)
  assert.match(def.version, /^\d+\.\d+\.\d+$/)
  assert.ok(def.settings.some((s) => s.key === 'enabled'))
  assert.equal(def.defaults.morning, '09:31')
  assert.equal(def.defaults.evening, '21:30')
  assert.equal(def.defaults.sticker, false, 'qq-hub 表情包名是用户自己配的，表情默认关')
  assert.equal(def.defaults.bingMorning, '', 'Bing 默认不启用')
  assert.equal(def.defaults.bingEvening, '')
  assert.equal(def.defaults.forumEnabled, undefined, 'qq-hub 版没有论坛节点')
})

test('bingRealUrl 解 apiclick 跳转', () => {
  const raw = 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.hk01.com%2Fnews%2F123'
  assert.equal(bingRealUrl(raw), 'https://www.hk01.com/news/123')
  assert.equal(bingRealUrl('https://example.com/a'), 'https://example.com/a')
})

test('decode 处理 CDATA 与实体', () => {
  assert.equal(decode('<![CDATA[<b>标题</b> &amp; 内容]]>'), '标题 & 内容')
  assert.equal(decode('A &lt; B &gt; C'), 'A < B > C')
})

test('parseFeed 解析 RSS', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[第一条 &amp; 新闻]]></title><link>https://a.com/1</link><pubDate>Tue, 11 Nov 2025 10:00:00 GMT</pubDate></item>
    <item><title>第二条</title><link>https://a.com/2</link></item>
  </channel></rss>`
  const out = parseFeed(xml, '测试源')
  assert.equal(out.length, 2)
  assert.equal(out[0].title, '第一条 & 新闻')
  assert.equal(out[0].url, 'https://a.com/1')
  assert.equal(out[0].source, '测试源')
  assert.ok(out[0].at > 0)
})

test('zhihuRealId 优先用 url 里的完整雪花 ID', () => {
  assert.equal(
    zhihuRealId({ id: 2103486193320949200, url: 'https://api.zhihu.com/questions/2103486193320949335' }, 'Q_2103486193320949335'),
    '2103486193320949335',
  )
  assert.equal(zhihuRealId({ id: 1 }, 'Q_2103833839650829073'), '2103833839650829073')
  assert.equal(zhihuRealId({ id: 42 }), '42')
})

test('linesOf / wordsOf / feedsOf', () => {
  assert.deepEqual(linesOf(' a\n\n b '), ['a', 'b'])
  assert.deepEqual(wordsOf('AI, 模型、芯片\n融资'), ['AI', '模型', '芯片', '融资'])
  assert.deepEqual(feedsOf({ feeds: 'https://x.com/rss|X 站' }), [['https://x.com/rss', 'X 站']])
  assert.deepEqual(feedsOf({ feeds: 'https://x.com/rss' }), [['https://x.com/rss', 'x.com']])
})
