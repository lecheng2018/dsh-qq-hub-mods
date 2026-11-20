import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, parse as parsePath, resolve } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { validateEntrySource, validateManifest, isModuleId, isSemver } from './validation.mjs'

export const DEFAULT_ARTIFACT_LIMITS = Object.freeze({
  maxZipBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
})

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const utf8 = new TextDecoder('utf-8', { fatal: true })

function fail(message) {
  throw new TypeError(`Invalid module artifact: ${message}`)
}

function limitsFrom(options = {}) {
  const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...options }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`)
  }
  return limits
}

function read(buffer, offset, size, label) {
  if (offset < 0 || size < 0 || offset + size > buffer.length) fail(`truncated ${label}`)
}

function decodeName(bytes) {
  try { return utf8.decode(bytes) } catch { fail('ZIP entry name is not valid UTF-8') }
}

function safeEntryPath(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) {
    fail(`unsafe ZIP path ${JSON.stringify(name)}`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) fail(`control character in ZIP path ${JSON.stringify(name)}`)
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) fail(`unsafe ZIP path ${JSON.stringify(name)}`)
  const reservedDevice = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu
  if (parts.some(part => part.includes(':') || /[. ]$/u.test(part) || reservedDevice.test(part))) {
    fail(`unsafe Windows path segment in ${JSON.stringify(name)}`)
  }
  if (parts.some(part => part.startsWith('.') || /^node_modules$/iu.test(part) || /\.test\.(?:mjs|cjs|js)$/iu.test(part) || /^(?:test|tests|fixtures|coverage)$/iu.test(part))) {
    fail(`development, hidden, or temporary path is not allowed: ${JSON.stringify(name)}`)
  }
  if (parts.some(part => /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?)$/iu.test(part)
    || /\.(?:pem|key|p12|pfx|keystore|jks|log|tmp|temp|bak|backup|swp|swo)$/iu.test(part))) {
    fail(`secret or temporary file is not allowed: ${JSON.stringify(name)}`)
  }
  return parts
}

function scanTextForSecrets(name, data) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const textExtensions = new Set(['js', 'mjs', 'cjs', 'json', 'md', 'txt', 'yml', 'yaml', 'sh', 'html', 'css', 'xml', 'toml', 'ini', 'conf'])
  if (!textExtensions.has(ext) && !['license', 'readme', 'dockerfile'].includes(basename(name).toLowerCase())) return
  if (data.includes(0)) return
  const text = data.toString('utf8')
  const patterns = [
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/u,
    /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_+/.=-]{24,}['"]/iu,
  ]
  if (patterns.some(pattern => pattern.test(text))) fail(`possible credential in ${JSON.stringify(name)}`)
}

function parseZip(buffer, limits) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('ZIP artifact must be a Buffer')
  if (buffer.length > limits.maxZipBytes) fail(`ZIP exceeds ${limits.maxZipBytes} bytes`)
  if (buffer.length < 22) fail('ZIP end record is missing')
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff)
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) !== EOCD) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) { endOffset = offset; break }
  }
  if (endOffset < 0) fail('ZIP end record is missing or has trailing data')
  const disk = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const diskEntries = buffer.readUInt16LE(endOffset + 8)
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (disk || centralDisk || diskEntries !== entryCount) fail('multi-disk ZIP is not supported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 is not supported')
  if (entryCount > limits.maxFiles) fail(`ZIP has more than ${limits.maxFiles} files`)
  if (centralOffset + centralSize !== endOffset) fail('invalid central directory bounds')
  read(buffer, centralOffset, centralSize, 'central directory')

  const entries = []
  const names = new Set()
  const foldedNames = new Set()
  let cursor = centralOffset
  let unpackedBytes = 0
  for (let index = 0; index < entryCount; index++) {
    read(buffer, cursor, 46, 'central directory header')
    if (buffer.readUInt32LE(cursor) !== CENTRAL) fail('invalid central directory signature')
    const madeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const startDisk = buffer.readUInt16LE(cursor + 34)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    read(buffer, cursor, recordEnd - cursor, 'central directory record')
    if (startDisk || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('ZIP64 or multi-disk entry is not supported')
    if (flags & ~0x0800) fail('encrypted or unsupported ZIP flags are not allowed')
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}`)
    if (method === 0 && compressedSize !== uncompressedSize) fail('stored entry size mismatch')
    if (madeBy >>> 8 === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000) fail('symbolic links are not allowed')
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    safeEntryPath(name)
    if (names.has(name)) fail(`duplicate ZIP path ${JSON.stringify(name)}`)
    names.add(name)
    const foldedName = name.normalize('NFC').toLocaleLowerCase('en-US')
    if (foldedNames.has(foldedName)) fail(`case-insensitive duplicate ZIP path ${JSON.stringify(name)}`)
    foldedNames.add(foldedName)
    if (name.endsWith('/')) fail('directory entries are not allowed')
    if (uncompressedSize > limits.maxUnpackedBytes - unpackedBytes) fail(`unpacked contents exceed ${limits.maxUnpackedBytes} bytes`)
    unpackedBytes += uncompressedSize

    read(buffer, localOffset, 30, 'local file header')
    if (buffer.readUInt32LE(localOffset) !== LOCAL) fail('invalid local file header signature')
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localChecksum = buffer.readUInt32LE(localOffset + 14)
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18)
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const localNameEnd = localOffset + 30 + localNameLength
    read(buffer, localOffset + 30, localNameLength + localExtraLength, 'local entry name and extra data')
    const localName = decodeName(buffer.subarray(localOffset + 30, localNameEnd))
    if (localName !== name || localFlags !== flags || localMethod !== method || localChecksum !== checksum
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) fail(`local and central headers differ for ${JSON.stringify(name)}`)
    const dataOffset = localNameEnd + localExtraLength
    const dataEnd = dataOffset + compressedSize
    if (dataEnd > centralOffset) fail(`entry overlaps central directory: ${JSON.stringify(name)}`)
    read(buffer, dataOffset, compressedSize, 'compressed file data')
    entries.push({ name, method, checksum, compressedSize, uncompressedSize, dataOffset, dataEnd, localOffset })
    cursor = recordEnd
  }
  if (cursor !== centralOffset + centralSize) fail('central directory entry count or size mismatch')
  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  let localCursor = 0
  const files = new Map()
  for (const entry of ordered) {
    if (entry.localOffset !== localCursor) fail('overlapping, duplicate, or unindexed local ZIP records')
    localCursor = entry.dataEnd
    const compressed = buffer.subarray(entry.dataOffset, entry.dataEnd)
    let body
    try {
      body = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.min(entry.uncompressedSize + 1, limits.maxUnpackedBytes + 1) })
    } catch (error) { fail(`cannot decompress ${JSON.stringify(entry.name)}: ${error.message}`) }
    if (body.length !== entry.uncompressedSize) fail(`unpacked size mismatch for ${JSON.stringify(entry.name)}`)
    if (crc32(body) !== entry.checksum) fail(`CRC32 mismatch for ${JSON.stringify(entry.name)}`)
    scanTextForSecrets(entry.name, body)
    files.set(entry.name, body)
  }
  if (localCursor !== centralOffset) fail('unindexed data before central directory')
  return { files, unpackedBytes }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('release entry must be an object')
  if (!isModuleId(record.id) || !isSemver(record.version)) fail('release entry needs a valid id and SemVer version')
  if (record.file !== `${record.id}.zip`) fail('release file must be <id>.zip')
  if (record.tag !== `${record.id}-v${record.version}`) fail('release tag must match id and version')
  if (!Number.isSafeInteger(record.size) || record.size < 0) fail('release size must be a nonnegative integer')
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/u.test(record.sha256)) fail('release sha256 must be a lowercase SHA-256 digest')
  if (typeof record.commit !== 'string' || (record.commit && !/^[a-f0-9]{40,64}(?![\s\S])/iu.test(record.commit))) fail('release commit must be empty or a hexadecimal Git object id')
  if (Object.hasOwn(record, 'dirty') && typeof record.dirty !== 'boolean') fail('release dirty marker must be boolean')
}

