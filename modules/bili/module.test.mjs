import { test } from 'node:test'
import assert from 'node:assert/strict'
import def from './index.mjs'

test('bili：清单与入口契约', () => {
  assert.equal(def.id, 'bili')
  assert.equal(def.version, '1.1.0')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'bili')
})
