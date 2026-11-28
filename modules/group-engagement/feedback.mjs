// 群参与分级 · 反馈观察与一次性结算（T3.5）。
//
// 红线：
//   · group/result 只读观察，绝不当成执行事实源（Outbox 台账才是）；
//   · ${chatId}:${turnId} 有界去重，同一条结果绝不重复结算；
//   · 仅 sent / partial + interject 创建 pending；failed / unknown / cancelled / skipped
//     只记结果计数；unknown 额外记 REACT 谨慎计数（绝不当 ignored / 成功 / 失败）；
//   · message 观察始终返回 undefined（绝不接管消息），只统计同群 pending 的 followup；
//   · 每个 turnId 至多一次终态结算、一次 bias 调整（recentTurnIds 有界去重）；
//   · feedbackBiasEnabled=false 时仍统计但不改 bias；
//   · 重启恢复后按 expiresAt 结算持久化的 pending，不重放未落盘事件。

export function resultKey(chatId, turnId) {
  return `${chatId}:${turnId}`
}

export function clampBias(value, limit) {
  const min = -Math.abs(Number(limit) || 0)
  const max = Math.abs(Number(limit) || 0)
  return Math.min(max, Math.max(min, Number(value) || 0))
}

export function outcomeFor(pending) {
  const speakers = new Set(Array.isArray(pending.followupSpeakerIds) ? pending.followupSpeakerIds : [])
  if ((Number(pending.followupCount) || 0) >= 2 || speakers.size >= 2) return 'extended'
  if ((Number(pending.followupCount) || 0) === 1) return 'connected'
  return 'ignored'
}

const BIAS_DIRECTION = { connected: 1, extended: 1, ignored: -1 }

/**
 * @param {object} o
 * @param {object} o.store createGroupEngagementStore 的实例
 * @param {() => object} o.settings 只读设置快照（feedbackWindowMs / feedbackBiasStep / feedbackBiasLimit / feedbackBiasEnabled / maxRecentTurnIdsPerGroup）
 * @param {boolean} [o.enabled] 反馈总开关（feedbackEnabled=false 时仍由入口决定是否注册；这里再做一道防御）
 * @param {number} [o.botId] 机器人自己的 QQ 号（排除自发消息；缺省不排除）
 */
