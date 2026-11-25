// 拉取 QQ Hub 发布列表与更新日志：
//   1. 首选 GitHub Releases API（支持 ETag / 304 省配额，完整返回稳定版与 Beta 预发布、更新说明与 .tgz 资产）
//   2. 网络受限或限流时自动降级到 jsDelivr / raw.githubusercontent.com 读取 package.json + CHANGELOG.md
//   3. 全部不可达时回退到上次缓存或本机已安装的 CHANGELOG.md（只读展示历史记录）

import { existsSync, readFileSync } from 'node:fs'
import { isPrerelease, normalizeVersion, sortReleases } from './semver.mjs'

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_API_BYTES = 2 * 1024 * 1024
const MAX_CHANGELOG_BYTES = 2 * 1024 * 1024
const FULL_SHA_RE = /^[0-9a-f]{40}$/i
const ALLOWED_GITHUB_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/** 校验远程下载链接是否属于 GitHub 官方发布域名。 */
export function isAllowedGitHubAssetUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    return u.protocol === 'https:' && ALLOWED_GITHUB_ASSET_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 带超时与响应体大小上限的文本抓取。 */
export async function fetchTextWithLimit(url, {
  fetchImpl = fetch,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_API_BYTES,
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  const res = await fetchImpl(url, { headers, signal, redirect: 'follow' })
  if (res.status === 304) {
    return { status: 304, ok: true, text: '', etag: res.headers?.get?.('etag') || '' }
  }
  const contentLength = Number(res.headers?.get?.('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`响应体超过上限（${Math.round(contentLength / 1024)} KB）`)
  }
  let text = ''
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      total += buf.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`响应体超过上限（${Math.round(maxBytes / 1024)} KB）`)
      }
      chunks.push(buf)
    }
    text = Buffer.concat(chunks, total).toString('utf8')
  } else {
    text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`响应体超过上限（${Math.round(maxBytes / 1024)} KB）`)
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    text,
    etag: res.headers?.get?.('etag') || '',
  }
}

/** 从 Release assets 里挑选最合适的 .tgz 包。 */
function pickTarballAsset(assets, version) {
  const list = Array.isArray(assets) ? assets : []
  const candidates = list
    .filter((a) => a && typeof a.name === 'string' && /\.tgz$/i.test(a.name) && isAllowedGitHubAssetUrl(a.browser_download_url))
  if (!candidates.length) return null
  const exact = candidates.find((a) => a.name === `dsh-qq-hub-${version}.tgz`)
  const chosen = exact || candidates.find((a) => a.name !== 'dsh-qq-hub.tgz') || candidates[0]
  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    size: Number(chosen.size) || 0,
  }
}

/** 从 Release assets 里挑选 sha256 校验文件（若有）。 */
function pickSha256Asset(assets) {
  const list = Array.isArray(assets) ? assets : []
  const found = list.find((a) => a && typeof a.name === 'string' && /sha256/i.test(a.name) && isAllowedGitHubAssetUrl(a.browser_download_url))
  if (!found) return null
  return { name: found.name, url: found.browser_download_url }
}

/** 把一条 GitHub Release 规整成统一结构。 */
export function normalizeGitHubRelease(raw, repo) {
  if (!raw || typeof raw !== 'object' || raw.draft) return null
  const tag = String(raw.tag_name || '').trim()
  const version = normalizeVersion(tag)
  if (!version) return null
  const prerelease = isPrerelease(version, Boolean(raw.prerelease))
  return {
    id: String(raw.id ?? tag),
    tag,
    version,
    name: String(raw.name || tag).trim(),
    prerelease,
    publishedAt: String(raw.published_at || raw.created_at || ''),
    targetCommitish: String(raw.target_commitish || '').trim(),
    htmlUrl: isAllowedGitHubAssetUrl(raw.html_url)
      ? raw.html_url
      : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    body: String(raw.body || '').trim(),
    tarballAsset: pickTarballAsset(raw.assets, version),
    sha256Asset: pickSha256Asset(raw.assets),
    installable: true,
    source: 'github-releases',
  }
}

/**
 * 解析 CHANGELOG.md 的二级标题（`## 1.5.3` / `## v1.4.6`），产出按版本排序的日志条目。
 * 跳过「未发布」「开发期变更明细」这类非独立发版节；同版本号保留第一段正式摘要。
 */
