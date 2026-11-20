import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoSymlinkPath, DEFAULT_ARTIFACT_LIMITS, validateArtifact, validateReleaseDirectory } from './lib/artifact.mjs'
import { compareVersions, isModuleId, validateEntrySource, validateManifest } from './lib/validation.mjs'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_LIMITS = DEFAULT_ARTIFACT_LIMITS
const EXCLUDED_DIRS = /^(?:node_modules|test|tests|fixtures|coverage|dist|build|tmp|temp|\.cache)$/iu
const EXCLUDED_FILES = /(?:\.test\.(?:mjs|cjs|js)|\.(?:tmp|temp|bak|backup|swp|swo|log)|^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?))$/iu
const EXCLUDED_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore|jks)$/iu

function runGit(repository, args, { git = process.env.GIT_EXECUTABLE || 'git', allowedStatuses = [] } = {}) {
  const result = spawnSync(git, ['-C', repository, ...args], {
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

function isExcludedPath(name, directory) {
  return name.startsWith('.') || (directory && EXCLUDED_DIRS.test(name)) || (!directory && (EXCLUDED_FILES.test(name) || EXCLUDED_EXTENSIONS.test(name)))
}

function collectFiles(directory, { maxFiles, maxUnpackedBytes }) {
  const files = []
  let totalBytes = 0
  function visit(current, prefix = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Module payload contains a symbolic link: ${name}`)
      if (entry.isDirectory()) {
        if (!isExcludedPath(entry.name, true)) visit(path, name)
        continue
      }
      if (!entry.isFile()) throw new Error(`Module payload contains a non-regular file: ${name}`)
      if (isExcludedPath(entry.name, false)) continue
      if (files.length >= maxFiles) throw new Error(`Module payload exceeds ${maxFiles} files`)
      if (stat.size > maxUnpackedBytes - totalBytes) throw new Error(`Module payload exceeds ${maxUnpackedBytes} unpacked bytes`)
      totalBytes += stat.size
      files.push({ name, path, size: stat.size })
    }
  }
  visit(directory)
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return { files, totalBytes }
}

function makeZip(files) {
  if (files.length > 0xffff) throw new Error('Too many files for the supported non-ZIP64 archive format')
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const path = Buffer.from(file.name, 'utf8')
    if (!path.length || path.length > 0xffff) throw new Error(`Invalid or too-long ZIP path ${JSON.stringify(file.name)}`)
    const data = file.data
    const compressed = deflateRawSync(data, { level: 9 })
    const checksum = crc32(data)
    if (compressed.length > 0xffffffff || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP64 is not supported')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    local.copy(central, 8, 6, 30)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, path, compressed)
    centrals.push(central, path)
    offset += local.length + path.length + compressed.length
  }
  const directory = Buffer.concat(centrals)
  if (offset > 0xffffffff || directory.length > 0xffffffff) throw new Error('ZIP64 is not supported')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function outputPaths(repository, output) {
  const out = resolve(repository, output || 'dist')
  const relativeToRoot = relative(repository, out)
  if (!relativeToRoot || relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error('Output directory must be dedicated and located below the repository root')
  }
  const moduleRoot = join(repository, 'modules')
  const relativeToModules = relative(moduleRoot, out)
  const isWithinModules = relativeToModules === '' || (!relativeToModules.startsWith(`..${sep}`) && relativeToModules !== '..' && !isAbsolute(relativeToModules))
  const modulesAboveOutput = relative(out, moduleRoot)
  if (isWithinModules || (!modulesAboveOutput.startsWith(`..${sep}`) && modulesAboveOutput !== '..' && !isAbsolute(modulesAboveOutput))) {
    throw new Error('Output directory cannot overlap modules source')
  }
  assertNoSymlinkPath(out, { allowMissing: true })
  return out
}

function listModules(repository) {
  return readdirSync(join(repository, 'modules'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(entry => ({ id: entry.name, directory: join(repository, 'modules', entry.name) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function readModule(repository, module, knownIds, limits) {
  if (!isModuleId(module.id)) throw new Error(`Invalid module directory name ${JSON.stringify(module.id)}`)
  const manifestPath = join(module.directory, 'module.json')
  const manifestStat = lstatSync(manifestPath)
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error(`${module.id}/module.json must be a regular file`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateManifest(manifest, { expectedId: module.id, knownIds })
  const entryName = ['index.mjs', 'index.js'].find(name => {
    try { const stat = lstatSync(join(module.directory, name)); return stat.isFile() && !stat.isSymbolicLink() } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  })
  if (!entryName) throw new Error(`${module.id} has no regular index.mjs or index.js entry`)
  validateEntrySource(readFileSync(join(module.directory, entryName), 'utf8'), manifest)
  for (const name of ['README.md', 'LICENSE']) {
    const path = join(module.directory, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${module.id}/${name} must be a regular file`)
  }
  const collected = collectFiles(module.directory, limits)
  const names = new Set(collected.files.map(file => file.name))
  for (const required of ['module.json', 'README.md', 'LICENSE']) if (!names.has(required)) throw new Error(`${module.id} package does not include ${required}`)
  if (!names.has('index.mjs') && !names.has('index.js')) throw new Error(`${module.id} package does not include its entry file`)
  const files = collected.files.map(file => ({ name: file.name, data: readFileSync(file.path) }))
  return { manifest, files }
}

function gitStatus(repository, git) {
  return gitText(repository, ['status', '--porcelain=v1', '--untracked-files=all'], { git })
}

function cleanOutputDirectory(output, repository) {
  assertNoSymlinkPath(output, { allowMissing: true })
  mkdirSync(output, { recursive: true })
  const stat = lstatSync(output)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Output path must be a regular directory, not a symlink')
  const entries = readdirSync(output, { withFileTypes: true })
  const allowedNames = new Set(['release.json'])
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Output directory contains a non-file or symlink: ${entry.name}`)
    if (entry.name !== 'release.json' && !/^[a-z][a-z0-9-]{1,39}\.zip$/u.test(entry.name)) {
      throw new Error(`Output directory contains an unexpected file: ${entry.name}`)
    }
  }
  const releasePath = join(output, 'release.json')
  if (entries.some(entry => entry.name === 'release.json')) {
    const releaseStat = lstatSync(releasePath)
    if (releaseStat.isSymbolicLink() || !releaseStat.isFile()) throw new Error('Existing release.json must be a regular file')
    let previous
    try { previous = JSON.parse(readFileSync(releasePath, 'utf8')) } catch (error) { throw new Error(`Existing release.json is invalid: ${error.message}`) }
    if (!Array.isArray(previous)) throw new Error('Existing release.json must be an array')
    for (const record of previous) {
      if (!record || !isModuleId(record.id) || record.file !== `${record.id}.zip`) throw new Error('Existing release.json contains an unsafe artifact path')
      allowedNames.add(record.file)
    }
  }
  for (const entry of entries) {
    if (entry.name === 'release.json') continue
    if (!allowedNames.has(entry.name) && !/^[a-z][a-z0-9-]{1,39}\.zip$/u.test(entry.name)) {
      throw new Error(`Output directory contains an unrecognized artifact: ${entry.name}`)
    }
  }
}

function parseArguments(argv) {
  const options = { out: 'dist', only: [], missing: false, requireClean: false }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (name === '--missing' || name === '--require-clean') {
      if (name === '--missing') options.missing = true
      else options.requireClean = true
      continue
    }
    if (!['--out', '--only', '--commit'].includes(name)) throw new Error(`Unknown argument ${name}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
    if (name === '--out') options.out = value
    else if (name === '--only') options.only = value.split(',').filter(Boolean)
    else options.commit = value
  }
  if (options.only.some(id => !isModuleId(id)) || new Set(options.only).size !== options.only.length) {
    throw new Error('--only requires unique valid module IDs separated by commas')
  }
  return options
}

export function packRepository(repository = ROOT, options = {}) {
  const root = resolve(repository)
  const git = options.git || process.env.GIT_EXECUTABLE || 'git'
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`)
  const output = outputPaths(root, options.out || 'dist')
  const head = gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { git })
  const commit = options.commit || head
  const resolvedCommit = gitText(root, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], { git })
  if (resolvedCommit.toLowerCase() !== head.toLowerCase()) throw new Error('--commit must identify the current HEAD')
  const status = gitStatus(root, git)
  const dirty = status.length > 0
  if (options.requireClean && dirty) throw new Error(`Git worktree is dirty; refusing --require-clean packaging:\n${status}`)
  const modules = listModules(root)
  const knownIds = new Set(modules.map(module => module.id))
  const selected = options.only?.length ? modules.filter(module => options.only.includes(module.id)) : modules
  const unknown = (options.only || []).filter(id => !knownIds.has(id))
  if (unknown.length) throw new Error(`Unknown module id(s) in --only: ${unknown.join(', ')}`)

  const tags = options.missing ? new Set(gitText(root, ['tag', '--list'], { git }).split('\n').filter(Boolean)) : new Set()
  const built = []
  const artifacts = new Map()
  for (const module of selected) {
    const { manifest, files } = readModule(root, module, knownIds, limits)
    const tag = `${manifest.id}-v${manifest.version}`
    if (tags.has(tag)) continue
    const buffer = makeZip(files)
    if (buffer.length > limits.maxZipBytes) throw new Error(`${module.id}.zip exceeds ${limits.maxZipBytes} bytes`)
    const record = {
      ...manifest,
      tag,
      file: `${manifest.id}.zip`,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      commit,
      dirty,
    }
    validateArtifact(buffer, record, { limits })
    built.push(record)
    artifacts.set(record.file, buffer)
  }

  cleanOutputDirectory(output, root)
  const parent = dirname(output)
  const stage = mkdtempSync(join(parent, `.pack-${basename(output)}-`))
  const backup = join(parent, `.pack-${basename(output)}-${randomUUID()}.old`)
  let movedOld = false
  try {
    for (const [name, buffer] of artifacts) writeFileSync(join(stage, name), buffer, { flag: 'wx' })
    writeFileSync(join(stage, 'release.json'), `${JSON.stringify(built, null, 2)}\n`, { flag: 'wx' })
    validateReleaseDirectory(stage, { limits, allowDirty: true })
    if (existsSync(output)) { renameSync(output, backup); movedOld = true }
    renameSync(stage, output)
    if (movedOld) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (movedOld && !existsSync(output) && existsSync(backup)) renameSync(backup, output)
    throw error
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  }
  return built
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const records = packRepository(ROOT, options)
  for (const record of records) console.log(`✓ ${record.file} (${record.size} bytes, sha256 ${record.sha256})`)
  console.log(`Packed ${records.length} module(s)${records.some(record => record.dirty) ? ' from a dirty worktree; release validation will reject these artifacts' : ''}`)
  return records
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
