// B 站模块（自带实现）：刷一轮 / 回评论 / 看她被发来的视频 / 出站身份闸 / 计数 / 记忆 / 截图 / 单独选模型。
// 全部用假实现：假 B 站接口、假模型回合、假记忆，数据目录用真的临时目录（走注入的 store）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBili, filterVideos, digestOf, pickJson } from './duty.mjs'
import { biliModelOf } from './vision.mjs'
import { fakeStore, noopLog } from './test/testkit.mjs'

function baseConfig(over = {}) {
  return {
    enabled: true,
    dryRun: false,
    ownerQQ: '10000001',
    botQQ: '10000002',
    ownerName: '主人',
    group: { interests: [] },
    speakUp: { awakeFrom: 0, awakeTo: 24 },
    security: { identityGuard: { mode: 'block' } },
    bili: {
      enabled: true,
      cookie: 'SESSDATA=x; bili_jct=y',
      perRun: 2,
      maxCommentsPerDay: 1,
      maxRepliesPerDay: 6,
      comment: true,
      reply: true,
      shareToOwner: true,
      like: false,
      vision: false,
      visionFrames: 4,
      minViews: 0,
      maxAgeDays: 0,
      intervalHours: 4,
      maxRunsPerDay: 3,
      keywords: [],
      shotChance: 0,
      shotLibrary: 20,
      model: { provider: '', model: '', reasoningEffort: '' },
      ...over,
    },
  }
}

export function fakes({ decisions = [], replyText = '是呀 我也觉得', cfg = baseConfig(), postError = null, guardOk = true, titles = ['米饭大赛', '猫猫做饭'] } = {}) {
  const posted = []
  const sent = []
  const events = []
  const facts = []
  const guardCalls = []
  const images = []
  const seenVision = []
  const store = fakeStore()
  const fakeApi = {
    nav: async () => ({ isLogin: true, uname: '肥鱼小号' }),
    search: async (kw) => [
      { bvid: 'BV1aaaaaaaaa', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() },
      { bvid: 'BV1bbbbbbbbb', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() },
    ],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid: bvid || 'BV1ccccccccc', aid: bvid === 'BV1bbbbbbbbb' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbbbb' ? titles[1] : titles[0], author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '大家好今天做饭',
    comments: async () => [{ name: '网友', text: '好香' }],
    postComment: async (aid, message, o) => {
      if (postError) { posted.push({ failed: true }); throw postError }
      posted.push({ aid, message, ...(o || {}) })
      return { rpid: 1 }
    },
    likeVideo: async () => {},
    setSign: async (sign) => { posted.push({ sign }) },
    setFace: async (url) => { posted.push({ face: url }) },
    replyFeed: async () => [{ id: 'f1', name: '路人甲', text: '你也爱吃米饭？', myText: '看饿了', oid: 1, root: 100, parent: 101, title: '米饭大赛', type: 1 }],
    resolveShort: async () => 'https://www.bilibili.com/video/BV1bbbbbbbbb',
  }
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      if (prompt.includes('回复你')) return replyText
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 } },
    sendImage: async (chatId, file) => { images.push({ chatId, file }); return { message_id: 1 } },
    logChat: () => {},
  }
  const memory = {
    list: () => [{ text: '主人喜欢猫', about: '10000001' }],
    listFor: () => [{ text: '主人喜欢猫', about: '10000001' }],
    recentEvents: () => [],
    recentEventsFor: () => [],
    addEvent: (e) => events.push(e.text),
    add: (m) => facts.push(m.text),
  }
  const b = createBili({
    getConfig: () => cfg,
    hub,
    memory,
    log: noopLog,
    api: fakeApi,
    store,
    isSilence: (t) => /^\s*\[沉默\]\s*$/.test(String(t || '')),
    // 和插件 chat/identity-guard.js 同形：{ ok, hits, message }
    guardOutbound: (text) => { guardCalls.push(text); return { ok: guardOk, hits: guardOk ? [] : ['账号标识'], message: guardOk ? '' : '包含账号标识' } },
    vision: async (o) => { seenVision.push(o); return { text: '画面里有一碗米饭', frames: [] } },
  })
  return { b, store, cfg, posted, sent, events, facts, guardCalls, images, seenVision }
}

test('纯函数：JSON 提取、视频过滤、交给她看的摘要', () => {
  assert.deepEqual(pickJson('前面废话 ["a","b"] 后面', []), ['a', 'b'])
  assert.deepEqual(pickJson('{"a":1}', null), { a: 1 })
  assert.deepEqual(pickJson('没有', ['x']), ['x'])
  const now = Date.now()
  const list = [
    { bvid: 'a', play: 100, pubdate: now },
    { bvid: 'b', play: 9000, pubdate: now - 100 * 86400_000 },
    { bvid: 'c', play: 9000, pubdate: now },
    { bvid: 'd', play: 9000, pubdate: now },
  ]
  assert.deepEqual(filterVideos(list, { minViews: 5000, maxAgeDays: 60, seen: new Set(['d']), now }).map((v) => v.bvid), ['c'])
  const digest = digestOf({ title: '猫猫做饭', author: 'UP主', play: 12, desc: '简介', bvid: 'BV1' }, { subtitle: '', comments: [{ name: '网友', text: '好香' }], vision: '一只猫' })
  assert.match(digest, /《猫猫做饭》/)
  assert.match(digest, /画面（抽帧）：一只猫/)
  assert.match(digest, /热评：/)
})