export function createFeedbackEngine({ store, settings, enabled = true, botId = '' }) {
  const seenMessageIds = new Map() // chatId -> Set<messageId>（纯内存去重，容量有界，不持久化）
  const MAX_SEEN_MESSAGE_IDS = 512

  const settingsOf = () => {
    const s = settings ? (typeof settings === 'function' ? settings() : settings) : {}
    return {
      feedbackWindowMs: Math.max(1000, Number(s.feedbackWindowMs) || 180_000),
      feedbackBiasStep: Math.max(0, Number(s.feedbackBiasStep) || 0.02),
      feedbackBiasLimit: Math.abs(Number(s.feedbackBiasLimit) || 0.1),
      feedbackBiasEnabled: s.feedbackBiasEnabled === true,
      maxRecentTurnIdsPerGroup: Math.max(16, Number(s.maxRecentTurnIdsPerGroup) || 128),
    }
  }

  function trimSeen(chatId) {
    const set = seenMessageIds.get(chatId)
    if (!set) return
    while (set.size > MAX_SEEN_MESSAGE_IDS) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  return {
    /** 消费 group/result（只读观察）。 */
    onGroupResult(result) {
      if (!enabled || !result || typeof result !== 'object') return
      const chatId = String(result.chatId || '')
      const turnId = String(result.turnId || '')
      if (!chatId || !turnId) return
      const s = settingsOf()
      store.mutate(chatId, (bucket) => {
        const key = resultKey(chatId, turnId)
        if (bucket.recentResultKeys.includes(key)) return // 有界去重：同一条结果绝不重复结算
        bucket.recentResultKeys.push(key)
        if (bucket.recentResultKeys.length > s.maxRecentTurnIdsPerGroup) {
          bucket.recentResultKeys = bucket.recentResultKeys.slice(-s.maxRecentTurnIdsPerGroup)
        }
        const state = String(result.state || '')
        bucket.resultCounts[state] = (bucket.resultCounts[state] || 0) + 1
        if (state === 'unknown') bucket.reactUnknownCount = (bucket.reactUnknownCount || 0) + 1
        // 仅 sent / partial + interject 创建成功观察；其余只计数
        if ((state === 'sent' || state === 'partial') && result.topicMode === 'interject') {
          const now = Number(result.at) || Date.now()
          bucket.pending.push({
            turnId,
            chatId,
            participation: String(result.participation || 'full'),
            triggerMessageIds: Array.isArray(result.triggerMessageIds) ? result.triggerMessageIds.map(String) : [],
            createdAt: now,
            expiresAt: now + s.feedbackWindowMs,
            followupCount: 0,
            followupSpeakerIds: [],
          })
          // pending 上限：最旧的先出（执行淘汰以保守上限 2 倍设置值为界，避免 pending 无界）
          const cap = Math.max(8, Math.round(s.maxRecentTurnIdsPerGroup / 4))
          if (bucket.pending.length > cap) bucket.pending = bucket.pending.slice(-cap)
        }
        bucket.lastActiveAt = Date.now()
      })
    },

    /** 消费 message：只观察，始终返回 undefined，绝不接管消息。 */
    onMessage(msg) {
      if (!enabled || !msg || typeof msg !== 'object') return undefined
      const chatId = String(msg.chatId || '')
      if (!chatId.startsWith('group:')) return undefined
      const messageId = String(msg.messageId || '')
      const senderId = String(msg.userId || msg.sender?.userId || '')
      if (msg.self === true || (botId && senderId === String(botId))) return undefined
      if (!messageId) return undefined
      const s = settingsOf()
      const now = Date.now()
      let touched = false
      store.mutate(chatId, (bucket) => {
        let set = seenMessageIds.get(chatId)
        if (!set) { set = new Set(); seenMessageIds.set(chatId, set) }
        if (set.has(messageId)) return // 重复 messageId 不重复计数
        set.add(messageId)
        trimSeen(chatId)
        for (const pending of bucket.pending) {
          if (pending.expiresAt <= now) continue // 过期的由结算负责
          if (Array.isArray(pending.triggerMessageIds) && pending.triggerMessageIds.includes(messageId)) continue
          pending.followupCount = (Number(pending.followupCount) || 0) + 1
          const speakers = Array.isArray(pending.followupSpeakerIds) ? pending.followupSpeakerIds : []
          if (senderId && !speakers.includes(senderId) && speakers.length < 16) speakers.push(senderId)
          pending.followupSpeakerIds = speakers
          touched = true
        }
        if (touched) bucket.lastActiveAt = Date.now()
      })
      // 新事件到来顺手扫描过期 pending（结算在 mutate 内逐桶完成）
      this.settleExpired(now)
      return undefined
    },

    /** 结算过期 pending：每 turnId 至多一次终态 + 一次 bias 调整。 */
    settleExpired(now = Date.now()) {
      if (!enabled) return []
      const s = settingsOf()
      const settled = []
      for (const chatId of store.groupIds()) {
        store.mutate(chatId, (bucket) => {
          const still = []
          for (const pending of bucket.pending) {
            const turnId = String(pending.turnId || '')
            if (pending.expiresAt > now) { still.push(pending); continue }
            if (bucket.recentTurnIds.includes(turnId)) continue // 每 turnId 至多结算一次
            const outcome = outcomeFor(pending)
            bucket.recentTurnIds.push(turnId)
            if (bucket.recentTurnIds.length > s.maxRecentTurnIdsPerGroup) {
              bucket.recentTurnIds = bucket.recentTurnIds.slice(-s.maxRecentTurnIdsPerGroup)
            }
            bucket.feedbackCounts[outcome] = (bucket.feedbackCounts[outcome] || 0) + 1
            if (s.feedbackBiasEnabled && BIAS_DIRECTION[outcome]) {
              bucket.bias = clampBias((Number(bucket.bias) || 0) + BIAS_DIRECTION[outcome] * s.feedbackBiasStep, s.feedbackBiasLimit)
            }
            settled.push({ chatId, turnId, outcome })
          }
          bucket.pending = still
        })
      }
      return settled
    },

    dispose() {
      seenMessageIds.clear()
    },
  }
}
