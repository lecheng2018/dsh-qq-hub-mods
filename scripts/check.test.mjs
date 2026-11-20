import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepository } from './check.mjs'

const git = process.env.GIT_EXECUTABLE || 'git'

function withRepository(t) {
  const root = mkdtempSync(join(tmpdir(), 'mods-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync(git, ['init', '-q', root])
  execFileSync(git, ['-C', root, 'config', 'user.email', 'check@example.test'])
  execFileSync(git, ['-C', root, 'config', 'user.name', 'Check Test'])
  execFileSync(git, ['-C', root, 'config', 'core.autocrlf', 'false'])
  mkdirSync(join(root, 'modules', 'demo'), { recursive: true })
  writeFileSync(join(root, 'revoked.json'), '{"revoked":[]}\n')
  writeModule(root, 'demo', '1.0.0')
  commit(root, 'initial')
  return root
}

function writeModule(root, id, version, extra = '') {
  const dir = join(root, 'modules', id)
  mkdirSync(dir, { recursive: true })
  const manifest = { id, name: 'Demo', version, description: 'Test module', author: 'Test', license: 'MIT', api: 1, requires: [] }
  writeFileSync(join(dir, 'module.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'index.mjs'), `export default { id: '${id}', version: '${version}', setup(api) {} }\n${extra}`)
  writeFileSync(join(dir, 'README.md'), '# Demo\n')
  writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
}

function commit(root, message) {
  execFileSync(git, ['-C', root, 'add', '-A'])
  execFileSync(git, ['-C', root, 'commit', '-qm', message])
}

function check(root, options = {}) {
  return checkRepository(root, { git, ...options })
}

test('check uses a real merge-base and requires a complete prerelease increment', t => {
  const root = withRepository(t)
  const base = execFileSync(git, ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeModule(root, 'demo', '1.0.0-beta.1')
  commit(root, 'prerelease')
  const failed = check(root, { base })
  assert.ok(failed.errors.some(error => error.includes('higher than 1.0.0')))
  writeModule(root, 'demo', '1.0.1-beta.1')
  commit(root, 'increment')
  assert.deepEqual(check(root, { base }).errors, [])
})

test('check fails closed for bad base and blocks changes to tagged versions', t => {
  const root = withRepository(t)
  assert.ok(check(root, { base: 'no-such-ref' }).errors.some(error => error.includes('Git validation failed closed')))
  execFileSync(git, ['-C', root, 'tag', 'demo-v1.0.0'])
  writeFileSync(join(root, 'modules', 'demo', 'README.md'), 'changed\n')
  assert.ok(check(root).errors.some(error => error.includes('published version 1.0.0 is immutable')))
})

test('check catches deletion of a released module without treating it as revocation', t => {
  const root = withRepository(t)
  execFileSync(git, ['-C', root, 'tag', 'demo-v1.0.0'])
  rmSync(join(root, 'modules', 'demo'), { recursive: true, force: true })
  const result = check(root)
  assert.ok(result.errors.some(error => error.includes('published module deletion/rename is blocked')))
})

test('check rejects a committed downgrade even without a PR base', t => {
  const root = withRepository(t)
  execFileSync(git, ['-C', root, 'tag', 'demo-v1.0.0'])
  writeModule(root, 'demo', '0.9.9')
  commit(root, 'invalid downgrade')
  assert.ok(check(root).errors.some(error => error.includes('lower than published')))
})

test('check catches untracked module payloads and invalid strict manifest values', t => {
  const root = withRepository(t)
  writeFileSync(join(root, 'modules', 'demo', 'extra.txt'), 'new')
  assert.ok(check(root).errors.some(error => error.includes('published') || error.includes('version must be higher')))
  const manifestPath = join(root, 'modules', 'demo', 'module.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = 1
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.ok(check(root).errors.some(error => error.includes('version must be a complete SemVer')))
})
