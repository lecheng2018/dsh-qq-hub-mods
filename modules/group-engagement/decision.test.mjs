// T3.2 纯决策真实行为测试：固定 random/now，覆盖 cue、内容排除、长短文本、缺 messageId、
// 冷却、熔断、Shadow、群白名单与 bias 上下限。
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideParticipation, pickEmojiId, normalizeAllowedGroupIds, scoreReply } from './decision.mjs'

const BASE_SETTINGS = {
  enabled: true,
  mode: 'engage',
  allowedGroupIds: ['30001'],
  reactEnabled: true,
  textLiteEnabled: true,
  emojiIds: ['66', '67'],
  reactScoreThreshold: 0.72,
  textLiteScoreThreshold: 0.4,
  reactCooldownMs: 90000,
  feedbackBiasLimit: 0.1,
  textLiteMaxBubbles: 1,
  textLiteMaxChars: 80,
}
const NOW = 1_800_000_000_000
const random = () => 0.25 // 稳定：选 emojiIds[0]='66'

const run = (over = {}) => decideParticipation({
  decision: { reply: true, mode: 'interject' },
  msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text: '哈哈这个太可爱了吧' },
  recentTexts: [],
  settings: BASE_SETTINGS,
  feedbackSnapshot: { bias: 0 },
  lastReactAt: 0,
  circuitUntil: 0,
  random,
  now: NOW,
  ...over,
})

test('硬性前置：非 interject / 未启用 / 群不在白名单 → undefined', () => {
  assert.equal(run({ decision: { reply: true, mode: 'must' } }), undefined)
  assert.equal(run({ decision: { reply: false, mode: 'interject' } }), undefined)
  assert.equal(run({ settings: { ...BASE_SETTINGS, enabled: false } }), undefined)
  assert.equal(run({ settings: { ...BASE_SETTINGS, enabled: undefined } }), undefined)
  assert.equal(run({ msg: { chatId: 'group:30002', groupId: '30002', messageId: '10001', text: '哈哈' } }), undefined)
  assert.equal(run({ settings: { ...BASE_SETTINGS, allowedGroupIds: '' } }), undefined)
})

test('Shadow：返回 { shadow: true, suggested } 统计对象，绝不是接管声明', () => {
  const r = run({ settings: { ...BASE_SETTINGS, mode: 'shadow' } })
  assert.ok(r && r.shadow === true)
  assert.ok('suggested' in r)
  assert.equal(r.level, undefined, 'Shadow 绝不携带 level（入口不能把它交给宿主）')
  assert.equal(r.suggested, 'react', '哈哈+短文本 + random 稳定 → 建议 react')
  // Shadow 下白名单外同样 undefined
  assert.equal(run({ settings: { ...BASE_SETTINGS, mode: 'shadow', allowedGroupIds: ['30002'] } }), undefined)
})

test('REACT：cue + 短文本达阈值 → 声明 react，emoji 从 settings.emojiIds 选出', () => {
  const r = run()
  assert.equal(r.level, 'react')
  assert.deepEqual(r.reaction, { messageId: '10001', emojiId: '66' })
})

test('缺有效 messageId：禁止 REACT（可回落 text_lite）', () => {
  const r = run({ msg: { chatId: 'group:30001', groupId: '30001', messageId: '', text: '哈哈这个太可爱了吧' } })
  assert.notEqual(r?.level, 'react')
  assert.equal(r?.level, 'text_lite', 'textLiteEnabled 开着 → 次选 text_lite')
})

test('内容信号强制排除 REACT：问号 / 求助 / 代码 / 步骤 / 地址 / 文件', () => {
  for (const text of ['这是为什么呀', '帮我看看这个报错', '给个教程呗', '第一步先干嘛', '看这个链接 http://x.invalid', '发我个文件']) {
    const r = run({ msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text } })
    assert.notEqual(r?.level, 'react', `不该 REACT：${text}`)
  }
})

test('长文本降分：达不到 react 阈值', () => {
  const long = '哈哈哈这个真的太有意思了，而且里面那个细节的设计确实很妙，我看完还去翻了翻原作，发现作者后面还补了几格番外，整体完成度比想象中高很多。'
  const r = run({ msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text: long } })
  assert.notEqual(r?.level, 'react')
})

