// T3.6 panel 真实行为测试：真实 new Function 求值 + 最小 hooks 行为夹具，
// 真实执行 effect 与 cleanup：验证 /state 拉取、卸载后不再 setState、零定时器泄漏。
// （禁止源码正则假测试——本文件只读源码用于 new Function 求值。）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panelSrc = readFileSync(new URL('./panel.js', import.meta.url), 'utf8')

function mkHarness({ stateResponse, immediate = true } = {}) {
  const stateSlots = [] // 按调用序复用（真实 React 语义：重渲染时 hooks 按序取回同一槽）
  let hookIndex = 0
  let setCallCount = 0
  const effects = []
  const React = {
    useState: (init) => {
      const idx = hookIndex++
      if (!stateSlots[idx]) stateSlots[idx] = { value: typeof init === 'function' ? init() : init, setCalls: 0 }
      const slot = stateSlots[idx]
      const set = (v) => {
        slot.setCalls += 1
        setCallCount += 1
        slot.value = typeof v === 'function' ? v(slot.value) : v
      }
      return [slot.value, set]
    },
    useEffect: (fn) => effects.push(fn),
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) })
  const ui = {}
  // call：immediate 立即返回；否则返回受控 deferred（等测试手动放行）
  let release = null
  const call = async (path) => {
    if (immediate) return stateResponse
    return new Promise((resolve) => { release = () => resolve(stateResponse) })
  }
  const timers = { interval: 0, timeout: 0 }
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (fn, ms, ...rest) => { timers.interval += 1; return realSetInterval(fn, ms, ...rest) }
  globalThis.setTimeout = (fn, ms, ...rest) => { timers.timeout += 1; return realSetTimeout(fn, ms, ...rest) }
  const restoreTimers = () => { globalThis.setInterval = realSetInterval; globalThis.setTimeout = realSetTimeout }
  const mkComp = () => {
    const Comp = new Function('React', 'h', 'ui', 'call', panelSrc)(React, h, ui, call)
    // 每次渲染重置 hook 序号：对齐真实 React 的「重渲染按序取回同一状态槽」
    return (props = {}) => { hookIndex = 0; return Comp(props) }
  }
  return {
    React, h, ui, call, stateSlots, effects, mkComp,
    setCallCount: () => setCallCount,
    timers, restoreTimers,
    getRelease: () => release,
  }
}

test('panel.js：new Function 可求值并返回组件函数；挂载即拉取 /state 并渲染状态', async () => {
  const harness = mkHarness({ stateResponse: { ok: true, mode: 'shadow', enabled: false, shadowStats: { total: 3, react: 1, text_lite: 1, full: 1 }, groups: [], pendingCount: 0, health: { degraded: null } } })
  const render = harness.mkComp()
  assert.equal(typeof render, 'function', 'panel.js 必须以函数体返回组件')
  const tree = render({})
  assert.equal(tree.type, 'div')
  assert.equal(harness.effects.length, 1, '/state 拉取在 useEffect 内')
  // 执行 effect：call 被调 → setState → 渲染数据
  const cleanup = harness.effects[0]()
  assert.equal(typeof cleanup, 'function', 'effect 必须返回 cleanup')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(harness.setCallCount() >= 1, true, '/state 结果写入状态')
  // 状态落地后重渲染（真实 React 会因 setState 重跑组件）：新树应包含建议统计与计数
  const tree2 = render({})
  const json = JSON.stringify(tree2)
  assert.ok(json.includes('群参与分级'), '渲染标题')
  assert.ok(json.includes('Shadow 建议'), '渲染建议统计')
  assert.ok(json.includes('覆盖群'), '渲染群计数汇总')
  harness.restoreTimers()
})

test('panel.js：卸载（cleanup）后异步返回不再 setState，且零定时器创建', async () => {
  const harness = mkHarness({ immediate: false }) // deferred：cleanup 先于数据到达
  const render = harness.mkComp()
  render({})
  const cleanup = harness.effects[0]()
  assert.equal(typeof cleanup, 'function')
  cleanup() // 卸载
  harness.restoreTimers() // 先还原计时器（后续等待用真实 setTimeout，不计入面板计数）
  const release = harness.getRelease()
  assert.ok(release, 'deferred call 已发出')
  release() // 数据在卸载后才到达
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(harness.setCallCount(), 0, '卸载后绝不 setState')
  assert.equal(harness.timers.interval, 0, '零 setInterval（面板本体未创建未清理定时器）')
  assert.equal(harness.timers.timeout, 0, '零 setTimeout（面板本体未创建定时器）')
})

test('panel.js：读取失败也安全（不抛出、状态落错误信息）', async () => {
  const stateSlots = []
  const effects = []
  const React = {
    useState: (init) => {
      const slot = { value: typeof init === 'function' ? init() : init, setCalls: 0 }
      const set = (v) => { slot.setCalls += 1; slot.value = typeof v === 'function' ? v(slot.value) : v }
      stateSlots.push(slot)
      return [slot.value, set]
    },
    useEffect: (fn) => effects.push(fn),
  }
  const h = (type, props) => ({ type, props: props || {}, children: [] })
  const call = async () => { throw new Error('网络炸了') }
  let hookIndex = 0
  const Comp = new Function('React', 'h', 'ui', 'call', panelSrc)(React, h, {}, call)
  const render = (props = {}) => { hookIndex = 0; return Comp(props) }
  render({})
  const cleanup = effects[0]()
  await new Promise((r) => setTimeout(r, 20))
  const loading = stateSlots[0]
  const state = stateSlots[1]
  const error = stateSlots[2]
  assert.equal(loading.value, false, 'loading 结束')
  assert.ok(error.value.includes('网络炸了'), '错误信息进状态（不吞错）')
  assert.equal(state.setCalls, 0)
  cleanup()
})

test('panel.js：只使用注入的 React hooks（useState/useEffect），不引用自由变量 toast 等', async () => {
  // 真实求值时只注入 React/h/ui/call：若面板引用了未注入的自由变量（toast 等），挂载即抛 ReferenceError
  const effects = []
  const React = {
    useState: (init) => { const slot = { value: init }; return [slot.value, () => {}] },
    useEffect: (fn) => effects.push(fn),
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) })
  let hookIndex = 0
  const Comp = new Function('React', 'h', 'ui', 'call', panelSrc)(React, h, {}, async () => ({ ok: true }))
  const render = (props = {}) => { hookIndex = 0; return Comp(props) }
  let threw = null
  try { render({}) } catch (error) { threw = error }
  assert.equal(threw, null, `挂载不得抛错（${threw ? threw.message : ''}）`)
  for (const fn of effects) { const cleanup = fn(); cleanup && cleanup() }
})
