// 刷抖音（商店版）：专用浏览器里登录一次；定时自己刷推荐、点赞、评论（特别想让主人看的会在评论里真·@主人），
// 看到好玩的分享给主人（抖音私信 / QQ）；别人发来抖音链接，她也能点开看完再聊。
// 浏览 / 点赞 / 评论 / 分享各有权限（面板「权限」页），默认仅主人。
//
// 2.3.0 起实现整包搬进本模块（lib/duty、site、browser、media），插件本体不再有 src/douyin；
// 插件只提供通用能力，靠 api.lib / api.core 注入（数据目录、出站身份闸、权限档、静默判定、工作区目录、
// 共享浏览器）。这样模块能单独迭代、单独测试：本仓测试全部用假 site / 假 store，不连外网。
import { createDouyin } from './lib/duty.mjs'

export default {
  id: 'douyin',
  name: '刷抖音',
  version: '2.3.0', // 与 module.json 同步（MOD-02：版本与清单一致）
  description: '专用浏览器刷抖音：看推荐、点赞、评论（可在评论里真·@主人），好玩的分享给主人（抖音私信 / QQ）；别人发来链接能点开看（douyin_watch / douyin_like / douyin_comment / douyin_browse）',
  tab: 'douyin',
  setup(api) {
    // 插件内部能力一律按「可缺」取：老版本插件少哪个就在 setup 时报清楚，别让模块静默半死。
    const lib = (path) => {
      try { return api.lib(path) || {} } catch (error) { return {} }
    }
    const store = lib('core/store.js')
    const reply = lib('chat/reply.js')
    const access = lib('chat/access.js')
    const identity = lib('chat/identity-guard.js')
    const { defineTool, str } = lib('tools/tools.js')
    const { profileToolVisible, profilePermits } = access

    const missing = [
      ['core/store.js', typeof store.dataDir === 'function'],
      ['chat/reply.js', typeof reply.isSilence === 'function'],
      ['chat/access.js', typeof access.permOf === 'function' && typeof profileToolVisible === 'function' && typeof profilePermits === 'function'],
      ['chat/identity-guard.js', typeof identity.guardOutbound === 'function'],
      ['tools/tools.js', typeof defineTool === 'function'],
      ['共享浏览器（api.browser，插件 1.4.7 起）', typeof api.browser === 'function'],
    ].filter(([, ok]) => !ok).map(([name]) => name)
    if (missing.length) throw new Error(`刷抖音模块缺宿主能力：${missing.join('、')}（插件版本太旧）`)

    const { hub, http } = api.core
    // 主人的抖音号只由「核对」写入（面板存配置时不能直接改 secUid）
    const setOwner = (owner) => api.setConfig((cur) => ({ ...cur, douyin: { ...cur.douyin, owner } }))
    // 共享浏览器：宿主统一的那一个；没开时 duty 会在面板 / 工具里明确报「共享浏览器没开」，不再自带专用浏览器
    const dy = createDouyin({
      getConfig: api.config,
      getSettings: api.settings,
      setOwner,
      hub,
      store,
      isSilence: reply.isSilence,
      permOf: access.permOf,
      guardOutbound: identity.guardOutbound,
      workspaceDir: (...parts) => api.workspaceDir(...parts),
      memory: api.lazy('memory'),
      log: api.log,
      browser: api.browser?.() || null,
      proactive: api.proactive, // 出站治理面：旧宿主没有时 duty 内部可选链降级回 hub.sendText
    })
    api.every(60_000, () => dy.tick(), '刷抖音')
    // 模块停用 / 被替换时停掉在途一轮、释放浏览器租约（宿主负责撤定时器）
    api.onDispose?.(() => { try { dy.dispose() } catch (error) { api.log?.debug?.('刷抖音收尾失败：' + (error?.message || error)) } })

    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.douyin.enabled || chat.kind === 'system') return []
      // 执行时再查一遍权限（面板可能刚改过）
      const guarded = (key, run) => async (args) => {
        const c = api.config()
        if (!c.douyin.enabled) return { ok: false, message: '抖音没打开' }
        const p = profilePermits(c, key, chat, hub.turnSendersAllOwner(sessionId))
        if (!p.ok) return p
        return run(args)
      }
      const tools = []
      if (profileToolVisible(cfg, 'douyinBrowse', chat)) {
        tools.push(defineTool({
          name: 'douyin_watch',
          description: '打开一个抖音视频看看：读标题、分类、内容摘要和热评，看完再聊。别人发来抖音链接（v.douyin.com 短链也行）时用。',
          properties: { link: str('抖音视频链接或 v.douyin.com 短链') },
          required: ['link'],
          execute: guarded('douyinBrowse', ({ link }) => dy.watch(String(link || ''))),
        }))
        tools.push(defineTool({
          name: 'douyin_recent',
          description: '查最近刷过的抖音视频及真实链接。有人问刚才刷了什么、要分享或评论刚看过的视频时先用；没有记录就如实说。',
          properties: {},
          execute: guarded('douyinBrowse', async () => {
            const videos = dy.recentVideos()
            return { ok: true, message: videos.length ? videos.map((v) => `《${v.title || '无标题'}》${v.url}`).join('\n') : '最近没有能找到链接的视频记录', videos }
          }),
        }))
        tools.push(defineTool({
          name: 'douyin_browse',
          description: '现在去刷一会儿抖音推荐，有人让你去刷抖音、找个视频给他时用。只是开始刷：要几分钟，刷完系统会把结果（看了什么、分享了哪个）告诉你，在那之前别说已经分享了 / 已经发了。主人开口要的话，这轮一定会挑一个分享给主人。',
          properties: {},
          execute: guarded('douyinBrowse', async () => dy.browse({ ownerAsked: hub.turnHasOwner(sessionId), report: chat })),
        }))
      }
      if (profileToolVisible(cfg, 'douyinShareOwner', chat)) tools.push(defineTool({
        name: 'douyin_share_owner',
        description: '主人明确要求分享某个抖音视频给自己时用；link 填真实链接或视频 id。发到面板设置的抖音私信、QQ 或两边。',
        properties: { link: str('抖音视频链接或视频 id') },
        required: ['link'],
        execute: guarded('douyinShareOwner', ({ link }) => dy.shareVideo(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinDm', chat)) tools.push(defineTool({
        name: 'douyin_send_dm',
        description: '主人明确要求你给某个抖音用户发私信时用。target 填对方的主页链接或抖音号，text 是要说的话（300 字以内）。只发给主人指定的人。',
        properties: { target: str('对方抖音主页链接或抖音号'), text: str('要说的话') },
        required: ['target', 'text'],
        execute: guarded('douyinDm', ({ target, text }) => dy.directDm({ target, text })),
      }))
      if (profileToolVisible(cfg, 'douyinLike', chat)) tools.push(defineTool({
        name: 'douyin_like',
        description: '给一个抖音视频点赞。有人明确让你点赞时用。link 填视频链接。',
        properties: { link: str('抖音视频链接') },
        required: ['link'],
        execute: guarded('douyinLike', ({ link }) => dy.likeVideo(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'douyinComment', chat)) tools.push(defineTool({
        name: 'douyin_comment',
        description: '在一个抖音视频下发评论。有人明确让你去评论时用。link 填视频链接，text 是评论内容（100 字以内）。',
        properties: { link: str('抖音视频链接'), text: str('评论内容') },
        required: ['link', 'text'],
        execute: guarded('douyinComment', ({ link, text }) => dy.commentVideo(String(link || ''), String(text || ''))),
      }))
      return tools
    })

    // 面板：/douyin/state 只读文件，绝不为了显示状态去开浏览器
    // （面板页还在插件里，路由沿用无前缀；面板搬进本模块后改成 /ext/douyin/*）
    api.route('/douyin/state', async () => ({ ok: true, ...dy.state() }))
    api.route('/douyin/account', async () => dy.account(true))
    api.route('/douyin/login', async () => dy.loginStep(true))
    api.route('/douyin/login/status', async () => dy.loginStep(false))
    api.route('/douyin/window', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.showWindow(Boolean(b?.visible))
    })
    api.route('/douyin/run', async () => dy.browse())
    api.route('/douyin/dms', async () => dy.checkOwnerDms())
    api.route('/douyin/confirm-owner', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.confirmOwner(String(b?.input ?? api.config().douyin.owner.input ?? ''))
    })
    return dy
  },
}
