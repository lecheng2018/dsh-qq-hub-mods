// 空间互动（商店版）：逛好友动态点赞评论，回复自己说说下的新评论。
// 实现留在插件包内（features/qzone-social.js），本模块经 api.lib 引用（壳上商店阶段）。
export default {
  id: 'qzone-social',
  name: '空间互动',
  version: '1.0.0',
  description: '逛好友的 QQ 空间点赞评论，回复自己说说下的评论',
  tab: 'diary',
  setup(api) {
    const { createQzoneSocial } = api.lib('features/qzone-social.js')
    const { hub, chatLog, onebot } = api.core
    const social = createQzoneSocial({ getConfig: api.config, onebot, hub, chatLog, memory: api.lazy('memory'), log: api.log })
    api.every(60_000, () => social.tick(), '空间互动')
    api.route('/qzone/social/run', async () => social.run({ force: true }))
    api.route('/qzone/social/state', async () => ({ ok: true, ...social.state() }))
    return social
  },
}