export function parseChangelog(markdown, repo, { limit = 40 } = {}) {
  const text = String(markdown || '')
  if (!text.trim()) return []
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = null
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current) sections.push(current)
      current = { heading: m[1].trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)

  const seen = new Set()
  const out = []
  for (const sec of sections) {
    if (/开发期变更明细|unreleased|未发布/i.test(sec.heading)) continue
    const vm = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)\b/.exec(sec.heading)
    if (!vm) continue
    const version = normalizeVersion(vm[1])
    if (!version || seen.has(version)) continue
    seen.add(version)
    const body = sec.lines.join('\n').trim()
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(sec.heading) || /(\d{4}-\d{2}-\d{2})/.exec(body.slice(0, 220))
    const publishedAt = dateMatch ? `${dateMatch[1]}T00:00:00Z` : ''
    const prerelease = isPrerelease(version, false)
    const tag = `v${version}`
    out.push({
      id: `changelog:${version}`,
      tag,
      version,
      name: sec.heading.startsWith('v') || sec.heading.startsWith(version) ? `v${sec.heading.replace(/^v/i, '')}` : sec.heading,
      prerelease,
      publishedAt,
      targetCommitish: '',
      htmlUrl: `https://github.com/${repo}/blob/main/CHANGELOG.md`,
      body,
      tarballAsset: null,
      sha256Asset: null,
      installable: false,
      source: 'changelog',
    })
    if (out.length >= limit) break
  }
  return sortReleases(out)
}

/**
 * 合并 GitHub Releases 与 CHANGELOG.md 历史节：
 * - GitHub Releases 条目保留全部安装元数据（tag、assets、targetCommitish）
 * - 仅存在于 CHANGELOG.md 的更早版本以只读历史日志补齐（installable: false），便于折叠查阅
 */
export function mergeReleasesWithChangelog(githubReleases, changelogEntries) {
  const map = new Map()
  for (const r of Array.isArray(githubReleases) ? githubReleases : []) {
    if (!r?.version) continue
    map.set(r.version, r)
  }
  for (const c of Array.isArray(changelogEntries) ? changelogEntries : []) {
    if (!c?.version) continue
    const existing = map.get(c.version)
    if (existing) {
      if (!existing.body && c.body) existing.body = c.body
    } else {
      map.set(c.version, c)
    }
  }
  return sortReleases([...map.values()])
}

