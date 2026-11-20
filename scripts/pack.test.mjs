import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { packRepository } from './pack.mjs'
import { validateReleaseDirectory } from './lib/artifact.mjs'
import { createRepository, git } from './fixtures/repository.mjs'

test('clean packages bind to HEAD and repeat deterministically without stale files', t => {
  const { repository } = createRepository(t)
  const first = packRepository(repository, { requireClean: true })
  const bytes = readFileSync(join(repository, 'dist', 'example-mod.zip'))
  assert.equal(first[0].commit, git(repository, 'rev-parse', 'HEAD'))
  assert.equal(first[0].dirty, false)
  assert.equal(validateReleaseDirectory(join(repository, 'dist')).length, 1)
  writeFileSync(join(repository, 'dist', 'stale-mod.zip'), 'old build')
  const second = packRepository(repository, { requireClean: true })
  assert.equal(first[0].sha256, second[0].sha256)
  assert.deepEqual(bytes, readFileSync(join(repository, 'dist', 'example-mod.zip')))
  assert.deepEqual(readdirSync(join(repository, 'dist')).sort(), ['example-mod.zip', 'release.json'])
})

test('dirty trees cannot be released and output cannot overwrite source or unrelated files', t => {
  const { repository, directory } = createRepository(t)
  writeFileSync(join(directory, 'README.md'), '# changed\n')
  assert.throws(() => packRepository(repository, { requireClean: true }), /dirty/i)
  const records = packRepository(repository)
  assert.equal(records[0].dirty, true)
  assert.throws(() => validateReleaseDirectory(join(repository, 'dist')), /dirty/i)
  assert.throws(() => packRepository(repository, { out: '.' }), /Output/)
  assert.throws(() => packRepository(repository, { out: 'modules/output' }), /overlap/)
  mkdirSync(join(repository, 'unsafe-output'))
  writeFileSync(join(repository, 'unsafe-output', 'keep.txt'), 'must remain')
  assert.throws(() => packRepository(repository, { out: 'unsafe-output' }), /unexpected file/)
  assert.equal(readFileSync(join(repository, 'unsafe-output', 'keep.txt'), 'utf8'), 'must remain')
})

test('packing enforces file, expanded-byte and credential limits before publishing output', t => {
  const { repository, directory } = createRepository(t)
  assert.throws(() => packRepository(repository, { limits: { maxFiles: 1 } }), /files/)
  assert.throws(() => packRepository(repository, { limits: { maxUnpackedBytes: 1 } }), /unpacked/)
  writeFileSync(join(directory, 'leak.mjs'), `export const secret = '${['gh', 'p_', 'z'.repeat(36)].join('')}'\n`)
  assert.throws(() => packRepository(repository), /credential/)
})