test('刷一轮：看视频、按每天上限评论、分享给主人、记成她的经历', async () => {
  const { b, posted, sent, events, facts } = fakes({ decisions: [
    { i: 1, feeling: '米饭好香', comment: '看饿了', share: '', remember: '有个米饭大赛很好玩' },
    { i: 2, feeling: '猫好可爱', comment: '猫猫好会', share: '主人你看这只猫会做饭！', remember: '' },
  ] })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(posted.length, 1, '每天最多 1 条，只发了第一条')
  assert.equal(posted[0].message, '看饿了')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.match(sent[0].text, /会做饭！\nhttps:\/\/www\.bilibili\.com\/video\/BV1/)
  assert.ok(events.some((e) => e.includes('看了《米饭大赛》，她的想法：') && e.includes('米饭好香')), '想法带出处：' + JSON.stringify(events))
  assert.ok(events.some((e) => e.includes('在B站一条视频下评论过：看饿了')))
  assert.deepEqual(facts, ['（来自《米饭大赛》）有个米饭大赛很好玩'], '知识条目带出处前缀')
  assert.equal(b.state().comments, 1)
  const r2 = await b.run({ force: true })
  assert.equal(r2.ok, false, '看过的不会再刷')
})

test('出站身份闸：拦下就不发、不计数、不记「已评论」', async () => {
  const { b, posted, events, guardCalls } = fakes({ guardOk: false, decisions: [
    { i: 1, feeling: '好看', comment: '主人的QQ是10000001', share: '', remember: '' },
  ] })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(posted.length, 0, '被拦下不能真发')
  assert.ok(guardCalls.length >= 1, '发之前先过闸')
  assert.equal(r.commented, 0)
  assert.equal(b.state().comments, 0, '被拦下不占当天次数')
  assert.ok(!events.some((e) => e.includes('评论过')), '被拦下不能记成评论过的经历')
})

test('试运行：记 dry:comment、不真发、不计数', async () => {
  const cfg = baseConfig({ maxCommentsPerDay: 5 })
  cfg.dryRun = true
  const { b, posted } = fakes({ cfg, decisions: [{ i: 1, feeling: '好看', comment: '真好', share: '', remember: '' }] })
  const r = await b.run({ force: true })
  assert.equal(r.commented, 0)
  assert.equal(posted.length, 0)
  assert.equal(b.state().comments, 0)
})

test('回复别人：带上楼层、按格式回，回过的不再回', async () => {
  const { b, posted, events } = fakes({ decisions: [] })
  const r = await b.checkReplies()
  assert.equal(r.replied, 1)
  assert.deepEqual(posted[0], { aid: 1, message: '回复 @路人甲 :是呀 我也觉得', root: 100, parent: 101 })
  assert.ok(events.some((e) => e.includes('在B站回复了 路人甲')))
  assert.equal((await b.checkReplies()).replied, 0)
})

test('共享流水写入失败不打断 B 站回复', async () => {
  const warnings = []
  const posted = []
  const b = createBili({
    getConfig: () => baseConfig(),
    hub: { runSystemTurn: async () => '谢谢你的回复', sendText: async () => ({}), sendImage: async () => ({}) },
    chatLog: { append() { throw new Error('disk full') } },
    log: { info() {}, debug() {}, warn: (...args) => warnings.push(args.join(' ')) },
    store: fakeStore(),
    isSilence: () => false,
    api: {
      replyFeed: async () => [{ id: 'isolated-reply', name: '网友', text: '你好', myText: '原评论', oid: 1, root: 100, parent: 101, title: '视频', type: 1 }],
      postComment: async (...args) => posted.push(args),
    },
  })
  assert.equal((await b.checkReplies()).replied, 1)
  assert.equal(posted.length, 1)
  assert.ok(warnings.some((message) => message.includes('disk full')))
})

test('看你发来的视频（短链也行）；主人让她评论才发', async () => {
  const { b, posted } = fakes({ decisions: [] })
  const w = await b.watch('https://b23.tv/abc123')
  assert.equal(w.ok, true)
  assert.match(w.message, /《猫猫做饭》/)
  assert.match(w.message, /字幕（节选）：大家好今天做饭/)
  const c = await b.comment('BV1bbbbbbbbb', '太会了')
  assert.equal(c.ok, true)
  assert.deepEqual(posted[0], { aid: 2, message: '太会了' })
  assert.equal((await b.watch('没有链接')).ok, false)
})

