// 红果短剧 → 共享浏览器适配层。
//
// 上游 hongguo 的 browser 契约（lib/browser.mjs createBrowser，与 xhs 同一作者同一底座）：
//   open(source, canStart) / connected() / evaluate / goto / waitFor / click /
//   press / type / clearFocused / pressEnter / waitResponse / screenshot / show /
//   close / cookies
// （xhs 多一个 setFiles；hongguo 没有）
//
// 与 xhs 适配器的关键差异：
//   · cookies(['hongguoduanju.com']) 传**域名数组**（xhs 传正则）——这里按域转 URL 再走 lease
//   · close 在上游语义里是「真关进程」（closeAfterRun 省内存）。共享层下改为还租约：
//     浏览器本体归宿主的空闲超时管，同样达到省内存的效果，且不用每轮冷启动
//
// 老宿主 fallback：没有 api.browser() 时用上游 createBrowser（独立实例），行为与原版一致。

const MODULE_ID = 'hongguo'

/** 红果允许的域（与宿主 strategies 一致）。 */
export const HONGGUO_HOSTS = ['hongguoduanju.com', 'hongguo.com', 'hgsnss.com']

/**
 * 造一个上游 lib/browser.mjs 形状的浏览器对象。
 *
 * @param {object} o
 * @param {object|null} o.service     api.browser() 的返回值（null = 老宿主走 fallback）
 * @param {() => object} o.fallback   老宿主的独立实现工厂（lib/browser.mjs createBrowser）
 * @param {object} [o.log]
 */
export function createSharedBrowserAdapter({ service, fallback, log } = {}) {
  if (!service) {
    log?.debug?.('[hongguo] 没有共享浏览器，退回红果自带的专用浏览器')
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
    if (!canStart()) return { ok: false, message: '红果没打开，请先打开红果开关' }
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

  /** 还租约（幂等）。浏览器本体由宿主空闲超时统一关 —— closeAfterRun 的省内存目标同样达成。 */
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
    show: (visible) => need().show(visible),
    cookies: async (domains = ['hongguoduanju.com']) => {
      // 上游传域名数组；lease 收 URL 列表 → 转成 https://<domain>/
      const urls = (Array.isArray(domains) ? domains : [domains]).map((d) => `https://${String(d).replace(/^\./, '')}/`)
      return (await need().cookies(urls)) || []
    },
    close,
  }
  return adapter
}