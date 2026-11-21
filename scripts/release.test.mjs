import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  GitHubHttpError,
  GitHubRestClient,
  HISTORICAL_PROVENANCE_EXCEPTIONS,
  isHttpStatus,
  publishAndUpdateRegistry,
  publishRecords,
  updateRegistry,
} from './release.mjs'

const commit = 'a'.repeat(40)
const zip = Buffer.from('verified module ZIP bytes')
const sha256 = createHash('sha256').update(zip).digest('hex')
const record = Object.freeze({
  id: 'sample-mod',
  name: 'Sample Module',
  version: '1.2.3',
  description: 'A test module',
  category: 'tool',
  tags: ['sample'],
  author: 'maintainer',
  license: 'MIT',
  api: 1,
  minPluginVersion: '1.4.3',
  requires: [],
  capabilities: ['storage'],
  replacesBuiltin: false,
  tag: 'sample-mod-v1.2.3',
  file: 'sample-mod.zip',
  size: zip.length,
  sha256,
  commit,
})
const metadataBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const assetName = value => `${value.id}-release.json`

function createMock({ tagCommit = null, releaseExists = false, assets = [], contents = null, mainCommit = commit, beforePut = null } = {}) {
  const state = {
    tagCommit,
    release: releaseExists ? { id: 7, tag_name: record.tag } : null,
    assets: new Map(),
    contents,
    uploads: [],
    puts: [],
    creates: 0,
    warnings: [],
    mainCommit,
    beforePut,
  }
  for (const [name, bytes] of assets) state.assets.set(name, Buffer.from(bytes))
  const client = {
    async getTagCommit() { return state.tagCommit },
    async getReleaseByTag() { return state.release },
    async createRelease({ tag }) {
      state.creates++
      state.tagCommit = commit
      state.release = { id: 7, tag_name: tag }
      return state.release
    },
    async listAssets() {
      return [...state.assets].map(([name, bytes], index) => ({ id: index + 1, name, size: bytes.length }))
    },
    async downloadAsset(asset, limit) {
      const entry = [...state.assets.entries()][asset.id - 1]
      if (!entry) throw new GitHubHttpError('GET', 'https://api.github.com/assets', 404)
      assert.ok(entry[1].length <= limit)
      return Buffer.from(entry[1])
    },
    async uploadAsset(_releaseId, name, bytes) {
      if (state.assets.has(name)) throw new GitHubHttpError('POST', 'https://uploads.github.com/assets', 422)
      state.uploads.push(name)
      state.assets.set(name, Buffer.from(bytes))
      return { name }
    },
    async getContentsFile() { return state.contents },
    async getBranchCommit(branch) { return branch === 'main' ? state.mainCommit : (state.contents ? commit : null) },
    async createBranch() { return null },
    async putContentsFile(request) {
      state.puts.push(request)
      if (state.beforePut) await state.beforePut(state, request)
      const expectedSha = state.contents?.sha
      if (expectedSha !== request.sha) throw new GitHubHttpError('PUT', 'https://api.github.com/contents/index.json', 409)
      const index = JSON.parse(request.content.toString('utf8'))
      state.contents = { sha: `blob-${state.puts.length}`, content: Buffer.from(request.content), index }
      return { content: { sha: state.contents.sha } }
    },
  }
  return { client, state }
}

function artifactProvider() {
  return { zip, metadata: metadataBytes(record) }
}

test('interrupted publication resumes a tag with one missing asset and verifies every asset before indexing', async () => {
  const { client, state } = createMock({ tagCommit: commit, releaseExists: true, assets: [[record.file, zip]] })
  const result = await publishAndUpdateRegistry({
    client,
    records: [record],
    expectedCommit: commit,
    artifactProvider,
    generatedAt: () => '2026-11-20T00:00:00.000Z',
  })
  assert.deepEqual(state.uploads, [assetName(record)])
  assert.equal(result.results[0].status, 'published')
  assert.equal(result.registry.changed, true)
  assert.equal(state.puts.length, 1)
  assert.equal(state.assets.size, 2)
})

test('an existing asset with different bytes is rejected and never overwritten', async () => {
  const wrongZip = Buffer.from('different, conflicting ZIP content')
  const { client, state } = createMock({ tagCommit: commit, releaseExists: true, assets: [[record.file, wrongZip]] })
  await assert.rejects(
    publishRecords({ records: [record], expectedCommit: commit, client, artifactProvider }),
    /does not match the expected size or SHA-256/,
  )
  assert.deepEqual(state.uploads, [])
  assert.deepEqual([...state.assets.keys()], [record.file])
})