export function validateArtifact(buffer, releaseRecord, options = {}) {
  const limits = limitsFrom(options.limits ?? {})
  validateRecord(releaseRecord)
  if (buffer.length !== releaseRecord.size) fail(`ZIP byte size does not match release record for ${releaseRecord.id}`)
  const digest = createHash('sha256').update(buffer).digest('hex')
  if (digest !== releaseRecord.sha256) fail(`ZIP SHA-256 does not match release record for ${releaseRecord.id}`)
  const { files, unpackedBytes } = parseZip(buffer, limits)
  const manifestData = files.get('module.json')
  if (!manifestData) fail('module.json is missing at the ZIP root')
  let manifest
  try { manifest = JSON.parse(utf8.decode(manifestData)) } catch (error) { fail(`module.json is invalid JSON: ${error.message}`) }
  try { validateManifest(manifest, { expectedId: releaseRecord.id }) } catch (error) { fail(error.message) }
  if (manifest.version !== releaseRecord.version) fail('module.json version does not match release record')
  const entryData = files.get('index.mjs') ?? files.get('index.js')
  if (!entryData) fail('module entry index.mjs or index.js is missing at the ZIP root')
  let entrySource
  try { entrySource = utf8.decode(entryData) } catch { fail('module entry is not valid UTF-8') }
  try { validateEntrySource(entrySource, manifest) } catch (error) { fail(error.message) }
  if (!files.has('README.md') || !files.has('LICENSE')) fail('README.md and LICENSE must be included at the ZIP root')
  return { files: files.size, unpackedBytes }
}

