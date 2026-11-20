import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(repository, ...args) {
  return execFileSync(process.env.GIT_EXECUTABLE || 'git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function createRepository(t) {
  const repository = mkdtempSync(join(tmpdir(), 'module-package-test-'))
  t.after(() => rmSync(repository, { recursive: true, force: true }))
  git(repository, 'init', '-q')
  git(repository, 'config', 'user.name', 'Package Test')
  git(repository, 'config', 'user.email', 'package@example.test')
  git(repository, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(repository, 'modules', 'example-mod'), { recursive: true })
  writeFileSync(join(repository, '.gitignore'), 'dist/\n')
  writeFileSync(join(repository, 'revoked.json'), '{"revoked":[]}\n')
  const manifest = { id: 'example-mod', name: 'Example', version: '1.0.0', description: 'A package fixture', author: 'Test', license: 'MIT', api: 1 }
  const directory = join(repository, 'modules', manifest.id)
  writeFileSync(join(directory, 'module.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'index.mjs'), "export default { id: 'example-mod', version: '1.0.0', setup() {} }\n")
  writeFileSync(join(directory, 'README.md'), '# Example\n')
  writeFileSync(join(directory, 'LICENSE'), 'MIT\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'fixture')
  return { repository, directory, manifest }
}