test('a tag bound to a different commit is rejected before release mutation when the existing Release cannot prove provenance', async () => {
  // 孤儿 tag 且 Release 里没有 release.json 资产：无法证明资产与 tag 自洽 → 拒绝恢复、拒绝变更。
  const { client, state } = createMock({ tagCommit: 'b'.repeat(40), releaseExists: true })
  await assert.rejects(
    publishRecords({ records: [record], expectedCommit: commit, client, artifactProvider }),
    /Recovery aborted for sample-mod-v1\.2\.3/,
  )
  assert.equal(state.creates, 0)
  assert.deepEqual(state.uploads, [])
})

test('an orphan tag with self-consistent Release assets is recovered into the registry without re-uploading', async () => {
  // PR17 真机事故复现：tag 已指向旧 commit、Release 双资产齐全，但 registry 没收录（发布中途崩溃）。
  // 恢复 = 校验 metadata.commit === tagCommit、zip 字节与 metadata 吻合后，原样收录，不上传任何资产。
  const oldCommit = 'b'.repeat(40)
  const orphanZip = Buffer.from('orphan module ZIP bytes from the interrupted run')
  const orphanDigest = createHash('sha256').update(orphanZip).digest('hex')
  // metadata 必须描述孤儿产物本身（size/sha256 与 tag 侧的 ZIP 一致），这正是恢复校验的依据。
  const orphan = { ...record, size: orphanZip.length, sha256: orphanDigest, commit: oldCommit }
  const { client, state } = createMock({
    tagCommit: oldCommit,
    releaseExists: true,
    assets: [[record.file, orphanZip], [assetName(record), metadataBytes(orphan)]],
  })
  state.release.tag_name = record.tag
  const warnings = []
  const result = await publishAndUpdateRegistry({
    client,
    records: [record],
    expectedCommit: commit,
    previousIndex: { modules: [] },
    artifactProvider: () => assert.fail('recovered release must not re-upload current artifacts'),
    generatedAt: () => '2026-11-20T00:00:00.000Z',
    warn: warning => warnings.push(warning),
  })
  assert.equal(result.results[0].status, 'recovered')
  assert.equal(result.results[0].assets, 'verified')
  assert.equal(result.records[0].commit, oldCommit, 'registry 条目保留孤儿产物自己的 commit（真实 provenance）')
  assert.deepEqual(state.uploads, [], '恢复绝不重传资产')
  assert.equal(state.creates, 0, '恢复绝不重建 Release')
  assert.equal(state.puts.length, 1, 'registry 需要收录恢复的版本')
  assert.match(warnings[0], /interrupted publication/)
  const indexed = JSON.parse(state.puts[0].content.toString('utf8')).modules[0]
  assert.equal(indexed.version, record.version)
  assert.equal(indexed.commit, oldCommit)
})

test('an orphan tag whose Release assets do not match its metadata is rejected, never recovered', async () => {
  // tag 自洽但 zip 字节与 metadata 不符（被篡改/上传中断的半截资产）→ 必须拒绝恢复。
  const oldCommit = 'b'.repeat(40)
  const oldRecord = { ...record, commit: oldCommit }
  const tamperedZip = Buffer.from('tampered bytes that do not match metadata digest')
  const { client, state } = createMock({
    tagCommit: oldCommit,
    releaseExists: true,
    assets: [[record.file, tamperedZip], [assetName(record), metadataBytes(oldRecord)]],
  })
  state.release.tag_name = record.tag
  await assert.rejects(
    publishRecords({ records: [record], expectedCommit: commit, client, previousIndex: { modules: [] }, artifactProvider }),
    /does not match the expected size or SHA-256/,
  )
  assert.equal(state.puts.length, 0)
  assert.deepEqual(state.uploads, [])
})

test('an orphan tag whose metadata commit disagrees with the git tag is rejected, never recovered', async () => {
  // metadata 自称的 commit 与 git tag 实际指向不一致 → provenance 不自洽，拒绝恢复。
  const tagCommit = 'b'.repeat(40)
  const lyingMetadata = { ...record, commit: 'c'.repeat(40) }
  const orphanZip = Buffer.from('some zip bytes')
  const orphan = { ...record, size: orphanZip.length, sha256: createHash('sha256').update(orphanZip).digest('hex') }
  const { client, state } = createMock({
    tagCommit,
    releaseExists: true,
    assets: [[record.file, orphanZip], [assetName(record), metadataBytes(lyingMetadata)]],
  })
  state.release.tag_name = record.tag
  await assert.rejects(
    publishRecords({ records: [record], expectedCommit: commit, client, previousIndex: { modules: [] }, artifactProvider }),
    /does not match the git tag/,
  )
  assert.equal(state.puts.length, 0)
  assert.deepEqual(state.uploads, [])
})