function assertRegularFile(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${label} is missing: ${error.message}`) }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file, not a symlink`)
}

function assertRealDirectory(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${label} is missing: ${error.message}`) }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink`)
}

export function validateReleaseDirectory(directory, { limits, allowDirty = false } = {}) {
  const root = resolve(directory)
  assertRealDirectory(root, 'release output')
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`release output contains a non-file or symlink: ${entry.name}`)
    if (entry.name !== 'release.json' && !/^[a-z][a-z0-9-]{1,39}\.zip$/u.test(entry.name)) {
      throw new Error(`release output contains an unexpected or temporary file: ${entry.name}`)
    }
  }
  const releasePath = join(root, 'release.json')
  assertRegularFile(releasePath, 'release.json')
  if (lstatSync(releasePath).size > 4 * 1024 * 1024) throw new Error('release.json exceeds 4 MiB')
  const resolvedLimits = limitsFrom(limits)
  let records
  try { records = JSON.parse(readFileSync(releasePath, 'utf8')) } catch (error) { throw new Error(`release.json is invalid: ${error.message}`) }
  if (!Array.isArray(records)) throw new Error('release.json must be an array')
  const ids = new Set()
  const files = new Set(['release.json'])
  for (const record of records) {
    validateRecord(record)
    if (ids.has(record.id)) throw new Error(`release.json contains duplicate module id ${record.id}`)
    ids.add(record.id)
    files.add(record.file)
    if (record.dirty === true && !allowDirty) throw new Error(`release artifact ${record.file} has dirty Git provenance`)
    const artifactPath = join(root, record.file)
    assertRegularFile(artifactPath, record.file)
    const stat = lstatSync(artifactPath)
    if (stat.size > resolvedLimits.maxZipBytes) throw new Error(`release ZIP exceeds byte limit: ${record.file}`)
    if (stat.size !== record.size) throw new Error(`release size mismatch for ${record.file}`)
    const buffer = readFileSync(artifactPath)
    validateArtifact(buffer, record, { limits: resolvedLimits })
  }
  for (const entry of entries) if (!files.has(entry.name)) throw new Error(`release output has stale artifact ${entry.name}`)
  return records
}

export function assertNoSymlinkPath(path, { allowMissing = true } = {}) {
  const target = resolve(path)
  const { root } = parsePath(target)
  let current = root
  for (const part of target.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`path contains a symbolic link: ${current}`)
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) continue
      throw error
    }
  }
}

