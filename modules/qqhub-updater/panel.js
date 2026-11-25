// QQ Hub 版本更新面板（插件商店模块 qqhub-updater）
// 约定：宿主传入 (React, h, ui, call)，返回组件函数；call(path[, body]) 自动指向 /ext/qqhub-updater<path>。
// 样式完全对齐 QQ Hub 现代中性主题（--ab-* 令牌，原生兼容 DSH 亮/暗模式与移动端）。

const { useState, useEffect, useCallback, useRef } = React

const STYLE_ID = 'qu-updater-styles'
const STYLE_CSS = `
.qu-root { display: flex; flex-direction: column; gap: 14px; }
.qu-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 4px 0 12px;
}
.qu-tile {
  padding: 12px 14px;
  border-radius: var(--ab-radius-sm, 9px);
  background: var(--ab-card-2, #f2f4f7);
  border: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.qu-tile-lbl {
  font-size: 12px;
  color: var(--ab-sub, #5a616e);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.qu-tile-val {
  font-size: 16px;
  font-weight: 650;
  color: var(--ab-text, #151821);
  letter-spacing: -.01em;
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  word-break: break-all;
}
.qu-tile-sub {
  font-size: 11.5px;
  color: var(--ab-dim, #737a87);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qu-tag {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 560;
  line-height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--ab-foam, rgba(51, 102, 230, .08));
  color: var(--ab-deep, #244db8);
  border: 1px solid var(--ab-foam-2, rgba(51, 102, 230, .15));
  white-space: nowrap;
}
.qu-tag.beta {
  background: color-mix(in srgb, var(--ab-warn, #b45309) 12%, var(--ab-card, #fff));
  color: var(--ab-warn, #b45309);
  border-color: color-mix(in srgb, var(--ab-warn, #b45309) 28%, transparent);
}
.qu-tag.ok {
  background: color-mix(in srgb, var(--ab-ok, #178a4b) 11%, var(--ab-card, #fff));
  color: var(--ab-ok, #178a4b);
  border-color: color-mix(in srgb, var(--ab-ok, #178a4b) 28%, transparent);
}
.qu-tag.dim {
  background: var(--ab-card-2, #f2f4f7);
  color: var(--ab-sub, #5a616e);
  border-color: var(--ab-line, rgba(15, 23, 42, .09));
}
.qu-fold-card {
  background: var(--ab-card, #ffffff);
  border: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
  border-radius: var(--ab-radius, 14px);
  padding: 18px 20px;
  box-shadow: var(--ab-shadow, 0 1px 2px rgba(15, 23, 42, .04));
}
.qu-fold-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
}
.qu-fold-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  min-width: 0;
  border-radius: 7px;
  padding: 2px 4px;
  margin: -2px -4px;
  transition: background .12s;
}
.qu-fold-head:hover { background: var(--ab-hover, rgba(38, 49, 72, .06)); }
.qu-fold-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 620;
  letter-spacing: -.01em;
  color: var(--ab-text, #151821);
  line-height: 1.35;
}
.qu-chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--ab-sub, #5a616e);
  flex: none;
  transition: transform .16s ease;
}
.qu-chev.open { transform: rotate(90deg); }
.qu-fold-sub {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
}
.qu-fold-sub-title {
  font-size: 13px;
  font-weight: 560;
  color: var(--ab-sub, #5a616e);
}
.qu-fold-sub-body { margin-top: 10px; }
.qu-md {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ab-text, #151821);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.qu-md h4 {
  margin: 12px 0 6px;
  font-size: 13.5px;
  font-weight: 640;
  color: var(--ab-text, #151821);
}
.qu-md h4:first-child { margin-top: 2px; }
.qu-md p { margin: 5px 0; }
.qu-md ul, .qu-md ol {
  margin: 4px 0 8px;
  padding-left: 19px;
}
.qu-md li { margin: 3px 0; }
.qu-md blockquote {
  margin: 6px 0;
  padding: 6px 11px;
  border-left: 3px solid var(--ab-sea, #3366e6);
  background: var(--ab-foam, rgba(51, 102, 230, .08));
  border-radius: 0 7px 7px 0;
  color: var(--ab-sub, #5a616e);
}
.qu-md code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--ab-card-2, #f2f4f7);
  border: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
}
.qu-md a {
  color: var(--ab-link, var(--ab-deep, #244db8));
  text-decoration: none;
}
.qu-md a:hover { text-decoration: underline; }
.qu-hist-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0 8px;
}
.qu-hist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.qu-hist-item {
  border: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
  border-radius: 11px;
  background: var(--ab-card-2, #f2f4f7);
  overflow: hidden;
  transition: border-color .14s;
}
.qu-hist-item.open {
  background: var(--ab-card, #ffffff);
  border-color: var(--ab-line-2, rgba(15, 23, 42, .16));
}
.qu-hist-head {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 10px 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-wrap: wrap;
  transition: background .12s;
}
.qu-hist-head:hover { background: var(--ab-hover, rgba(38, 49, 72, .06)); }
.qu-hist-ver {
  font-weight: 630;
  font-size: 13.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ab-text, #151821);
}
.qu-hist-name {
  flex: 1 1 160px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ab-sub, #5a616e);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qu-hist-date {
  font-size: 11.5px;
  color: var(--ab-dim, #737a87);
  font-variant-numeric: tabular-nums;
  margin-left: auto;
  white-space: nowrap;
}
.qu-hist-body {
  padding: 10px 15px 13px;
  border-top: 1px solid var(--ab-line, rgba(15, 23, 42, .09));
}
.qu-dot-pulse {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ab-sea, #3366e6);
  margin-right: 7px;
  animation: quPulse 1.3s ease-in-out infinite;
}
@keyframes quPulse {
  0%, 100% { opacity: .35; transform: scale(.88); }
  50% { opacity: 1; transform: scale(1.12); }
}
.qu-link {
  color: var(--ab-link, var(--ab-deep, #244db8));
  font-size: 12.5px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.qu-link:hover { text-decoration: underline; }
@media (max-width: 720px) {
  .qu-summary { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .qu-fold-card { padding: 15px 14px; border-radius: 13px; }
  .qu-hist-name { flex-basis: 100%; order: 10; white-space: normal; }
}
`

