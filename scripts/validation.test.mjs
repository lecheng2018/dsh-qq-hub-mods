import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEntryContract, validateEntrySource } from './lib/validation.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('all active module entries satisfy static contract', () => {
  for (const entry of readdirSync(join(ROOT, 'modules'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const dir = join(ROOT, 'modules', entry.name)
    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'))
    const entryPath = ['index.mjs', 'index.js'].map(name => join(dir, name)).find(path => { try { return !!readFileSync(path) } catch { return false } })
    assert.ok(entryPath, `${entry.name} entry exists`)
    assert.doesNotThrow(() => validateEntrySource(readFileSync(entryPath, 'utf8'), manifest), entry.name)
  }
})

test('entry contract rejects dynamic or overriding metadata', () => {
  const valid = "const ID = 'demo'; const VERSION = '1.0.0'; export default { id: ID, version: VERSION, setup(api) {} }"
  assert.deepEqual(readEntryContract(valid), { id: 'demo', version: '1.0.0' })
  assert.throws(() => readEntryContract("export default { id: 'demo', version: '1.0.0', setup: undefined }"), /setup/)
  assert.throws(() => readEntryContract("export default { id: 'demo', version: '1.0.0', ...{ id: 'evil' }, setup() {} }"), /spread/)
  assert.throws(() => readEntryContract("export default { ['id']: 'demo', version: '1.0.0', setup() {} }"), /computed/)
  assert.throws(() => readEntryContract("export default { id: 'demo', version: '1.0.0', get setup() {} }"), /accessors/)
})
