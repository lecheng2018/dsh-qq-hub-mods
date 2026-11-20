import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex } from './publish-index.mjs'
import { compareVersions } from './lib/validation.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHA_RE = /^[0-9a-f]{40}$/iu
const HASH_RE = /^[0-9a-f]{64}$/u
const DEFAULT_API = 'https://api.github.com'
const DEFAULT_UPLOADS = 'https://uploads.github.com'
export const DEFAULT_LIMITS = Object.freeze({ maxAssetBytes: 64 * 1024 * 1024, maxMetadataBytes: 1024 * 1024 })

// These are the only historical provenance mismatches that are known and intentionally retained.
export const HISTORICAL_PROVENANCE_EXCEPTIONS = Object.freeze({
  'meme-wiki-v0.2.7': Object.freeze({
    registryCommit: 'bcb5b18b1d4e8f43a4f35859425fdda12a7530e6',
    tagCommit: '3c2fadd2b0e2cd9743e4138f551530b763b99d6b',
  }),
  'tophub-v0.3.1': Object.freeze({
    registryCommit: 'bcb5b18b1d4e8f43a4f35859425fdda12a7530e6',
    tagCommit: '3c2fadd2b0e2cd9743e4138f551530b763b99d6b',
  }),
})

function sanitiseUrl(value) {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|authorization|key/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}

export class GitHubHttpError extends Error {
  constructor(method, url, status) {
    super(`${method} ${sanitiseUrl(url)} failed (${status})`)
    this.name = 'GitHubHttpError'
    this.method = method
    this.url = sanitiseUrl(url)
    this.status = status
  }
}

export const isHttpStatus = (error, status) => error instanceof GitHubHttpError && error.status === status

function encode(value) {
  return encodeURIComponent(String(value))
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(value)
}

async function readResponseBuffer(response, maxBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        const chunk = asBuffer(part.value)
        total += chunk.length
        if (total > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes`)
        chunks.push(chunk)
      }
    } finally {
      try { reader.releaseLock?.() } catch { /* noop */ }
    }
    return Buffer.concat(chunks, total)
  }
  if (typeof response.arrayBuffer === 'function') {
    const result = Buffer.from(await response.arrayBuffer())
    if (result.length > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes`)
    return result
  }
  if (typeof response.text === 'function') {
    const result = Buffer.from(await response.text())
    if (result.length > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes`)
    return result
  }
  return Buffer.alloc(0)
}

function parseJson(buffer, label) {
  try { return JSON.parse(buffer.toString('utf8')) } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`) }
}

export class GitHubRestClient {
  constructor({ owner, repo, token = '', fetchImpl = globalThis.fetch, apiBase = DEFAULT_API, uploadsBase = DEFAULT_UPLOADS, timeoutMs = 30_000, maxResponseBytes = DEFAULT_LIMITS.maxAssetBytes } = {}) {
    if (!owner || !repo) throw new Error('GitHub repository owner and name are required')
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive safe integer')
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive safe integer')
    this.owner = owner
    this.repo = repo
    this.token = token
    this.fetch = fetchImpl
    this.apiBase = apiBase.replace(/\/$/u, '')
    this.uploadsBase = uploadsBase.replace(/\/$/u, '')
    this.timeoutMs = timeoutMs
    this.maxResponseBytes = maxResponseBytes
    this.allowedOrigins = new Set([new URL(this.apiBase).origin, new URL(this.uploadsBase).origin])
  }

  repositoryPath(suffix) {
    return `/repos/${encode(this.owner)}/${encode(this.repo)}${suffix}`
  }

  assertAllowedUrl(url) {
    const parsed = new URL(url)
    if (!this.allowedOrigins.has(parsed.origin)) throw new Error(`Refusing request to untrusted GitHub origin ${parsed.origin}`)
  }

