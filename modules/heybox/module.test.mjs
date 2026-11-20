import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// lib/site.mjs 顶层就要用 globalThis.aurabot.lib（宿主在加载模块前已挂好）。
// 测试环境没有宿主，先垫一个最小的——这本来就是宿主集成契约的一部分。
globalThis.aurabot ||= { lib: () => ({ dataDir: (...p) => '/tmp/hb-test/' + p.join('/'), registerSecretField() {} }) }
const { default: def } = await import('./index.mjs')

test('heybox：清单与入口契约', () => {
  assert.equal(def.id, 'heybox')
  assert.equal(def.version, '1.6.3')
  assert.equal(typeof def.setup, 'function')
  assert.ok(def.description)
  assert.equal(def.tab, 'heybox')
  // 入口与清单必须同步（MOD-02）—— 防止版本号再次漂移
  const manifest = JSON.parse(readFileSync(new URL('./module.json', import.meta.url)))
  assert.equal(def.version, manifest.version)
})
