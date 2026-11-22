// B站（商店版）：别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，
// 看到好玩的分享给主人；抽帧看画面、发截图；按权限改自己的头像/签名。
//
// 1.2.0 起实现整包搬进本模块（api.mjs / duty.mjs / vision.mjs / shots.mjs），插件本体不再有
// src/bili；插件只提供通用能力，靠 api.lib 注入（数据目录、模型调用、ffmpeg 查找、SSRF 校验、
// 出站身份闸、静默判定）。这样模块能单独迭代、单独测试，B 站自己选模型也只在这里改。
//
// 「B 站用的模型」：面板里选一个模型后——
//   · 刷 B 站那几轮后台回合（挑关键词 / 决定评论·回复·分享）用 model 事件改成它；
//   · 抽帧看画面的描述也用它（先问它能不能看图，不能就跳过看画面）；
//   · 留空 = 全部跟随全局模型，行为和老版本一样。
import { readFileSync } from 'node:fs'
import { createBili } from './duty.mjs'
import { lookWithVision, biliModelOf } from './vision.mjs'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.2.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论；抽帧看画面、发截图；按权限改自己的头像 / 签名，可单独选模型（bili_watch / bili_comment / qq_send_shot / bili_set_avatar / bili_set_sign）',
  tab: 'bili',
  setup(api) {
    // 插件内部能力一律按「可选」取：缺一个（老版本插件）就少一项功能，不要让整个模块加载失败。
    const lib = (path) => {
      try { return api.lib(path) || {} } catch (error) { return {} }
    }
    const store = lib('core/store.js')
    const llm = lib('core/llm.js')
    const img = lib('core/img.js')
    const net = lib('core/net.js')
    const reply = lib('chat/reply.js')
    const identity = lib('chat/identity-guard.js')
    const { defineTool, str } = lib('tools/tools.js')
    const { profileToolVisible, profilePermits } = lib('chat/access.js')
    const { avatarSource } = lib('modules/profile/index.js')

    const { hub, chatLog } = api.core
    const lastImage = new Map() // chatId → 最近一张图的网址（给 bili_set_avatar 的 last 用）
    api.on('message', (msg) => {
      const url = (msg.images || []).slice(-1)[0]?.data?.url
      if (url && /^https?:\/\//i.test(url)) lastImage.set(msg.chatId, url)
      return false
    })

    // 看画面要用到的插件能力，一次性注入（不 import 插件路径，模块仓库里能跑测试）
    const visionDeps = {
      findFfmpeg: img.findFfmpeg,
      assertPublicUrl: net.assertPublicUrl,
      askModel: llm.askModel,
      canSeeImages: llm.canSeeImages,
      modelVision: llm.modelVision,
    }

    const bili = createBili({
      getConfig: api.config,
      hub,
      chatLog,
      memory: api.lazy('memory'),
      log: api.log,
      dsh: api.dsh,
      store,
      isSilence: reply.isSilence,
      guardOutbound: identity.guardOutbound,
      vision: (o) => lookWithVision({ ...o, deps: visionDeps }),
      visionDeps,
    })
    api.every(60_000, () => bili.tick(), '刷B站')

    // 单独选的模型：只改「刷 B 站」那几个后台会话（system:bili），聊天和别的模块不受影响。
    // 没选 / 插件太老没这个配置时返回 undefined，宿主就按原来的全局模型走。
    api.on('model', (sel, chat) => {
      if (!chat || chat.kind !== 'system') return undefined
      const key = String(chat.chatId || '')
      if (key !== 'system:bili' && !key.startsWith('system:bili:')) return undefined
      const chosen = biliModelOf(api.config().bili || {})
      if (!chosen) return undefined
      return {
        ...(sel || {}),
        provider: chosen.provider,
        model: chosen.model,
        reasoningEffort: chosen.reasoningEffort || (sel && sel.reasoningEffort) || '',
      }
    })

    // 看视频谁发的链接都能看，评论要主人开口
    api.tool(({ chat, sessionId }) => {
      if (!api.config().bili.enabled || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
        }),
        // 截图：刷 B 站看画面时截下来的那些帧，存在本机，随时能挑一张发出来
        defineTool({
          name: 'qq_send_shot',
          description: '把你在 B 站视频里截到的画面发到当前聊天。主人说「发张截图」「给我看看你刷到的」「刚才那个视频长啥样」这类话时用。query 填视频标题里的词或想看的内容，不填就挑最近的一张。',
          properties: { query: str('可选：视频标题关键词，或想看的内容') },
          required: [],
          execute: async ({ query }) => bili.sendShot({ chatId: chat.chatId, query: String(query || '') }),
        }),
        defineTool({
          name: 'qq_list_shots',
          description: '看看你手上还有哪些 B 站截图（来自哪个视频、第几秒）。挑截图之前可以先看一眼。',
          properties: { query: str('可选，按视频标题筛选') },
          required: [],
          execute: async ({ query }) => bili.listShots(String(query || '')),
        }),
      ]
    })

    // 改 B 站头像 / 签名：权限在面板「权限」页（关 / 仅主人私聊 / 所有人），默认仅主人私聊
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.bili.enabled) return []
      const tools = []
      if (profileToolVisible(cfg, 'biliAvatar', chat)) tools.push(defineTool({
        name: 'bili_set_avatar',
        description: '换你自己 B 站账号的头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图（最大 2MB）。',
        properties: { image: str('图片网址（http/https），或 last 表示刚才发的那张图') },
        required: ['image'],
        execute: async ({ image }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliAvatar', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          const raw = String(image || '').trim()
          const useLast = !raw || /^(last|刚才|上一张|最近)/i.test(raw)
          const previous = lastImage.get(hub.chatOfSession?.(sessionId) || chat.chatId)
          if (useLast && !previous) return { ok: false, message: '这个聊天里还没人发过可用的图片网址' }
          // QQ 头像模块现在只校验网址；B站的 last 在这里解析，避免与画作编号混用。
          const src = avatarSource(useLast ? previous : raw)
          if (!src.ok) return src
          return bili.setAvatar(src.file)
        },
      }))
      if (!profileToolVisible(cfg, 'biliSign', chat)) return tools
      return [...tools, defineTool({
        name: 'bili_set_sign',
        description: '改你自己 B 站账号的个性签名（最多 70 字）。有人让你改 B 站签名时用。',
        properties: { text: str('新的签名') },
        required: ['text'],
        execute: async ({ text }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliSign', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          return bili.setSign(text)
        },
      })]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
    // 截图库（面板里看全部、手动删）
    api.route('/bili/shots', async () => ({ ...bili.libraryShots(), limit: api.config().bili.shotLibrary }))
    api.route('/bili/shot/image', async (req, res) => {
      const p = bili.shotFileOf(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      return api.core.http.send(res, 200, readFileSync(p), 'image/jpeg')
    })
    api.route('/bili/shot/delete', async (req) => bili.deleteShot(String((await api.core.http.body(req)).file || '')))
    return bili
  },
}