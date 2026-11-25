import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isQualityRule, normalizeSituation, normalizeStyle } from './verifier.mjs'

const STOPWORDS = new Set([
  '情境', '口癖', '表达', '使用', '时候', '情况', '别人', '自己', '经常', '习惯',
  '遇到', '发生', '看到', '发现', '表示', '说明', '提出', '建议', '开始', '继续',
  '觉得', '如果', '怎么', '这样', '那样', '这个', '那个', '一个', '一下', '有点',
  '真的', '确实', '好像', '其实', '大家', '有人', '群友', '我们', '你们', '他们',
  '什么', '为什么', '怎么会', '可以', '可能', '就是', '不是', '还是', '直接', '然后',
  '很多', '一些', '所有', '对方', '他人', '东西', '问题', '消息', '说法', '行为',
  '吐槽', '调侃', '短句', '反问', '语气', '口语', '简短', '随口', '回复', '回应',
  '用来', '用于', '某样', '某个', '某项', '某种', '某人', '聊到', '说到', '听到',
])

const FILLER_STRIP_RE = /(?:觉得|感到|感觉|表示|遇到|看到|听到|发现|认为|非常|特别|比较|有点|十分|极其|真的|其实|就是|有点儿|稍微)/g
const DEGREE_CHAR_RE = /[很太真超巨蛮挺的了着过吧啊呀呢嘛哦哈]/g

