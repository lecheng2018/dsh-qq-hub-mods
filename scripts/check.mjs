import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, isModuleId, validateEntrySource, validateManifest, validateRevoked } from './lib/validation.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = join(ROOT, 'modules')
let configuredGitExecutable = process.env.GIT_EXECUTABLE || 'git'
const isActiveModuleName = name => !name.startsWith('_') && !name.startsWith('.')

function runGit(repository, args, { allowedStatuses = [] } = {}) {
  const result = spawnSync(configuredGitExecutable, ['-C', repository, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`Git command failed (${args.join(' ')}): ${result.error.message}`)
  if (result.status !== 0 && !allowedStatuses.includes(result.status)) {
    const details = (result.stderr || '').trim()
    throw new Error(`Git command failed (${args.join(' ')}) with status ${result.status ?? 'unknown'}${details ? `: ${details}` : ''}`)
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function gitText(repository, args, options) {
  return runGit(repository, args, options).stdout.trim()
}

function listCurrentModules(repository) {
  const directory = join(repository, 'modules')
  const modules = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Module directory cannot be a symbolic link: ${entry.name}`)
    if (entry.isDirectory() && isActiveModuleName(entry.name)) modules.push({ id: entry.name, dir: join(directory, entry.name) })
  }
  return modules.sort((a, b) => a.id.localeCompare(b.id))
}

function activeTreeIds(repository, ref) {
  const result = runGit(repository, ['ls-tree', '-d', '--name-only', '-z', `${ref}:modules`])
  return result.stdout.split('\0').filter(name => name && isActiveModuleName(name))
}

function readRegularFile(path, label) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file, not a symlink`)
  return readFileSync(path, 'utf8')
}

function checkSourceSymlinks(directory, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in module payloads: ${name}`)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || /^(?:test|tests|fixtures|coverage|dist|build|tmp|temp)$/iu.test(entry.name)) continue
      checkSourceSymlinks(path, name)
    }
  }
}

function checkModule(module, knownIds) {
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(readRegularFile(join(module.dir, 'module.json'), `${module.id}/module.json`))
    validateManifest(manifest, { expectedId: module.id, knownIds })
  } catch (error) {
    return { errors: [`${module.id}: ${error.message}`], manifest: null }
  }
  const entryPath = ['index.mjs', 'index.js'].map(name => join(module.dir, name)).find(existsSync)
  if (!entryPath) errors.push(`${module.id}: missing index.mjs or index.js entry`)
  else {
    try {
      const source = readRegularFile(entryPath, `${module.id}/${entryPath.slice(module.dir.length + 1)}`)
      validateEntrySource(source, manifest)
    } catch (error) { errors.push(`${module.id}: ${error.message}`) }
  }
  for (const name of ['README.md', 'LICENSE']) {
    try { readRegularFile(join(module.dir, name), `${module.id}/${name}`) }
    catch { errors.push(`${module.id}: missing regular ${name}`) }
  }
  try { checkSourceSymlinks(module.dir) } catch (error) { errors.push(`${module.id}: ${error.message}`) }
  return { errors, manifest }
}

function exactTagExists(repository, tag) {
  const result = runGit(repository, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { allowedStatuses: [1] })
  return result.status === 0
}

function moduleReleaseTags(repository, id) {
  return gitText(repository, ['tag', '--list', `${id}-v*`]).split('\n').filter(Boolean)
}

function moduleHasAnyReleaseTag(repository, id) {
  return moduleReleaseTags(repository, id).length > 0
}

function trackedPathChanged(repository, left, right, moduleId) {
  const result = runGit(repository, ['diff', '--quiet', '--no-ext-diff', '--no-renames', left, right, '--', `modules/${moduleId}`], { allowedStatuses: [1] })
  return result.status === 1
}

function workingTreePathChanged(repository, moduleId) {
  const tracked = runGit(repository, ['diff', '--quiet', '--no-ext-diff', 'HEAD', '--', `modules/${moduleId}`], { allowedStatuses: [1] }).status === 1
  const untracked = gitText(repository, ['ls-files', '--others', '-z', '--', `modules/${moduleId}`])
  return tracked || untracked.length > 0
}

function untrackedModuleFiles(repository, moduleId) {
  return gitText(repository, ['ls-files', '--others', '-z', '--', `modules/${moduleId}`]).length > 0
}

function resolveBase(repository, base) {
  const resolved = gitText(repository, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
  const bases = gitText(repository, ['merge-base', '--all', resolved, 'HEAD']).split('\n').filter(Boolean)
  if (bases.length !== 1) throw new Error(bases.length ? `--base has ${bases.length} merge bases; refusing an ambiguous comparison` : '--base and HEAD have no merge base')
  return bases[0]
}

function baselineManifest(repository, baseline, id) {
  const path = `${baseline}:modules/${id}/module.json`
  const exists = runGit(repository, ['cat-file', '-e', path], { allowedStatuses: [1] })
  if (exists.status === 1) return null
  const text = gitText(repository, ['show', path])
  let manifest
  try { manifest = JSON.parse(text) } catch (error) { throw new Error(`Baseline modules/${id}/module.json is invalid JSON: ${error.message}`) }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new Error(`Baseline modules/${id}/module.json has no string version`)
  }
  return manifest
}

function checkGitPolicy(repository, modules, manifests, base) {
  const errors = []
  const head = gitText(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const baseline = base ? resolveBase(repository, base) : head
  const baselineIds = activeTreeIds(repository, baseline)
  const currentIds = new Set(modules.map(module => module.id))

  for (const oldId of baselineIds) {
    if (currentIds.has(oldId)) continue
    if (moduleHasAnyReleaseTag(repository, oldId)) {
      errors.push(`${oldId}: published module deletion/rename is blocked; this checker does not treat retirement as a security revocation`)
    }
  }

  for (const module of modules) {
    const manifest = manifests.get(module.id)
    if (!manifest) continue
    const version = manifest.version
    const tag = `${module.id}-v${version}`
    const tagExists = exactTagExists(repository, tag)
    for (const releasedTag of moduleReleaseTags(repository, module.id)) {
      const releasedVersion = releasedTag.slice(`${module.id}-v`.length)
      if (compareVersions(version, releasedVersion) < 0) {
        errors.push(`${module.id}: version ${version} is lower than published ${releasedVersion}`)
      }
    }
    const untracked = untrackedModuleFiles(repository, module.id)
    if (tagExists) {
      const changedSinceTag = trackedPathChanged(repository, tag, 'HEAD', module.id)
      const changedInWorktree = workingTreePathChanged(repository, module.id)
      if (changedSinceTag || changedInWorktree || untracked) errors.push(`${module.id}: published version ${version} is immutable; create a higher version`)
    }

    const changedFromBaseline = trackedPathChanged(repository, baseline, 'HEAD', module.id) || workingTreePathChanged(repository, module.id) || untracked
    if (changedFromBaseline && baselineIds.includes(module.id)) {
      const before = baselineManifest(repository, baseline, module.id)
      if (before && compareVersions(version, before.version) <= 0) {
        errors.push(`${module.id}: changed module version must be higher than ${before.version}`)
      }
    }
  }
  return errors
}

export function checkRepository(repository = ROOT, { base = '', git = configuredGitExecutable } = {}) {
  const resolvedRepository = resolve(repository)
  const previousGit = configuredGitExecutable
  configuredGitExecutable = git
  try {
    gitText(resolvedRepository, ['rev-parse', '--show-toplevel'])
    const modules = listCurrentModules(resolvedRepository)
    const knownIds = new Set(modules.map(module => module.id))
    const errors = []
    const manifests = new Map()
    for (const module of modules) {
      if (!isModuleId(module.id)) errors.push(`${module.id}: directory name is not a valid module id`)
      const result = checkModule(module, knownIds)
      errors.push(...result.errors)
      if (result.manifest) manifests.set(module.id, result.manifest)
    }
    let revoked
    try {
      revoked = JSON.parse(readRegularFile(join(resolvedRepository, 'revoked.json'), 'revoked.json'))
      validateRevoked(revoked)
    } catch (error) { errors.push(`revoked.json: ${error.message}`) }
    try { errors.push(...checkGitPolicy(resolvedRepository, modules, manifests, base)) }
    catch (error) { errors.push(`Git validation failed closed: ${error.message}`) }
    return { modules: modules.length, errors }
  } finally {
    configuredGitExecutable = previousGit
  }
}

function parseArguments(argv) {
  let base = ''
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--base') throw new Error(`Unknown argument ${argv[index]}`)
    if (base || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--base requires exactly one Git reference')
    base = argv[++index]
  }
  return { base }
}

export function main(argv = process.argv.slice(2)) {
  const { base } = parseArguments(argv)
  const result = checkRepository(ROOT, { base })
  for (const error of result.errors) console.error(`✗ ${error}`)
  if (!result.errors.length) console.log(`✓ checked ${result.modules} modules`)
  else console.error(`checked ${result.modules} modules with ${result.errors.length} error(s)`)
  return result.errors.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
