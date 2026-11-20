import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { discoverTests, testEnvironment } from './test.mjs'

function makeRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quality runner paths '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const name of ['modules', 'scripts', 'templates/module', 'tests/contract', 'modules/_archived', 'modules/.hidden']) {
    fs.mkdirSync(path.join(directory, name), { recursive: true })
  }
  return directory
}

test('discovers active module, scripts, template, and ordinary contract tests but excludes archives and .contract.mjs files', t => {
  const repository = makeRepository(t)
  fs.mkdirSync(path.join(repository, 'modules/active-module'), { recursive: true })
  fs.mkdirSync(path.join(repository, 'modules/_archived'), { recursive: true })
  fs.mkdirSync(path.join(repository, 'modules/.hidden'), { recursive: true })
  for (const file of [
    'modules/active-module/module.test.mjs',
    'modules/_archived/old.test.mjs',
    'modules/.hidden/hidden.test.mjs',
    'scripts/check.test.mjs',
    'templates/module/template.test.mjs',
    'tests/contract/ordinary.test.mjs',
    'tests/contract/host-contract.contract.mjs',
    'tests/contract/host-contract.test.mjs',
  ]) {
    fs.writeFileSync(path.join(repository, file), '')
  }
  const result = discoverTests(repository)
  assert.deepEqual(result.activeModules.map(module => module.id), ['active-module'])
  assert.equal(result.files.length, 5)
  assert.equal(result.files.some(file => file.includes('_archived') || file.includes(`${path.sep}.hidden`)), false)
  assert.equal(result.files.some(file => file.endsWith('host-contract.contract.mjs')), false)
  assert.equal(result.files.some(file => file.endsWith('host-contract.test.mjs')), true)
  assert.equal(result.contractFiles.length, 2)
})

test('fails discovery when an active module has no test file', t => {
  const repository = makeRepository(t)
  fs.mkdirSync(path.join(repository, 'modules/new-active-module'), { recursive: true })
  assert.throws(() => discoverTests(repository), /Active modules require at least one \*\.test\.mjs file: new-active-module/)
})

test('NODE_OPTIONS preloads a guard from a path containing spaces on Windows-style paths', t => {
  const repository = makeRepository(t)
  fs.writeFileSync(path.join(repository, 'scripts/network-guard.cjs'), "process.env.TEST_GUARD_LOADED = 'yes'\n")
  const env = testEnvironment(repository)
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.TEST_GUARD_LOADED || "missing")'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, 'yes')
})

test('removes GitHub and package credentials from the test child environment', t => {
  const repository = makeRepository(t)
  const oldGitHubToken = process.env.GITHUB_TOKEN
  const oldGhToken = process.env.GH_TOKEN
  process.env.GITHUB_TOKEN = 'must-not-leak'
  process.env.GH_TOKEN = 'also-must-not-leak'
  try {
    const env = testEnvironment(repository)
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.equal(env.GH_TOKEN, undefined)
  } finally {
    if (oldGitHubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = oldGitHubToken
    if (oldGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = oldGhToken
  }
})