/** 安全读取本地已安装的 CHANGELOG.md（缺失或读取失败返回空串）。 */
export function readLocalChangelog(filePath) {
  if (!filePath || !existsSync(filePath)) return ''
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 拉取远端发布与日志：优先 GitHub Releases API（带 ETag），失败自动降级 jsDelivr / raw.githubusercontent.com。
 */
export async function fetchReleases({
  repo,
  cached = null,
  localChangelogPath = '',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const localText = readLocalChangelog(localChangelogPath)
  const localHistory = parseChangelog(localText, repo)
  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-qq-hub-updater',
  }
  if (cached?.etag && Array.isArray(cached.releases) && cached.releases.length) {
    apiHeaders['If-None-Match'] = cached.etag
  }

  let primaryError = ''
  try {
    const res = await fetchTextWithLimit(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      fetchImpl,
      headers: apiHeaders,
      timeoutMs,
      maxBytes: MAX_API_BYTES,
    })
    if (res.status === 304 && Array.isArray(cached?.releases) && cached.releases.length) {
      return {
        ok: true,
        source: 'github-releases',
        notModified: true,
        etag: cached.etag,
        releases: mergeReleasesWithChangelog(cached.releases, localHistory),
        warning: '',
      }
    }
    if (!res.ok) {
      throw new Error(res.status === 403 ? 'GitHub API 触发频率限制（403）' : `GitHub API 返回 HTTP ${res.status}`)
    }
    const rawList = JSON.parse(res.text)
    if (!Array.isArray(rawList)) throw new Error('GitHub Releases 返回格式异常')
    const ghReleases = rawList.map((r) => normalizeGitHubRelease(r, repo)).filter(Boolean)
    return {
      ok: true,
      source: 'github-releases',
      notModified: false,
      etag: res.etag || '',
      releases: mergeReleasesWithChangelog(ghReleases, localHistory),
      warning: '',
    }
  } catch (error) {
    primaryError = error?.message || String(error)
  }

  // 降级：jsDelivr / raw.githubusercontent.com 读取 main 分支 package.json 与 CHANGELOG.md
  const fallbackBases = [
    { name: 'jsdelivr', base: `https://cdn.jsdelivr.net/gh/${repo}@main` },
    { name: 'raw-github', base: `https://raw.githubusercontent.com/${repo}/main` },
  ]
  for (const fb of fallbackBases) {
    try {
      const pkgRes = await fetchTextWithLimit(`${fb.base}/package.json`, {
        fetchImpl,
        headers: { 'User-Agent': 'dsh-qq-hub-updater' },
        timeoutMs,
        maxBytes: 256 * 1024,
      })
      if (!pkgRes.ok) throw new Error(`HTTP ${pkgRes.status}`)
      const pkg = JSON.parse(pkgRes.text)
      const version = normalizeVersion(pkg?.version)
      if (!version) throw new Error('package.json 缺少合法版本号')

      let changelogText = ''
      try {
        const clRes = await fetchTextWithLimit(`${fb.base}/CHANGELOG.md`, {
          fetchImpl,
          headers: { 'User-Agent': 'dsh-qq-hub-updater' },
          timeoutMs,
          maxBytes: MAX_CHANGELOG_BYTES,
        })
        if (clRes.ok) changelogText = clRes.text
      } catch {
        changelogText = localText
      }

      const entries = parseChangelog(changelogText, repo)
      const hasLatest = entries.some((e) => e.version === version)
      const combined = hasLatest
        ? entries
        : sortReleases([
            {
              id: `${fb.name}:${version}`,
              tag: `v${version}`,
              version,
              name: `v${version}`,
              prerelease: isPrerelease(version, false),
              publishedAt: '',
              targetCommitish: '',
              htmlUrl: `https://github.com/${repo}/releases`,
              body: '',
              tarballAsset: null,
              sha256Asset: null,
              installable: false,
              source: fb.name,
            },
            ...entries,
          ])
      return {
        ok: true,
        source: fb.name,
        degraded: true,
        notModified: false,
        etag: cached?.etag || '',
        releases: mergeReleasesWithChangelog(combined, localHistory),
        warning: `GitHub Releases 接口暂不可达（${primaryError}），已通过 ${fb.name} 镜像获取主分支版本与更新日志（Beta 预发布与一键升级需连通 GitHub）。`,
      }
    } catch {
      // 尝试下一个降级源
    }
  }

  // 全离线回退：保留旧缓存或本机 CHANGELOG.md
  const fallbackList = Array.isArray(cached?.releases) && cached.releases.length
    ? mergeReleasesWithChangelog(cached.releases, localHistory)
    : localHistory
  return {
    ok: false,
    source: cached?.releases?.length ? (cached.source || 'cache') : 'local-changelog',
    notModified: false,
    etag: cached?.etag || '',
    releases: fallbackList,
    error: `检查更新失败：${primaryError}`,
    warning: '',
  }
}

/**
 * 解析某个 Git tag 对应的完整 40 位 Commit SHA（DSH pluginManager.updateBundle 的 git 方式要求精确到 40 位 SHA）。
 */
export async function resolveTagCommitSha({
  repo,
  tag,
  targetCommitish = '',
  shaCache = {},
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (FULL_SHA_RE.test(targetCommitish)) return targetCommitish.toLowerCase()
  const cached = shaCache && typeof shaCache[tag] === 'string' ? shaCache[tag] : ''
  if (FULL_SHA_RE.test(cached)) return cached.toLowerCase()
  if (!tag) throw new Error('缺少目标版本 tag，无法解析提交哈希')

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-qq-hub-updater',
  }
  const refUrl = `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`
  const res = await fetchTextWithLimit(refUrl, { fetchImpl, headers, timeoutMs, maxBytes: 256 * 1024 })
  if (!res.ok) throw new Error(`解析 tag ${tag} 失败（HTTP ${res.status}）`)
  const data = JSON.parse(res.text)
  const obj = data?.object
  if (!obj || typeof obj !== 'object') throw new Error(`tag ${tag} 引用数据异常`)
  if (obj.type === 'commit' && FULL_SHA_RE.test(obj.sha || '')) {
    return obj.sha.toLowerCase()
  }
  if (obj.type === 'tag' && typeof obj.url === 'string' && obj.url.startsWith(`https://api.github.com/repos/${repo}/git/tags/`)) {
    const tagRes = await fetchTextWithLimit(obj.url, { fetchImpl, headers, timeoutMs, maxBytes: 256 * 1024 })
    if (!tagRes.ok) throw new Error(`解析附注 tag ${tag} 失败（HTTP ${tagRes.status}）`)
    const tagObj = JSON.parse(tagRes.text)
    if (FULL_SHA_RE.test(tagObj?.object?.sha || '')) return tagObj.object.sha.toLowerCase()
  }
  throw new Error(`无法从 tag ${tag} 获取 40 位提交哈希`)
}