test('401 and 403 remain distinct HTTP failures and errors never contain the token', async () => {
  const token = 'top-secret-token-value'
  for (const status of [401, 403]) {
    const client = new GitHubRestClient({
      owner: 'owner', repo: 'repo', token,
      fetchImpl: async () => ({ ok: false, status, statusText: 'Unauthorized body may contain secret' }),
    })
    await assert.rejects(client.request('GET', '/repos/owner/repo'), error => {
      assert.ok(error instanceof GitHubHttpError)
      assert.equal(error.status, status)
      assert.equal(isHttpStatus(error, status), true)
      assert.equal(error.message.includes(token), false)
      assert.equal(error.message.includes('Unauthorized body'), false)
      return true
    })
  }
})

test('historical release metadata is validated against its registry fields and only exact provenance exceptions are allowed', async () => {
  const tag = 'meme-wiki-v0.2.7'
  const exception = HISTORICAL_PROVENANCE_EXCEPTIONS[tag]
  const historicalZip = Buffer.from('historical asset bytes')
  const historicalDigest = createHash('sha256').update(historicalZip).digest('hex')
  const previous = {
    id: 'meme-wiki', name: '梗百科', version: '0.2.7', description: 'local meme database', category: 'social',
    tags: ['梗', '百科'], author: 'Nightc-c', license: 'MIT', api: 1, minPluginVersion: '1.4.3', requires: [],
    capabilities: ['storage', 'schedule', 'tools', 'panel'], replacesBuiltin: false,
    path: `${tag}/meme-wiki.zip`, sha256: historicalDigest, size: historicalZip.length, commit: exception.registryCommit,
  }
  const priorRecord = {
    id: previous.id, name: previous.name, version: previous.version, description: previous.description,
    category: previous.category, tags: previous.tags, author: previous.author, license: previous.license,
    api: previous.api, minPluginVersion: previous.minPluginVersion, requires: previous.requires,
    capabilities: previous.capabilities,
    tag, file: 'meme-wiki.zip', size: previous.size, sha256: previous.sha256, commit: previous.commit,
  }
  const current = { ...priorRecord, commit, size: zip.length, sha256 }
  const { client, state } = createMock({
    tagCommit: exception.tagCommit,
    releaseExists: true,
    contents: { sha: 'historical-index', content: Buffer.from(JSON.stringify({
      schema: 1,
      generatedAt: '2026-11-19T00:00:00.000Z',
      assetsBase: 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/',
      revoked: [],
      modules: [previous],
    })) },
    assets: [[priorRecord.file, historicalZip], [assetName(previous), metadataBytes(priorRecord)]],
  })
  state.release.tag_name = tag
  const warnings = []
  const result = await publishAndUpdateRegistry({
    records: [current], expectedCommit: commit, client, previousIndex: { modules: [previous] },
    artifactProvider: () => assert.fail('historical release must not use current artifact'),
    generatedAt: () => '2026-11-20T00:00:00.000Z',
    warn: warning => warnings.push(warning),
  })
  assert.equal(result.results[0].status, 'historical')
  assert.equal(result.records[0].id, previous.id)
  assert.equal(result.records[0].tag, tag)
  assert.equal(result.records[0].file, 'meme-wiki.zip')
  assert.equal(result.registry.changed, false)
  assert.equal(state.uploads.length, 0)
  assert.equal(state.puts.length, 0)
  assert.match(warnings[0], /historical tag/)

  const wrongTag = 'b'.repeat(40)
  state.tagCommit = wrongTag
  await assert.rejects(
    publishRecords({ records: [current], expectedCommit: commit, client, previousIndex: { modules: [previous] }, artifactProvider }),
    /unapproved tag\/registry provenance mismatch/,
  )
})

