// QQ Hub 本体检查更新与自动更新模块（插件商店版）
//
// 功能：
//   - 支持切换「稳定版（stable）」与「Beta 测试版（beta）」两个更新通道
//   - 拉取 GitHub Releases（带 ETag/304 省配额）与完整更新日志，网络受限时自动降级 jsDelivr / 本地 CHANGELOG.md
//   - 经 DSH pluginManager 执行一键/自动升级（优先原生 updateBundle，支持 HMR 热重载与失败自动回滚）
//   - 可选定时自动检查、可选自动更新（含静默更新时段保护，永不自动降级）与经 Outbox 的主人私聊通知
//   - 主人命令 /更新（/update）快速查看、切换通道或立即升级

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareSemver,
  isInUpdateWindow,
  isPrerelease,
  normalizeChannel,
  normalizeVersion,
  parseGitHubRepo,
  selectForChannel,
  validateMirrorPrefix,
  validateUpdateWindow,
} from './lib/semver.mjs'
import { fetchReleases } from './lib/releases.mjs'
import {
  buildManualCommands,
  createStateStore,
  executeUpdatePlan,
  inspectInstallEnvironment,
  prepareUpdatePlan,
} from './lib/updater.mjs'

const MODULE_ID = 'qqhub-updater'
const MODULE_VERSION = '1.0.0'
const DEFAULT_REPO = 'lecheng2018/dsh-qq-hub'
const TICK_MS = 15 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 15_000
const STALE_UPDATING_MS = 5 * 60 * 1000
const ALLOWED_INTERVAL_HOURS = new Set([1, 3, 6, 12, 24])

const DEFAULTS = Object.freeze({
  channel: 'stable',
  autoCheck: true,
  checkIntervalHours: 6,
  autoUpdate: false,
  autoUpdateWindow: '',
  notifyOwner: true,
  githubMirror: '',
})

/** 规范化并校验设置补丁，仅允许声明字段。 */
export function sanitizeSettingsPatch(patch, current = DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: '参数格式错误' }
  }
  const next = {}
  if (Object.hasOwn(patch, 'channel')) {
    const raw = String(patch.channel ?? '').trim().toLowerCase()
    if (raw !== 'stable' && raw !== 'beta') {
      return { ok: false, message: '更新通道只能选择 stable（稳定版）或 beta（测试版）' }
    }
    next.channel = raw
  }
  if (Object.hasOwn(patch, 'autoCheck')) {
    next.autoCheck = Boolean(patch.autoCheck)
  }
  if (Object.hasOwn(patch, 'checkIntervalHours')) {
    const h = Number(patch.checkIntervalHours)
    if (!Number.isFinite(h) || h < 1 || h > 168) {
      return { ok: false, message: '检查间隔应在 1～168 小时之间' }
    }
    next.checkIntervalHours = ALLOWED_INTERVAL_HOURS.has(Math.round(h)) ? Math.round(h) : Math.round(h)
  }
  if (Object.hasOwn(patch, 'autoUpdate')) {
    next.autoUpdate = Boolean(patch.autoUpdate)
  }
  if (Object.hasOwn(patch, 'autoUpdateWindow')) {
    const w = validateUpdateWindow(patch.autoUpdateWindow)
    if (!w.ok) return { ok: false, message: w.message }
    next.autoUpdateWindow = w.value
  }
  if (Object.hasOwn(patch, 'notifyOwner')) {
    next.notifyOwner = Boolean(patch.notifyOwner)
  }
  if (Object.hasOwn(patch, 'githubMirror')) {
    const m = validateMirrorPrefix(patch.githubMirror)
    if (!m.ok) return { ok: false, message: m.message }
    next.githubMirror = m.value
  }
  return { ok: true, patch: next, merged: { ...DEFAULTS, ...(current || {}), ...next } }
}

