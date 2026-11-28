// modules/group-engagement/panel.js
// 只读状态面板：按 new Function('React','h','ui','call', src) 求值的函数体编写。
// 铁律：不写 import/export；只用注入的 React / h / ui / call；拉取 /state 放在 useEffect 且
// cleanup 设 disposed 并清 timer；卸载后绝不 setState；无 setInterval / DOM style /
// 事件监听 / clipboard 写操作；只读展示，无清空数据或立即发送按钮。

const { useState, useEffect } = React

return function GroupEngagementPanel() {
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const res = await call('/state')
        if (disposed) return // 卸载后异步返回绝不 setState
        if (res && res.ok) setState(res)
        else setError((res && res.message) || '状态读取失败')
      } catch (e) {
        if (!disposed) setError((e && e.message) || '状态读取失败')
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    load()
    return () => { disposed = true }
  }, [])

  const badge = (text, ok) => h('span', { style: { fontSize: '12px', marginRight: '6px', color: ok ? '#16a34a' : '#6b7280' } }, text)

  const rows = []
  const on = state && state.enabled === true
  rows.push(h('div', { key: 'mode' }, [
    badge(on ? '已启用' : '未启用', on),
    badge('模式：' + ((state && state.mode) || '-')),
  ]))
  if (state) {
    const flags = [
      ['reactEnabled', 'REACT 声明'],
      ['textLiteEnabled', 'TEXT_LITE 声明'],
      ['guardEnabled', '质量门'],
      ['feedbackEnabled', '反馈观察'],
      ['feedbackBiasEnabled', '反馈偏置'],
    ]
    rows.push(h('div', { key: 'flags', style: { marginTop: '6px' } }, flags.map(([key, label]) => {
      const ok = state[key] === true
      return badge(label + '：' + (ok ? '开' : '关'), ok)
    })))
    rows.push(h('div', { key: 'shadow', style: { marginTop: '6px', fontSize: '12px', color: '#6b7280' } },
      'Shadow 建议：react ' + ((state.shadowStats && state.shadowStats.react) || 0) +
      ' / text_lite ' + ((state.shadowStats && state.shadowStats.text_lite) || 0) +
      ' / full ' + ((state.shadowStats && state.shadowStats.full) || 0) +
      '（累计 ' + ((state.shadowStats && state.shadowStats.total) || 0) + '）'))
    const groups = Array.isArray(state.groups) ? state.groups : []
    rows.push(h('div', { key: 'counts', style: { marginTop: '6px', fontSize: '12px', color: '#6b7280' } },
      '覆盖群 ' + groups.length + '（上限内） / 累计 pending ' + (state.pendingCount || 0) +
      ' / 存储' + (state.health && state.health.degraded ? ' degraded：' + state.health.degraded : '健康')))
    for (const g of groups.slice(0, 20)) {
      const circuit = Number(g.circuitUntil) || 0
      rows.push(h('div', {
        key: 'g-' + g.chatId,
        style: { marginTop: '4px', fontSize: '12px', color: circuit > Date.now() ? '#dc2626' : '#374151' },
      }, g.chatId + '：pending ' + g.pending + ' / bias ' + g.bias +
        ' / 连败 ' + g.consecutiveFailures + ' / unknown ' + g.reactUnknownCount +
        (circuit > Date.now() ? ' / 熔断中' : '')))
    }
  }

  return h('div', { className: 'group-engagement-panel' }, [
    h('h3', { key: 'title', style: { margin: '0 0 8px 0', fontSize: '15px' } }, '群参与分级（只读状态）'),
    loading ? h('div', { key: 'loading', style: { fontSize: '12px', color: '#6b7280' } }, '加载中…') : null,
    !loading && error ? h('div', { key: 'error', style: { fontSize: '12px', color: '#dc2626' } }, '读取失败：' + error) : null,
    ...rows,
    h('div', { key: 'hint', style: { marginTop: '8px', fontSize: '12px', color: '#9ca3af' } },
      '数据只存每群的计数与偏置，绝不保存聊天正文；首版阈值需在 Shadow 样本后校准。'),
  ])
}
