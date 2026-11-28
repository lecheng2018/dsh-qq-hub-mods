// 群参与分级 · 插话质量门（T3.3）。
//
// 接入点：api.on('reply', ...)（宿主把即将发出的整段话交过来）。
// 生效条件（全部满足才检查，否则原样放行）：
//   guardEnabled=true && 群聊 && info.topicMode === 'interject' && info.participation !== 'react'。
// 旧宿主缺 info.topicMode 时直接跳过 —— 不按群猜测回合身份。
// 命中返回 null（宿主整轮不投递），不补发贴纸 / 表情 / 文本。
//
// 重复检测身份：reply 阶段按 turnId 暂存候选；仅当 group/result 为 sent / partial 才进入
// 内存有界「已发送文本」缓存（按群隔离）；skipped / failed / cancelled / unknown 清理候选
// 且不污染已发送缓存。纯内存、容量有界、绝不持久化正文。

const MEANINGLESS = new Set([
  '确实', '好的', '同感', '+1', '1', '嗯嗯', '嗯', '是的', '对', '对对对', '是的呢',
  '好耶', '了解', '收到', '哈哈', '哈哈哈', '哈哈哈哈', '666', '6',
  '好的好的', '是的是的', '嗯嗯嗯', '好好好',
])
// 「无意义词」原样重复两三次（好的好的 / 嗯嗯嗯）仍是零信息附和；不含实质内容的句子才命中。
const REPEATED_MEANINGLESS = (plain) => [...MEANINGLESS].some((w) => w.length >= 1 && (plain === w + w || plain === w + w + w))
// 纯动作描写：整条只有括号/星号包住的动作，没有任何实际内容。
const PURE_ACTION_RE = /^(?:[（(\*【\[][^）)\*】\]]{1,20}[）)\*】\]]|[\*][^\*]{1,20}[\*])[呢呀啦叭~～]*$/
// 万能接话 / 工具腔 / AI 自报身份：精确或强特征匹配，避免误伤正常句子。
const AI_SELF_RE = /^(?:作为(?:一个)?AI|我是(?:一个)?(?:AI|人工智能|机器人|助手|语言模型)|本人是AI|身为AI)/i
const TOOL_SPEAK_RE = /^(?:好的，(?:我|已)|正在(?:调用|处理|执行|生成|为您|为你|帮您|帮你)|已为您|任务完成|工具调用|解析成功|请求成功)/

const normalize = (text) => String(text || '').normalize('NFKC')
  .replace(/[\s\p{P}\p{S}]/gu, '')
  .toLowerCase()
// 语气词收尾（呀/呢/啊/啦/叭/哦/嘛/哟/哈/吧/咯 + 波浪）剥掉后再做「精确附和」比对：
// 「同感呀」与「同感」是同一种零信息附和；带实质内容的句子不受影响。
const stripTailParticles = (plain) => plain.replace(/(?:[呀呢啊啦叭哦嘛哟哈吧咯~～]+)+$/u, '')

export function classifyReply(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return 'empty'
  const plain = stripTailParticles(normalize(raw))
  if (!plain) return 'empty'
  if (MEANINGLESS.has(plain) || REPEATED_MEANINGLESS(plain)) return 'meaningless'
  if (AI_SELF_RE.test(trimmed)) return 'ai-self'
  if (TOOL_SPEAK_RE.test(trimmed) && plain.length <= 12) return 'tool-speak'
  if (PURE_ACTION_RE.test(trimmed)) return 'pure-action'
  return null // 有实际内容：放行
}

const MAX_SENT_PER_GROUP = 32
const MAX_CANDIDATES = 256
const MAX_GROUPS = 200

/**
 * @param {object} o
 * @param {() => object} o.settings 只读设置快照（guardEnabled）
 * @param {boolean} [o.enabled] 入口开关（guardEnabled；双重防御）
 * @param {object} [o.log]
 */
export function createOutputGuard({ settings, enabled = true, log = { info() {}, warn() {} } } = {}) {
  const settingsOf = () => (settings ? (typeof settings === 'function' ? settings() : settings) : {})
  const candidates = new Map() // turnId -> { chatId, text }（reply 阶段暂存）
  const sentByGroup = new Map() // chatId -> Set<normalized text>（已确认发送的 interject 文本）
  let disposed = false

  function touchSent(chatId, text) {
    let set = sentByGroup.get(chatId)
    if (!set) {
      if (sentByGroup.size >= MAX_GROUPS) {
        // 淘汰最旧一个群（Map 插入序）
        const oldest = sentByGroup.keys().next().value
        if (oldest !== undefined) sentByGroup.delete(oldest)
      }
      set = new Set()
      sentByGroup.set(chatId, set)
    }
    set.add(normalize(text))
    while (set.size > MAX_SENT_PER_GROUP) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  return {
    /** api.on('reply') 入口。命中返回 null（拦截）；其余返回 undefined。 */
    onReply(text, info) {
      if (disposed) return undefined
      const cfg = settingsOf()
      if (!enabled || cfg.guardEnabled !== true) return undefined
      const chatId = String(info?.chatId || '')
      // 旧宿主缺 topicMode 直接跳过：不按群猜回合身份
      if (!info || typeof info.topicMode !== 'string') return undefined
      if (info.topicMode !== 'interject') return undefined
      if (info.participation === 'react') return undefined
      if (!chatId.startsWith('group:')) return undefined
      const turnId = String(info.turnId || '')
      const kind = classifyReply(text)
      if (kind) {
        log.info(`[群参与] 质量门拦截（${kind}）：${chatId} 回合 ${turnId || '?'}`)
        return null
      }
      // 同群已确认发送过的 interject 文本重复 → 拦
      const plain = normalize(text)
      const sent = sentByGroup.get(chatId)
      if (sent && sent.has(plain)) {
        log.info(`[群参与] 质量门拦截（duplicate）：${chatId} 回合 ${turnId || '?'}`)
        return null
      }
      // 按 turnId 暂存候选：终态 sent / partial 才进已发送缓存
      if (turnId) {
        if (candidates.size >= MAX_CANDIDATES) {
          const oldest = candidates.keys().next().value
          if (oldest !== undefined) candidates.delete(oldest)
        }
        candidates.set(turnId, { chatId, text: String(text ?? '') })
      }
      return undefined
    },

    /** 消费 group/result：sent / partial 才把候选文本转入已发送缓存；其余清理候选。 */
    onGroupResult(result) {
      if (disposed || !result || typeof result !== 'object') return
      const turnId = String(result.turnId || '')
      if (!turnId) return
      const candidate = candidates.get(turnId)
      if (!candidate) return
      candidates.delete(turnId)
      const state = String(result.state || '')
      const chatId = String(result.chatId || candidate.chatId || '')
      if ((state === 'sent' || state === 'partial') && chatId.startsWith('group:')) {
        touchSent(chatId, candidate.text)
      }
      // skipped / failed / cancelled / unknown：只清候选，绝不污染已发送缓存
    },

    dispose() {
      if (disposed) return
      disposed = true
      candidates.clear()
      sentByGroup.clear()
    },
  }
}
