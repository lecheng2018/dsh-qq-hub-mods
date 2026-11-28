// T3.3 质量门真实行为测试：五类拦截 + 生效条件边界 + 重复检测生命周期（sent/partial 进缓存、
// skipped/failed/cancelled/unknown 只清候选）+ 容量有界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutputGuard, classifyReply } from './output-guard.mjs'

const SETTINGS = { guardEnabled: true }
const mk = (over = {}) => createOutputGuard({ settings: () => ({ ...SETTINGS, ...over }), log: { info() {}, warn() {} }, ...over })
const info = (over = {}) => ({ chatId: 'group:30001', turnId: 't1', topicMode: 'interject', participation: 'text_lite', ...over })

test('classifyReply：五类判定', () => {
  assert.equal(classifyReply('   '), 'empty')
  assert.equal(classifyReply(''), 'empty')
  assert.equal(classifyReply('确实！'), 'meaningless')
  assert.equal(classifyReply('+1'), 'meaningless')
  assert.equal(classifyReply('同感呀'), 'meaningless', '语气词收尾的零信息附和同样拦（呀/呢/啊等剥离后命中）')
  assert.equal(classifyReply('（拍拍你的头）'), 'pure-action')
  assert.equal(classifyReply('*摸摸头*'), 'pure-action')
  assert.equal(classifyReply('作为AI我觉得挺好的'), 'ai-self')
  assert.equal(classifyReply('正在调用查询工具'), 'tool-speak')
  assert.equal(classifyReply('确实，不过第二段的论述有个漏洞：作者忽略了时间线的矛盾。'), null, '含实际信息的句子不得误拦')
  assert.equal(classifyReply('这个设定的第二幕反转我没想到。'), null)
})

test('生效条件：guardEnabled / topicMode 缺失 / 非 interject / participation react / 私聊', () => {
  const g = mk()
  const text = '第一条真实的插话内容。'
  assert.equal(g.onReply(text, info({ guardEnabled: false, turnId: 'a' })), undefined, 'guardEnabled=false 放行')
  assert.equal(g.onReply(text, { chatId: 'group:30001', turnId: 'b' }), undefined, '旧宿主缺 topicMode → 跳过不猜')
  assert.equal(g.onReply(text, info({ topicMode: 'must', turnId: 'c' })), undefined, '非 interject 不检查')
  assert.equal(g.onReply('确实', info({ participation: 'react', turnId: 'd' })), undefined, 'react 不做质量门')
  assert.equal(g.onReply('确实', info({ chatId: 'private:10001', turnId: 'e' })), undefined, '私聊不检查')
})

test('五类拦截：命中返回 null', () => {
  const g = mk()
  assert.equal(g.onReply('   ', info({ turnId: 'e1' })), null, '空文本')
  assert.equal(g.onReply('确实', info({ turnId: 'e2' })), null, '精确附和')
  assert.equal(g.onReply('好的好的', info({ turnId: 'e3' })), null)
  assert.equal(g.onReply('（拍了拍你的肩膀）', info({ turnId: 'e4' })), null, '纯动作')
  assert.equal(g.onReply('我是AI助手，很高兴为你服务', info({ turnId: 'e5' })), null, 'AI 自报身份')
  assert.equal(g.onReply('正在为您生成结果', info({ turnId: 'e6' })), null, '工具腔')
})

test('重复检测生命周期：reply 暂存候选 → sent/partial 进已发送缓存 → 下次同文本拦截', async () => {
  const g = mk()
  const text = '这个细节其实呼应了第一集的伏笔。'
  assert.equal(g.onReply(text, info({ turnId: 't9' })), undefined, '首条放行')
  // skipped 终态：只清候选，不进已发送缓存
  g.onGroupResult({ turnId: 't9', chatId: 'group:30001', state: 'skipped' })
  assert.equal(g.onReply(text, info({ turnId: 't10' })), undefined, 'skipped 候选不污染已发送缓存')
  // sent 终态：进缓存
  g.onReply(text, info({ turnId: 't11' }))
  g.onGroupResult({ turnId: 't11', chatId: 'group:30001', state: 'sent' })
  assert.equal(g.onReply(text, info({ turnId: 't12' })), null, '同群同文本再次插话 → 拦截')
  // partial 也进缓存
  const text2 = '另一个有内容的插话句子。'
  g.onReply(text2, info({ turnId: 't13' }))
  g.onGroupResult({ turnId: 't13', chatId: 'group:30001', state: 'partial' })
  assert.equal(g.onReply(text2, info({ turnId: 't14' })), null, 'partial 同样进入已发送缓存')
})

test('群隔离：同文本在另一个群不判重', () => {
  const g = mk()
  const text = '这个细节其实呼应了第一集的伏笔。'
  g.onReply(text, info({ turnId: 't20' }))
  g.onGroupResult({ turnId: 't20', chatId: 'group:30001', state: 'sent' })
  assert.equal(g.onReply(text, info({ chatId: 'group:30002', turnId: 't21' })), undefined, '另一个群不判重')
})

test('unknown / failed / cancelled 终态：清候选不污染缓存', () => {
  const g = mk()
  for (const state of ['unknown', 'failed', 'cancelled']) {
    const text = `这一条插话有具体内容${state}。`
    g.onReply(text, info({ turnId: `u-${state}` }))
    g.onGroupResult({ turnId: `u-${state}`, chatId: 'group:30001', state })
    assert.equal(g.onReply(text, info({ turnId: `u2-${state}` })), undefined, `${state} 不进已发送缓存`)
  }
})

test('容量有界：已发送缓存与候选淘汰最旧项', () => {
  const g = mk({ MAX_GROUPS: undefined })
  for (let i = 0; i < 40; i++) {
    const text = `这是第 ${i} 条有实际内容的插话，用来撑满缓存容量上限。`
    g.onReply(text, info({ turnId: `c${i}` }))
    g.onGroupResult({ turnId: `c${i}`, chatId: 'group:30001', state: 'sent' })
  }
  // 第 0 条已被淘汰出容量 32 的缓存 → 不再判重；第 39 条仍在
  assert.equal(g.onReply('这是第 0 条有实际内容的插话，用来撑满缓存容量上限。', info({ turnId: 'fresh0' })), undefined, '最旧已淘汰')
  assert.equal(g.onReply('这是第 39 条有实际内容的插话，用来撑满缓存容量上限。', info({ turnId: 'fresh39' })), null, '最新仍在缓存')
})

test('dispose：清空候选与缓存', () => {
  const g = mk()
  const text = '待清理的插话内容句子。'
  g.onReply(text, info({ turnId: 'd1' }))
  g.onGroupResult({ turnId: 'd1', chatId: 'group:30001', state: 'sent' })
  g.dispose()
  assert.equal(g.onReply(text, info({ turnId: 'd2' })), undefined, 'dispose 后缓存清空')
})
