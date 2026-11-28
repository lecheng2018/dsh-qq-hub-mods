/** @type {import('../qq-hub').QQHubModule} */
// 群参与分级（T3.6 组合入口）：策略在插件、执行在宿主。
//
// 铁律：
//   · 插件只通过 group/participate **声明**参与级别，由宿主 Shared Outbox 执行；
//     本模块绝不调用 api.onebot('set_msg_emoji_like')，绝不绕过宿主发消息；
//   · Shadow 模式零物理副作用：group/participate 返回 undefined（绝不把 {shadow:true}
//     当接管对象交给宿主），统计只在内存；
//   · REACT 熔断：连续明确 failed 达 reactFailureCircuit → circuitUntil 暂停；
//     unknown 独立记谨慎计数（不当失败也不当成功）；sent 清零连续失败并更新 lastReactAt；
//   · 只读 /state 路由只给脱敏汇总（模式 / 计数 / pending 数 / 存储健康 / circuitUntil），
//     绝不返回聊天正文或完整原始 ID 列表；
//   · dispose 完整撤销监听、定时器与路由；重复 setup / dispose 不重复注册、不重复结算。

import { decideParticipation, normalizeAllowedGroupIds, pickEmojiId } from './decision.mjs'
import { createOutputGuard } from './output-guard.mjs'
import { createFeedbackEngine } from './feedback.mjs'
import { createGroupEngagementStore } from './store.mjs'

export const DEFAULT_SETTINGS = {
  enabled: false,
  mode: 'shadow',
  allowedGroupIds: [],
  reactEnabled: false,
  textLiteEnabled: false,
  guardEnabled: false,
  feedbackEnabled: false,
  feedbackBiasEnabled: false,
  emojiIds: ['66'],
  reactScoreThreshold: 0.72,
  textLiteScoreThreshold: 0.4,
  reactCooldownMs: 90000,
  reactFailureCircuit: 3,
  reactCircuitPauseMs: 600000,
  textLiteMaxBubbles: 1,
  textLiteMaxChars: 80,
  feedbackWindowMs: 180000,
  feedbackBiasStep: 0.02,
  feedbackBiasLimit: 0.1,
  maxPendingPerGroup: 32,
  maxRecentTurnIdsPerGroup: 128,
  maxGroups: 200,
}

const shadowStats = { total: 0, react: 0, text_lite: 0, full: 0 }

function groupOf(msg) {
  return String(msg?.groupId || String(msg?.chatId || '').replace(/^group:/, ''))
}