  async request(method, pathOrUrl, { headers = {}, body, raw = false, maxBytes = this.maxResponseBytes } = {}) {
    const url = /^https?:\/\//iu.test(pathOrUrl) ? pathOrUrl : `${this.apiBase}${pathOrUrl}`
    this.assertAllowedUrl(url)
    const requestHeaders = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-qq-hub-mods-release',
      ...headers,
    }
    if (this.token) requestHeaders.authorization = `Bearer ${this.token}`
    let requestBody = body
    if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      requestBody = JSON.stringify(body)
      requestHeaders['content-type'] ||= 'application/json'
    }
    let response
    try {
      response = await this.fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`${method} ${sanitiseUrl(url)} network failure: ${error.message}`)
    }
    if (!response.ok) {
      let statusText = response.statusText || ''
      try {
        const errorBody = await readResponseBuffer(response, Math.min(maxBytes, 64 * 1024))
        if (!statusText && errorBody.length) statusText = parseJson(errorBody, 'GitHub error').message || ''
      } catch { /* Keep the status distinction even when an error body is malformed. */ }
      throw new GitHubHttpError(method, url, response.status, statusText)
    }
    if (response.status === 204) return null
    const data = await readResponseBuffer(response, maxBytes)
    return raw ? data : parseJson(data, `GitHub ${method} response`)
  }

  async getTagCommit(tag) {
    let ref
    try {
      ref = await this.request('GET', this.repositoryPath(`/git/ref/tags/${encode(tag)}`))
    } catch (error) {
      if (isHttpStatus(error, 404)) return null
      throw error
    }
    const object = ref?.object
    if (!object?.sha) throw new Error(`Git tag ${tag} response has no object SHA`)
    if (object.type !== 'tag') return object.sha
    const annotated = await this.request('GET', this.repositoryPath(`/git/tags/${encode(object.sha)}`))
    if (annotated?.object?.type !== 'commit' || !annotated.object.sha) throw new Error(`Git tag ${tag} does not resolve to a commit`)
    return annotated.object.sha
  }

  async getReleaseByTag(tag) {
    try {
      return await this.request('GET', this.repositoryPath(`/releases/tags/${encode(tag)}`))
    } catch (error) {
      if (isHttpStatus(error, 404)) return null
      throw error
    }
  }

  async createRelease({ tag, targetCommit, name, version, body = '' }) {
    return this.request('POST', this.repositoryPath('/releases'), {
      body: {
        tag_name: tag,
        target_commitish: targetCommit,
        name,
        body,
        draft: false,
        prerelease: String(version || '').includes('-'),
      },
    })
  }

  async listAssets(releaseId) {
    const result = []
    for (let page = 1; ; page++) {
      const pageItems = await this.request('GET', this.repositoryPath(`/releases/${encode(releaseId)}/assets?per_page=100&page=${page}`))
      if (!Array.isArray(pageItems)) throw new Error(`GitHub release ${releaseId} returned an invalid asset list`)
      result.push(...pageItems)
      if (pageItems.length < 100) return result
    }
  }

  async downloadAsset(asset, maxBytes = this.maxResponseBytes) {
    return this.request('GET', this.repositoryPath(`/releases/assets/${encode(asset.id)}`), {
      raw: true,
      maxBytes,
      headers: { accept: 'application/octet-stream' },
    })
  }

  async uploadAsset(releaseId, name, content, maxBytes = this.maxResponseBytes) {
    const buffer = asBuffer(content)
    if (buffer.length > maxBytes) throw new Error(`Upload ${name} exceeds ${maxBytes} bytes`)
    const url = `${this.uploadsBase}${this.repositoryPath(`/releases/${encode(releaseId)}/assets`)}?name=${encode(name)}`
    return this.request('POST', url, {
      body: buffer,
      maxBytes: 256 * 1024,
      headers: { accept: 'application/vnd.github+json', 'content-type': 'application/octet-stream' },
    })
  }

  async getContentsFile(filePath, branch = 'registry') {
    try {
      const response = await this.request('GET', this.repositoryPath(`/contents/${filePath.split('/').map(encode).join('/')}?ref=${encode(branch)}`))
      if (!response?.content || !response.sha) throw new Error(`GitHub contents response for ${filePath} is incomplete`)
      return { sha: response.sha, content: Buffer.from(response.content.replace(/\s/gu, ''), 'base64') }
    } catch (error) {
      if (isHttpStatus(error, 404)) return null
      throw error
    }
  }

  async putContentsFile({ filePath, branch = 'registry', content, sha, message }) {
    return this.request('PUT', this.repositoryPath(`/contents/${filePath.split('/').map(encode).join('/')}`), {
      body: {
        message,
        content: asBuffer(content).toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      },
    })
  }

  async getBranchCommit(branch = 'registry') {
    try {
      const ref = await this.request('GET', this.repositoryPath(`/git/ref/heads/${encode(branch)}`))
      return ref?.object?.sha || null
    } catch (error) {
      if (isHttpStatus(error, 404)) return null
      throw error
    }
  }

  async createBranch(branch, sha) {
    return this.request('POST', this.repositoryPath('/git/refs'), { body: { ref: `refs/heads/${branch}`, sha } })
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function recordTag(record) {
  return record.tag || `${record.id}-v${record.version}`
}

function metadataName(record) {
  return `${record.id}-release.json`
}

function matchingPrevious(record, previous) {
  const tag = recordTag(record)
  return (previous?.modules || []).find(entry => entry?.id === record.id && entry.version === record.version && entry.path === `${tag}/${record.file}`)
}

function validateRecords(records, expectedCommit) {
  if (!Array.isArray(records)) throw new Error('release.json must contain an array')
  if (!SHA_RE.test(expectedCommit || '')) throw new Error('--commit must be a full 40-character commit SHA')
  for (const record of records) {
    if (!record || typeof record !== 'object') throw new Error('release.json contains a non-object record')
    if (!record.id || !record.version || !record.file) throw new Error('release.json record lacks id, version, or file')
    if (recordTag(record) !== `${record.id}-v${record.version}`) throw new Error(`Release tag mismatch for ${record.id}`)
    if (String(record.commit).toLowerCase() !== String(expectedCommit).toLowerCase()) throw new Error(`Artifact commit mismatch for ${record.id}: expected ${expectedCommit}`)
    if (!Number.isInteger(record.size) || record.size < 0 || !HASH_RE.test(String(record.sha256 || ''))) throw new Error(`Artifact digest metadata is invalid for ${record.id}`)
  }
}

function expectedMetadata(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function compareZip(buffer, record, name) {
  if (buffer.length !== record.size || digest(buffer) !== String(record.sha256).toLowerCase()) throw new Error(`Existing release asset ${name} does not match the expected size or SHA-256`)
}

function compareMetadata(buffer, record, name, limits = DEFAULT_LIMITS) {
  if (buffer.length > limits.maxMetadataBytes) throw new Error(`Release metadata asset ${name} exceeds the configured limit`)
  let parsed
  try { parsed = JSON.parse(buffer.toString('utf8')) } catch { throw new Error(`Existing release asset ${name} is not valid JSON`) }
  if (!sameJson(parsed, record)) throw new Error(`Existing release metadata ${name} conflicts with the expected record`)
}

function compareHistoricalMetadata(buffer, previous, name, limits = DEFAULT_LIMITS) {
  if (buffer.length > limits.maxMetadataBytes) throw new Error(`Historical metadata asset ${name} exceeds the configured limit`)
  let metadata
  try { metadata = JSON.parse(buffer.toString('utf8')) } catch { throw new Error(`Historical metadata asset ${name} is not valid JSON`) }
  let projected
  try {
    projected = buildIndex({ release: [metadata], previous: { modules: [] }, generatedAt: 'historical-verification' }).modules[0]
  } catch (error) {
    throw new Error(`Historical metadata asset ${name} cannot be projected into the registry: ${error.message}`)
  }
  for (const key of Object.keys(projected)) {
    if (!sameJson(projected[key], previous[key])) throw new Error(`Historical metadata ${name} conflicts on registry field ${key}`)
  }
  return metadata
}

function historicalProvenanceAllowed(tag, registryCommit, tagCommit) {
  if (!registryCommit || !tagCommit) return false
  if (registryCommit.toLowerCase() === tagCommit.toLowerCase()) return true
  const exception = HISTORICAL_PROVENANCE_EXCEPTIONS[tag]
  return Boolean(exception && exception.registryCommit.toLowerCase() === registryCommit.toLowerCase() && exception.tagCommit.toLowerCase() === tagCommit.toLowerCase())
}

async function inspectAsset(client, assets, name, record, kind, limits) {
  const matching = assets.filter(candidate => candidate.name === name)
  if (matching.length > 1) throw new Error(`Release contains duplicate assets named ${name}`)
  const asset = matching[0]
  if (!asset) return { present: false }
  const maxBytes = kind === 'zip' ? limits.maxAssetBytes : limits.maxMetadataBytes
  if (Number.isInteger(asset.size) && asset.size > maxBytes) throw new Error(`Existing release asset ${name} exceeds the configured limit`)
  let content
  try { content = await client.downloadAsset(asset, maxBytes) } catch (error) {
    if (isHttpStatus(error, 404)) return { present: false, missingAfterListing: true }
    throw error
  }
  if (kind === 'zip') compareZip(content, record, name)
  else compareMetadata(content, record, name, limits)
  return { present: true }
}

async function inspectHistoricalAssets(client, release, previous, limits = DEFAULT_LIMITS) {
  if (!release?.id) throw new Error(`Release ${previous.path} has no numeric ID`)
  const assets = await client.listAssets(release.id)
  const zipName = previous.path?.split('/').at(-1)
  const metadataNameForPrevious = `${previous.id}-release.json`
  const zip = await inspectAsset(client, assets, zipName, previous, 'zip', limits)
  const metadataAsset = assets.find(candidate => candidate.name === metadataNameForPrevious)
  if (!metadataAsset) return { complete: false, missing: [!zip.present && zipName, metadataNameForPrevious].filter(Boolean) }
  let metadataContent
  try { metadataContent = await client.downloadAsset(metadataAsset, limits.maxMetadataBytes) } catch (error) {
    if (isHttpStatus(error, 404)) return { complete: false, missing: [!zip.present && zipName, metadataNameForPrevious].filter(Boolean) }
    throw error
  }
  const metadata = compareHistoricalMetadata(metadataContent, previous, metadataNameForPrevious, limits)
  return { complete: zip.present, metadata, missing: zip.present ? [] : [zipName] }
}

async function inspectReleaseAssets(client, release, record, limits = DEFAULT_LIMITS) {
  if (!release?.id) throw new Error(`Release ${recordTag(record)} has no numeric ID`)
  const assets = await client.listAssets(release.id)
  if (!Array.isArray(assets)) throw new Error(`Release ${recordTag(record)} returned an invalid asset list`)
  const zip = await inspectAsset(client, assets, record.file, record, 'zip', limits)
  const metadata = await inspectAsset(client, assets, metadataName(record), record, 'metadata', limits)
  return { complete: zip.present && metadata.present, missing: [!zip.present && record.file, !metadata.present && metadataName(record)].filter(Boolean) }
}

async function ensureAsset(client, release, name, content, record, kind, limits) {
  const maxBytes = kind === 'zip' ? limits.maxAssetBytes : limits.maxMetadataBytes
  if (content.length > maxBytes) throw new Error(`Upload ${name} exceeds the configured limit`)
  let assets = await client.listAssets(release.id)
  let status = await inspectAsset(client, assets, name, record, kind, limits)
  if (!status.present) {
    try {
      await client.uploadAsset(release.id, name, content, maxBytes)
    } catch (error) {
      if (!isHttpStatus(error, 409) && !isHttpStatus(error, 422)) throw error
      assets = await client.listAssets(release.id)
      status = await inspectAsset(client, assets, name, record, kind, limits)
      if (!status.present) throw error
    }
    assets = await client.listAssets(release.id)
    status = await inspectAsset(client, assets, name, record, kind, limits)
  }
  if (!status.present) throw new Error(`Release ${recordTag(record)} is missing asset ${name} after upload`)
}

async function createOrRecoverRelease(client, record, expectedCommit) {
  const tag = recordTag(record)
  let tagCommit = await client.getTagCommit(tag)
  if (tagCommit && tagCommit.toLowerCase() !== expectedCommit.toLowerCase()) throw new Error(`Tag ${tag} points to ${tagCommit}, expected artifact commit ${expectedCommit}`)
  let release = await client.getReleaseByTag(tag)
  if (!release) {
    try {
      release = await client.createRelease({ tag, targetCommit: expectedCommit, version: record.version, name: `${record.name || record.id} v${record.version}`, body: 'Published by the verified release artifact.' })
    } catch (error) {
      if (!isHttpStatus(error, 409) && !isHttpStatus(error, 422)) throw error
      tagCommit = await client.getTagCommit(tag)
      release = await client.getReleaseByTag(tag)
      if (!release || !tagCommit || tagCommit.toLowerCase() !== expectedCommit.toLowerCase()) throw error
    }
  }
  tagCommit = await client.getTagCommit(tag)
  if (!tagCommit || tagCommit.toLowerCase() !== expectedCommit.toLowerCase()) throw new Error(`Release ${tag} is not bound to artifact commit ${expectedCommit}`)
  return release
}

export async function publishRecords({ records, expectedCommit, client, previousIndex = { modules: [] }, artifactProvider, limits = DEFAULT_LIMITS, warn = message => console.warn(message) } = {}) {
  if (!client) throw new Error('publishRecords requires a REST client')
  validateRecords(records, expectedCommit)
  if (typeof artifactProvider !== 'function') throw new Error('publishRecords requires an artifact provider')
  const indexedRecords = []
  const results = []
  for (const record of records) {
    const tag = recordTag(record)
    const previous = matchingPrevious(record, previousIndex)
    if (previous) {
      const release = await client.getReleaseByTag(tag)
      const tagCommit = await client.getTagCommit(tag)
      if (!release || !tagCommit) throw new Error(`Historical release ${tag} is incomplete; cannot reconstruct it from a tag`)
      if (!historicalProvenanceAllowed(tag, previous.commit, tagCommit)) throw new Error(`Historical release ${tag} has an unapproved tag/registry provenance mismatch`)
      if (previous.commit.toLowerCase() !== tagCommit.toLowerCase()) warn(`Warning: historical tag ${tag} points to ${tagCommit}, registry provenance records ${previous.commit}; verified assets are retained without overwrite.`)
      const assets = await inspectHistoricalAssets(client, release, previous, limits)
      if (!assets.complete) throw new Error(`Historical release ${tag} is missing asset(s): ${assets.missing.join(', ')}; cannot reconstruct it from a tag`)
      indexedRecords.push(assets.metadata)
      results.push({ id: record.id, tag, status: 'historical', assets: 'verified' })
      continue
    }

    const files = await artifactProvider(record)
    const zip = asBuffer(files.zip)
    const metadata = asBuffer(files.metadata ?? expectedMetadata(record))
    compareZip(zip, record, record.file)
    compareMetadata(metadata, record, metadataName(record), limits)
    const release = await createOrRecoverRelease(client, record, expectedCommit)
    await ensureAsset(client, release, record.file, zip, record, 'zip', limits)
    await ensureAsset(client, release, metadataName(record), metadata, record, 'metadata', limits)
    const verified = await inspectReleaseAssets(client, release, record, limits)
    if (!verified.complete) throw new Error(`Release ${tag} is incomplete after publication`)
    indexedRecords.push(record)
    results.push({ id: record.id, tag, status: 'published', assets: 'verified' })
  }
  return { records: indexedRecords, results }
}

function withoutGeneratedAt(index) {
  const copy = { ...index }
  delete copy.generatedAt
  return copy
}

export async function updateRegistry({ client, releaseRecords, revoked = [], branch = 'registry', filePath = 'index.json', maxAttempts = 5, generatedAt = () => new Date().toISOString(), warn = message => console.warn(message) } = {}) {
  if (!client) throw new Error('updateRegistry requires a REST client')
  let branchReady = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let current = await client.getContentsFile(filePath, branch)
    if (!current && !branchReady) {
      const branchHead = await client.getBranchCommit(branch)
      if (!branchHead) {
        const mainHead = await client.getBranchCommit('main')
        if (!mainHead) throw new Error(`Cannot create ${branch}: main branch has no commit`)
        try { await client.createBranch(branch, mainHead) } catch (error) {
          if (!isHttpStatus(error, 409) && !isHttpStatus(error, 422)) throw error
        }
      }
      branchReady = true
      current = await client.getContentsFile(filePath, branch)
    }
    const previous = current ? parseJson(current.content, `registry ${filePath}`) : { modules: [], revoked: [] }
    const candidate = buildIndex({ release: releaseRecords, previous, revoked, generatedAt: generatedAt() })
    if (current && sameJson(withoutGeneratedAt(candidate), withoutGeneratedAt(previous))) return { index: previous, attempts: attempt, changed: false }
    const content = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)
    try {
      await client.putContentsFile({ filePath, branch, content, sha: current?.sha, message: 'index: update verified module registry' })
      return { index: candidate, attempts: attempt, changed: true }
    } catch (error) {
      if (!isHttpStatus(error, 409) || attempt === maxAttempts) throw error
      warn(`Registry update conflicted; retrying with the latest index (attempt ${attempt + 1}/${maxAttempts}).`)
    }
  }
  throw new Error('Registry update exhausted retry attempts')
}