/** 读取宿主 package.json（获取包名、版本号、GitHub 仓库）。 */
function readHostPackage(root) {
  if (!root) return null
  const p = join(root, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 从请求读取 JSON body（兼容宿主 http.body 与单测 mock）。 */
async function readJsonBody(api, req) {
  if (req && req.body && typeof req.body === 'object') return req.body
  if (typeof api?.core?.http?.body === 'function') {
    try { return (await api.core.http.body(req)) || {} } catch { return {} }
  }
  return {}
}

/** 判断 HTTP 方法是否为 POST（或测试未指定 method 时拒绝非 POST）。 */
function isPost(req) {
  return String(req?.method || 'GET').toUpperCase() === 'POST'
}

export default {
  id: 'qqhub-updater',
  name: '版本更新',
  version: '1.0.0',
  api: 1,
  description: '检查并自动更新 QQ Hub 本体，支持稳定版 / Beta 测试版通道与可折叠历史更新日志',
  panel: 'panel.js',
  defaults: { ...DEFAULTS },

  setup(api, deps = {}) {
    const fetchImpl = deps.fetchImpl || globalThis.fetch
    const nowFn = deps.now || (() => Date.now())
    const scheduleUpdate = deps.scheduleUpdate || ((fn) => {
      const t = setTimeout(fn, 150)
      t.unref?.()
    })

    const hostRoot = api.core?.root || ''
    const hostPkg = readHostPackage(hostRoot)
    const pkgName = String(hostPkg?.name || 'dsh-qq-hub')
    const repo = parseGitHubRepo(hostPkg, DEFAULT_REPO)
    const currentVersion = normalizeVersion(api.version || hostPkg?.version) || String(api.version || hostPkg?.version || '')
    const localChangelogPath = hostRoot ? join(hostRoot, 'CHANGELOG.md') : ''
    const stateFile = api.dataDir('state.json')
    const downloadDir = api.dataDir('downloads')
    const store = createStateStore(stateFile)

    let state = store.load()
    let disposed = false
    let checkingPromise = null
    let updatingLock = false

    // 启动收敛：如果上次热更新正在进行中、而当前已加载出目标版本，标记完成；超时则清理死锁
    if (state.updating && state.updating.inProgress) {
      const targetVer = normalizeVersion(state.updating.to)
      if (targetVer && currentVersion && compareSemver(currentVersion, targetVer) >= 0) {
        state.lastUpdate = {
          ok: true,
          from: state.updating.from || '',
          to: currentVersion,
          channel: state.updating.channel || 'stable',
          method: state.updating.method || 'DSH 热更新',
          application: 'applied',
          restartRequired: false,
          restored: false,
          finishedAt: nowFn(),
          message: `已更新并热重载到 v${currentVersion}`,
        }
        state.updating = null
        state.lastFailedVersion = ''
        store.save(state)
      } else if (nowFn() - Number(state.updating.startedAt || 0) > STALE_UPDATING_MS) {
        state.updating = null
        store.save(state)
      }
    }

    function readSettings() {
      const raw = typeof api.settings === 'function' ? api.settings() : {}
      const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
      merged.channel = normalizeChannel(merged.channel)
      merged.autoCheck = Boolean(merged.autoCheck)
      merged.checkIntervalHours = Math.max(1, Math.min(168, Math.round(Number(merged.checkIntervalHours) || 6)))
      merged.autoUpdate = Boolean(merged.autoUpdate)
      merged.autoUpdateWindow = validateUpdateWindow(merged.autoUpdateWindow).ok ? String(merged.autoUpdateWindow || '').trim() : ''
      merged.notifyOwner = Boolean(merged.notifyOwner)
      merged.githubMirror = validateMirrorPrefix(merged.githubMirror).ok ? String(merged.githubMirror || '').trim() : ''
      return merged
    }

    function persistSettings(patch) {
      if (typeof api.saveSettings === 'function') {
        api.saveSettings(patch)
        return readSettings()
      }
      if (typeof api.setConfig === 'function') {
        api.setConfig((cur) => ({
          ...(cur || {}),
          ext: {
            ...((cur && cur.ext) || {}),
            [MODULE_ID]: { ...((cur && cur.ext && cur.ext[MODULE_ID]) || {}), ...patch },
          },
        }))
      }
      return readSettings()
    }

    /** 经宿主 Outbox 私聊通知主人（绝不直连 onebot）。 */
    async function notifyOwnerText(text) {
      const cfg = typeof api.config === 'function' ? api.config() : {}
      const s = readSettings()
      if (!s.notifyOwner) return false
      if (!cfg?.enabled || cfg?.dryRun) return false
      const ownerQQ = String(cfg?.ownerQQ || '').trim()
      if (!ownerQQ || typeof api.sendText !== 'function') return false
      try {
        await api.sendText(`private:${ownerQQ}`, text)
        return true
      } catch (error) {
        api.log?.warn?.('通知主人失败：', error?.message || error)
        return false
      }
    }

    /** 组装只读面板状态（绝不产生副作用）。 */
    async function buildStateView(overrideChannel) {
      const settings = readSettings()
      const channel = overrideChannel ? normalizeChannel(overrideChannel) : settings.channel
      const env = await inspectInstallEnvironment({ dsh: api.dsh, pkgName })
      const selected = selectForChannel(state.releases, channel, currentVersion)
      const stableView = selectForChannel(state.releases, 'stable', currentVersion)
      const betaView = selectForChannel(state.releases, 'beta', currentVersion)
      const manual = buildManualCommands({ repo, release: selected.latest })
      const updating = state.updating && state.updating.inProgress && (nowFn() - Number(state.updating.startedAt || 0) <= STALE_UPDATING_MS)
        ? state.updating
        : null

      return {
        ok: true,
        repo,
        pkgName,
        currentVersion,
        currentIsBeta: isPrerelease(currentVersion, false),
        settings,
        env,
        channel: selected.channel,
        relation: selected.relation,
        hasUpdate: selected.hasUpdate,
        latest: selected.latest,
        history: selected.history,
        channelSummary: {
          stableLatest: stableView.latest?.version || '',
          betaLatest: betaView.latest?.version || '',
          stableCount: stableView.allInChannel.length,
          betaCount: betaView.allInChannel.length,
        },
        source: state.source || '',
        warning: state.warning || '',
        lastError: state.lastError || '',
        lastCheckedAt: Number(state.lastCheckedAt) || 0,
        updating,
        lastUpdate: state.lastUpdate || null,
        manual,
      }
    }

    /** 执行一次更新检查，并更新本地持久化缓存。 */
    async function checkNow({ force = false, channel } = {}) {
      if (checkingPromise) return checkingPromise
      const settings = readSettings()
      const targetChannel = channel ? normalizeChannel(channel) : settings.channel
      const minCacheMs = force ? 0 : 2 * 60 * 1000
      if (!force && state.lastCheckedAt && (nowFn() - state.lastCheckedAt) < minCacheMs && state.releases.length) {
        return buildStateView(targetChannel)
      }

      checkingPromise = (async () => {
        const res = await fetchReleases({
          repo,
          cached: { etag: state.etag, source: state.source, releases: state.releases },
          localChangelogPath,
          fetchImpl,
        })
        state.releases = res.releases || []
        state.source = res.source || state.source
        state.warning = res.warning || ''
        if (res.etag) state.etag = res.etag
        if (res.ok) {
          state.lastCheckedAt = nowFn()
          state.lastError = ''
        } else {
          state.lastError = res.error || '检查更新失败'
        }
        store.save(state)
        return buildStateView(targetChannel)
      })()

      try {
        return await checkingPromise
      } finally {
        checkingPromise = null
      }
    }

    /**
     * 执行本体升级或显式版本切换。
     * - asyncStart=true（面板请求）：先完成全部前置校验与下载/SHA 解析，落盘 updating 标记后立即返回，
     *   再异步触发 DSH pluginManager，避免 HMR 卸载本体时中断浏览器 HTTP 响应。
     * - asyncStart=false（后台自动更新或单测）：等待执行完成并返回最终结果。
     */
    async function triggerUpdate({
      version = '',
      channel,
      allowDowngrade = false,
      asyncStart = false,
      reason = 'manual',
    } = {}) {
      if (updatingLock || (state.updating && state.updating.inProgress && (nowFn() - Number(state.updating.startedAt || 0) <= STALE_UPDATING_MS))) {
        return { ok: false, message: '已有更新任务正在执行，请稍候完成后再试' }
      }
      const settings = readSettings()
      const ch = channel ? normalizeChannel(channel) : settings.channel
      const env = await inspectInstallEnvironment({ dsh: api.dsh, pkgName })
      if (!env.supported) {
        return { ok: false, message: env.reason || '当前安装环境不支持自动更新', env }
      }

      // 若尚无发布缓存，先即时拉取一次
      if (!state.releases.length) {
        await checkNow({ force: true, channel: ch })
      }
      const selected = selectForChannel(state.releases, ch, currentVersion)
      const wanted = version
        ? selected.allInChannel.find((r) => r.version === normalizeVersion(version) || r.tag === version)
          || state.releases.find((r) => r.version === normalizeVersion(version) || r.tag === version)
        : selected.latest
      if (!wanted) {
        return { ok: false, message: version ? `未找到版本 ${version}` : '当前通道暂无可用版本' }
      }

      updatingLock = true
      let prepared
      try {
        prepared = await prepareUpdatePlan({
          env,
          release: wanted,
          currentVersion,
          allowDowngrade: Boolean(allowDowngrade),
          repo,
          downloadDir,
          mirrorPrefix: settings.githubMirror,
          shaCache: state.shaCache,
          fetchImpl,
        })
      } catch (error) {
        updatingLock = false
        return { ok: false, message: `准备更新失败：${error?.message || error}` }
      }

      if (!prepared.ok) {
        updatingLock = false
        return { ok: false, message: prepared.message }
      }

      const plan = prepared.plan
      if (plan.sha && wanted.tag) {
        state.shaCache[wanted.tag] = plan.sha
      }
      state.updating = {
        inProgress: true,
        from: plan.from,
        to: plan.to,
        channel: ch,
        method: plan.methodLabel,
        reason,
        startedAt: nowFn(),
      }
      store.save(state)

      const pluginManager = api.dsh?.get?.('pluginManager')
      const hmr = api.dsh?.get?.('hmr')

      const run = async () => {
        try {
          const outcome = await executeUpdatePlan({ pluginManager, hmr, pkgName, plan })
          // 重新读取最新磁盘状态再写回（避免覆盖期间其他写入）
          const latestState = store.load()
          latestState.updating = null
          latestState.lastUpdate = { ...outcome, channel: ch, reason }
          if (outcome.ok) {
            latestState.lastFailedVersion = ''
          } else {
            latestState.lastFailedVersion = plan.to
          }
          store.save(latestState)
          state = latestState
          if (reason === 'auto') {
            const summary = outcome.ok
              ? `QQ Hub 已自动更新：v${plan.from} → v${plan.to}（${ch === 'beta' ? 'Beta 测试版' : '稳定版'}）${outcome.restartRequired ? '，重启 DSH 后生效' : '，热重载已生效'}。`
              : `QQ Hub 自动更新到 v${plan.to} 失败：${outcome.message}`
            await notifyOwnerText(summary)
          }
          return outcome
        } finally {
          updatingLock = false
        }
      }

      if (asyncStart) {
        scheduleUpdate(() => { run().catch((error) => api.log?.warn?.('后台更新执行异常：', error?.message || error)) })
        return {
          ok: true,
          started: true,
          from: plan.from,
          to: plan.to,
          channel: ch,
          method: plan.methodLabel,
          hmr: env.hmr,
          message: `已开始更新 QQ Hub：v${plan.from} → v${plan.to}`,
        }
      }

      const outcome = await run()
      return outcome
    }

    /** 定时检查与自动更新主循环。 */
    async function tick({ force = false } = {}) {
      if (disposed) return { skipped: 'disposed' }
      const settings = readSettings()
      if (!force && !settings.autoCheck) return { skipped: 'autoCheck-off' }
      const intervalMs = settings.checkIntervalHours * 3600_000
      if (!force && state.lastCheckedAt && (nowFn() - state.lastCheckedAt) < intervalMs) {
        return { skipped: 'within-interval' }
      }

      const view = await checkNow({ force: true, channel: settings.channel })
      if (!view.hasUpdate || !view.latest) return { ok: true, hasUpdate: false }

      const targetVer = view.latest.version
      const chLabel = settings.channel === 'beta' ? 'Beta 测试版' : '稳定版'

      // 自动更新：仅升级（永不自动降级），需在允许时段内，且同一失败版本不死循环重试
      if (settings.autoUpdate && view.env?.supported && state.lastFailedVersion !== targetVer) {
        if (isInUpdateWindow(settings.autoUpdateWindow, new Date(nowFn()))) {
          api.log?.info?.(`发现 ${chLabel} 新版本 v${targetVer}，触发自动更新`)
          const outcome = await triggerUpdate({
            version: targetVer,
            channel: settings.channel,
            allowDowngrade: false,
            asyncStart: false,
            reason: 'auto',
          })
          return { ok: outcome.ok, autoUpdated: true, outcome }
        }
      }

      // 不自动更新（或未到静默时段）：同一新版本只私聊提醒主人一次
      if (settings.notifyOwner && state.lastNotifiedVersion !== targetVer) {
        const sent = await notifyOwnerText(
          `QQ Hub 发现新版本 v${targetVer}（当前 v${currentVersion}，通道：${chLabel}）。可在面板「系统 → 版本更新」查看更新日志并一键升级，或回复 /更新 now 立即更新。`,
        )
        if (sent) {
          state.lastNotifiedVersion = targetVer
          store.save(state)
        }
      }

      return { ok: true, hasUpdate: true, latest: targetVer }
    }

    // ---- 面板 HTTP 路由（/qq-hub/api/ext/qqhub-updater/*）----

    // 只读状态：不触发网络写入或配置修改
    api.route('/state', async () => buildStateView())

    // 手动检查更新
    api.route('/check', async (req) => {
      if (!isPost(req)) return { ok: false, message: '请使用 POST 请求检查更新' }
      const body = await readJsonBody(api, req)
      const ch = body.channel ? normalizeChannel(body.channel) : undefined
      return checkNow({ force: body.force !== false, channel: ch })
    })

    // 保存设置（通道切换、自动检查、自动更新开关、时段、镜像）
    api.route('/config', async (req) => {
      if (!isPost(req)) return { ok: false, message: '请使用 POST 请求保存设置' }
      const body = await readJsonBody(api, req)
      const cur = readSettings()
      const checked = sanitizeSettingsPatch(body, cur)
      if (!checked.ok) return { ok: false, message: checked.message }
      persistSettings(checked.patch)
      if (Object.hasOwn(checked.patch, 'channel') && checked.patch.channel !== cur.channel) {
        // 切换通道时清除上次失败标记，方便用户重试新通道
        state.lastFailedVersion = ''
        store.save(state)
      }
      const view = await buildStateView()
      return { ...view, message: '设置已保存' }
    })

    // 触发升级 / 版本切换
    api.route('/update', async (req) => {
      if (!isPost(req)) return { ok: false, message: '请使用 POST 请求执行更新' }
      const body = await readJsonBody(api, req)
      const version = typeof body.version === 'string' ? body.version.trim() : ''
      const channel = body.channel ? normalizeChannel(body.channel) : undefined
      const allowDowngrade = body.allowDowngrade === true
      return triggerUpdate({
        version,
        channel,
        allowDowngrade,
        asyncStart: body.sync !== true,
        reason: 'manual',
      })
    })

    // ---- 主人 QQ 命令 ----
    if (typeof api.command === 'function') {
      api.command({
        name: '更新',
        aliases: ['update', '检查更新'],
        desc: '检查或更新 QQ Hub 本体：/更新 [check|stable|beta|now]',
        run: async (arg) => {
          const sub = String(arg || '').trim().toLowerCase()
          if (sub === 'stable' || sub === '稳定' || sub === '稳定版') {
            persistSettings({ channel: 'stable' })
            const v = await checkNow({ force: true, channel: 'stable' })
            return `已切换到稳定版通道。\n当前：v${v.currentVersion}，最新：${v.latest ? 'v' + v.latest.version : '暂无'}${v.hasUpdate ? '（可发送 /更新 now 升级）' : '（已是最新）'}`
          }
          if (sub === 'beta' || sub === '测试' || sub === '测试版') {
            persistSettings({ channel: 'beta' })
            const v = await checkNow({ force: true, channel: 'beta' })
            return `已切换到 Beta 测试版通道。\n当前：v${v.currentVersion}，最新：${v.latest ? 'v' + v.latest.version : '暂无'}${v.hasUpdate ? '（可发送 /更新 now 升级）' : '（已是最新）'}`
          }
          if (sub === 'now' || sub === '升级' || sub === '立即更新') {
            const v = await checkNow({ force: true })
            if (!v.hasUpdate || !v.latest) return `当前 v${v.currentVersion} 已是所选通道最新版本，无需更新。`
            const r = await triggerUpdate({ version: v.latest.version, channel: v.channel, allowDowngrade: false, asyncStart: true, reason: 'command' })
            return r.ok ? `已开始更新 QQ Hub：v${r.from} → v${r.to}，完成后会自动重载。` : `更新未启动：${r.message}`
          }
          const v = await checkNow({ force: true })
          const chLabel = v.channel === 'beta' ? 'Beta 测试版' : '稳定版'
          const latestText = v.latest ? `v${v.latest.version}` : '暂无'
          const statusText = v.hasUpdate
            ? `发现新版本 ${latestText}！发送 /更新 now 可一键升级。`
            : v.relation === 'ahead-of-channel'
              ? `当前版本高于${chLabel}最新（${latestText}）。`
              : `当前已是${chLabel}最新。`
          return `QQ Hub 版本检查（${chLabel}）\n当前：v${v.currentVersion}\n通道最新：${latestText}\n${statusText}`
        },
      })
    }

    // ---- 定时任务与清理 ----
    if (typeof api.every === 'function') {
      api.every(TICK_MS, () => tick(), 'qqhub-updater-tick')
    }
    if (typeof api.later === 'function') {
      api.later(INITIAL_CHECK_DELAY_MS, () => tick())
    }
    if (typeof api.onDispose === 'function') {
      api.onDispose(() => { disposed = true })
    }

    return {
      version: MODULE_VERSION,
      state: () => buildStateView(),
      check: (opts) => checkNow(opts),
      update: (opts) => triggerUpdate(opts),
      tick: (opts) => tick(opts),
      setChannel: (ch) => {
        const checked = sanitizeSettingsPatch({ channel: ch }, readSettings())
        if (!checked.ok) throw new Error(checked.message)
        return persistSettings(checked.patch)
      },
      dispose: () => { disposed = true },
    }
  },
}