export default {
  id: 'group-engagement',
  name: '群参与分级',
  version: '1.0.0',
  api: 1,
  description: '群插话参与分级：Shadow 只记录建议，TEXT_LITE 收紧分条，REACT 声明由宿主发表情（本模块零直接发送）。',
  panel: 'panel.js',
  defaults: { ...DEFAULT_SETTINGS },
  settings: [
    { key: 'enabled', label: '启用群参与分级', type: 'switch' },
    { key: 'mode', label: '模式（shadow=只记录建议，engage=真实声明）', type: 'select', options: [{ value: 'shadow', label: 'Shadow（只记录建议）' }, { value: 'engage', label: 'Engage（真实声明）' }] },
    { key: 'allowedGroupIds', label: '生效群号（逗号分隔，留空不生效）', type: 'textarea', placeholder: '30001,30002' },
    { key: 'reactEnabled', label: '允许声明 REACT（表情回应）', type: 'switch' },
    { key: 'textLiteEnabled', label: '允许声明 TEXT_LITE（收紧分条）', type: 'switch' },
    { key: 'guardEnabled', label: '插话质量门（拦无意义附和/重复/纯动作）', type: 'switch' },
    { key: 'feedbackEnabled', label: '反馈观察（记录 group/result 与后续消息）', type: 'switch' },
    { key: 'feedbackBiasEnabled', label: '反馈偏置（根据反馈微调内部评分）', type: 'switch' },
    { key: 'emojiIds', label: 'REACT 表情 id（逗号分隔，表情只从这里选）', type: 'text', placeholder: '66' },
    { key: 'reactScoreThreshold', label: 'REACT 评分阈值', type: 'number', min: 0, max: 1 },
    { key: 'textLiteScoreThreshold', label: 'TEXT_LITE 评分阈值', type: 'number', min: 0, max: 1 },
    { key: 'reactCooldownMs', label: 'REACT 冷却（毫秒）', type: 'number', min: 0 },
    { key: 'reactFailureCircuit', label: 'REACT 连续失败熔断阈值（次）', type: 'number', min: 1, max: 20 },
    { key: 'reactCircuitPauseMs', label: 'REACT 熔断暂停时长（毫秒）', type: 'number', min: 0 },
    { key: 'textLiteMaxBubbles', label: 'TEXT_LITE 每轮气泡数', type: 'number', min: 1, max: 12 },
    { key: 'textLiteMaxChars', label: 'TEXT_LITE 每条字数目标', type: 'number', min: 10, max: 500 },
    { key: 'feedbackWindowMs', label: '反馈观察窗口（毫秒）', type: 'number', min: 1000 },
    { key: 'feedbackBiasStep', label: '反馈偏置步长', type: 'number', min: 0, max: 1 },
    { key: 'feedbackBiasLimit', label: '反馈偏置上限（绝对值）', type: 'number', min: 0, max: 1 },
    { key: 'maxPendingPerGroup', label: '每群 pending 上限', type: 'number', min: 4, max: 256 },
    { key: 'maxRecentTurnIdsPerGroup', label: '每群已结算回合记录上限', type: 'number', min: 16, max: 1024 },
    { key: 'maxGroups', label: '覆盖群数量上限', type: 'number', min: 8, max: 2000 },
  ],

  setup(api) {
    const offs = []
    let disposed = false

    const settingsOf = () => ({ ...DEFAULT_SETTINGS, ...(api.settings() || {}) })
    // 存储上限取 setup 时的设置（改上限后重新加载模块生效）；错误走 log，绝不丢旧文件。
    const initial = settingsOf()
    const store = createGroupEngagementStore(api.dataDir('feedback.json'), {
      maxGroups: Math.max(8, Number(initial.maxGroups) || 200),
      maxPendingPerGroup: Math.max(4, Number(initial.maxPendingPerGroup) || 32),
      maxRecentKeysPerGroup: Math.max(16, Number(initial.maxRecentTurnIdsPerGroup) || 128),
      onError: (message) => api.log.warn(message),
    })
    const guard = createOutputGuard({ settings: settingsOf, enabled: true, log: api.log })
    const feedback = createFeedbackEngine({
      store,
      settings: settingsOf,
      enabled: true, // 引擎内不做开关判断：group/result 与 message 入口已按 feedbackEnabled 分流
      botId: '',
    })

    // ---- group/participate：唯一的参与声明入口 ----
    offs.push(api.on('group/participate', (decision, info) => {
      if (disposed) return undefined
      const s = settingsOf()
      const msg = info?.msg || {}
      const groupId = groupOf(msg)
      const bucket = store.getBucket(`group:${groupId}`)
      const result = decideParticipation({
        decision,
        msg,
        recentTexts: Array.isArray(info?.recentTexts) ? info.recentTexts : [],
        settings: s,
        feedbackSnapshot: { bias: Number(bucket.bias) || 0 },
        lastReactAt: Number(bucket.lastReactAt) || 0,
        circuitUntil: Number(bucket.circuitUntil) || 0,
        random: Math.random,
        now: Date.now(),
      })
      // Shadow：只更新内存建议统计，绝不返回接管对象（宿主保持 FULL）。
      if (!result || result.shadow) {
        if (result?.shadow) {
          shadowStats.total += 1
          shadowStats[result.suggested] = (shadowStats[result.suggested] || 0) + 1
        }
        return undefined
      }
      if (result.level === 'react' && result.reaction) {
        return { level: 'react', reaction: { messageId: result.reaction.messageId, emojiId: result.reaction.emojiId } }
      }
      if (result.level === 'text_lite' && result.limits) {
        return { level: 'text_lite', limits: { ...result.limits } }
      }
      return undefined
    }))

    // ---- 插话质量门 ----
    offs.push(api.on('reply', (text, info) => guard.onReply(text, info)))

    // ---- 消息观察（反馈 followup 统计；始终返回 undefined 不接管）----
    offs.push(api.on('message', (msg) => {
      if (disposed) return undefined
      const s = settingsOf()
      if (s.feedbackEnabled !== true) return undefined
      return feedback.onMessage(msg)
    }))

    // ---- group/result：反馈结算 + 质量门终态 + REACT 熔断账 ----
    offs.push(api.on('group/result', (result) => {
      if (disposed || !result || typeof result !== 'object') return
      const s = settingsOf()
      const chatKey = String(result.chatId || '')
      guard.onGroupResult(result)
      if (s.feedbackEnabled === true) feedback.onGroupResult(result)
      // REACT 熔断账：只认自己的声明（sourceModuleId === 本模块 id）
      if (result.sourceModuleId === 'group-engagement' && result.participation === 'react') {
        store.mutate(chatKey, (bucket) => {
          const state = String(result.state || '')
          const threshold = Math.max(1, Number(s.reactFailureCircuit) || 3)
          if (state === 'failed') {
            bucket.consecutiveFailures = (Number(bucket.consecutiveFailures) || 0) + 1
            if (bucket.consecutiveFailures >= threshold) {
              bucket.circuitUntil = Date.now() + Math.max(0, Number(s.reactCircuitPauseMs) || 600000)
              bucket.consecutiveFailures = 0
              api.log.warn(`[群参与] REACT 连续失败达 ${threshold}，熔断至 ${new Date(bucket.circuitUntil).toISOString()}`)
            }
          } else if (state === 'unknown') {
            bucket.reactUnknownCount = (Number(bucket.reactUnknownCount) || 0) + 1 // 谨慎计数：不当失败也不当成功
          } else if (state === 'sent') {
            bucket.consecutiveFailures = 0
            bucket.lastReactAt = Date.now()
          }
          bucket.lastActiveAt = Date.now()
        })
      }
    }))

    // ---- 定期结算过期 pending（也在新事件到来时顺手扫描）----
    offs.push(api.every(60_000, () => {
      if (disposed) return
      const s = settingsOf()
      if (s.feedbackEnabled !== true) return
      feedback.settleExpired(Date.now())
    }, '群参与反馈结算'))

    // ---- 只读 /state：脱敏汇总 ----
    offs.push(api.route('/state', () => {
      const s = settingsOf()
      const groupIds = store.groupIds()
      const groups = []
      let pendingCount = 0
      for (const chatId of groupIds) {
        const bucket = store.getBucket(chatId)
        pendingCount += bucket.pending.length
        groups.push({
          chatId,
          pending: bucket.pending.length,
          bias: Math.round((Number(bucket.bias) || 0) * 1000) / 1000,
          consecutiveFailures: Number(bucket.consecutiveFailures) || 0,
          reactUnknownCount: Number(bucket.reactUnknownCount) || 0,
          circuitUntil: Number(bucket.circuitUntil) || 0,
          resultCounts: { ...bucket.resultCounts },
          feedbackCounts: { ...bucket.feedbackCounts },
        })
      }
      return {
        ok: true,
        enabled: s.enabled === true,
        mode: s.mode,
        reactEnabled: s.reactEnabled === true,
        textLiteEnabled: s.textLiteEnabled === true,
        guardEnabled: s.guardEnabled === true,
        feedbackEnabled: s.feedbackEnabled === true,
        feedbackBiasEnabled: s.feedbackBiasEnabled === true,
        shadowStats: { ...shadowStats },
        groups: groups.slice(0, 100), // 脱敏汇总：绝不返回正文或完整原始 ID 列表
        pendingCount,
        health: store.health(),
      }
    }))

    return {
      dispose() {
        if (disposed) return
        disposed = true
        for (const off of offs) { try { off() } catch {} }
        guard.dispose()
        feedback.dispose()
        store.dispose()
      },
    }
  },
}
