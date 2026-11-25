// SemVer 解析比较、通道筛选、更新时段判断与镜像 URL 安全校验（纯函数，无外部依赖）

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const NUMERIC_ID_RE = /^(0|[1-9]\d*)$/u
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/u

/** 规范化版本号（去首尾空白与前缀 v/V）。非合法 SemVer 返回空串。 */
export function normalizeVersion(raw) {
  const s = String(raw ?? '').trim()
  const m = SEMVER_RE.exec(s)
  if (!m) return ''
  return `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}${m[5] ? '+' + m[5] : ''}`
}

/** 解析 SemVer；非法返回 null。 */
export function parseSemver(raw) {
  const m = SEMVER_RE.exec(String(raw ?? '').trim())
  if (!m) return null
  return {
    major: BigInt(m[1]),
    minor: BigInt(m[2]),
    patch: BigInt(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] || '',
    normalized: `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}${m[5] ? '+' + m[5] : ''}`,
  }
}

/** 比较两个 SemVer：a > b 返回 1，a < b 返回 -1，相等返回 0。非法版本排在合法版本之后。 */
export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length ? -1 : 1
  }
  const count = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < count; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === y) continue
    const xn = NUMERIC_ID_RE.test(x)
    const yn = NUMERIC_ID_RE.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  if (a.prerelease.length === b.prerelease.length) return 0
  return a.prerelease.length > b.prerelease.length ? 1 : -1
}

/** 判断一个版本/发布条目是否属于预发布（Beta / test / alpha / rc）。 */
export function isPrerelease(version, releaseFlag = false) {
  if (releaseFlag === true) return true
  const parsed = parseSemver(version)
  if (parsed) return parsed.prerelease.length > 0
  return /-(?:test|beta|alpha|rc|pre|canary|dev)\b/i.test(String(version ?? ''))
}

/** 规范化通道名，只认 'stable' | 'beta'，默认 'stable'。 */
export function normalizeChannel(channel) {
  return String(channel || '').trim().toLowerCase() === 'beta' ? 'beta' : 'stable'
}

/** 按版本降序、发布时间降序排序发布列表。 */
export function sortReleases(releases) {
  return [...(Array.isArray(releases) ? releases : [])].sort((a, b) => {
    const cmp = compareSemver(b?.version || b?.tag, a?.version || a?.tag)
    if (cmp !== 0) return cmp
    const ta = Date.parse(a?.publishedAt || '') || 0
    const tb = Date.parse(b?.publishedAt || '') || 0
    return tb - ta
  })
}

/**
 * 根据通道从全量发布中筛出可见列表、最新目标以及相对当前版本的关系。
 * - stable: 仅保留正式版（非 draft、非 prerelease）
 * - beta:   保留全部非 draft 版本（正式版 + Beta/测试版），取 SemVer 最高者
 */
export function selectForChannel(releases, channel, currentVersion) {
  const ch = normalizeChannel(channel)
  const valid = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && normalizeVersion(r.version || r.tag))
    .map((r) => {
      const version = normalizeVersion(r.version || r.tag)
      return {
        ...r,
        version,
        prerelease: isPrerelease(version, Boolean(r.prerelease)),
      }
    })
  const filtered = ch === 'beta' ? valid : valid.filter((r) => !r.prerelease)
  const ordered = sortReleases(filtered)
  const latest = ordered[0] || null
  const history = ordered.slice(1)
  const current = normalizeVersion(currentVersion)

  let relation = 'unknown'
  let hasUpdate = false
  if (latest && current) {
    const cmp = compareSemver(latest.version, current)
    if (cmp > 0) {
      relation = 'update-available'
      hasUpdate = true
    } else if (cmp === 0) {
      relation = 'up-to-date'
    } else {
      relation = 'ahead-of-channel'
    }
  } else if (latest) {
    relation = 'unknown'
  } else {
    relation = 'empty'
  }

  return {
    channel: ch,
    current: current || String(currentVersion || ''),
    latest,
    history,
    allInChannel: ordered,
    hasUpdate,
    relation,
  }
}

/** 校验并规范化自动更新时段（空串 = 不限；否则 'HH:MM-HH:MM'）。 */
export function validateUpdateWindow(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: '' }
  const m = WINDOW_RE.exec(s)
  if (!m) return { ok: false, message: '静默更新时段格式应为 HH:MM-HH:MM（如 03:00-05:00），留空表示不限制' }
  return { ok: true, value: `${m[1]}:${m[2]}-${m[3]}:${m[4]}` }
}

/** 判断指定时刻是否处于更新时段内（支持跨午夜，如 23:00-05:00；空串视为随时允许）。 */
export function isInUpdateWindow(windowStr, now = new Date()) {
  const s = String(windowStr ?? '').trim()
  if (!s) return true
  const m = WINDOW_RE.exec(s)
  if (!m) return false
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

/** 校验是否内网/回环/保留主机名（防止 SSRF）。 */
function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number)
    if (parts.some((n) => n > 255)) return true
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

/** 校验可选的 GitHub 下载镜像前缀（仅允许公网 HTTPS，禁凭据/空白/内网地址）。 */
export function validateMirrorPrefix(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: '' }
  if (/\s/.test(s)) return { ok: false, message: '镜像地址不能包含空白字符' }
  let url
  try {
    url = new URL(s)
  } catch {
    return { ok: false, message: '镜像地址不是合法的 HTTPS 网址' }
  }
  if (url.protocol !== 'https:') return { ok: false, message: '镜像地址必须使用 https://' }
  if (url.username || url.password) return { ok: false, message: '镜像地址不允许包含账号或密码' }
  if (isPrivateOrLocalHost(url.hostname)) return { ok: false, message: '镜像地址不能指向本机或内网地址' }
  const normalized = url.toString().replace(/\/+$/, '') + '/'
  return { ok: true, value: normalized }
}

/** 从 package.json 或字符串中提取合法 GitHub owner/repo。 */
export function parseGitHubRepo(input, fallback = 'lecheng2018/dsh-qq-hub') {
  const raw = typeof input === 'string'
    ? input
    : typeof input?.repository === 'string'
      ? input.repository
      : input?.repository?.url || ''
  const trimmed = String(raw || '').trim()
  if (REPO_RE.test(trimmed)) return trimmed
  const m = trimmed.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?]|$)/i)
  if (m && REPO_RE.test(`${m[1]}/${m[2]}`)) return `${m[1]}/${m[2]}`
  return fallback
}
