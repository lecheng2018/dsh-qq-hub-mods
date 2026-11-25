import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareSemver,
  isInUpdateWindow,
  isPrerelease,
  normalizeVersion,
  parseGitHubRepo,
  selectForChannel,
  validateMirrorPrefix,
  validateUpdateWindow,
} from './lib/semver.mjs'
import {
  fetchReleases,
  mergeReleasesWithChangelog,
  parseChangelog,
  resolveTagCommitSha,
} from './lib/releases.mjs'
import {
  downloadAndVerifyTarball,
  executeUpdatePlan,
  inspectInstallEnvironment,
  parseSha256Text,
  prepareUpdatePlan,
} from './lib/updater.mjs'
import mod, { sanitizeSettingsPatch } from './index.mjs'

const MOD_DIR = fileURLToPath(new URL('.', import.meta.url))

function mockResponse({ status = 200, body = '', headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
}

const SAMPLE_GH_RELEASES = [
  {
    id: 104,
    tag_name: '1.5.4-test.20261126.1',
    name: '1.5.4 测试版：新功能预览',
    prerelease: true,
    draft: false,
    published_at: '2026-11-26T06:00:00Z',
    target_commitish: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    html_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/1.5.4-test.20261126.1',
    body: '### 测试版亮点\n- 新增实验性功能 A\n- 修复问题 B',
    assets: [
      {
        name: 'dsh-qq-hub-1.5.4-test.20261126.1.tgz',
        browser_download_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/download/1.5.4-test.20261126.1/dsh-qq-hub-1.5.4-test.20261126.1.tgz',
        size: 102400,
      },
    ],
  },
  {
    id: 103,
    tag_name: 'v1.5.3',
    name: 'Release v1.5.3',
    prerelease: false,
    draft: false,
    published_at: '2026-11-25T10:17:17Z',
    target_commitish: 'main',
    html_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/v1.5.3',
    body: '### 重点更新\n- **面板现代化重设计**\n- 修复记忆写入',
    assets: [
      {
        name: 'dsh-qq-hub-1.5.3.tgz',
        browser_download_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/download/v1.5.3/dsh-qq-hub-1.5.3.tgz',
        size: 204800,
      },
      {
        name: 'dsh-qq-hub.tgz',
        browser_download_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/download/v1.5.3/dsh-qq-hub.tgz',
        size: 204800,
      },
    ],
  },
  {
    id: 102,
    tag_name: '1.5.1-test.20261125.1',
    name: '1.5.1 测试版',
    prerelease: true,
    draft: false,
    published_at: '2026-11-25T01:49:44Z',
    target_commitish: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    html_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/1.5.1-test.20261125.1',
    body: '- 表情包加固',
    assets: [],
  },
  {
    id: 101,
    tag_name: 'v1.4.6',
    name: 'Release v1.4.6',
    prerelease: false,
    draft: false,
    published_at: '2026-11-16T08:00:00Z',
    target_commitish: 'cccccccccccccccccccccccccccccccccccccccc',
    html_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/v1.4.6',
    body: '- 稳定性修复',
    assets: [],
  },
  {
    id: 100,
    tag_name: 'v9.9.9',
    name: 'Draft release',
    prerelease: false,
    draft: true,
    published_at: '2026-11-26T00:00:00Z',
    target_commitish: 'main',
    html_url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/v9.9.9',
    body: 'should be ignored',
    assets: [],
  },
]

test('semver: parsing, prerelease comparison and channel selection', () => {
  assert.equal(normalizeVersion('v1.5.3'), '1.5.3')
  assert.equal(normalizeVersion('1.5.1-test.20261125.1'), '1.5.1-test.20261125.1')
  assert.equal(normalizeVersion('not-a-version'), '')

  assert.equal(compareSemver('1.5.3', '1.5.3-test.1'), 1)
  assert.equal(compareSemver('1.5.4-test.20261126.1', '1.5.3'), 1)
  assert.equal(compareSemver('1.5.1-test.20261125.10', '1.5.1-test.20261125.2'), 1)
  assert.equal(compareSemver('v1.5.3', '1.5.3'), 0)

  assert.equal(isPrerelease('1.5.3', false), false)
  assert.equal(isPrerelease('1.5.1-test.20261125.1', false), true)
  assert.equal(isPrerelease('1.5.3', true), true)

  const releases = SAMPLE_GH_RELEASES.filter((r) => !r.draft).map((r) => ({
    tag: r.tag_name,
    version: normalizeVersion(r.tag_name),
    prerelease: r.prerelease,
    publishedAt: r.published_at,
  }))

  // 稳定版通道：过滤 beta，1.5.1 -> 1.5.3 可更新
  const stable = selectForChannel(releases, 'stable', '1.5.1')
  assert.equal(stable.latest.version, '1.5.3')
  assert.deepEqual(stable.history.map((r) => r.version), ['1.4.6'])
  assert.equal(stable.hasUpdate, true)
  assert.equal(stable.relation, 'update-available')

  // Beta 通道：包含预发布与正式版，1.5.3 -> 1.5.4-test.20261126.1 可更新
  const beta = selectForChannel(releases, 'beta', '1.5.3')
  assert.equal(beta.latest.version, '1.5.4-test.20261126.1')
  assert.deepEqual(beta.history.map((r) => r.version), ['1.5.3', '1.5.1-test.20261125.1', '1.4.6'])
  assert.equal(beta.hasUpdate, true)

  // 当前在 Beta 高版本，切回稳定版时识别为 ahead-of-channel 且不判为有更新
  const ahead = selectForChannel(releases, 'stable', '1.5.4-test.20261126.1')
  assert.equal(ahead.latest.version, '1.5.3')
  assert.equal(ahead.hasUpdate, false)
  assert.equal(ahead.relation, 'ahead-of-channel')
})

test('validation: update window, mirror SSRF guard, repo parsing and settings patch', () => {
  assert.deepEqual(validateUpdateWindow(''), { ok: true, value: '' })
  assert.deepEqual(validateUpdateWindow('03:00-05:30'), { ok: true, value: '03:00-05:30' })
  assert.equal(validateUpdateWindow('25:00-05:00').ok, false)

  assert.equal(isInUpdateWindow('', new Date('2026-11-25T14:00:00')), true)
  assert.equal(isInUpdateWindow('03:00-05:00', new Date('2026-11-25T04:15:00')), true)
  assert.equal(isInUpdateWindow('03:00-05:00', new Date('2026-11-25T05:00:00')), false)
  // 跨午夜时段
  assert.equal(isInUpdateWindow('23:00-05:00', new Date('2026-11-25T23:30:00')), true)
  assert.equal(isInUpdateWindow('23:00-05:00', new Date('2026-11-25T02:00:00')), true)
  assert.equal(isInUpdateWindow('23:00-05:00', new Date('2026-11-25T12:00:00')), false)

  // SSRF / 协议拦截
  assert.deepEqual(validateMirrorPrefix(''), { ok: true, value: '' })
  assert.equal(validateMirrorPrefix('https://mirror.example.com/proxy').value, 'https://mirror.example.com/proxy/')
  assert.equal(validateMirrorPrefix('http://mirror.example.com/').ok, false)
  assert.equal(validateMirrorPrefix('https://127.0.0.1:8080/').ok, false)
  assert.equal(validateMirrorPrefix('https://192.168.1.1/').ok, false) // pii-scan:ignore
  assert.equal(validateMirrorPrefix('https://localhost/').ok, false)
  assert.equal(validateMirrorPrefix('https://user:pass@mirror.example.com/').ok, false) // pii-scan:ignore

  assert.equal(parseGitHubRepo({ repository: { url: 'https://github.com/lecheng2018/dsh-qq-hub.git' } }), 'lecheng2018/dsh-qq-hub')
  assert.equal(parseGitHubRepo({}), 'lecheng2018/dsh-qq-hub')

  assert.equal(sanitizeSettingsPatch({ channel: 'nightly' }).ok, false)
  assert.equal(sanitizeSettingsPatch({ checkIntervalHours: 0 }).ok, false)
  assert.equal(sanitizeSettingsPatch({ channel: 'beta', autoUpdate: true, checkIntervalHours: 12 }).ok, true)
})

test('releases: GitHub API ETag 304, CHANGELOG parsing & jsDelivr fallback', async () => {
  const md = `# 更新记录

## 1.5.3

**正式版（2026-11-25）**

- 重点修复 A

## 1.5.3 开发期变更明细（1.4.7-test → 1.5.1-test）

不应作为独立版本节出现

## 1.4.2

- 早期版本修复（2026-11-12）
`
  const parsed = parseChangelog(md, 'lecheng2018/dsh-qq-hub')
  assert.deepEqual(parsed.map((x) => x.version), ['1.5.3', '1.4.2'])
  assert.equal(parsed[0].publishedAt, '2026-11-25T00:00:00Z')

  // 1) GitHub API 200 + ETag
  let seenIfNoneMatch = ''
  const first = await fetchReleases({
    repo: 'lecheng2018/dsh-qq-hub',
    fetchImpl: async (url, init) => {
      seenIfNoneMatch = init?.headers?.['If-None-Match'] || ''
      assert.match(url, /api\.github\.com\/repos\/lecheng2018\/dsh-qq-hub\/releases/)
      return mockResponse({ status: 200, body: SAMPLE_GH_RELEASES, headers: { etag: 'W/"abc123"' } })
    },
  })
  assert.equal(first.ok, true)
  assert.equal(first.source, 'github-releases')
  assert.equal(first.etag, 'W/"abc123"')
  assert.equal(first.releases.length, 4) // 过滤掉 draft
  assert.equal(seenIfNoneMatch, '')

  // 2) ETag 304 复用缓存
  const second = await fetchReleases({
    repo: 'lecheng2018/dsh-qq-hub',
    cached: { etag: first.etag, source: first.source, releases: first.releases },
    fetchImpl: async (_url, init) => {
      seenIfNoneMatch = init?.headers?.['If-None-Match'] || ''
      return mockResponse({ status: 304, headers: { etag: 'W/"abc123"' } })
    },
  })
  assert.equal(seenIfNoneMatch, 'W/"abc123"')
  assert.equal(second.ok, true)
  assert.equal(second.notModified, true)
  assert.equal(second.releases.length, 4)

  // 3) GitHub API 403 限流时自动降级到 jsDelivr
  const degraded = await fetchReleases({
    repo: 'lecheng2018/dsh-qq-hub',
    fetchImpl: async (url) => {
      if (url.includes('api.github.com')) return mockResponse({ status: 403, body: { message: 'rate limit' } })
      if (url.includes('cdn.jsdelivr.net') && url.endsWith('package.json')) {
        return mockResponse({ status: 200, body: { name: 'dsh-qq-hub', version: '1.5.3' } })
      }
      if (url.includes('cdn.jsdelivr.net') && url.endsWith('CHANGELOG.md')) {
        return mockResponse({ status: 200, body: md })
      }
      return mockResponse({ status: 404 })
    },
  })
  assert.equal(degraded.ok, true)
  assert.equal(degraded.source, 'jsdelivr')
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.releases[0].version, '1.5.3')
  assert.equal(degraded.releases[1].version, '1.4.2')

  // 4) 合并历史：保留 GitHub Releases 安装信息并补齐更早 CHANGELOG 版本
  const merged = mergeReleasesWithChangelog(first.releases, parsed)
  assert.equal(merged.find((r) => r.version === '1.5.3').installable, true)
  assert.equal(merged.find((r) => r.version === '1.4.2').installable, false)
})