export async function publishAndUpdateRegistry({ client, records, expectedCommit, previousIndex = { modules: [] }, artifactProvider, revoked = [], limits = DEFAULT_LIMITS, warn } = {}) {
  const published = await publishRecords({ records, expectedCommit, client, previousIndex, artifactProvider, limits, ...(warn ? { warn } : {}) })
  const registry = await updateRegistry({ client, releaseRecords: published.records, revoked, ...(warn ? { warn } : {}) })
  return { ...published, registry }
}

function parseArgs(argv) {
  const options = { dist: join(ROOT, 'dist'), repo: process.env.GITHUB_REPOSITORY || '', previous: '', revoked: join(ROOT, 'revoked.json') }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}`)
    const value = argv[++index]
    if (!value) throw new Error(`Missing value for ${name}`)
    if (name === '--dist') options.dist = resolve(value)
    else if (name === '--commit') options.commit = value
    else if (name === '--repo') options.repo = value
    else if (name === '--previous') options.previous = resolve(value)
    else if (name === '--revoked') options.revoked = resolve(value)
    else throw new Error(`Unknown argument ${name}`)
  }
  if (!options.commit) throw new Error('--commit is required')
  const [owner, repo] = options.repo.split('/')
  if (!owner || !repo) throw new Error('--repo or GITHUB_REPOSITORY must be owner/name')
  return { ...options, owner, repo }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv)
  const token = env.GITHUB_TOKEN || ''
  if (!token) throw new Error('GITHUB_TOKEN is required')
  const { validateReleaseDirectory } = await import('./lib/artifact.mjs')
  const records = validateReleaseDirectory(options.dist)
  const client = new GitHubRestClient({ owner: options.owner, repo: options.repo, token })
  let previous
  if (options.previous) previous = parseJson(readFileSync(options.previous), options.previous)
  else {
    const previousFile = await client.getContentsFile('index.json', 'registry')
    previous = previousFile ? parseJson(previousFile.content, 'registry index.json') : { modules: [], revoked: [] }
  }
  const result = await publishAndUpdateRegistry({
    client,
    records,
    expectedCommit: options.commit,
    previousIndex: previous,
    artifactProvider: record => ({ zip: readFileSync(join(options.dist, record.file)), metadata: expectedMetadata(record) }),
    revoked: parseJson(readFileSync(options.revoked), options.revoked).revoked || [],
  })
  console.log(`Verified ${result.results.length} release record(s); registry ${result.registry.changed ? 'updated' : 'unchanged'} in ${result.registry.attempts} attempt(s).`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch(error => { console.error(error.message); process.exitCode = 1 })
