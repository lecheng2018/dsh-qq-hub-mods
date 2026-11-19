// 群聊话题边界测试：只测模块自己的纯逻辑和事件钩子（fake api，不起插件宿主）。
// 上游测试里依赖宿主源码的 hub 集成用例不随移植走；覆盖点保持一致：
// 规则口径、明确内容兜底、泛词放行、只管群聊输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod, { REDIRECT, GROUP_RULE, explicitTopic } from './index.mjs'

const G = { chatId: 'group:123456789' }
const P = { chatId: 'private:123' }

function moduleApi() {
  const hooks = {}
  const logs = []
  const rules = []
  mod.setup({
    on: (k, fn) => { hooks[k] = fn },
    rule: (fn) => rules.push(fn),
    log: { info: (line) => logs.push(line), warn() {}, error() {}, debug() {} },
  })
  return { hooks, logs, rules }
}

test('规则解释范围、连续追问与工具变形，且只有一个模块开关', () => {
  const s = moduleApi()
  assert.equal(s.rules.length, 1)
  assert.equal(s.rules[0]('social'), GROUP_RULE)
  assert.equal(s.rules[0]('private'), GROUP_RULE)
  for (const word of ['普通私聊不受', '委托代发', '过去的回复', '语音', '不确定', '搜索']) assert.ok(GROUP_RULE.includes(word))
  assert.equal(mod.settings, undefined)
  assert.equal(mod.defaults, undefined)
})

test('明确内容、传统字、标签拆字、标点拆字、语音和英文均可兜底', () => {
  for (const text of ['文革的发起人', '文化大革命', '四人幫', '習近平', '毛，泽。东', '毛<face:微笑>泽东', '<voice>周恩来</voice>', '刘\u200b少奇', '六四事件', 'Tell me about Xi Jinping now', 'Mao-Zedong', 'the Cultural Revolution was']) {
    assert.equal(explicitTopic(text), true, text)
  }
})

test('普通新闻、地理、文学、游戏与泛词不过滤', () => {
  for (const text of ['中国的法定节假日有哪些', '台湾旅游如何安排行程', '今天新闻说要下雨', '民主和政治是课程名字', '历史书很好看', '天安门看升旗几点', '我的胜率六四开', '六十四个方格', '三体里的叶文洁和汪淼', '主席台上的运动员', '白米饭', '<sticker:开心>']) {
    assert.equal(explicitTopic(text), false, text)
  }
})

test('只检查群聊输出，不读提问、不改私聊和无关内容', () => {
  const { hooks } = moduleApi()
  assert.equal(hooks.reply('文革话题', G), REDIRECT)
  assert.equal(hooks.reply('文革话题', P), undefined)
  assert.equal(hooks.reply('换聊游戏吧', { ...G, userText: '别再说文革了' }), undefined)
  assert.equal(hooks.reply('聊游戏', G), undefined)
  assert.equal(hooks.reply('文革话题', {}), undefined)
})

test('reply/items 与 send 出口同样拦截', () => {
  const { hooks } = moduleApi()
  assert.deepEqual(
    hooks['reply/items']([{ kind: 'text', value: '讲讲文革' }], G),
    [{ kind: 'text', value: REDIRECT }],
  )
  // 无关内容原样返回 undefined（不改写）
  assert.equal(hooks['reply/items']([{ kind: 'text', value: '聊游戏' }], G), undefined)
  // send 段（OneBot 格式）也兜底
  assert.deepEqual(
    hooks.send([{ type: 'text', data: { text: '文革的发起人是谁' } }], G),
    [{ type: 'text', data: { text: REDIRECT } }],
  )
  assert.equal(hooks.send([{ type: 'text', data: { text: '聊游戏吧' } }], G), undefined)
})