test('releases: resolveTagCommitSha handles lightweight and annotated tags', async () => {
  const sha = '1234567890abcdef1234567890abcdef12345678'
  // 直接从 40 位 targetCommitish 返回，不发请求
  const direct = await resolveTagCommitSha({
    repo: 'lecheng2018/dsh-qq-hub',
    tag: '1.5.4-test.1',
    targetCommitish: sha,
    fetchImpl: async () => { throw new Error('should not fetch') },
  })
  assert.equal(direct, sha)

  // 附注 tag（tag -> commit 二次解引用）
  const resolved = await resolveTagCommitSha({
    repo: 'lecheng2018/dsh-qq-hub',
    tag: 'v1.5.3',
    targetCommitish: 'main',
    fetchImpl: async (url) => {
      if (url.endsWith('/git/ref/tags/v1.5.3')) {
        return mockResponse({
          status: 200,
          body: {
            object: {
              type: 'tag',
              sha: '9999999999999999999999999999999999999999',
              url: 'https://api.github.com/repos/lecheng2018/dsh-qq-hub/git/tags/9999999999999999999999999999999999999999',
            },
          },
        })
      }
      if (url.endsWith('/git/tags/9999999999999999999999999999999999999999')) {
        return mockResponse({ status: 200, body: { object: { type: 'commit', sha } } })
      }
      return mockResponse({ status: 404 })
    },
  })
  assert.equal(resolved, sha)
})

