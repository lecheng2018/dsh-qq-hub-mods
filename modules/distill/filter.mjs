/**
 * 群友蒸馏 v2 · 统一消息过滤器（实时流与历史抽样共用）
 * 彻底隔离自身 Bot、Q群管家、其他 AI 机器人、链接广播、长篇粘贴与代码日志，
 * 只保留真实群友的短句自然口语。
 */

const BUILTIN_BOT_UIDS = new Set([
  '2854196310', // Q群管家 pii-scan:ignore
  '2854196306', // QQ小冰 pii-scan:ignore
  '2854196312', // QQ官方机器人 pii-scan:ignore
  '2854196320', // QQ官方系统号 pii-scan:ignore
])

const BOT_NAME_RE = /^(?:bot|ai|q群管家|群管家|小冰)$/i
const BOT_NAME_HINT_RE = /(?:q群管家|群管家|群助手|机器人|自动回复|广播|小助手|\b(?:bot|ai)\b)/i
const URL_RE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|cn|net|org|io|top|us|me|dev|app|ai)\b)/i
const MEDIA_ONLY_RE = /^(?:\[(?:图片|表情|动画表情|分享卡片|语音|视频|文件[^\]]*|合并转发|卡片消息|sticker|image)\]\s*)+$/i
const CODE_OR_LOG_RE = /(?:[{}\[\]]{2,}|```|Traceback|Exception|TypeError|SyntaxError|ReferenceError|\b(?:const|function|import|return|SELECT|INSERT)\b)/

/**
 * 判断发言人是否为机器人 / 系统账号
 */
export function isBotSender({ userId = '', nickname = '', botQQ = '', fishGuard = null } = {}) {
  const uid = String(userId || '').trim()
  const nick = String(nickname || '').trim()
  const selfQQ = String(botQQ || '').trim()

  // chatlog 中 Bot 自身记录为 who='bot' 且 uid=null/''
  if (!uid || nick.toLowerCase() === 'bot') return true
  if (selfQQ && uid === selfQQ) return true
  if (BUILTIN_BOT_UIDS.has(uid)) return true

  // 继承群聊配置里的 fishGuard 名单与后缀
  const fishIds = Array.isArray(fishGuard?.fishIds) ? fishGuard.fishIds.map(String) : []
  if (fishIds.includes(uid)) return true

  const suffixes = Array.isArray(fishGuard?.nameSuffixes) ? fishGuard.nameSuffixes : []
  for (const s of suffixes) {
    if (s && nick.toLowerCase().endsWith(String(s).toLowerCase())) return true
  }

  if (BOT_NAME_RE.test(nick) || BOT_NAME_HINT_RE.test(nick)) return true
  return false
}

/**
 * 清洗并校验一条群消息是否适合进入蒸馏池或上下文匹配
 * 返回清洗后的短文本；不适合则返回空串 ''
 */
export function sanitizeHumanMessage(rawText, { maxChars = 60 } = {}) {
  if (!rawText || typeof rawText !== 'string') return ''
  const text = rawText.replace(/\r\n/g, '\n').trim()
  if (!text) return ''

  if (text.startsWith('/') || text.startsWith('【更早聊天的摘要')) return ''
  if (MEDIA_ONLY_RE.test(text)) return ''
  if (URL_RE.test(text)) return ''

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length >= 3) return ''
  const compact = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (compact.length < 2 || compact.length > maxChars) return ''

  if (CODE_OR_LOG_RE.test(compact)) return ''
  const asciiLetters = (compact.match(/[a-zA-Z]/g) || []).length
  const cjkChars = (compact.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjkChars < 2 && asciiLetters > 6) return ''
  if (compact.length >= 12 && asciiLetters / compact.length > 0.65) return ''

  if (/^[\d\s\p{P}\p{S}]+$/u.test(compact)) return ''

  return compact
}
