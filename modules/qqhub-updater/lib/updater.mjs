// QQ Hub 本体更新执行器：
//   - 通过 DSH pluginManager 检查 dsh-qq-hub 的安装方式（git-pinned / tarball / registry / local-link / no-plugin-manager）
//   - 优先使用 DSH 原生 pluginManager.updateBundle（自带 HMR 卸载、安装、校验与失败自动回滚）
//   - 离线包/非固定 commit 场景支持下载 Release .tgz + 可选 sha256.txt 校验，再经 pluginManager 切换并在失败时回滚
//   - 绝不调用任意 shell 命令；所有路径和 URL 严格校验

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { compareSemver, normalizeVersion, validateMirrorPrefix } from './semver.mjs'
import { fetchTextWithLimit, isAllowedGitHubAssetUrl, resolveTagCommitSha } from './releases.mjs'

const FULL_COMMIT_HASH_RE = /#(?:[^#]*&)?([0-9a-f]{40})(?:&|$)/i
const TARBALL_SOURCE_RE = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
const MAX_TARBALL_BYTES = 30 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000
const SAFE_VERSION_FILE_RE = /[^0-9A-Za-z._-]+/g

/** 探测当前 DSH 中 dsh-qq-hub 的安装方式与是否支持一键/自动更新。 */
export async function inspectInstallEnvironment({ dsh, pkgName = 'dsh-qq-hub' } = {}) {
  let pluginManager = null
  let hmr = null
  try { pluginManager = dsh?.get?.('pluginManager') || null } catch {}
  try { hmr = dsh?.get?.('hmr') || null } catch {}

  if (!pluginManager || typeof pluginManager.listBundles !== 'function') {
    return {
      supported: false,
      mode: 'no-plugin-manager',
      modeLabel: '手动更新',
      hmr: Boolean(hmr),
      pkgName,
      source: '',
      installedVersion: '',
      reason: '当前 DSH 环境未提供 pluginManager 服务，仅支持检查更新与查看日志，请使用手动命令更新。',
    }
  }

  let bundles = []
  try {
    bundles = await pluginManager.listBundles()
  } catch (error) {
    return {
      supported: false,
      mode: 'inspect-failed',
      modeLabel: '状态未知',
      hmr: Boolean(hmr),
      pkgName,
      source: '',
      installedVersion: '',
      reason: `读取 DSH 插件列表失败：${error?.message || error}`,
    }
  }

  const bundle = Array.isArray(bundles) ? bundles.find((b) => b && b.name === pkgName) : null
  if (!bundle || !bundle.installed) {
    return {
      supported: false,
      mode: 'unmanaged',
      modeLabel: '未托管安装',
      hmr: Boolean(hmr),
      pkgName,
      source: '',
      installedVersion: '',
      reason: `未在当前 DSH profile 依赖中找到 ${pkgName}，无法自动更新。`,
    }
  }

  if (bundle.readOnlyReason) {
    return {
      supported: false,
      mode: 'readonly',
      modeLabel: '只读插件',
      hmr: Boolean(hmr),
      pkgName,
      source: String(bundle.source || ''),
      installedVersion: String(bundle.version || ''),
      reason: `插件处于只读状态（${bundle.readOnlyReason}），无法自动更新。`,
    }
  }

  const source = String(bundle.source || '').trim()
  const installedVersion = String(bundle.version || '')

  // link: 或本地目录路径（非 .tgz）：保护开发者工作区，拒绝自动覆盖
  if (/^link:/i.test(source) || ((/^file:/i.test(source) || /^[\\/]|^[A-Za-z]:[\\/]/.test(source)) && !TARBALL_SOURCE_RE.test(source))) {
    return {
      supported: false,
      mode: 'local-link',
      modeLabel: '本地开发链接',
      hmr: Boolean(hmr),
      pkgName,
      source,
      installedVersion,
      reason: '当前是通过本地目录链接运行的开发版（link/path），为避免覆盖你的本地源码已禁用自动更新。',
    }
  }

  // Git 固定提交（DSH 推荐在线安装形态：github:owner/repo#<40-hex>）
  if (/^(?:github|gitlab|bitbucket|git\+|https?:\/\/github\.com\/)/i.test(source) && !TARBALL_SOURCE_RE.test(source)) {
    const pinned = FULL_COMMIT_HASH_RE.test(source)
    return {
      supported: true,
      mode: pinned ? 'git-pinned' : 'git-unpinned',
      modeLabel: pinned ? 'Git 托管（支持自动回滚）' : 'Git 托管',
      hmr: Boolean(hmr),
      pkgName,
      source,
      installedVersion,
      reason: '',
    }
  }

  // 离线 .tgz 安装包或远程 .tgz URL
  if (TARBALL_SOURCE_RE.test(source)) {
    return {
      supported: true,
      mode: 'tarball',
      modeLabel: '离线包（.tgz）',
      hmr: Boolean(hmr),
      pkgName,
      source,
      installedVersion,
      reason: '',
    }
  }

  // npm / registry 安装
  if (source && !source.includes(':')) {
    return {
      supported: true,
      mode: 'registry',
      modeLabel: '包仓库托管',
      hmr: Boolean(hmr),
      pkgName,
      source,
      installedVersion,
      reason: '',
    }
  }

  return {
    supported: false,
    mode: 'unknown',
    modeLabel: '自定义来源',
    hmr: Boolean(hmr),
    pkgName,
    source,
    installedVersion,
    reason: `未识别的插件安装来源（${source || '空'}），请手动更新。`,
  }
}