function ensureStyle() {
  if (typeof document === 'undefined' || !document.head) return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== STYLE_CSS) el.textContent = STYLE_CSS
}

function chevronSvg(open) {
  return h('span', { className: 'qu-chev' + (open ? ' open' : ''), 'aria-hidden': 'true' },
    h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M4.5 3 7.5 6 4.5 9' })))
}

function fmtDate(iso) {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtAgo(ts) {
  const n = Number(ts)
  if (!n || !Number.isFinite(n)) return '尚未检查'
  const diff = Math.max(0, Date.now() - n)
  const m = Math.round(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const hr = Math.round(m / 60)
  if (hr < 24) return hr + ' 小时前'
  return Math.round(hr / 24) + ' 天前'
}

function fmtSize(bytes) {
  const n = Number(bytes)
  if (!n || !Number.isFinite(n)) return ''
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function sourceLabel(src) {
  if (src === 'github-releases') return 'GitHub Releases'
  if (src === 'jsdelivr') return 'jsDelivr 镜像'
  if (src === 'raw-github') return 'GitHub Raw'
  if (src === 'local-changelog') return '本机更新记录'
  return src || '缓存'
}

/** 安全内联 Markdown 渲染（仅 React 节点，无 dangerouslySetInnerHTML，仅放行 https:// 链接）。 */
function renderInline(text) {
  const s = String(text || '')
  const out = []
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g
  let last = 0
  let match
  let k = 0
  while ((match = tokenRe.exec(s)) !== null) {
    if (match.index > last) out.push(s.slice(last, match.index))
    const tok = match[0]
    if (tok.startsWith('**') && tok.endsWith('**')) {
      out.push(h('strong', { key: 'b' + k++ }, tok.slice(2, -2)))
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      out.push(h('code', { key: 'c' + k++ }, tok.slice(1, -1)))
    } else if (tok.startsWith('[')) {
      const m = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(tok)
      if (m) {
        out.push(h('a', { key: 'a' + k++, href: m[2], target: '_blank', rel: 'noopener noreferrer' }, m[1]))
      } else {
        out.push(tok)
      }
    }
    last = match.index + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/** 安全块级 Markdown 渲染：标题、无序/有序列表、引用、段落。 */
function renderMarkdown(markdown) {
  const raw = String(markdown || '').trim()
  if (!raw) return h('div', { className: 'ab-small ab-muted' }, '该版本暂无文字更新说明，可前往 GitHub 查看提交记录。')
  const lines = raw.split(/\r?\n/)
  const blocks = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { i++; continue }

    // 标题（### / #### / ##）
    const hm = /^#{1,4}\s+(.+)$/.exec(trimmed)
    if (hm) {
      blocks.push(h('h4', { key: 'h' + key++ }, renderInline(hm[1])))
      i++
      continue
    }

    // 引用块
    if (trimmed.startsWith('>')) {
      const quoteLines = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(h('blockquote', { key: 'q' + key++ }, renderInline(quoteLines.join(' '))))
      continue
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''))
        i++
      }
      blocks.push(h('ul', { key: 'u' + key++ },
        items.map((it, idx) => h('li', { key: idx }, renderInline(it)))))
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(h('ol', { key: 'o' + key++ },
        items.map((it, idx) => h('li', { key: idx }, renderInline(it)))))
      continue
    }

    // 普通段落
    const para = [trimmed]
    i++
    while (i < lines.length) {
      const next = lines[i].trim()
      if (!next || /^#{1,4}\s+/.test(next) || next.startsWith('>') || /^[-*+]\s+/.test(next) || /^\d+\.\s+/.test(next)) break
      para.push(next)
      i++
    }
    blocks.push(h('p', { key: 'p' + key++ }, renderInline(para.join(' '))))
  }

  return h('div', { className: 'qu-md' }, blocks)
}

function FoldCard({ title, desc, right, defaultOpen, children }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  const toggle = () => setOpen((v) => !v)
  return h('div', { className: 'qu-fold-card' },
    h('div', { className: 'qu-fold-bar' },
      h('div', {
        className: 'qu-fold-head',
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: toggle,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
      },
        chevronSvg(open),
        h('h3', null, title)),
      right ? h('div', { className: 'ab-card-right' }, right) : null),
    desc ? h('p', { className: 'ab-desc', style: { marginBottom: open ? 10 : 0 } }, desc) : null,
    open ? h('div', { style: { marginTop: desc ? 2 : 12 } }, children) : null)
}

function copyText(text, toast) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast && toast('已复制到剪贴板', 'ok'))
        .catch(() => toast && toast('复制失败，请手动选中复制', 'err'))
      return
    }
  } catch {}
  toast && toast('当前浏览器不支持自动复制，请手动选中复制', 'err')
}

