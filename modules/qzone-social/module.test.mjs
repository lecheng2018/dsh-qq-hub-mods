import { test } from 'node:test'
import assert from 'node:assert/strict'
import def from './index.mjs'

test('qzone-social：清单与入口契约', () => {
  assert.equal(def.id, 'qzone-social')
  assert.equal(def.version, '1.0.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'diary')
})
