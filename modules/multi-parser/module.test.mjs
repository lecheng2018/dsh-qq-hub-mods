import { test } from 'node:test'
import assert from 'node:assert/strict'
import def, { allowedHere } from './index.mjs'

test('multi-parser：清单与入口契约', () => {
  assert.equal(def.id, 'multi-parser')
  assert.equal(def.version, '1.0.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.defaults.enabled, false, '默认关闭')
})

test('multi-parser：allowedHere 三层判定', () => {
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, {}), true, '群默认开')
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, { inGroups: false }), false, '群关掉则连链接都不碰')
  assert.equal(allowedHere({ kind: 'group', chatId: 'group:555' }, { disabledGroups: ['555'] }), false, '按群禁用')
  assert.equal(allowedHere({ kind: 'group', groupId: '555' }, { disabledGroups: ['555'] }), false)
  assert.equal(allowedHere({ kind: 'private', chatId: 'private:1' }, {}), true, '私聊默认开')
  assert.equal(allowedHere({ kind: 'private', chatId: 'private:1' }, { inPrivate: false }), false)
  assert.equal(allowedHere({ kind: 'system' }, {}), false, 'system 后台轮次不解析')
})