test('updater: environment detection, sha256 tarball verify, git-pinned upgrade and rollback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qu-updater-test-'))
  try {
    // 环境识别：git-pinned / local-link / no-plugin-manager
    const envNone = await inspectInstallEnvironment({ dsh: { get: () => undefined } })
    assert.equal(envNone.supported, false)
    assert.equal(envNone.mode, 'no-plugin-manager')

    const envLink = await inspectInstallEnvironment({
      dsh: {
        get: (k) => (k === 'pluginManager'
          ? { listBundles: async () => [{ name: 'dsh-qq-hub', installed: true, version: '1.5.3', source: 'link:/dev/qqhub' }] }
          : undefined),
      },
    })
    assert.equal(envLink.supported, false)
    assert.equal(envLink.mode, 'local-link')

    const oldSha = 'e65737800fd95608617989ce1f49748345ce65ee'
    const newSha = '1111111111111111111111111111111111111111'
    const envGit = await inspectInstallEnvironment({
      dsh: {
        get: (k) => {
          if (k === 'hmr') return { baseDir: dir }
          if (k === 'pluginManager') {
            return {
              listBundles: async () => [{ name: 'dsh-qq-hub', installed: true, version: '1.5.0', source: `github:lecheng2018/dsh-qq-hub#${oldSha}` }],
            }
          }
          return undefined
        },
      },
    })
    assert.equal(envGit.supported, true)
    assert.equal(envGit.mode, 'git-pinned')
    assert.equal(envGit.hmr, true)

    // 准备 git-pinned 升级计划
    const rel = {
      tag: 'v1.5.3',
      version: '1.5.3',
      targetCommitish: newSha,
      installable: true,
    }
    const planned = await prepareUpdatePlan({
      env: envGit,
      release: rel,
      currentVersion: '1.5.0',
      repo: 'lecheng2018/dsh-qq-hub',
      downloadDir: dir,
    })
    assert.equal(planned.ok, true)
    assert.equal(planned.plan.strategy, 'updateBundle-git')
    assert.equal(planned.plan.spec, `github:lecheng2018/dsh-qq-hub#${newSha}`)

    // 禁止未授权自动降级
    const refusedDown = await prepareUpdatePlan({
      env: envGit,
      release: { tag: 'v1.4.6', version: '1.4.6', targetCommitish: oldSha, installable: true },
      currentVersion: '1.5.3',
      allowDowngrade: false,
      repo: 'lecheng2018/dsh-qq-hub',
      downloadDir: dir,
    })
    assert.equal(refusedDown.ok, false)

    // 执行 updateBundle-git
    const calls = []
    const outcome = await executeUpdatePlan({
      pluginManager: {
        updateBundle: async (name, ver, opts) => {
          calls.push({ name, ver, opts })
          return { from: '1.5.0', to: ver, step: 'install', result: { changed: true, application: 'applied' } }
        },
      },
      hmr: {},
      pkgName: 'dsh-qq-hub',
      plan: planned.plan,
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.restartRequired, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].opts.spec, `github:lecheng2018/dsh-qq-hub#${newSha}`)

    // Tarball SHA-256 校验（成功与篡改拒绝）
    const payload = Buffer.alloc(512, 0x42)
    const digest = createHash('sha256').update(payload).digest('hex')
    assert.equal(parseSha256Text(`${digest}  dsh-qq-hub-1.5.3.tgz\n`, 'dsh-qq-hub-1.5.3.tgz'), digest)

    const tarballRelease = {
      version: '1.5.3',
      tag: 'v1.5.3',
      tarballAsset: { name: 'dsh-qq-hub-1.5.3.tgz', url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/download/v1.5.3/dsh-qq-hub-1.5.3.tgz' },
      sha256Asset: { name: 'sha256.txt', url: 'https://github.com/lecheng2018/dsh-qq-hub/releases/download/v1.5.3/sha256.txt' },
    }
    const dlOk = await downloadAndVerifyTarball({
      release: tarballRelease,
      downloadDir: dir,
      fetchImpl: async (url) => {
        if (url.endsWith('.tgz')) return mockResponse({ status: 200, body: payload })
        if (url.endsWith('sha256.txt')) return mockResponse({ status: 200, body: `${digest}  dsh-qq-hub-1.5.3.tgz\n` })
        return mockResponse({ status: 404 })
      },
    })
    assert.equal(dlOk.verifiedSha256, true)
    assert.equal(dlOk.sha256, digest)

    await assert.rejects(() => downloadAndVerifyTarball({
      release: tarballRelease,
      downloadDir: dir,
      fetchImpl: async (url) => {
        if (url.endsWith('.tgz')) return mockResponse({ status: 200, body: payload })
        if (url.endsWith('sha256.txt')) return mockResponse({ status: 200, body: `${'0'.repeat(64)}  dsh-qq-hub-1.5.3.tgz\n` })
        return mockResponse({ status: 404 })
      },
    }), /SHA-256/)

    // reinstall 失败自动回滚到 previousSpec
    const installLog = []
    const failOutcome = await executeUpdatePlan({
      pluginManager: {
        removeBundle: async (n) => { installLog.push(['remove', n]); return { application: 'applied' } },
        installBundle: async (spec) => {
          installLog.push(['install', spec])
          if (spec === dlOk.filePath) return { application: 'failed', stage: 'install', error: { diagnostic: 'broken' } }
          return { application: 'applied' }
        },
      },
      hmr: {},
      pkgName: 'dsh-qq-hub',
      plan: {
        strategy: 'reinstall',
        from: '1.5.0',
        to: '1.5.3',
        tag: 'v1.5.3',
        spec: dlOk.filePath,
        previousSpec: `github:lecheng2018/dsh-qq-hub#${oldSha}`,
      },
    })
    assert.equal(failOutcome.ok, false)
    assert.equal(failOutcome.restored, true)
    assert.deepEqual(installLog.map(([op]) => op), ['remove', 'install', 'install'])
    assert.equal(installLog[2][1], `github:lecheng2018/dsh-qq-hub#${oldSha}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('module integration: routes, Outbox notification dedupe, auto-update and /update command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qu-mod-test-'))
  try {
    const hostRoot = join(dir, 'host')
    const dataRoot = join(dir, 'data')
    writeFileSync(join(dir, 'host-pkg-placeholder'), '')
    rmSync(join(dir, 'host-pkg-placeholder'))
    // 创建模拟宿主目录（package.json + CHANGELOG.md）
    const { mkdirSync } = await import('node:fs')
    mkdirSync(hostRoot, { recursive: true })
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({
      name: 'dsh-qq-hub',
      version: '1.5.0',
      repository: { url: 'https://github.com/lecheng2018/dsh-qq-hub.git' },
    }))
    writeFileSync(join(hostRoot, 'CHANGELOG.md'), '# 更新记录\n\n## 1.4.0\n\n- 旧历史版本\n')

    const routes = new Map()
    const commands = []
    const sent = []
    const updatedCalls = []
    let extSettings = { ...mod.defaults }

    const oldSha = 'e65737800fd95608617989ce1f49748345ce65ee'
    const targetSha = '2222222222222222222222222222222222222222'

    const api = {
      id: 'qqhub-updater',
      version: '1.5.0',
      log: { info() {}, warn() {}, debug() {} },
      config: () => ({ enabled: true, dryRun: false, ownerQQ: '10001', ext: { 'qqhub-updater': extSettings } }),
      settings: () => ({ ...mod.defaults, ...extSettings }),
      saveSettings: (patch) => { extSettings = { ...extSettings, ...patch }; return extSettings },
      dataDir: (...parts) => join(dataRoot, ...parts),
      core: {
        root: hostRoot,
        http: { body: async (req) => req?.body || {} },
      },
      dsh: {
        get: (k) => {
          if (k === 'hmr') return { baseDir: dir }
          if (k === 'pluginManager') {
            return {
              listBundles: async () => [{ name: 'dsh-qq-hub', installed: true, version: '1.5.0', source: `github:lecheng2018/dsh-qq-hub#${oldSha}` }],
              updateBundle: async (name, ver, opts) => {
                updatedCalls.push({ name, ver, opts })
                return { from: '1.5.0', to: ver, step: 'install', result: { changed: true, application: 'applied' } }
              },
            }
          }
          return undefined
        },
      },
      route: (path, fn) => routes.set(path, fn),
      command: (c) => commands.push(c),
      every: () => () => {},
      later: () => () => {},
      onDispose: () => {},
      sendText: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true } },
    }

    const fetchImpl = async (url) => {
      if (url.includes('/releases?')) return mockResponse({ status: 200, body: SAMPLE_GH_RELEASES, headers: { etag: 'W/"e1"' } })
      if (url.includes('/git/ref/tags/v1.5.3')) return mockResponse({ status: 200, body: { object: { type: 'commit', sha: targetSha } } })
      return mockResponse({ status: 404 })
    }

    const svc = mod.setup(api, { fetchImpl, scheduleUpdate: (fn) => fn() })

    // GET /state 只读，不发网络请求也不发通知
    const st0 = await routes.get('/state')({ method: 'GET' })
    assert.equal(st0.ok, true)
    assert.equal(st0.currentVersion, '1.5.0')
    assert.equal(st0.channel, 'stable')
    assert.equal(sent.length, 0)

    // GET 调用写路由被拒绝
    const badCheck = await routes.get('/check')({ method: 'GET' })
    assert.equal(badCheck.ok, false)
    const badCfg = await routes.get('/config')({ method: 'GET' })
    assert.equal(badCfg.ok, false)
    const badUpd = await routes.get('/update')({ method: 'GET' })
    assert.equal(badUpd.ok, false)

    // POST /check 拉取稳定版（发现 v1.5.3，合并本地 CHANGELOG 1.4.0 历史）
    const checked = await routes.get('/check')({ method: 'POST', body: { force: true } })
    assert.equal(checked.hasUpdate, true)
    assert.equal(checked.latest.version, '1.5.3')
    assert.ok(checked.history.some((h) => h.version === '1.4.6'))
    assert.ok(checked.history.some((h) => h.version === '1.4.0'))

    // tick：未开 autoUpdate 时通过 Outbox 通知主人，且同一版本不重复提醒
    await svc.tick({ force: true })
    await svc.tick({ force: true })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, 'private:10001')
    assert.match(sent[0].text, /1\.5\.3/)

    // 切换到 Beta 通道：看到 1.5.4-test.20261126.1
    const switched = await routes.get('/config')({ method: 'POST', body: { channel: 'beta', autoUpdate: true } })
    assert.equal(switched.ok, true)
    assert.equal(switched.channel, 'beta')
    assert.equal(switched.latest.version, '1.5.4-test.20261126.1')

    // 非法镜像地址在 /config 拦截
    const badMirror = await routes.get('/config')({ method: 'POST', body: { githubMirror: 'http://127.0.0.1/' } })
    assert.equal(badMirror.ok, false)

    // 开启 autoUpdate 后 tick 自动升级到 Beta 最新版本
    const autoRes = await svc.tick({ force: true })
    assert.equal(autoRes.autoUpdated, true)
    assert.equal(autoRes.ok, true)
    assert.equal(updatedCalls.length, 1)
    assert.equal(updatedCalls[0].ver, '1.5.4-test.20261126.1')

    // 主人命令 /更新 stable 切回稳定版并汇报状态
    assert.equal(commands.length, 1)
    const reply = await commands[0].run('stable')
    assert.match(reply, /稳定版/)
    assert.match(reply, /1\.5\.3/)

    svc.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('panel.js: evaluates cleanly and renders initial & loaded views without throwing', () => {
  const src = readFileSync(join(MOD_DIR, 'panel.js'), 'utf8')
  assert.equal(/dangerouslySetInnerHTML\s*[:=]/.test(src), false)

  const hMock = (type, props, ...children) => ({ type, props: props || {}, children })
  const stub = (name) => function Stub(p) { return { stub: name, ...p } }
  const uiMock = {
    Card: stub('Card'),
    Btn: stub('Btn'),
    Switch: stub('Switch'),
    Row: stub('Row'),
    Empty: stub('Empty'),
    Select: stub('Select'),
    Seg: stub('Seg'),
    Range: stub('Range'),
    ListInput: stub('ListInput'),
    NumInput: stub('NumInput'),
  }
  const callMock = async () => ({ ok: true })

  // 1) 初始加载态
  const ReactLoading = {
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  }
  const Comp1 = new Function('React', 'h', 'ui', 'call', src)(ReactLoading, hMock, uiMock, callMock)
  assert.equal(typeof Comp1, 'function')
  const loadingTree = Comp1({ toast: () => {}, reload: () => {} })
  assert.equal(loadingTree.props.className, 'qu-root')

  // 2) 完整数据态（Beta 通道 + 最新 Markdown 日志 + 历史日志展开 + 校验不放行 javascript: 链接）
  const loadedState = {
    ok: true,
    repo: 'lecheng2018/dsh-qq-hub',
    currentVersion: '1.5.3',
    currentIsBeta: false,
    channel: 'beta',
    relation: 'update-available',
    hasUpdate: true,
    source: 'github-releases',
    lastCheckedAt: Date.now() - 120_000,
    settings: { ...mod.defaults, channel: 'beta', autoCheck: true, autoUpdate: false, notifyOwner: true },
    env: { supported: true, mode: 'git-pinned', modeLabel: 'Git 托管（支持自动回滚）', hmr: true },
    latest: {
      version: '1.5.4-test.20261126.1',
      tag: '1.5.4-test.20261126.1',
      name: '1.5.4 测试版',
      prerelease: true,
      publishedAt: '2026-11-26T06:00:00Z',
      htmlUrl: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/1.5.4-test.20261126.1',
      body: '### 重点\n- **加粗** 与 `代码` 与 [安全链接](https://github.com/lecheng2018/dsh-qq-hub) 与 [恶意](javascript:alert(1))\n> 引用说明\n1. 第一项',
      tarballAsset: { name: 'dsh-qq-hub-1.5.4-test.20261126.1.tgz', size: 204800 },
      installable: true,
    },
    history: [
      {
        version: '1.5.3',
        tag: 'v1.5.3',
        name: 'Release v1.5.3',
        prerelease: false,
        publishedAt: '2026-11-25T10:17:17Z',
        htmlUrl: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/v1.5.3',
        body: '- 正式版更新',
        installable: true,
      },
      {
        version: '1.4.6',
        tag: 'v1.4.6',
        name: 'Release v1.4.6',
        prerelease: false,
        publishedAt: '2026-11-16T08:00:00Z',
        htmlUrl: 'https://github.com/lecheng2018/dsh-qq-hub/releases/tag/v1.4.6',
        body: '- 历史版本',
        installable: false,
      },
    ],
    manual: { linux: 'dsh plugin --profile web add github:lecheng2018/dsh-qq-hub', windows: 'dsh.cmd ...' },
  }
  let stateCall = 0
  const ReactLoaded = {
    Fragment: Symbol('Fragment'),
    useState: (init) => {
      stateCall++
      if (stateCall === 1) return [loadedState, () => {}] // data
      if (stateCall === 7) return [{ '1.5.3': true }, () => {}] // openHist
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  }
  const Comp2 = new Function('React', 'h', 'ui', 'call', src)(ReactLoaded, hMock, uiMock, callMock)
  const loadedTree = Comp2({ toast: () => {}, reload: () => {} })
  assert.equal(loadedTree.props.className, 'qu-root')
  assert.equal(loadedTree.children.length, 4) // 4 张主卡片：版本概览 + 自动更新设置 + 更新日志 + 历史更新日志

  // 展开内部 FoldCard 子树，确认 Markdown 渲染不会把 javascript: 渲染成 <a>
  const foldCards = loadedTree.children.filter((c) => typeof c?.type === 'function' && c.type.name === 'FoldCard')
  assert.equal(foldCards.length, 2)
  const latestCardTree = foldCards[0].type({ ...foldCards[0].props, children: foldCards[0].children })
  const jsonText = JSON.stringify(latestCardTree)
  assert.ok(jsonText.includes('https://github.com/lecheng2018/dsh-qq-hub'))
  assert.equal(jsonText.includes('"href":"javascript:'), false)
  // 历史更新日志卡片默认折叠，展开后渲染 2 条历史记录
  const histFold = foldCards[1].type({ ...foldCards[1].props, defaultOpen: true, children: foldCards[1].children })
  const histText = JSON.stringify(histFold)
  assert.ok(histText.includes('v1.5.3'))
  assert.ok(histText.includes('v1.4.6'))
})
