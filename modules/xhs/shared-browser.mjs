// 小红书 → 共享浏览器适配层。
//
// 上游 xhs 的 browser 契约（lib/browser.mjs createBrowser 返回的对象）：
//   open(source, canStart) / connected() / evaluate / goto / waitFor / click /
//   press / type / clearFocused / pressEnter / waitResponse / screenshot / show /
//   close / setFiles / cookies
//
// 与抖音 wrapper 的差异：
//   · open 带 source 和 canStart（登录可以在开关关闭时进行）
//   · setFiles（发帖传图，走 DOM.setFileInputFiles —— 共享层 lease 已支持）
//   · cookies(domainRe) 读某域的 Cookie（含 HttpOnly）
//   · close 在 duty 里被当成「空闲时关浏览器」用 —— 共享层下是**还租约**，
//     浏览器本身由宿主的空闲超时管理（不能替别的模块关掉）
//
// 老宿主 fallback：没有 api.browser() 时用上游自己的 createBrowser（独立实例），
// 行为和原版完全一样。两条路不会同时常驻。

const MODULE_ID = 'xhs'

/** 小红书允许的域（与宿主 strategies 一致）。 */
export const XHS_HOSTS = ['xiaohongshu.com', 'xhscdn.com', 'xhslink.com']

/**
 * 造一个上游 lib/browser.mjs 形状的浏览器对象。
 *
 * @param {object} o
 * @param {object|null} o.service    api.browser() 的返回值（null = 老宿主走 fallback）
 * @param {() => object} o.fallback  老宿主的独立实现工厂（lib/browser.mjs createBrowser）
 * @param {() => object} o.getConfig  插件主配置（读 browser 设置）
 * @param {() => object} o.getSettings 模块 settings（enabled 开关）
 * @param {object} [o.log]
 */
export function createSharedBrowserAdapter({ service, fallback, getConfig, getSettings, log } = {}) {
  // 老宿主：原样走上游独立实现，行为不变
  if (!service) {
    log?.debug?.('[xhs] 没有共享浏览器，退回小红书自带的专用浏览器')
    return fallback()
  }

  let lease = null
  let opening = null
  let closing = false

  const connected = () => Boolean(lease && !lease.released)

  function need() {
    if (closing) throw new Error('浏览器正在关闭')
    if (!connected()) throw new Error('浏览器没连上')
    return lease
  }

  async function open(source = '主人要求', canStart = () => true) {
    if (closing) await new Promise((r) => setTimeout(r, 50))
    if (!canStart()) return { ok: false, message: '小红书已关闭，请先打开小红书开关' }
    if (connected()) return { ok: true }
    if (opening) return opening
    opening = (async () => {
      try {
        lease = await service.acquire(MODULE_ID)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error?.message || '浏览器起不来' }
      }
    })().finally(() => { opening = null })
    return opening
  }

  /** 还租约（幂等）。浏览器本体由宿主空闲超时关 —— 不替别的模块做主。 */
  function close() {
    try { lease?.release?.() } catch {}
    lease = null
  }

  const adapter = {
    open,
    connected,
    evaluate: (expression, ms) => need().evaluate(expression, { timeoutMs: ms }),
    goto: (url, ms) => need().goto(url, { waitMs: ms }),
    waitFor: (selector, ms) => need().waitFor(selector, { timeoutMs: ms }),
    click: (x, y) => need().click(x, y),
    press: (selector) => need().press(selector),
    type: (text) => need().type(text),
    clearFocused: () => need().clearFocused(),
    pressEnter: () => need().pressEnter(),
    waitResponse: (urlRe, ms) => need().waitResponse(urlRe, { timeoutMs: ms }),
    screenshot: (clip) => need().screenshot({ clip }),
    setFiles: (selector, files) => need().setFiles(selector, files),
    cookies: async (domainRe = /xiaohongshu\.com/) => {
      // lease.cookies 只收 URL 列表；这里全量拿回来自己按域过滤（和上游 browser.mjs 同语义）
      const all = await need().cookies([])
      return (all || []).filter((x) => domainRe.test(String(x.domain || '')))
    },
    show: (visible) => need().show(visible),
    close,
  }
  return adapter
}