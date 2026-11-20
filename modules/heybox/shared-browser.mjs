// 小黑盒 → 共享浏览器适配层。
//
// 上游 heybox 的 browser 契约（lib/browser.mjs createBrowser 返回的连接对象）：
//   open(source, canStart) / connected / evaluate / goto / waitFor /
//   setCookies(list) / cookies() / screenshot / show / close
// 使用方（全部经注入拿到这个对象）：
//   · verify.mjs   createVerifier({ browser })   —— 浏览器验证兜底
//   · site.mjs     tokenBrowser                  —— 扫码后取 x_xhh_tokenid、网页兜底发帖
//   · qr.mjs       fetchWebToken({ browser })    —— 同上（走 site 的 getWebBrowser）
//
// 与抖音/小红书适配层同一形状；特殊点：
//   · cookies() 无参 = 全量（verify.mjs 要自己按 xiaoheihe.cn 域过滤）
//   · close() 还租约（浏览器本体由宿主空闲超时统一关）
//
// 老宿主 fallback：没有 api.browser() 时用上游 createBrowser（独立实例），原版行为。

const MODULE_ID = 'heybox'

/** 小黑盒允许的域（与宿主 strategies 对齐时用）。 */
export const HEYBOX_HOSTS = ['xiaoheihe.cn']

/**
 * 造一个上游 lib/browser.mjs 形状的浏览器连接对象。
 *
 * @param {object} o
 * @param {object|null} o.service    api.browser() 的返回值（null = 老宿主走 fallback）
 * @param {() => object} o.fallback  老宿主的独立实现工厂（lib/browser.mjs createBrowser）
 * @param {object} [o.log]
 */
export function createSharedBrowserAdapter({ service, fallback, log } = {}) {
  if (!service) {
    log?.debug?.('[heybox] 没有共享浏览器，退回小黑盒自带的专用浏览器')
    return fallback()
  }

  let lease = null
  let opening = null

  const connected = () => Boolean(lease && !lease.released)

  function need() {
    if (!connected()) throw new Error('浏览器没连上')
    return lease
  }

  async function open(source = '主人要求', canStart = () => true) {
    if (!canStart()) return { ok: false, message: '浏览器被调用方拦下' }
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

  /** 还租约（幂等）。 */
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
    setCookies: (list) => need().setCookies(list),
    cookies: async () => (await need().cookies()) || [],
    screenshot: (clip) => need().screenshot({ clip }),
    show: (visible) => need().show(visible),
    close,
  }
  return adapter
}