function stripFillers(str) {
  return normalizeSituation(str)
    .replace(FILLER_STRIP_RE, ' ')
    .replace(/[很太真超巨蛮挺]+/g, ' ')
    .replace(/[的了着过吧啊呀呢嘛哦]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function coreStyle(str) {
  return normalizeStyle(str).replace(DEGREE_CHAR_RE, '').trim() || normalizeStyle(str)
}

/**
 * 中文实词 / 2-gram 提取（先剥除虚词与程度词，再切 2-gram，避免过渡噪点）
 */
export function extractKeywords(str) {
  if (!str) return []
  const stripped = stripFillers(str)
  const parts = stripped.split(/[，,。、！？!?；;：\s\/\-_「」“”"']+/u).filter(Boolean)
  const keywords = new Set()

  for (const p of parts) {
    if (p.length < 2) continue
    if (p.length === 2) {
      if (!STOPWORDS.has(p)) keywords.add(p)
      continue
    }
    for (let i = 0; i <= p.length - 2; i++) {
      const sub = p.slice(i, i + 2)
      if (sub.length === 2 && !STOPWORDS.has(sub)) {
        keywords.add(sub)
      }
    }
  }
  return Array.from(keywords)
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  const union = setA.size + setB.size - inter
  return union > 0 ? inter / union : 0
}

/**
 * 判定两条规则是否真正近义重复（先剥除程度虚词，再用 Jaccard 双重门槛）
 */
export function areRulesSimilar(r1, r2) {
  if (!r1 || !r2) return false
  const sit1 = normalizeSituation(r1.situation)
  const sit2 = normalizeSituation(r2.situation)
  const sty1 = normalizeStyle(r1.style)
  const sty2 = normalizeStyle(r2.style)

  if (!sit1 || !sit2 || !sty1 || !sty2) return false
  if (sit1 === sit2 && sty1 === sty2) return true

  const k1 = extractKeywords(sit1)
  const k2 = extractKeywords(sit2)
  const sitSim = sit1 === sit2 ? 1 : jaccard(k1, k2)

  const cs1 = coreStyle(sty1)
  const cs2 = coreStyle(sty2)
  if (cs1 && cs2 && (cs1 === cs2 || (cs1.length >= 2 && cs2.includes(cs1)) || (cs2.length >= 2 && cs1.includes(cs2)))) {
    return sitSim >= 0.34 || sit1.includes(sit2) || sit2.includes(sit1)
  }

  const s1 = extractKeywords(sty1)
  const s2 = extractKeywords(sty2)
  const stySim = jaccard(s1, s2)

  return sitSim >= 0.5 && stySim >= 0.45
}

/**
 * 按群严格隔离的蒸馏规则存储（无全局共享底座，避免跨群污染与规则膨胀）
 */
export function createDistillStore(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const filePath = join(dataDir, 'distill-rules.json')

  function load() {
    try {
      if (existsSync(filePath)) {
        const text = readFileSync(filePath, 'utf8')
        const data = JSON.parse(text)
        if (!data || typeof data !== 'object') return { groups: {} }
        if (!data.groups || typeof data.groups !== 'object') data.groups = {}
        return data
      }
    } catch (e) {
      console.warn('[distill] 读取规则库失败，使用默认空库:', e.message)
    }
    return { groups: {} }
  }

  function save(data) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmpPath, filePath)
    } catch {
      try {
        writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
      } catch (e) {
        console.error('[distill] 保存规则库失败:', e.message)
      }
    }
  }

  function isValidGroupId(groupId) {
    const gid = String(groupId || '').trim()
    return Boolean(gid && gid !== 'global')
  }

  return {
    getRawRules(groupId) {
      if (!isValidGroupId(groupId)) return []
      const gid = String(groupId).trim()
      const data = load()
      return (data.groups[gid]?.rules || []).map(r => ({ ...r }))
    },

    getRules(groupId) {
      return this.getRawRules(groupId)
    },

    getActiveRules(groupId, minCount = 4) {
      return this.getRawRules(groupId).filter(r => r.locked || (r.count || 1) >= minCount)
    },

    getCandidateRules(groupId, minCount = 4) {
      return this.getRawRules(groupId).filter(r => !r.locked && (r.count || 1) < minCount)
    },

    /** 列出所有群 ID（自动忽略旧版遗留的 global 键） */
    getAllGroupIds() {
      const data = load()
      return Object.keys(data.groups).filter(gid => isValidGroupId(gid))
    },

    /**
     * 合并新提炼的规则到指定群库：
     * - 同一批内对同一条已有规则最多 +1 频次（防止一波刷屏直接转正）
     * - 合并时保留更短、更凝练的 style，绝不越改越长
     */
    addRules(groupId, newRules, maxCapacity = 60) {
      if (!isValidGroupId(groupId) || !Array.isArray(newRules) || !newRules.length) return
      const gid = String(groupId).trim()
      const data = load()
      if (!data.groups[gid]) data.groups[gid] = { rules: [] }
      const list = data.groups[gid].rules
      const now = Date.now()
      const bumpedIds = new Set()

      for (const nr of newRules) {
        const situation = normalizeSituation(nr.situation)
        const style = normalizeStyle(nr.style)
        if (!situation || !style) continue

        const existing = list.find(r => areRulesSimilar(r, { situation, style }))
        if (existing) {
          if (!bumpedIds.has(existing.id)) {
            existing.count = (existing.count || 1) + 1
            bumpedIds.add(existing.id)
          }
          existing.lastSeenAt = now
          if (!existing.locked && style.length < String(existing.style || '').length) {
            existing.style = style
          }
        } else {
          const id = Math.random().toString(36).slice(2, 10)
          bumpedIds.add(id)
          list.push({
            id,
            situation,
            style,
            count: 1,
            createdAt: now,
            lastSeenAt: now,
            locked: false,
          })
        }
      }

      if (list.length > maxCapacity) {
        const locked = list.filter(r => r.locked)
        const unlocked = list.filter(r => !r.locked)
        unlocked.sort((a, b) => {
          const countDiff = (b.count || 1) - (a.count || 1)
          if (countDiff !== 0) return countDiff
          const timeDiff = (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
          if (timeDiff !== 0) return timeDiff
          return (b.createdAt || 0) - (a.createdAt || 0)
        })
        const keepCount = Math.max(0, maxCapacity - locked.length)
        data.groups[gid].rules = [...locked, ...unlocked.slice(0, keepCount)]
      }

      save(data)
    },

    consolidate(groupId) {
      if (!isValidGroupId(groupId)) return 0
      const gid = String(groupId).trim()
      const data = load()
      const rawList = data.groups[gid]?.rules || []
      if (!rawList.length) return 0

      const merged = []
      for (const r of rawList) {
        const target = merged.find(m => areRulesSimilar(m, r))
        if (target) {
          target.count = (target.count || 1) + (r.count || 1)
          if (r.locked) target.locked = true
          if ((r.lastSeenAt || 0) > (target.lastSeenAt || 0)) target.lastSeenAt = r.lastSeenAt
          if ((r.injectedCount || 0) > 0) target.injectedCount = (target.injectedCount || 0) + r.injectedCount
          if (!target.locked && String(r.style || '').length < String(target.style || '').length) {
            target.style = r.style
          }
        } else {
          merged.push({ ...r })
        }
      }

      const reduced = rawList.length - merged.length
      data.groups[gid].rules = merged
      save(data)
      return reduced
    },

    /** 清理低频偶发噪点 + 未锁定的不合格脏规则 */
    pruneNoise(groupId, minCount = 2) {
      if (!isValidGroupId(groupId)) return 0
      const gid = String(groupId).trim()
      const data = load()
      const list = data.groups[gid]?.rules || []
      const before = list.length
      data.groups[gid].rules = list.filter(r => r.locked || ((r.count || 1) >= minCount && isQualityRule(r)))
      const deleted = before - data.groups[gid].rules.length
      if (deleted > 0) save(data)
      return deleted
    },

    /** 专项清洗旧库脏规则，并移除旧版遗留的 global 键 */
    purgeDirtyRules(groupId) {
      const data = load()
      let deleted = 0
      let changed = false

      if (!groupId && Object.prototype.hasOwnProperty.call(data.groups, 'global')) {
        deleted += Array.isArray(data.groups.global?.rules) ? data.groups.global.rules.length : 0
        delete data.groups.global
        changed = true
      }

      const targets = groupId
        ? (isValidGroupId(groupId) ? [String(groupId).trim()] : [])
        : Object.keys(data.groups).filter(isValidGroupId)

      for (const gid of targets) {
        const list = data.groups[gid]?.rules
        if (!Array.isArray(list)) continue
        const kept = []
        for (const r of list) {
          if (r.locked) { kept.push(r); continue }
          if (!isQualityRule(r)) { deleted++; changed = true; continue }
          kept.push({
            ...r,
            situation: normalizeSituation(r.situation),
            style: normalizeStyle(r.style),
          })
        }
        data.groups[gid].rules = kept
      }
      if (changed) save(data)
      return deleted
    },

    promoteCandidate(groupId, ruleId, targetMinCount = 4) {
      if (!isValidGroupId(groupId)) return false
      const gid = String(groupId).trim()
      const data = load()
      const rule = data.groups[gid]?.rules?.find(r => r.id === ruleId)
      if (!rule) return false
      rule.locked = true
      rule.count = Math.max(rule.count || 1, targetMinCount)
      save(data)
      return true
    },

    toggleLock(groupId, ruleId) {
      if (!isValidGroupId(groupId)) return false
      const gid = String(groupId).trim()
      const data = load()
      const rule = data.groups[gid]?.rules?.find(r => r.id === ruleId)
      if (!rule) return false
      rule.locked = !rule.locked
      save(data)
      return rule.locked
    },

    deleteRule(groupId, ruleId) {
      if (!isValidGroupId(groupId)) return
      const gid = String(groupId).trim()
      const data = load()
      if (data.groups[gid]?.rules) {
        data.groups[gid].rules = data.groups[gid].rules.filter(r => r.id !== ruleId)
        save(data)
      }
    },

    addManualRule(groupId, { situation, style }) {
      if (!isValidGroupId(groupId)) return
      const gid = String(groupId).trim()
      const data = load()
      if (!data.groups[gid]) data.groups[gid] = { rules: [] }
      const now = Date.now()
      data.groups[gid].rules.unshift({
        id: Math.random().toString(36).slice(2, 10),
        situation: normalizeSituation(situation) || String(situation).trim(),
        style: normalizeStyle(style) || String(style).trim(),
        count: 5,
        createdAt: now,
        lastSeenAt: now,
        locked: true,
      })
      save(data)
    },

    clearRules(groupId) {
      if (!isValidGroupId(groupId)) return
      const gid = String(groupId).trim()
      const data = load()
      if (data.groups[gid]) {
        data.groups[gid].rules = []
        save(data)
      }
    },

    recordRuleUsage(groupId, ruleIds) {
      if (!isValidGroupId(groupId) || !ruleIds || !ruleIds.length) return
      const gid = String(groupId).trim()
      const data = load()
      const list = data.groups[gid]?.rules
      if (!Array.isArray(list)) return
      const now = Date.now()
      const idSet = new Set(ruleIds)
      let changed = false
      for (const r of list) {
        if (idSet.has(r.id)) {
          r.injectedCount = (r.injectedCount || 0) + 1
          r.lastInjectedAt = now
          changed = true
        }
      }
      if (changed) save(data)
    },

    /**
     * 高精度情境匹配：
     * 1. 运行期兜底跳过未锁定脏规则
     * 2. 跳过冷却期内刚用过的规则（默认 10 分钟不复读同一口癖）
     * 3. 短情境（<=2 个关键词）必须全命中；长情境至少命中 2 个实词且覆盖率 >= 45%
     */
    matchRelevantRules(rules, contextText, limit = 1, { now = Date.now(), ruleCooldownMs = 10 * 60_000 } = {}) {
      if (!Array.isArray(rules) || !rules.length || !contextText) return []
      const text = String(contextText)
      const scored = []

      for (const rule of rules) {
        if (!rule) continue
        if (!rule.locked && !isQualityRule(rule)) continue
        if (ruleCooldownMs > 0 && rule.lastInjectedAt && now - rule.lastInjectedAt < ruleCooldownMs) continue

        const sitKeywords = extractKeywords(rule.situation)
        if (!sitKeywords.length) continue

        let hitSitCount = 0
        for (const k of sitKeywords) {
          if (text.includes(k)) hitSitCount++
        }

        const coverage = hitSitCount / sitKeywords.length
        const passed = sitKeywords.length <= 2
          ? hitSitCount === sitKeywords.length
          : hitSitCount >= 2 && coverage >= 0.45
        if (!passed) continue

        const freqBonus = Math.min(1, Math.log2(1 + (rule.count || 1)) * 0.2)
        const score = coverage * 4 + hitSitCount * 1.5 + freqBonus
        scored.push({ rule, score })
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, Math.max(1, limit)).map(m => m.rule)
    },
  }
}
