// 价格监控面板（qq-hub 版）：监控列表 / 查价加监控 / 价格记忆 三块。
// 标量设置（间隔、阈值、白名单、记忆保留……）走上面的宿主自动表单，这里不再重复渲染。
// 来源：参考 aureth-labs/dsh-aurabot-qq-mods 的 price-watch 面板（作者 cdcp998，MIT）按 qq-hub 面板组件重写。
// 闭包可用：React, h, ui（Card/Btn/Switch/Row/Empty/Select）, call(path[, body]), settings/save/toast/reload。
// 路由：GET /state · POST /search {query} · POST /add {query, pick?} · POST /remove {id}
//       POST /check {id?} · GET/DELETE /memory {id?|clear?,query?}
const { useState, useEffect, useCallback } = React

const fmtPrice = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? '¥' + (Math.round(Number(n) * 100) / 100) : '—')
const clock = (ts) => {
  const n = Number(ts)
  if (!n || !Number.isFinite(n)) return '—'
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
const qualityMark = (q) => (q === 'super' ? '【超级好价】' : q === 'early' ? '【早期好价】' : '')

return function PriceWatchPanel({ toast, reload }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null) // /search 或 /add 的返回
  const [memories, setMemories] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([call('/state'), call('/memory')])
      setState(s)
      setMemories(m)
    } catch (e) { toast && toast(e.message) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const run = async (path, body, note) => {
    setBusy(path)
    try {
      const r = await call(path, body)
      if (r && r.ok === false && r.message && toast) toast(r.message)
      return r
    } catch (e) { if (toast) toast(e.message); return null }
    finally { setBusy(''); refresh() }
  }

  const c = state || {}
  const watches = c.watches || []

  const watchRow = (w, i) => h('div', { key: w.id, style: { borderTop: i ? '1px solid #eee' : '', padding: '8px 0' } },
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
      h('span', { style: { fontWeight: 600 } }, qualityMark(w.quality) + String(w.title || '').slice(0, 44)),
      h('span', { className: 'ab-small' }, w.mall || '未知平台')),
    h('div', { className: 'ab-small', style: { marginTop: 2 } },
      '现在 ' + fmtPrice(w.price),
      Number(w.lowest) > 0 && Number(w.lowest) < Number(w.price) - 0.001 ? ' · 记录最低 ' + fmtPrice(w.lowest) : '',
      ' · 上次检查 ' + clock(w.lastCheck),
      Number(w.alerts) ? ' · 已提醒 ' + w.alerts + ' 次' : ''),
    h('div', { className: 'ab-flex', style: { gap: 6, marginTop: 6 } },
      h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
        const r = await run('/check', { id: w.id }, '检查')
        if (r && r.ok && toast) toast(r.message || '检查完成')
      } }, busy === '/check' ? '检查中…' : '检查'),
      h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
        if (!confirm('取消监控「' + String(w.title || '').slice(0, 30) + '」？')) return
        const r = await run('/remove', { id: w.id })
        if (r && r.ok && toast) toast('已取消监控')
      } }, '取消')))

  const optionRow = (item, i) => h('div', { key: item.articleId || i, style: { padding: '6px 0', borderTop: i ? '1px solid #eee' : '' } },
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
      h('span', null, (i + 1) + '. ' + qualityMark(item.quality) + String(item.title || '').slice(0, 40)),
      h('span', { className: 'ab-small' }, item.mall + ' ' + fmtPrice(item.price))),
    item.url ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, wordBreak: 'break-all' } }, item.url) : null,
    h('div', { style: { marginTop: 4 } },
      h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
        const r = await run('/add', { query, pick: item.articleId })
        if (r && r.ok && toast) toast(r.message || '已开始监控')
        if (r && r.watch) setResult(null)
      } }, '监控这个')))

  const memRow = (item, i) => h('div', { key: item.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: i ? '1px solid #eee' : '' } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { className: 'ab-small', style: { wordBreak: 'break-all' } }, item.text)),
    h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
      const r = await run('/memory', { id: item.id, clear: true })
      if (r && r.ok && toast) toast('已删掉这条价格记忆')
    } }, '删'))

  return h('div', { className: 'ab-grid' },
    h(ui.Card, {
      title: '监控列表（' + watches.length + '）',
      desc: c.enabled ? '到点自动检查；降价或创下记录最低时提醒。' : '总开关在下面的设置表单里，现在是关着的。',
      right: h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
        const r = await run('/check', {})
        if (r && r.ok && toast) toast(r.message || '检查完成')
      } }, busy === '/check' ? '检查中…' : '全部检查'),
    },
      c.lastResult ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } }, '上次：' + c.lastResult) : null,
      watches.length ? watches.map(watchRow) : h(ui.Empty, null, '还没有监控。下面搜一件商品然后点「监控」。')),

    h(ui.Card, { title: '查价 / 加监控', desc: '数据来自什么值得买的公开爆料（聚合京东 / 天猫 / 拼多多 / 抖音商城）；查到的价格会写进她的记忆。' },
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('input', { className: 'ab-input', style: { flex: 1, minWidth: 200 }, placeholder: '商品名，比如 索尼 WH-1000XM5；也支持什么值得买链接', value: query, onChange: (e) => setQuery(e.target.value) }),
        h(ui.Btn, { small: true, disabled: !query.trim() || !!busy, onClick: async () => {
          setBusy('/search'); setResult(null)
          try { const r = await call('/search', { query: query.trim() }); setResult({ kind: 'search', ...(r || {}) }) }
          catch (e) { if (toast) toast(e.message) }
          finally { setBusy(''); refresh() }
        } }, busy === '/search' ? '查价中…' : '查价'),
        h(ui.Btn, { small: true, disabled: !query.trim() || !!busy, onClick: async () => {
          setBusy('/add'); setResult(null)
          try { const r = await call('/add', { query: query.trim() }); setResult({ kind: 'add', ...(r || {}) }) }
          catch (e) { if (toast) toast(e.message) }
          finally { setBusy(''); refresh() }
        } }, busy === '/add' ? '添加中…' : '加监控')),
      result && result.message ? h('div', { className: 'ab-note', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, result.message) : null,
      result && Array.isArray(result.groups) && result.groups.length
        ? result.groups.map((g) => h('div', { key: g.mall, style: { marginTop: 10 } },
            h('div', { className: 'ab-small', style: { fontWeight: 600 } }, g.mall + '（' + (g.total || (g.items || []).length) + ' 条）'),
            (g.items || []).map((item, i) => h('div', { key: item.articleId || i, className: 'ab-small', style: { padding: '3px 0' } },
              fmtPrice(item.price) + ' · ' + String(item.title || '').slice(0, 44) + (item.accessory ? '（配件）' : '')))))
        : null,
      result && Array.isArray(result.options) && result.options.length
        ? h('div', { style: { marginTop: 8 } }, result.options.map(optionRow))
        : null,
      result && result.watch && result.watch.url
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6, wordBreak: 'break-all' } }, '已监控：' + result.watch.title + ' ' + result.watch.url)
        : null),

    h(ui.Card, {
      title: '价格记忆',
      desc: memories && memories.available
        ? '查过的价格按「' + (memories.ttlLabel || '保留时长') + '」写进她的记忆；到期自动清掉。'
        : '记忆模块这会儿不在跑：查价照常，只是不写记忆。',
      right: h(ui.Btn, { small: true, disabled: !!busy, onClick: async () => {
        if (!confirm('清掉全部价格记忆？')) return
        const r = await run('/memory', { clear: true })
        if (r && r.ok && toast) toast(r.message || '已清空')
      } }, '全清'),
    },
      memories && Array.isArray(memories.items) && memories.items.length
        ? memories.items.map(memRow)
        : h(ui.Empty, null, '记忆里还没有价格。')),

    h('div', { className: 'ab-small ab-muted' },
      '监控时段、检查间隔、降价阈值、群聊白名单这些设置在下面的表单里改。'),
  )
}
