import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isBotSender, sanitizeHumanMessage } from './filter.mjs'

/**
 * 扫描本地 chatlog 目录中所有群聊及消息统计
 */
export function scanHistoryGroups(chatLogDir) {
  if (!existsSync(chatLogDir)) return []
  let files = []
  try {
    files = readdirSync(chatLogDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  } catch {
    return []
  }

  const groupStats = new Map()

  for (const f of files) {
    try {
      const content = readFileSync(join(chatLogDir, f), 'utf8')
      const lines = content.split('\n')
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.chatId && entry.chatId.startsWith('group:')) {
            const gid = entry.chatId.slice(6)
            const stat = groupStats.get(gid) || { groupId: gid, totalCount: 0, lastAt: 0 }
            stat.totalCount += 1
            if (entry.t && entry.t > stat.lastAt) stat.lastAt = entry.t
            groupStats.set(gid, stat)
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(groupStats.values()).sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * 从本地 chatlog 提取指定群的历史有效短句样本（严格排除 Bot / Q群管家 / 广告链接 / 长文）
 */
export function sampleGroupHistory(chatLogDir, groupId, { days = 3, sampleSize = 35, botQQ = '', fishGuard = null } = {}) {
  if (!existsSync(chatLogDir) || !groupId) return []
  let files = []
  try {
    files = readdirSync(chatLogDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  } catch {
    return []
  }

  const selectedFiles = files.slice(0, Math.max(1, days))
  const targetChatId = `group:${groupId}`
  const rawEntries = []

  for (const f of selectedFiles) {
    try {
      const content = readFileSync(join(chatLogDir, f), 'utf8')
      const lines = content.split('\n')
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.chatId === targetChatId) {
            rawEntries.push(entry)
          }
        } catch {}
      }
    } catch {}
  }

  rawEntries.sort((a, b) => (a.t || 0) - (b.t || 0))

  const validLines = []
  const recentTexts = new Set()

  for (const item of rawEntries) {
    const uid = String(item.uid || '').trim()
    const who = String(item.who || '').trim()

    if (isBotSender({ userId: uid, nickname: who, botQQ, fishGuard })) continue

    const clean = sanitizeHumanMessage(item.text)
    if (!clean) continue

    const key = `${uid}:${clean}`
    if (recentTexts.has(key)) continue
    recentTexts.add(key)

    validLines.push({
      name: who || '群友',
      userId: uid,
      isBot: false,
      text: clean,
      t: item.t,
    })
  }

  if (validLines.length <= sampleSize) {
    return validLines
  }

  const step = validLines.length / sampleSize
  const sampled = []
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.min(validLines.length - 1, Math.floor(i * step))
    sampled.push(validLines[idx])
  }
  return sampled
}
