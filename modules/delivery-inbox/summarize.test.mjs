// summarizeDeliveries 纯函数回归（移植自主仓 test/delivery-inbox.test.js）。
// 重点守：读不到必须明确报错、异常状态必须完整列出、正常状态不许混进来。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summarizeDeliveries } from './index.mjs'

const NOW = 1_800_000_000_000

function rec(over = {}) {
  return {
    contractVersion: 1,
    deliveryId: 'dlv-1',
    chatKey: 'group:123',
    sourceModuleId: 'core',
    state: 'unknown',
    attemptCount: 1,
    segments: [{ type: 'text', data: { text: '你好世界' } }],
    contentChars: 4,
    createdAt: NOW - 60_000,
    ...over,
  }
}

const doc = (deliveries) => ({ version: 1, savedAt: NOW, deliveries })

test('读不到/结构不对：明确报 deliveries-unreadable，绝不伪装成没有异常', () => {
  for (const bad of [null, undefined, {}, { deliveries: 'nope' }, []]) {
    const out = summarizeDeliveries(bad)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'deliveries-unreadable')
    assert.deepEqual(out.items, [])
  }
})

test('异常状态完整列出（unknown/failed/cancelled），带预览与理由', () => {
  const out = summarizeDeliveries(doc([
    rec({ deliveryId: 'a', state: 'unknown', unknownReason: '网关没回执' }),
    rec({ deliveryId: 'b', state: 'failed', failReason: '网关拒收' }),
    rec({ deliveryId: 'c', state: 'cancelled', cancelReason: '试运行' }),
    rec({ deliveryId: 'd', state: 'sent', segments: [{ type: 'text', data: { text: '正常送达' } }] }),
  ]))
  assert.equal(out.ok, true)
  assert.equal(out.total, 4)
  assert.deepEqual(out.items.map((i) => i.deliveryId), ['a', 'b', 'c'], 'sent 不进列表')
  assert.equal(out.items[0].preview, '你好世界')
  assert.equal(out.items[0].reason, '网关没回执')
  assert.equal(out.counts.sent, 1)
})

test('媒体与杂项段落打码成占位，正文超长截断', () => {
  const out = summarizeDeliveries(doc([rec({
    segments: [{ type: 'image', data: {} }, { type: 'record', data: {} }, { type: 'at', data: { qq: 42 } }],
  })]))
  assert.equal(out.items[0].preview, '[图片][语音]@42')

  const long = summarizeDeliveries(doc([rec({ segments: [{ type: 'text', data: { text: '字'.repeat(100) } }] })]))
  assert.ok(long.items[0].preview.length <= 61, '60 字 + 省略号')
  assert.ok(long.items[0].preview.endsWith('…'))
})

test('limit 语义：非正数回默认 50，正数生效且不超上限', () => {
  const many = Array.from({ length: 60 }, (_, i) => rec({ deliveryId: `d${i}`, state: 'failed', failedAt: NOW - i }))
  assert.equal(summarizeDeliveries(doc(many), { limit: 5 }).items.length, 5)
  assert.equal(summarizeDeliveries(doc(many), { limit: -3 }).items.length, 50, '非正数回默认，不夹成 1')
  assert.equal(summarizeDeliveries(doc(many), { limit: 999 }).items.length, 50, '不超过 MAX_ITEMS')
})

test('排序按进入终态的时间倒序', () => {
  const out = summarizeDeliveries(doc([
    rec({ deliveryId: 'old', failedAt: NOW - 5000 }),
    rec({ deliveryId: 'new', unknownAt: NOW - 1000 }),
    rec({ deliveryId: 'mid', createdAt: NOW - 3000 }),
  ]))
  assert.deepEqual(out.items.map((i) => i.deliveryId), ['new', 'mid', 'old'])
})