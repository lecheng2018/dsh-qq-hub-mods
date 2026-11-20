import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import def from './index.mjs'

test('douyin：清单与入口契约', () => {
  assert.equal(def.id, 'douyin')
  assert.equal(def.version, '2.2.0')
  // 入口与清单必须同步（MOD-02）—— 这个测试就是为那次漂移补的回归
  const manifest = JSON.parse(readFileSync(new URL('./module.json', import.meta.url)))
  assert.equal(def.version, manifest.version)
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'douyin')
})