/** 构造不同平台的手动更新命令（在无法自动更新或用户想手动执行时展示）。 */
export function buildManualCommands({ repo, release } = {}) {
  const safeRepo = repo || 'lecheng2018/dsh-qq-hub'
  const refSuffix = release?.tag && release?.prerelease ? `#${release.tag}` : ''
  const spec = `github:${safeRepo}${refSuffix}`
  return {
    windows: `& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add ${spec}`,
    linux: `dsh plugin --profile web add ${spec}`,
    tarballUrl: release?.tarballAsset?.url || `https://github.com/${safeRepo}/releases`,
  }
}

/** 从 sha256.txt 文本中提取指定文件名的预期 SHA-256 摘要。 */
export function parseSha256Text(text, targetFilename) {
  const lines = String(text || '').split(/\r?\n/)
  const target = basename(String(targetFilename || ''))
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line)
    if (!m) continue
    const hash = m[1].toLowerCase()
    const file = basename(m[2].trim())
    if (file === target) return hash
  }
  return ''
}

/** 清理下载目录里的旧安装包，最多保留最近 keep 个。 */
function pruneOldDownloads(downloadDir, keep = 2) {
  try {
    const files = readdirSync(downloadDir)
      .filter((n) => /^dsh-qq-hub-[0-9A-Za-z._-]+\.tgz$/.test(n))
      .map((name) => {
        const full = join(downloadDir, name)
        let mtimeMs = 0
        try { mtimeMs = statSync(full).mtimeMs } catch {}
        return { name, full, mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const f of files.slice(keep)) {
      try { rmSync(f.full, { force: true }) } catch {}
    }
  } catch {}
}

/** 组装带可选镜像前缀的下载 URL。 */
function applyMirror(url, mirrorPrefix) {
  if (!mirrorPrefix) return url
  const check = validateMirrorPrefix(mirrorPrefix)
  if (!check.ok || !check.value) return url
  return `${check.value}${url}`
}

/** 下载 Release .tgz 到受限目录并在提供 sha256.txt 时做完整性校验。 */
export async function downloadAndVerifyTarball({
  release,
  downloadDir,
  mirrorPrefix = '',
  fetchImpl = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const asset = release?.tarballAsset
  if (!asset || !isAllowedGitHubAssetUrl(asset.url)) {
    throw new Error('该版本未提供受信任的 GitHub Release .tgz 安装包')
  }
  const safeVer = String(release.version || 'unknown').replace(SAFE_VERSION_FILE_RE, '_')
  const fileName = `dsh-qq-hub-${safeVer}.tgz`
  const rootDir = resolve(downloadDir)
  mkdirSync(rootDir, { recursive: true })
  const finalPath = resolve(rootDir, fileName)
  if (!finalPath.startsWith(rootDir + (rootDir.endsWith('/') || rootDir.endsWith('\\') ? '' : (process.platform === 'win32' ? '\\' : '/')))) {
    throw new Error('下载路径校验失败')
  }
  const tmpPath = `${finalPath}.tmp-${Date.now()}`

  const downloadUrl = applyMirror(asset.url, mirrorPrefix)
  const res = await fetchImpl(downloadUrl, {
    headers: { 'User-Agent': 'dsh-qq-hub-updater' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`下载安装包失败（HTTP ${res.status}）`)
  const cl = Number(res.headers?.get?.('content-length') || 0)
  if (Number.isFinite(cl) && cl > MAX_TARBALL_BYTES) {
    throw new Error(`安装包超过大小上限（${Math.round(cl / 1024 / 1024)} MB）`)
  }

  const hash = createHash('sha256')
  const chunks = []
  let total = 0
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      total += buf.length
      if (total > MAX_TARBALL_BYTES) {
        try { await reader.cancel() } catch {}
        throw new Error('安装包超过 30 MB 上限，已中止下载')
      }
      hash.update(buf)
      chunks.push(buf)
    }
  } else {
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length > MAX_TARBALL_BYTES) throw new Error('安装包超过 30 MB 上限')
    total = buf.length
    hash.update(buf)
    chunks.push(buf)
  }
  if (total < 128) throw new Error('下载到的安装包为空或已损坏')
  const actualSha256 = hash.digest('hex')

  // 若该 Release 附带 sha256.txt，严格校验摘要
  let verifiedSha256 = false
  if (release.sha256Asset && isAllowedGitHubAssetUrl(release.sha256Asset.url)) {
    const shaRes = await fetchTextWithLimit(applyMirror(release.sha256Asset.url, mirrorPrefix), {
      fetchImpl,
      headers: { 'User-Agent': 'dsh-qq-hub-updater' },
      timeoutMs: 12_000,
      maxBytes: 64 * 1024,
    })
    if (!shaRes.ok) throw new Error(`拉取校验文件 sha256.txt 失败（HTTP ${shaRes.status}）`)
    const expected = parseSha256Text(shaRes.text, asset.name)
    if (expected) {
      if (expected !== actualSha256) {
        throw new Error(`安装包 SHA-256 校验不通过（期望 ${expected.slice(0, 12)}…，实际 ${actualSha256.slice(0, 12)}…）`)
      }
      verifiedSha256 = true
    }
  }

  writeFileSync(tmpPath, Buffer.concat(chunks, total))
  renameSync(tmpPath, finalPath)
  pruneOldDownloads(rootDir, 2)
  return { filePath: finalPath, bytes: total, sha256: actualSha256, verifiedSha256 }
}

/**
 * 在真正卸载/替换当前插件之前，先把升级计划准备好（解析 SHA 或下载校验 .tgz）。
 * 任何前置校验失败都在这里直接返回，绝不触碰当前运行中的 QQ Hub。
 */
export async function prepareUpdatePlan({
  env,
  release,
  currentVersion,
  allowDowngrade = false,
  repo,
  downloadDir,
  mirrorPrefix = '',
  shaCache = {},
  fetchImpl = fetch,
} = {}) {
  if (!env?.supported) {
    return { ok: false, message: env?.reason || '当前安装环境不支持自动更新' }
  }
  if (!release || !release.version) {
    return { ok: false, message: '未找到可更新的目标版本' }
  }
  if (release.installable === false) {
    return { ok: false, message: `版本 v${release.version} 仅来自更新日志记录，未关联可安装的 GitHub Release` }
  }
  const cur = normalizeVersion(currentVersion)
  const cmp = cur ? compareSemver(release.version, cur) : 1
  if (cmp === 0) {
    return { ok: false, message: `当前已经是 v${release.version}，无需重复更新` }
  }
  if (cmp < 0 && !allowDowngrade) {
    return { ok: false, message: `目标版本 v${release.version} 低于当前版本 v${cur}；自动更新不会降级，如需切换请在面板手动确认` }
  }

  // 1. Git 固定提交：升级直接走 DSH 原生 updateBundle；显式降级走 removeBundle + installBundle + 失败回滚
  if (env.mode === 'git-pinned') {
    const sha = await resolveTagCommitSha({
      repo,
      tag: release.tag,
      targetCommitish: release.targetCommitish,
      shaCache,
      fetchImpl,
    })
    const spec = `github:${repo}#${sha}`
    return {
      ok: true,
      plan: {
        strategy: cmp > 0 ? 'updateBundle-git' : 'reinstall',
        from: cur || String(currentVersion || ''),
        to: release.version,
        tag: release.tag,
        spec,
        sha,
        previousSpec: env.source,
        methodLabel: cmp > 0 ? 'DSH Git 升级（自动回滚保护）' : 'DSH Git 版本切换',
      },
    }
  }

  // 2. Registry 托管：升级走 updateBundle
  if (env.mode === 'registry' && cmp > 0) {
    return {
      ok: true,
      plan: {
        strategy: 'updateBundle-registry',
        from: cur || String(currentVersion || ''),
        to: release.version,
        tag: release.tag,
        spec: `${env.pkgName}@${release.version}`,
        previousSpec: env.source,
        methodLabel: 'DSH 仓库升级',
      },
    }
  }

  // 3. 离线 .tgz 或未固定 commit 的 Git：优先下载 Release .tgz 并校验，若无 .tgz 则尝试 pinned git spec
  if (release.tarballAsset && isAllowedGitHubAssetUrl(release.tarballAsset.url)) {
    const dl = await downloadAndVerifyTarball({
      release,
      downloadDir,
      mirrorPrefix,
      fetchImpl,
    })
    return {
      ok: true,
      plan: {
        strategy: 'reinstall',
        from: cur || String(currentVersion || ''),
        to: release.version,
        tag: release.tag,
        spec: dl.filePath,
        sha256: dl.sha256,
        verifiedSha256: dl.verifiedSha256,
        previousSpec: env.source,
        methodLabel: dl.verifiedSha256 ? 'Release 安装包（SHA-256 已校验）' : 'Release 安装包（.tgz）',
      },
    }
  }

  // 无 .tgz 资产时，尝试解析 tag commit SHA 走 git 安装
  const sha = await resolveTagCommitSha({
    repo,
    tag: release.tag,
    targetCommitish: release.targetCommitish,
    shaCache,
    fetchImpl,
  })
  return {
    ok: true,
    plan: {
      strategy: 'reinstall',
      from: cur || String(currentVersion || ''),
      to: release.version,
      tag: release.tag,
      spec: `github:${repo}#${sha}`,
      sha,
      previousSpec: env.source,
      methodLabel: 'DSH Git 安装',
    },
  }
}

function summarizeChangeError(res) {
  const err = res?.error
  if (typeof err === 'string' && err) return err
  if (err?.diagnostic) return String(err.diagnostic).slice(0, 260)
  if (err?.code) return String(err.code)
  if (res?.packageResult?.output) return String(res.packageResult.output).slice(-260)
  return res?.application || '未知错误'
}

/**
 * 执行已准备好的更新计划。
 * 注意：当 HMR 开启时，updateBundle / removeBundle 会卸载运行中的 dsh-qq-hub 自身；
 * 但 DSH pluginManager 属于宿主根上下文，Promise 会继续跑完并重新激活新版本。
 */
export async function executeUpdatePlan({ pluginManager, hmr, pkgName = 'dsh-qq-hub', plan } = {}) {
  const base = {
    from: plan.from,
    to: plan.to,
    tag: plan.tag,
    method: plan.methodLabel || plan.strategy,
    startedAt: Date.now(),
  }

  try {
    if (plan.strategy === 'updateBundle-git' || plan.strategy === 'updateBundle-registry') {
      const opts = plan.strategy === 'updateBundle-git' ? { spec: plan.spec } : undefined
      const upd = await pluginManager.updateBundle(pkgName, plan.to, opts)
      const app = upd?.result?.application || 'failed'
      const ok = app !== 'failed' && app !== 'cancelled'
      const restartRequired = app === 'restart-required'
      const restored = Boolean(upd?.restore && upd.restore.application !== 'failed' && upd.restore.application !== 'cancelled')
      return {
        ...base,
        ok,
        application: app,
        restartRequired,
        restored,
        finishedAt: Date.now(),
        message: ok
          ? (restartRequired ? `已安装 v${plan.to}，重启 DSH 后生效` : `已热更新到 v${plan.to}`)
          : `更新到 v${plan.to} 失败（${upd?.step || 'install'}：${summarizeChangeError(upd?.result)}）${restored ? '，已自动回滚到旧版本' : ''}`,
      }
    }

    // strategy === 'reinstall'（离线 .tgz 升级或显式降级切换通道）
    if (hmr && typeof pluginManager.removeBundle === 'function') {
      const removed = await pluginManager.removeBundle(pkgName)
      if (removed?.application === 'failed' || removed?.application === 'cancelled') {
        return {
          ...base,
          ok: false,
          application: removed.application,
          restartRequired: false,
          restored: false,
          finishedAt: Date.now(),
          message: `卸载旧版本失败：${summarizeChangeError(removed)}`,
        }
      }
      const installed = await pluginManager.installBundle(plan.spec, { enabled: true })
      const app = installed?.application || 'failed'
      const ok = app !== 'failed' && app !== 'cancelled'
      if (ok) {
        return {
          ...base,
          ok: true,
          application: app,
          restartRequired: app === 'restart-required',
          restored: false,
          finishedAt: Date.now(),
          message: app === 'restart-required' ? `已安装 v${plan.to}，重启 DSH 后生效` : `已切换到 v${plan.to}`,
        }
      }
      // 安装失败：尽量自动回滚到旧 source
      let restored = false
      if (plan.previousSpec) {
        try {
          if (installed?.stage === 'enable') await pluginManager.removeBundle(pkgName)
          const r = await pluginManager.installBundle(plan.previousSpec, { enabled: true })
          restored = Boolean(r && r.application !== 'failed' && r.application !== 'cancelled')
        } catch {}
      }
      return {
        ...base,
        ok: false,
        application: app,
        restartRequired: false,
        restored,
        finishedAt: Date.now(),
        message: `安装 v${plan.to} 失败：${summarizeChangeError(installed)}${restored ? '，已自动恢复旧版本' : ''}`,
      }
    }

    // 无 HMR：直接覆盖安装，提示重启生效
    const installed = await pluginManager.installBundle(plan.spec, { enabled: true })
    const app = installed?.application || 'failed'
    const ok = app !== 'failed' && app !== 'cancelled'
    return {
      ...base,
      ok,
      application: app,
      restartRequired: ok && app === 'restart-required',
      restored: false,
      finishedAt: Date.now(),
      message: ok
        ? (app === 'restart-required' ? `已安装 v${plan.to}，重启 DSH 后生效` : `已更新到 v${plan.to}`)
        : `安装 v${plan.to} 失败：${summarizeChangeError(installed)}`,
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      application: 'failed',
      restartRequired: false,
      restored: false,
      finishedAt: Date.now(),
      message: `执行更新异常：${error?.message || error}`,
    }
  }
}

/** 原子读写持久化状态文件（跨插件热重载保留缓存、ETag、更新进度与上次结果）。 */
export function createStateStore(filePath) {
  const defaultState = () => ({
    version: 1,
    etag: '',
    source: '',
    warning: '',
    lastError: '',
    lastCheckedAt: 0,
    releases: [],
    shaCache: {},
    lastNotifiedVersion: '',
    lastFailedVersion: '',
    updating: null,
    lastUpdate: null,
  })

  function load() {
    if (!filePath || !existsSync(filePath)) return defaultState()
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return defaultState()
      return {
        ...defaultState(),
        ...parsed,
        releases: Array.isArray(parsed.releases) ? parsed.releases : [],
        shaCache: parsed.shaCache && typeof parsed.shaCache === 'object' ? parsed.shaCache : {},
      }
    } catch {
      return defaultState()
    }
  }

  function save(state) {
    if (!filePath) return
    const dir = resolve(filePath, '..')
    mkdirSync(dir, { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, filePath)
  }

  return { load, save }
}
