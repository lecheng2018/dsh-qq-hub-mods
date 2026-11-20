// 贴吧 → 共享浏览器适配层。
//
// 以前贴吧自带一个 Electron 43（200+ MB），自己管窗口、会话、Cookie、下载拦截，
// 还要经本机 socket 与子进程传 JSON。现在全走宿主的共享浏览器：
// 同一个 Chrome 进程给抖音/贴吧/小红书共用，一个模块一个标签页，任务串行。
//
// 这里实现 tieba.mjs 期望的 renderPage(url, kind) 契约：
//   kind: read / browse / home / search / account / login / logout
//   返回 { html, url, title }（login/logout/account 另有 loggedIn / name / message）
//
// 兼容性：主宿主没有 api.browser()（≤1.4.x 旧版）时，createBrowserReader 仍然存在，
// index.mjs 会退回原来的 Electron 路线。两个实现不能同时常驻 —— 由 index.mjs 的
// 依赖注入决定走哪条。

/** 贴吧允许访问的域（与宿主 strategies 一致；导航级白名单 + 子资源安全过滤都在共享层做）。 */
export const TIEBA_HOSTS = ['tieba.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'baidu.com']
/** 贴吧登录要的 Cookie 名（与原 session.cjs 一致）。 */
export const COOKIE_NAMES = ['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'BAIDUID', 'BAIDUID_BFESS', 'TIEBAUID', 'USER_JUMP', 'PSTM']

/** 「BDUSS=x; STOKEN=y」→ [{name,value}]，只留白名单名字（对应旧 session.cjs 的过滤）。 */
export function parseCookieString(raw, allowNames) {
  const allow = new Set(allowNames || [])
  return String(raw || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      if (i < 1) return null
      const name = p.slice(0, i).trim()
      const value = p.slice(i + 1).trim()
      return name && allow.has(name) ? { name, value } : null
    })
    .filter(Boolean)
}

/**
 * 造一个与旧 createBrowserReader 同形的浏览器对象，底层换成共享层租约。
 *
 * 对 index.mjs 暴露的形状：
 *   renderPage(url, kind)      主契约（tieba.mjs 用）
 *   available()                有没有可用浏览器
 *   status()                   { loginPending, lastLogin, pending, account, available }
 *   openLogin()                打开登录流程
 *   recordAccount(result)      记录登录检查结果
 *
 * @param {object} o
 * @param {object} o.service        api.browser() 返回的共享浏览器服务
 * @param {() => string} o.getCookie  设置里的整串 Cookie
 * @param {object} [o.log]
 * @param {{ pollMs?: number, loginTimeoutMs?: number }} [o.timing] 测试注入：轮询间隔/登录超时
 */
export function createSharedBrowserReader({ service, getCookie, log, timing = {} } = {}) {
  const pollMs = timing.pollMs ?? 5000
  const loginTimeoutMs = timing.loginTimeoutMs ?? 600000
  if (!service) throw new Error('createSharedBrowserReader 需要 service（api.browser()）')

  const MODULE_ID = 'tieba-reader'
  let loginPending = false
  let lastLogin = ''
  let disposed = false
  const account = { loggedIn: null, checkedAt: 0, message: '尚未检查登录' }

  const status = () => ({ loginPending, lastLogin, account, available: true, pending: 0 })

  /** 把整串 Cookie 写进共享浏览器（只写白名单名字）。 */
  async function applyCookies(lease) {
    const raw = getCookie()
    if (!raw) return
    const list = parseCookieString(raw, COOKIE_NAMES)
    if (!list.length) return
    const withDomain = list.map((c) => ({ ...c, domain: '.baidu.com', path: '/', secure: true }))
    await lease.setCookies(withDomain)
    log?.debug?.(`贴吧：写入 ${withDomain.length} 个 Cookie`)
  }

  /**
   * 读 Cookie 进来后先清一次旧会话再写新值 —— 对应旧 clearSession 的语义：
   * 换了 Cookie 就不能带着上一个人的登录态。
   */
  async function resetSession(lease) {
    await lease.clearCookies('https://tieba.baidu.com')
    await applyCookies(lease)
  }

  /** 登录检查：页面里 fetch 用户信息接口（和旧 browser.cjs 相同逻辑）。 */
  async function checkLogin(lease) {
    const r = await lease.evaluate(`(async () => {
      if (/安全验证|访问验证|验证码/.test(document.title) || document.querySelector('#captcha,#vcode,#wappassverify')) return { pending: true }
      try {
        const response = await fetch('/f/user/json_userinfo', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return {}
        const j = await response.json(); const user = j?.data?.user || j?.data || j?.user || j;
        const name = user?.user_name || user?.name_show || user?.user_name_show;
        return name ? { loggedIn: true, name: String(name).slice(0, 100) } : { loggedIn: false }
      } catch { return {} }
    })()`)
    if (r?.pending) return { loggedIn: null, message: '贴吧要求安全验证，请打开登录窗口完成验证。' }
    if (r?.loggedIn === true) return { ok: true, loggedIn: true, name: r.name, message: `已登录：${r.name}` }
    if (r?.loggedIn === false) return { ok: true, loggedIn: false, message: '未确认登录，请打开登录窗口完成验证。' }
    return { ok: false, loggedIn: null, message: '未能检查登录，请打开登录窗口完成验证。' }
  }

  /** 主契约：读页面。 */
  async function renderPage(url, kind) {
    if (disposed) throw new Error('贴吧模块已停用。')
    if (loginPending && kind !== 'login') throw new Error('登录窗口仍然打开，确认登录后会自动关闭；也可先用右上角 × 手动关闭，再检查登录或读帖。')

    const lease = await service.acquire(MODULE_ID)
    try {
      if (kind === 'logout') {
        await lease.clearCookies('https://tieba.baidu.com')
        Object.assign(account, { loggedIn: false, checkedAt: Date.now(), message: '扩展浏览器登录会话已清除。' })
        return { ok: true, loggedIn: false, message: account.message }
      }

      if (kind === 'login') {
        // 登录是「人工流程」：共享层的 lease 没有窗口可弹。
        // 老宿主弹 Electron 窗口；这里改为「先把 Cookie 写进去 → 打开登录页 → 轮询检查 → 主人看 VNC 或看 QQ 截图」。
        loginPending = true
        lastLogin = '登录窗口准备中'
        try {
          await resetSession(lease)
          await lease.goto('https://tieba.baidu.com/', { waitMs: 10000 })
          lastLogin = '登录页已打开。用「远程看画面」（VNC）完成登录；没有 VNC 时看 QQ 里的截图，按提示在手机上配合。'
          // 登录页保持打开（标签页是本模块私有的），轮询上限与旧 Electron 实现一致（10 分钟）；
          // 间隔与超时可注入（测试用小值，真机用默认）
          const deadline = Date.now() + loginTimeoutMs
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, pollMs))
            const st = await checkLogin(lease)
            if (st.loggedIn === true) {
              lastLogin = st.message
              return { ok: true, loggedIn: true, name: st.name, message: `${st.message}（会话已保存在共享浏览器里）`, autoClosed: true }
            }
            if (st.loggedIn === false && Date.now() > deadline - 5000) {
              lastLogin = st.message
              return { ok: true, loggedIn: false, message: st.message }
            }
            if (st.message?.includes('安全验证')) lastLogin = st.message
          }
          lastLogin = '等待登录超时（10 分钟）。页面还开着，可以再点一次登录检查。'
          return { ok: false, loggedIn: null, message: lastLogin }
        } finally {
          loginPending = false
        }
      }

      // 其余 kind 都先保证 Cookie 在（没配就匿名读，由页面自己决定要不要登录墙）
      await applyCookies(lease)

      if (kind === 'account') {
        await lease.goto('https://tieba.baidu.com/', { waitMs: 10000 })
        const st = await checkLogin(lease)
        Object.assign(account, { loggedIn: st.loggedIn, checkedAt: Date.now(), message: st.message })
        return st
      }

      // read / browse / home / search：读整页 HTML 回去给 parse* 用
      await lease.goto(url, { waitMs: 15000 })
      await new Promise((r) => setTimeout(r, 800)) // 等动态渲染一小会儿
      const page = await lease.content()
      if (page.html && /安全验证|访问验证/.test(documentTitleOf(page.title))) {
        throw new Error('贴吧要求安全验证，请打开登录窗口完成验证。')
      }
      return { html: page.html, url: page.url, title: page.title }
    } finally {
      lease.release()
    }
  }

  function documentTitleOf(title) { return String(title || '') }

  /** 登录入口（面板「登录」按钮）。 */
  function openLogin() {
    if (disposed) return { ok: false, message: '贴吧模块已停用。' }
    if (loginPending) return { ok: true, message: '登录流程进行中；确认成功后会自动保存并关闭。' }
    // 异步跑：面板立刻拿到「已开始」，之后用 /state 或 /account 轮询
    renderPage('https://tieba.baidu.com/', 'login').catch((error) => { lastLogin = error.message; loginPending = false })
    return { ok: true, message: '正在打开贴吧登录：会先写入你填的 Cookie，再打开登录页。用「远程看画面」完成验证，确认后会自动检查登录状态。' }
  }

  // 返回**可调用对象**：tieba.mjs 的契约是 `renderPage(url, kind)` 直接调用（旧 Electron
  // 实现返回的就是一个挂了属性的函数）。返回普通对象的话，`renderPage(url, kind)`
  // 会变成「调用对象」→ TypeError: renderPage is not a function。
  const reader = (url, kind) => renderPage(url, kind)
  reader.renderPage = renderPage
  reader.available = () => Boolean(service)
  reader.status = status
  reader.openLogin = openLogin
  reader.recordAccount = (result) => { Object.assign(account, { ...result, checkedAt: Date.now() }) }
  /** 模块卸载时调用：不再接受新任务。 */
  reader.dispose = () => { disposed = true }
  return reader
}