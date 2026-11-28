// 群参与分级 · 纯决策（T3.2）。零副作用：不调 LLM、不读长期记忆、不写文件、不请求网络；
// 时间 / 随机 / 反馈快照一律由调用方注入，方便固定序列测试。
//
// 输出契约（宿主 group/participate 声明式钩子）：
//   · undefined            = 不接管（宿主按 FULL 处理）
//   · { shadow: true, suggested } = Shadow 模式内部统计用 —— **入口绝不能把它当作接管对象返回给宿主**
//   · { level: 'react', reaction: { messageId, emojiId } }   声明 REACT（宿主经 Shared Outbox 执行）
//   · { level: 'text_lite', limits: { maxBubbles, maxChars } } 声明 TEXT_LITE（仍调模型，只收紧分条）

// 轻量回应 cue：短促共鸣词，插话发个表情很自然。
const REACT_CUES = ['哈哈', '笑死', '好耶', '可爱', '确实', '+1', '哈哈哈', '草', '牛', '赞', '太真实了', '乐']
// 需要实际内容的信号：出现即强制排除 REACT（问求助、要资料、贴代码、要解释步骤、带地址/文件）。
const CONTENT_BLOCK_RE = /[?？]|求助|帮[我忙]|怎么办|怎么弄|怎么解|请问|查一下|查查|搜一下|搜索|资料|文档|教程|代码|报错|解释一下|为什么|怎么用|步骤|攻略|地址|链接|网址|下载|文件|看看这个|帮我看看/i
// 短文本（不含标点）加分；长文本降分。
const SHORT_TEXT_CHARS = 12
const LONG_TEXT_CHARS = 40

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** emojiId 只能从 settings.emojiIds 经 random 选出，消息文本永远指定不了表情。 */
export function pickEmojiId(emojiIds, random) {
  const ids = Array.isArray(emojiIds) ? emojiIds.filter((id) => /^\d{1,10}$/.test(String(id))) : []
  if (!ids.length) return null
  const pick = Math.floor(random() * ids.length) % ids.length
  return String(ids[pick])
}

/** allowedGroupIds 兼容数组与逗号分隔字符串两种存法。 */
export function normalizeAllowedGroupIds(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  return String(value || '').split(/[,，\s\n]+/).map((v) => v.trim()).filter(Boolean)
}

/** 评分：只做纯文本的启发式打分，0 ~ 1。 */
export function scoreReply(text) {
  const plain = String(text || '')
  const trimmed = plain.trim()
  if (!trimmed) return { score: 0, blocked: true }
  if (CONTENT_BLOCK_RE.test(plain)) return { score: 0, blocked: true, blockedBy: 'content-need' }
  let score = 0.15 // 基线：纯文本无事发生时的保守起点
  for (const cue of REACT_CUES) {
    if (trimmed.includes(cue)) { score += 0.34; break } // 命中一类 cue 即可，不逐词累加
  }
  const compact = trimmed.replace(/[\s\p{P}]/gu, '')
  if (compact.length && compact.length <= SHORT_TEXT_CHARS) score += 0.35
  if (plain.length > LONG_TEXT_CHARS) score -= 0.45
  return { score: clamp(score, 0, 1), blocked: false }
}

/**
 * 群插话参与决策。
 * @param {object} input 全部显式注入：decision / msg / recentTexts / settings / feedbackSnapshot /
 *                       lastReactAt / circuitUntil / random / now
 * @returns {undefined | {shadow: true, suggested: string, score: number} |
 *                   {level: 'react', reaction: object} |
 *                   {level: 'text_lite', limits: object}}
 */
export function decideParticipation(input = {}) {
  const decision = input.decision || {}
  const msg = input.msg || {}
  const settings = input.settings || {}
  const random = typeof input.random === 'function' ? input.random : Math.random
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const lastReactAt = Number(input.lastReactAt) || 0
  const circuitUntil = Number(input.circuitUntil) || 0

  // ---- 硬性前置：顺序即任务书口径 ----
  if (decision.reply !== true || decision.mode !== 'interject') return undefined
  if (settings.enabled === false || settings.enabled !== true) return undefined
  const groupId = String(msg.groupId || String(msg.chatId || '').replace(/^group:/, ''))
  const allowed = normalizeAllowedGroupIds(settings.allowedGroupIds)
  if (!allowed.includes(groupId)) return undefined

  const feedbackSnapshot = input.feedbackSnapshot || {}
  const biasLimit = clamp(Number(settings.feedbackBiasLimit) || 0.1, 0, 1)
  const bias = clamp(Number(feedbackSnapshot.bias) || 0, -biasLimit, biasLimit)

  // ---- Shadow：只给统计，绝不当接管对象 ----
  if (settings.mode === 'shadow') {
    const { score, blocked } = scoreReply(msg.text)
    const suggested = (!blocked && score >= (Number(settings.reactScoreThreshold) || 0.72)) ? 'react'
      : (!blocked && score >= (Number(settings.textLiteScoreThreshold) || 0.4)) ? 'text_lite'
        : 'full'
    return { shadow: true, suggested, score }
  }

  const { score: rawScore, blocked } = scoreReply(msg.text)
  if (blocked) return undefined
  const score = clamp(rawScore + bias, 0, 1)

  // ---- REACT：内容信号排除 + 达阈值 + reactEnabled + 冷却完成 + 未熔断 + 有效 messageId ----
  const reactEnabled = settings.reactEnabled === true
  const hasValidMessageId = /^\d{1,15}$/.test(String(msg.messageId ?? ''))
  const cooldownMs = Math.max(0, Number(settings.reactCooldownMs) || 0)
  const cooldownDone = !lastReactAt || now - lastReactAt >= cooldownMs
  const circuitOpen = circuitUntil > now
  if (reactEnabled && hasValidMessageId && !circuitOpen && cooldownDone && score >= (Number(settings.reactScoreThreshold) || 0.72)) {
    const emojiId = pickEmojiId(settings.emojiIds, random)
    if (emojiId) {
      return {
        level: 'react',
        reaction: { messageId: String(msg.messageId), emojiId },
        score,
      }
    }
  }

  // ---- 次选 TEXT_LITE：仍调模型，只收紧分条（绝不减少本次模型调用）----
  if (settings.textLiteEnabled === true && score >= (Number(settings.textLiteScoreThreshold) || 0.4)) {
    return {
      level: 'text_lite',
      limits: {
        maxBubbles: clamp(Math.round(Number(settings.textLiteMaxBubbles) || 1), 1, 12),
        maxChars: clamp(Math.round(Number(settings.textLiteMaxChars) || 80), 10, 500),
      },
      score,
    }
  }

  return undefined
}