test('冷却未完成：不 REACT（reactEnabled 仍开）', () => {
  const r = run({ lastReactAt: NOW - 30_000, circuitUntil: 0 })
  assert.notEqual(r?.level, 'react')
  assert.equal(r?.level, 'text_lite', '冷却中回落 text_lite')
})

test('熔断中：不 REACT', () => {
  const r = run({ circuitUntil: NOW + 600_000 })
  assert.notEqual(r?.level, 'react')
})

test('reactEnabled=false：不 REACT，text_lite 达阈值照常', () => {
  const r = run({ settings: { ...BASE_SETTINGS, reactEnabled: false } })
  assert.notEqual(r?.level, 'react')
  assert.equal(r?.level, 'text_lite')
})

test('textLiteEnabled=false 且未达 react 阈值 → undefined（保持 FULL）', () => {
  // 无 cue 中等文本：基线 0.15 + 短文本 0.35 = 0.5 < 0.72（react 不可达），text_lite 关闭 → undefined
  const r = run({
    msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text: '这个聊天的设定还挺有意思' },
    settings: { ...BASE_SETTINGS, textLiteEnabled: false },
  })
  assert.equal(r, undefined)
})

test('feedback bias 只作用于内部 score 且钳制在 ±feedbackBiasLimit', () => {
  // 原始分 0.49（cue 命中 + 长文本无短加分）：bias +0.5 只按 +0.1 生效 → 0.59 < 0.72 不该冲进 REACT
  const up = run({
    msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text: '哈哈这个聊天的设定还挺有意思的' },
    feedbackSnapshot: { bias: 0.5 },
  })
  assert.notEqual(up.level, 'react', 'bias 钳制在 +0.1：不得把 0.49 拔过 0.72 的 REACT 阈值')
  assert.equal(up.level, 'text_lite', '0.49 + 0.1 = 0.59 ≥ 0.4 → TEXT_LITE')
  // 原始分 0.5（短文本无 cue）：bias -0.5 只按 -0.1 生效 → 0.4 < 0.5 回落 undefined
  const down = run({
    msg: { chatId: 'group:30001', groupId: '30001', messageId: '10001', text: '这个聊天的设定还挺有意思' },
    settings: { ...BASE_SETTINGS, reactScoreThreshold: 1.5, textLiteScoreThreshold: 0.5 },
    feedbackSnapshot: { bias: -0.5 },
  })
  assert.equal(down, undefined, 'bias 钳制在 -0.1：不得把 0.5 压出 0.5 的 TEXT_LITE 阈值太多——刚好回落')
})

test('emojiId 只能从 settings.emojiIds 经 random 选出；空表情表不 REACT', () => {
  assert.equal(pickEmojiId(['66', '67'], () => 0), '66')
  assert.equal(pickEmojiId(['66', '67'], () => 0.99), '67')
  assert.equal(pickEmojiId([], random), null)
  assert.equal(pickEmojiId(['abc', '-1'], random), null, '非数字 id 全部过滤')
  const r = run({ settings: { ...BASE_SETTINGS, emojiIds: [] } })
  assert.notEqual(r?.level, 'react', '表情表为空 → 不 REACT')
})

test('allowedGroupIds / emojiIds 兼容逗号字符串存法', () => {
  assert.deepEqual(normalizeAllowedGroupIds('30001, 30002'), ['30001', '30002'])
  const r = run({ settings: { ...BASE_SETTINGS, allowedGroupIds: '30001' } })
  assert.equal(r.level, 'react')
})

test('scoreReply：基线 / cue / 内容排除 / 长文本', () => {
  assert.equal(scoreReply('').blocked, true)
  assert.equal(scoreReply('   ').blocked, true)
  assert.ok(scoreReply('哈哈').score > 0.7)
  assert.equal(scoreReply('这是为什么？').blocked, true)
  assert.ok(scoreReply('这个聊天的设定还挺有想法的，细节处理得不错，整体感觉超出了我的预期很多。').score < 0.4)
})
