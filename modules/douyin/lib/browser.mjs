// 抖音浏览器适配层：只走宿主的共享浏览器（api.browser()）。
//
// 2.3.0 起不再自带「起 Edge/Chrome、连 CDP、挑标签页」的专用浏览器：
//   · 同一台机器上多开浏览器很容易把内存吃光，共享层（插件 src/browser/）只留一份实现；
//   · 抖音、贴吧、小红书共用一个浏览器进程，一个模块一个标签页，任务串行。
// 宿主没开共享浏览器时明确返回一句人话，不偷偷降级去起第二个进程。
//
// 对外方法名与 site.js 的调用完全一致；close() 只释放租约，不停浏览器（别的模块可能还在用）。

const NOT_READY = '共享浏览器没开：到插件面板「浏览器」页打开总开关，并先装好浏览器'

/**
 * @param {{
 *   service?: object | null,   // api.browser() 的返回值；null = 宿主关了这个功能
 *   moduleId?: string,         // 租约登记用的模块 id
 *   log?: object,
 * }} o
 */
export function createBrowser({ service, moduleId = 'douyin', log } = {}) {
  if (service) return createLeaseBrowser({ service, moduleId, log })
  return {
    open: async () => ({ ok: false, message: NOT_READY }),
    connected: () => false,
    evaluate: async () => { throw new Error(NOT_READY) },
    goto: async () => { throw new Error(NOT_READY) },
    waitFor: async () => { throw new Error(NOT_READY) },
    click: async () => { throw new Error(NOT_READY) },
    press: async () => { throw new Error(NOT_READY) },
    type: async () => { throw new Error(NOT_READY) },
    clearFocused: async () => { throw new Error(NOT_READY) },
    pressEnter: async () => { throw new Error(NOT_READY) },
    waitResponse: async () => { throw new Error(NOT_READY) },
    screenshot: async () => '',
    show: async () => ({ ok: false, message: NOT_READY }),
    close() {},
  }
}

/** 把动作转给共享浏览器的租约。 */
function createLeaseBrowser({ service, moduleId, log }) {
  let lease = null
  let opening = null

  const connected = () => Boolean(lease && !lease.released)

  function need() {
    if (!connected()) throw new Error('浏览器没连上')
    return lease
  }

  async function open() {
    if (connected()) return { ok: true }
    if (opening) return opening
    opening = (async () => {
      try {
        lease = await service.acquire(moduleId)
        return { ok: true }
      } catch (error) {
        log?.warn?.('抖音打开共享浏览器失败：', error?.message)
        return { ok: false, message: error?.message || '浏览器起不来' }
      }
    })().finally(() => { opening = null })
    return opening
  }

  return {
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
    /** 只释放租约，不停浏览器 —— 别的模块可能还在用。 */
    close() {
      try { lease?.release?.() } catch {}
      lease = null
    },
  }
}