const CHANNEL_OPTS = [
  { value: 'stable', label: '稳定版' },
  { value: 'beta', label: 'Beta 测试版' },
]

const INTERVAL_OPTS = [
  { value: '1', label: '每 1 小时' },
  { value: '3', label: '每 3 小时' },
  { value: '6', label: '每 6 小时' },
  { value: '12', label: '每 12 小时' },
  { value: '24', label: '每天一次' },
]

return function QQHubUpdaterPanel({ toast, reload }) {
  ensureStyle()
  const { Card, Btn, Switch, Row, Empty, Select, Seg } = ui

  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [advOpen, setAdvOpen] = useState(false)
  const [windowInput, setWindowInput] = useState('')
  const [mirrorInput, setMirrorInput] = useState('')
  const [histFilter, setHistFilter] = useState('all')
  const [openHist, setOpenHist] = useState({})
  const [pollingTarget, setPollingTarget] = useState('')
  const [justUpdatedTo, setJustUpdatedTo] = useState('')
  const pollTimer = useRef(null)

  const syncInputs = (st) => {
    if (!st || !st.settings) return
    setWindowInput(st.settings.autoUpdateWindow || '')
    setMirrorInput(st.settings.githubMirror || '')
  }

  const fetchState = useCallback(async ({ silent = false } = {}) => {
    try {
      const r = await call('/state')
      if (r && r.ok !== false) {
        setData(r)
        syncInputs(r)
        if (!r.lastCheckedAt && !silent) {
          // 首次打开且无缓存时自动检查一次
          setBusy('check')
          try {
            const c = await call('/check', { force: false })
            if (c && c.ok !== false) {
              setData(c)
              syncInputs(c)
            }
          } catch {}
          setBusy('')
        }
        return r
      }
    } catch (e) {
      if (!silent && toast) toast('读取更新状态失败：' + e.message, 'err')
    }
    return null
  }, [toast])

  useEffect(() => {
    fetchState()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [fetchState])

  // 热重载期间容错轮询，直到版本号生效或更新结果落盘
  useEffect(() => {
    if (!pollingTarget) return
    let attempts = 0
    const tickPoll = async () => {
      attempts++
      try {
        const r = await call('/state')
        if (r && r.ok !== false) {
          setData(r)
          if (r.currentVersion === pollingTarget) {
            setPollingTarget('')
            setJustUpdatedTo(pollingTarget)
            toast && toast(`QQ Hub 已更新到 v${pollingTarget}`, 'ok')
            reload && reload()
            return
          }
          if (!r.updating && r.lastUpdate && r.lastUpdate.to === pollingTarget) {
            setPollingTarget('')
            if (r.lastUpdate.ok) {
              setJustUpdatedTo(pollingTarget)
              toast && toast(r.lastUpdate.message || `已安装 v${pollingTarget}`, 'ok')
              reload && reload()
            } else {
              toast && toast(r.lastUpdate.message || '更新失败', 'err')
            }
            return
          }
        }
      } catch {
        // HMR 重载切换窗口内短暂断开属正常现象，继续等待
      }
      if (attempts >= 40) {
        setPollingTarget('')
        toast && toast('等待更新超时，请稍后刷新页面查看当前版本', 'err')
      }
    }
    pollTimer.current = setInterval(tickPoll, 2500)
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [pollingTarget, toast, reload])

  const checkUpdates = async (overrideChannel) => {
    setBusy('check')
    try {
      const r = await call('/check', { force: true, ...(overrideChannel ? { channel: overrideChannel } : {}) })
      if (r && r.ok !== false) {
        setData(r)
        if (r.lastError) toast && toast(r.lastError, 'err')
        else if (r.hasUpdate && r.latest) toast && toast(`发现新版本 v${r.latest.version}`, 'ok')
        else toast && toast('检查完成，当前已是最新', 'ok')
      } else {
        toast && toast((r && r.message) || '检查更新失败', 'err')
      }
    } catch (e) {
      toast && toast('检查更新失败：' + e.message, 'err')
    } finally {
      setBusy('')
    }
  }

  const saveConfig = async (patch, { recheck = false } = {}) => {
    setBusy('config')
    try {
      const r = await call('/config', patch)
      if (!r || r.ok === false) {
        toast && toast((r && r.message) || '保存失败', 'err')
        return
      }
      setData(r)
      syncInputs(r)
      if (!recheck) toast && toast('设置已保存', 'ok')
      if (recheck) {
        setBusy('check')
        const c = await call('/check', { force: true, channel: patch.channel })
        if (c && c.ok !== false) setData(c)
        toast && toast(patch.channel === 'beta' ? '已切换到 Beta 测试版通道' : '已切换到稳定版通道', 'ok')
      }
    } catch (e) {
      toast && toast('保存设置失败：' + e.message, 'err')
    } finally {
      setBusy('')
    }
  }

  const startUpdate = async (targetRelease, { allowDowngrade = false } = {}) => {
    if (!targetRelease || !targetRelease.version) return
    const curVer = data && data.currentVersion ? `v${data.currentVersion}` : '当前版本'
    const actionWord = allowDowngrade ? '切换' : '更新'
    const betaTip = targetRelease.prerelease ? '\n注意：目标为 Beta 测试版，可能包含实验性改动。' : ''
    const ok = typeof confirm === 'function'
      ? confirm(`确定将 QQ Hub 从 ${curVer} ${actionWord}到 v${targetRelease.version}？${betaTip}\n配置、人格与记忆数据都会完整保留；若安装失败将自动回滚。`)
      : true
    if (!ok) return

    setBusy('update')
    setJustUpdatedTo('')
    try {
      const r = await call('/update', {
        version: targetRelease.version,
        channel: data.channel,
        allowDowngrade,
      })
      if (!r || r.ok === false) {
        toast && toast((r && r.message) || '更新启动失败', 'err')
        return
      }
      toast && toast(r.message || `正在更新到 v${targetRelease.version}…`, 'ok')
      setPollingTarget(targetRelease.version)
      await fetchState({ silent: true })
    } catch (e) {
      toast && toast('触发更新失败：' + e.message, 'err')
    } finally {
      setBusy('')
    }
  }

  if (!data) {
    return h('div', { className: 'qu-root' },
      h(Card, { title: 'QQ Hub 版本更新' }, h(Empty, { icon: '⏳', text: '正在读取版本与通道信息…' })))
  }

  const s = data.settings || {}
  const env = data.env || {}
  const latest = data.latest || null
  const history = Array.isArray(data.history) ? data.history : []
  const isUpdating = Boolean(pollingTarget || (data.updating && data.updating.inProgress))
  const updatingTo = pollingTarget || (data.updating && data.updating.to) || ''
  const channelLabel = data.channel === 'beta' ? 'Beta 测试版' : '稳定版'

  // 状态胶囊
  let statusPill
  if (isUpdating) {
    statusPill = h('span', { className: 'ab-pill' }, `正在更新 v${updatingTo}`)
  } else if (data.lastError && !latest) {
    statusPill = h('span', { className: 'ab-pill err' }, '检查失败')
  } else if (data.hasUpdate && latest) {
    statusPill = h('span', { className: 'ab-pill warn' }, `可更新 v${latest.version}`)
  } else if (data.relation === 'ahead-of-channel') {
    statusPill = h('span', { className: 'ab-pill' }, '高于当前通道')
  } else if (data.relation === 'up-to-date') {
    statusPill = h('span', { className: 'ab-pill ok' }, '已是最新')
  } else {
    statusPill = h('span', { className: 'ab-pill' }, '未检查')
  }

  // 历史记录过滤
  const stableHistCount = history.filter((x) => !x.prerelease).length
  const betaHistCount = history.filter((x) => x.prerelease).length
  const visibleHistory = data.channel === 'beta'
    ? history.filter((x) => histFilter === 'all' || (histFilter === 'beta' ? x.prerelease : !x.prerelease))
    : history
  const anyHistOpen = visibleHistory.some((x) => openHist[x.version])
  const toggleAllHist = () => {
    if (anyHistOpen) {
      setOpenHist({})
    } else {
      const next = {}
      for (const item of visibleHistory) next[item.version] = true
      setOpenHist(next)
    }
  }

  const manual = data.manual || {}

  return h('div', { className: 'qu-root' },
    // ---------------- 1. 版本与通道概览卡 ----------------
    h(Card, {
      title: 'QQ Hub 版本更新',
      desc: '管理 QQ Hub 本体的版本通道、自动检查与一键热更新；配置、人格与记忆不受升级影响。',
      right: statusPill,
    },
      // 3 格核心指标
      h('div', { className: 'qu-summary' },
        h('div', { className: 'qu-tile' },
          h('div', { className: 'qu-tile-lbl' },
            h('span', null, '当前版本'),
            h('span', { className: 'qu-tag ' + (data.currentIsBeta ? 'beta' : 'ok') }, data.currentIsBeta ? 'Beta' : '稳定版')),
          h('div', { className: 'qu-tile-val' }, 'v' + (data.currentVersion || '—')),
          h('div', { className: 'qu-tile-sub', title: env.source || '' }, env.modeLabel || '未知安装方式')),
        h('div', { className: 'qu-tile' },
          h('div', { className: 'qu-tile-lbl' },
            h('span', null, channelLabel + '最新'),
            latest ? h('span', { className: 'qu-tag ' + (latest.prerelease ? 'beta' : 'ok') }, latest.prerelease ? 'Beta' : '正式版') : null),
          h('div', { className: 'qu-tile-val' }, latest ? 'v' + latest.version : '暂无记录'),
          h('div', { className: 'qu-tile-sub' }, latest && latest.publishedAt ? '发布于 ' + fmtDate(latest.publishedAt) : (data.repo || ''))),
        h('div', { className: 'qu-tile' },
          h('div', { className: 'qu-tile-lbl' }, h('span', null, '上次检查')),
          h('div', { className: 'qu-tile-val' }, fmtAgo(data.lastCheckedAt)),
          h('div', { className: 'qu-tile-sub' }, '来源：' + sourceLabel(data.source)))),

      // 通道切换
      h(Row, {
        label: '更新通道',
        hint: '稳定版仅追踪正式 Release；Beta 测试版包含测试构建（-test / -beta）与正式版中的最新版本。',
      },
        h(Seg, {
          value: data.channel || 'stable',
          options: CHANNEL_OPTS,
          onChange: (val) => {
            if (val !== data.channel) saveConfig({ channel: val }, { recheck: true })
          },
        })),

      // 实时进度 / 结果提示条
      isUpdating ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
        h('span', { className: 'qu-dot-pulse' }),
        h('b', null, `正在更新到 v${updatingTo}…`),
        ' 插件热重载期间连接会短暂断开几秒，页面会自动轮询直到恢复，请勿重复点击。') : null,

      justUpdatedTo && !isUpdating ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
        h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 8 } },
          h('span', null, h('b', null, `更新完成：v${justUpdatedTo}`), '。建议刷新页面以加载最新版前端界面。'),
          h('div', { className: 'ab-spacer' }),
          h(Btn, { small: true, kind: 'primary', onClick: () => typeof window !== 'undefined' && window.location.reload() }, '刷新面板'))) : null,

      !isUpdating && data.lastUpdate && data.lastUpdate.restartRequired ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } },
        h('b', null, `已安装 v${data.lastUpdate.to}`), '：当前环境未启用 HMR 热重载，重启 DSH 后生效。') : null,

      !isUpdating && data.lastUpdate && data.lastUpdate.ok === false ? h('div', { className: 'ab-note err', style: { marginTop: 10 } },
        h('b', null, '上次更新未成功：'), data.lastUpdate.message || '请查看日志') : null,

      data.warning ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } }, data.warning) : null,
      data.lastError ? h('div', { className: 'ab-note err', style: { marginTop: 10 } }, data.lastError) : null,

      !env.supported ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } },
        h('div', null, env.reason || '当前环境不支持一键更新，请复制下方命令手动更新：'),
        manual.linux ? h('div', { className: 'ab-code' }, manual.linux) : null,
        h('div', { className: 'ab-flex', style: { marginTop: 8, flexWrap: 'wrap', gap: 6 } },
          manual.linux ? h(Btn, { small: true, onClick: () => copyText(manual.linux, toast) }, '复制 Linux/NAS 命令') : null,
          manual.windows ? h(Btn, { small: true, onClick: () => copyText(manual.windows, toast) }, '复制 Windows 命令') : null,
          manual.tarballUrl ? h('a', { className: 'qu-link', href: manual.tarballUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginLeft: 4 } }, '下载离线 .tgz ↗') : null)) : null,

      // 操作按钮栏
      h('div', { className: 'ab-actions', style: { marginTop: 14 } },
        data.hasUpdate && latest && env.supported && latest.installable !== false
          ? h(Btn, {
              kind: 'primary',
              disabled: !!busy || isUpdating,
              onClick: () => startUpdate(latest, { allowDowngrade: false }),
            }, busy === 'update' ? '正在准备更新…' : `立即更新到 v${latest.version}`)
          : null,
        h(Btn, {
          kind: !(data.hasUpdate && env.supported && latest && latest.installable !== false) ? 'primary' : undefined,
          disabled: !!busy || isUpdating,
          onClick: () => checkUpdates(),
        }, busy === 'check' ? '检查中…' : '检查更新'),
        data.relation === 'ahead-of-channel' && latest && env.supported && latest.installable !== false
          ? h(Btn, {
              disabled: !!busy || isUpdating,
              onClick: () => startUpdate(latest, { allowDowngrade: true }),
            }, `切回${channelLabel} v${latest.version}`)
          : null,
        latest && latest.htmlUrl
          ? h('a', { className: 'qu-link', href: latest.htmlUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginLeft: 'auto' } }, '在 GitHub 查看 ↗')
          : null)),

    // ---------------- 2. 自动检查与自动更新设置卡 ----------------
    h(Card, {
      title: '自动检查与自动更新',
      desc: '可按间隔在后台静默检查更新；开启自动更新后仅自动升级到更高版本，失败自动回滚。',
    },
      h(Row, {
        label: '定时自动检查',
        hint: '后台定时检查所选通道的新版本（使用 ETag 缓存，几乎不消耗 GitHub API 配额）。',
      },
        h(Switch, {
          on: Boolean(s.autoCheck),
          disabled: !!busy,
          onChange: (val) => saveConfig({ autoCheck: val }),
        })),
      h(Row, {
        label: '检查频率',
        hint: '两次后台自动检查之间的最小间隔。',
      },
        h(Select, {
          value: String(s.checkIntervalHours || 6),
          options: INTERVAL_OPTS,
          onChange: (val) => saveConfig({ checkIntervalHours: Number(val) }),
        })),
      h(Row, {
        label: '自动更新 QQ Hub',
        hint: env.supported
          ? '发现所选通道的新版本时自动调用 DSH 插件管理器升级；若当前为 Beta 切到稳定版，绝不会自动降级。'
          : '当前安装环境不支持无人值守自动更新，开启后仅做检查与提醒。',
      },
        h(Switch, {
          on: Boolean(s.autoUpdate),
          disabled: !!busy,
          onChange: (val) => saveConfig({ autoUpdate: val }),
        })),
      h(Row, {
        label: '私聊通知主人',
        hint: '发现新版本或自动更新完成时，经统一 Outbox 给主人发一条 QQ 提醒（同一版本只提醒一次）。',
      },
        h(Switch, {
          on: Boolean(s.notifyOwner),
          disabled: !!busy,
          onChange: (val) => saveConfig({ notifyOwner: val }),
        })),

      // 折叠高级项
      h('div', { className: 'qu-fold-sub' },
        h('div', {
          className: 'qu-fold-head',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': advOpen,
          onClick: () => setAdvOpen((v) => !v),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAdvOpen((v) => !v) } },
        },
          chevronSvg(advOpen),
          h('span', { className: 'qu-fold-sub-title' }, '高级选项（更新时段、下载镜像与手动命令）')),
        advOpen ? h('div', { className: 'qu-fold-sub-body' },
          h(Row, {
            label: '静默更新时段',
            hint: '限制自动更新仅在指定本地时段执行（如 03:00-05:00，支持跨午夜）；留空表示随时可更新。',
          },
            h('input', {
              className: 'ab-input',
              placeholder: '例如 03:00-05:00（留空不限）',
              value: windowInput,
              onChange: (e) => setWindowInput(e.target.value),
            }),
            h(Btn, { small: true, disabled: !!busy, onClick: () => saveConfig({ autoUpdateWindow: windowInput }) }, '保存')),
          h(Row, {
            label: 'GitHub 下载镜像前缀',
            hint: '离线包（.tgz）升级时可选填写公网 HTTPS 加速前缀；留空直连 GitHub。',
          },
            h('input', {
              className: 'ab-input',
              placeholder: '留空直连（仅允许 https://）',
              value: mirrorInput,
              onChange: (e) => setMirrorInput(e.target.value),
            }),
            h(Btn, { small: true, disabled: !!busy, onClick: () => saveConfig({ githubMirror: mirrorInput }) }, '保存')),
          data.lastUpdate ? h(Row, {
            label: '上次更新记录',
            hint: data.lastUpdate.method || '',
          },
            h('div', { className: 'ab-small' },
              h('span', { className: 'qu-tag ' + (data.lastUpdate.ok ? 'ok' : 'beta'), style: { marginRight: 6 } }, data.lastUpdate.ok ? '成功' : '失败'),
              data.lastUpdate.message || '',
              data.lastUpdate.finishedAt ? h('span', { className: 'ab-muted' }, ' · ' + fmtAgo(data.lastUpdate.finishedAt)) : null)) : null,
          env.supported && manual.linux ? h(Row, {
            label: '手动命令行',
            hint: '也可以在终端手动执行升级命令。',
          },
            h('div', { style: { width: '100%' } },
              h('div', { className: 'ab-code', style: { marginTop: 0 } }, manual.linux),
              h('div', { className: 'ab-flex', style: { marginTop: 6, gap: 6, flexWrap: 'wrap' } },
                h(Btn, { small: true, onClick: () => copyText(manual.linux, toast) }, '复制 Linux/NAS'),
                manual.windows ? h(Btn, { small: true, onClick: () => copyText(manual.windows, toast) }, '复制 Windows') : null))) : null) : null)),

    // ---------------- 3. 当前通道最新更新日志（可折叠，默认展开） ----------------
    h(FoldCard, {
      title: latest ? `更新日志 · v${latest.version}` : '更新日志',
      desc: latest && latest.name && latest.name !== 'Release v' + latest.version && latest.name !== 'v' + latest.version
        ? latest.name
        : `当前所选「${channelLabel}」通道的最新版本变更说明。`,
      defaultOpen: true,
      right: latest ? h(React.Fragment, null,
        h('span', { className: 'qu-tag ' + (latest.prerelease ? 'beta' : 'ok') }, latest.prerelease ? 'Beta' : '稳定版'),
        latest.version === data.currentVersion ? h('span', { className: 'qu-tag' }, '当前运行') : null,
        latest.publishedAt ? h('span', { className: 'ab-small ab-muted' }, fmtDate(latest.publishedAt)) : null) : null,
    },
      latest
        ? h(React.Fragment, null,
            renderMarkdown(latest.body),
            h('div', { className: 'ab-card-foot' },
              h('span', { className: 'ab-small ab-muted' },
                [
                  latest.tag ? 'Tag ' + latest.tag : '',
                  latest.tarballAsset && latest.tarballAsset.size ? '安装包 ' + fmtSize(latest.tarballAsset.size) : '',
                ].filter(Boolean).join(' · ') || 'QQ Hub Release'),
              latest.htmlUrl
                ? h('a', { className: 'qu-link', href: latest.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看完整 Release ↗')
                : null))
        : h(Empty, { icon: '📝', text: '暂无更新日志，请点击上方「检查更新」拉取。' })),

    // ---------------- 4. 历史更新日志（外层默认折叠 + 每条历史版本可独立折叠） ----------------
    h(FoldCard, {
      title: '历史更新日志',
      desc: history.length
        ? `收录更早的 ${history.length} 个历史版本更新记录，点击可逐条展开阅读。`
        : '当前通道暂无更早的历史更新记录。',
      defaultOpen: false,
      right: h('span', { className: 'qu-tag dim' }, `${history.length} 个历史版本`),
    },
      history.length === 0
        ? h(Empty, { icon: '🗂️', text: '暂无历史更新日志' })
        : h(React.Fragment, null,
            h('div', { className: 'qu-hist-toolbar' },
              data.channel === 'beta'
                ? h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
                    h('button', { type: 'button', className: 'ab-chip solid' + (histFilter === 'all' ? ' on' : ''), onClick: () => setHistFilter('all') },
                      '全部', h('span', { className: 'n' }, String(history.length))),
                    h('button', { type: 'button', className: 'ab-chip solid' + (histFilter === 'stable' ? ' on' : ''), onClick: () => setHistFilter('stable') },
                      '正式版', h('span', { className: 'n' }, String(stableHistCount))),
                    h('button', { type: 'button', className: 'ab-chip solid' + (histFilter === 'beta' ? ' on' : ''), onClick: () => setHistFilter('beta') },
                      'Beta', h('span', { className: 'n' }, String(betaHistCount))))
                : h('span', { className: 'ab-small ab-muted' }, `共 ${visibleHistory.length} 条历史记录`),
              visibleHistory.length > 1
                ? h(Btn, { small: true, kind: 'ghost', onClick: toggleAllHist }, anyHistOpen ? '全部收起' : '全部展开')
                : null),
            visibleHistory.length === 0
              ? h(Empty, { icon: '🔎', text: '该筛选下没有历史版本' })
              : h('div', { className: 'qu-hist-list' },
                  visibleHistory.map((item) => {
                    const isOpen = Boolean(openHist[item.version])
                    const isCur = item.version === data.currentVersion
                    const cleanTitle = item.name && item.name !== 'Release v' + item.version && item.name !== 'v' + item.version && item.name !== item.tag
                      ? item.name
                      : ''
                    return h('div', { key: item.version, className: 'qu-hist-item' + (isOpen ? ' open' : '') },
                      h('button', {
                        type: 'button',
                        className: 'qu-hist-head',
                        'aria-expanded': isOpen,
                        onClick: () => setOpenHist((prev) => ({ ...prev, [item.version]: !prev[item.version] })),
                      },
                        chevronSvg(isOpen),
                        h('span', { className: 'qu-hist-ver' }, 'v' + item.version),
                        h('span', { className: 'qu-tag ' + (item.prerelease ? 'beta' : 'ok') }, item.prerelease ? 'Beta' : '稳定版'),
                        isCur ? h('span', { className: 'qu-tag' }, '当前版本') : null,
                        cleanTitle ? h('span', { className: 'qu-hist-name', title: cleanTitle }, cleanTitle) : null,
                        item.publishedAt ? h('span', { className: 'qu-hist-date' }, fmtDate(item.publishedAt)) : null),
                      isOpen ? h('div', { className: 'qu-hist-body' },
                        renderMarkdown(item.body),
                        h('div', { className: 'ab-card-foot', style: { marginTop: 10, paddingTop: 8 } },
                          h('span', { className: 'ab-small ab-muted' },
                            item.installable === false ? '历史归档记录（来自 CHANGELOG.md）' : ('Tag ' + (item.tag || 'v' + item.version))),
                          h('div', { className: 'ab-flex', style: { gap: 8 } },
                            env.supported && item.installable !== false && !isCur
                              ? h(Btn, {
                                  small: true,
                                  kind: 'ghost',
                                  disabled: !!busy || isUpdating,
                                  onClick: () => startUpdate(item, { allowDowngrade: true }),
                                }, '切换到此版本')
                              : null,
                            item.htmlUrl
                              ? h('a', { className: 'qu-link', href: item.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗')
                              : null))) : null)
                  })))))
}