test('没登录不让她写评论；被风控就当天暂停评论和回复', async () => {
  const d = [{ i: 1, feeling: '好看', comment: '真好', share: '' }, { i: 2, feeling: '可爱', comment: '哈哈', share: '' }]
  const noLogin = fakes({ decisions: d, cfg: baseConfig({ cookie: '' }) })
  await noLogin.b.run({ force: true })
  assert.equal(noLogin.posted.length, 0, '没 bili_jct 不能发')

  const e = Object.assign(new Error('B 站返回 -352：风控校验失败'), { code: -352 })
  const risky = fakes({ decisions: d, cfg: baseConfig({ maxCommentsPerDay: 5 }), postError: e })
  await risky.b.run({ force: true })
  assert.equal(risky.posted.length, 1, '第一条失败后不再试第二条')
  assert.match(risky.b.state().pauseReason, /风控/)
  assert.equal(risky.b.state().canPost, false)
  assert.equal((await risky.b.checkReplies()).replied, 0, '回复也不发了')
})

test('改签名 / 换头像：试运行、没登录、超长、非图片网址都不发', async () => {
  const { b, posted } = fakes()
  assert.equal((await b.setSign('')).ok, false)
  assert.equal((await b.setSign('字'.repeat(71))).ok, false)
  assert.equal((await b.setSign('换个签名')).ok, true)
  assert.deepEqual(posted[0], { sign: '换个签名' })

  const dry = baseConfig()
  dry.dryRun = true
  const d = fakes({ cfg: dry })
  assert.match((await d.b.setSign('试试')).message, /试运行/)
  assert.match((await d.b.setAvatar('https://x/a.png')).message, /试运行/)

  const noLogin = fakes({ cfg: baseConfig({ cookie: '' }) })
  assert.equal((await noLogin.b.setSign('试试')).ok, false)
  assert.equal((await noLogin.b.setAvatar('https://x/a.png')).ok, false)
  assert.equal((await noLogin.b.setAvatar('C:\\a.png')).ok, false, '只收 http(s) 网址')
  const ok = await fakes().b.setAvatar('https://x/a.png')
  assert.equal(ok.ok, true)
})

test('单独选的模型：看画面用选的那个，没选就跟随全局', async () => {
  assert.equal(biliModelOf({}), null)
  assert.equal(biliModelOf({ model: { provider: 'p', model: '' } }), null)
  assert.deepEqual(biliModelOf({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }), { provider: 'p', model: 'm', reasoningEffort: 'high' })

  const cfg = baseConfig({ vision: true, model: { provider: 'fast', model: 'fast-vision', reasoningEffort: '' } })
  const { b, seenVision } = fakes({ cfg })
  const w = await b.watch('BV1aaaaaaaaa')
  assert.equal(w.ok, true)
  assert.equal(seenVision.length, 1, '开着看画面就会调一次')
  assert.deepEqual(seenVision[0].model, { provider: 'fast', model: 'fast-vision', reasoningEffort: '' })
  assert.ok(seenVision[0].deps.findFfmpeg === undefined || typeof seenVision[0].deps.findFfmpeg === 'function')
})

test('记忆截断按码点：标题/感受/知识里带 emoji 也不会写出孤立代理项（#226）', async () => {
  // 'a' + 30 个 emoji：第 30 个 UTF-16 单元正好落在第二个 emoji 的高位，
  // 老写法 s.slice(0, 30) 会留下孤立的 high surrogate，向量化时 400。
  const title = 'a' + '🐟'.repeat(30)
  const { b, events, facts } = fakes({
    titles: [title, '猫猫做饭'],
    decisions: [{ i: 1, feeling: '🐟'.repeat(40), comment: '', share: '', remember: '🐟'.repeat(100) }],
  })
  await b.run({ force: true })
  assert.ok(events.length >= 1 && facts.length === 1, '想法和知识都要写进记忆')
  for (const text of [...events, ...facts]) {
    assert.equal(typeof text.isWellFormed, 'function', '需要 Node 20+ 的 String#isWellFormed')
    assert.equal(text.isWellFormed(), true, '不能出现孤立代理项：' + JSON.stringify(text.slice(0, 40)))
  }
  assert.ok(Array.from(events[0]).length < events[0].length, 'emoji 按码点算一个字')
})

test('刷一轮会落盘到 bili.json（数据位置不变）', async () => {
  const { b, store } = fakes({ decisions: [{ i: 1, feeling: '好看', comment: '', share: '', remember: '' }] })
  await b.run({ force: true })
  const saved = JSON.parse(readFileSync(store.dataDir('bili.json'), 'utf8'))
  assert.ok(saved.seen.includes('BV1aaaaaaaaa'), '看过的视频要记住')
  assert.ok(saved.lastRun > 0)
})
