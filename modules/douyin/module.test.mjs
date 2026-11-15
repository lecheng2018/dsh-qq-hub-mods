import { test } from 'node:test'
import assert from 'node:assert/strict'
import def from './index.mjs'

test('douyin：清单与入口契约', () => {
  assert.equal(def.id, 'douyin')
  assert.equal(def.version, '2.0.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'douyin')
})