test('historical indexed release with an absent asset blocks registry update rather than reconstructing from its tag', async () => {
  const tag = 'meme-wiki-v0.2.7'
  const exception = HISTORICAL_PROVENANCE_EXCEPTIONS[tag]
  const historicalZip = Buffer.from('historical asset bytes')
  const historicalDigest = createHash('sha256').update(historicalZip).digest('hex')
  const previous = {
    id: 'meme-wiki', version: '0.2.7', path: `${tag}/meme-wiki.zip`,
    sha256: historicalDigest, size: historicalZip.length, commit: exception.registryCommit,
  }
  const current = { ...record, id: previous.id, version: previous.version, tag, file: 'meme-wiki.zip' }
  const { client, state } = createMock({ tagCommit: exception.tagCommit, releaseExists: true })
  state.release.tag_name = tag
  await assert.rejects(
    publishAndUpdateRegistry({ client, records: [current], expectedCommit: commit, previousIndex: { modules: [previous] }, artifactProvider }),
    /missing asset.*cannot reconstruct it from a tag/,
  )
  assert.equal(state.puts.length, 0)
  assert.equal(state.uploads.length, 0)
})

test('registry conflict retries from latest content and preserves newer modules without downgrade', async () => {
  const newer = {
    schema: 1, generatedAt: '2026-11-19T00:00:00.000Z', assetsBase: 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/',
    revoked: [], modules: [{ id: 'another-mod', name: 'Newer concurrent module', version: '2.0.0', path: 'another-mod-v2.0.0/another-mod.zip', sha256: '1'.repeat(64), size: 1, commit }],
  }
  const initial = {
    schema: 1, generatedAt: '2026-11-18T00:00:00.000Z', assetsBase: newer.assetsBase, revoked: [],
    modules: [{ id: 'sample-mod', name: 'Old sample', version: '1.0.0', path: 'sample-mod-v1.0.0/sample-mod.zip', sha256: '2'.repeat(64), size: 1, commit }],
  }
  const { client, state } = createMock({ contents: { sha: 'blob-old', content: Buffer.from(JSON.stringify(initial)) } })
  state.beforePut = async (mutable, request) => {
    if (mutable.puts.length !== 1) return
    mutable.contents = { sha: 'blob-concurrent', content: Buffer.from(JSON.stringify(newer)) }
    throw new GitHubHttpError('PUT', 'https://api.github.com/contents/index.json', 409)
  }
  const result = await updateRegistry({
    client,
    releaseRecords: [record],
    revoked: [],
    generatedAt: () => '2026-11-20T00:00:00.000Z',
    warn: () => {},
  })
  assert.equal(result.attempts, 2)
  assert.equal(result.changed, true)
  assert.deepEqual(result.index.modules.map(entry => entry.id), ['another-mod', 'sample-mod'])
  assert.equal(result.index.modules.find(entry => entry.id === 'another-mod').version, '2.0.0')
  assert.equal(result.index.modules.find(entry => entry.id === 'sample-mod').version, '1.2.3')
  assert.equal(state.puts[1].sha, 'blob-concurrent')
  assert.equal(state.puts.length, 2)
})

test('registry index updates refuse same-version digest replacement and do not PUT unchanged content', async () => {
  const sameVersionWrongDigest = {
    id: record.id, name: record.name, version: record.version,
    path: `${record.tag}/${record.file}`, sha256: '0'.repeat(64), size: record.size, commit,
  }
  const currentIndex = {
    schema: 1, generatedAt: '2026-11-19T00:00:00.000Z',
    assetsBase: 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/', revoked: [], modules: [sameVersionWrongDigest],
  }
  const { client, state } = createMock({ contents: { sha: 'blob-same', content: Buffer.from(JSON.stringify(currentIndex)) } })
  await assert.rejects(updateRegistry({ client, releaseRecords: [record], revoked: [] }), /different release content/)

  const expectedIndex = {
    schema: 1, generatedAt: '2026-11-19T00:00:00.000Z',
    assetsBase: 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/', revoked: [],
    modules: [{ id: record.id, name: record.name, version: record.version, description: record.description, category: record.category, tags: record.tags, author: record.author, license: record.license, api: record.api, minPluginVersion: record.minPluginVersion, requires: record.requires, capabilities: record.capabilities, replacesBuiltin: record.replacesBuiltin, path: `${record.tag}/${record.file}`, sha256: record.sha256, size: record.size, commit: record.commit }],
  }
  const noOp = createMock({ contents: { sha: 'blob-noop', content: Buffer.from(JSON.stringify(expectedIndex)) } })
  const result = await updateRegistry({ client: noOp.client, releaseRecords: [record], revoked: [], generatedAt: () => '2026-11-20T00:00:00.000Z' })
  assert.equal(result.changed, false)
  assert.equal(noOp.state.puts.length, 0)
})
