/** @type {import('../qq-hub').QQHubModule} */
import { resolve } from 'node:path'
import { isBotSender, sanitizeHumanMessage } from './filter.mjs'
import { buildDistillPrompt } from './prompt.mjs'
import { verifyAndCleanRules, safeParseJsonArray, normalizeStyle } from './verifier.mjs'
import { createDistillStore } from './store.mjs'
import { scanHistoryGroups, sampleGroupHistory } from './history-miner.mjs'

const RECENT_CACHE_MAX = 4 // 只看最近 4 条干净群友短句
const RULE_REPEAT_COOLDOWN_MS = 10 * 60_000 // 单条口癖 10 分钟内不重复注入

function formatHintPrompt(matched) {
  if (!matched || !matched.length) return ''
  const phrases = matched
    .map(r => normalizeStyle(r.style))
    .filter(Boolean)
    .map(s => `「${s}」`)
  if (!phrases.length) return ''
  return `（顺嘴参考：群里聊到这类事偶尔会随口带一句${phrases.join('或')}，顺嘴就用，不顺嘴直接忽略，千万别硬套。）`
}

export default {
  id: 'distill',
  name: '群友蒸馏',
  version: '2.0.0',
  api: 1,
  description: '按群独立、高信噪比提炼群友短口癖与接话节奏：严格隔离机器人/广告/具体台词，带冷却、概率门禁与复读防线，宁缺毋滥。',
  panel: 'panel.js',
  tab: 'distill',
  defaults: {
    enabled: true,
    batchSize: 35,               // 攒够 35 条干净群友短句再提炼，省 token 且信噪比高
    minDistillIntervalSec: 180,  // 单群最少间隔 3 分钟才允许跑一次提炼
    maxCapacity: 60,             // 每群精简规则上限，宁缺毋滥
    minPromotionCount: 4,        // 至少跨批次出现 4 次（或手动锁定）才生效
    maxInjectedRules: 1,         // 每次最多注入 1 条
    injectChance: 0.35,          // 即使命中也只按 35% 概率顺嘴点缀
    injectCooldownSec: 180,      // 同群 3 分钟内最多注入 1 次
    activeGroups: '',
    modelOverride: '',           // 蒸馏专用模型 provider::模型名；留空跟随主模型
  },
  settings: [
    { key: 'enabled', label: '启用群友蒸馏', type: 'switch' },
    { key: 'minPromotionCount', label: '正式生效门槛（群友使用频次 ≥）', type: 'number', min: 2, max: 15 },
    { key: 'batchSize', label: '实时提炼样本阈值（条）', type: 'number', min: 15, max: 100 },
    { key: 'minDistillIntervalSec', label: '单群提炼最小间隔（秒）', type: 'number', min: 30, max: 3600 },
    { key: 'maxCapacity', label: '每群规则库上限', type: 'number', min: 20, max: 200 },
    { key: 'maxInjectedRules', label: '单次回复最多参考规则数', type: 'number', min: 1, max: 2 },
    { key: 'injectChance', label: '命中后注入概率（0~1）', type: 'number', min: 0.05, max: 1, step: 0.05 },
    { key: 'injectCooldownSec', label: '同群注入冷却（秒）', type: 'number', min: 0, max: 1800 },
    { key: 'activeGroups', label: '指定生效群号（逗号分隔，留空全生效）', type: 'text' },
    { key: 'modelOverride', label: '蒸馏专用模型（provider::模型名，留空跟随主模型）', type: 'text', placeholder: '例如 openai::gpt-5-mini' },
  ],

  setup(api) {
    const store = createDistillStore(api.dataDir())
    const buffers = new Map()         // groupId -> [] 待提炼干净人类短句
    const recentChatCache = new Map() // groupId -> [] 最近 4 条干净群友短句
    const lastDistillAt = new Map()   // groupId -> 上次提炼时间戳
    const lastInjectAt = new Map()    // groupId -> 上次注入时间戳
    const distilling = new Set()      // groupId 正在提炼锁，防并发重入

    const storeLib = api.lib?.('core/store.js')
    const chatLogDir = storeLib?.dataDir ? storeLib.dataDir('chatlog') : resolve(api.dataDir(), '../../chatlog')

    function isGroupActive(groupId) {
      const cfg = api.settings()
      if (cfg.enabled === false) return false
      const activeStr = String(cfg.activeGroups || '').trim()
      if (!activeStr) return true
      const allowed = activeStr.split(/[,，\s\n]+/).map(s => s.trim()).filter(Boolean)
      return allowed.includes(String(groupId))
    }

    // ---------- 蒸馏专用模型 ----------
    function readModelOverride() {
      const raw = String(api.settings().modelOverride || '').trim()
      if (!raw) return null
      const m = /^([^:/|\s]+)\s*(?:::|[/|])\s*(.+)$/.exec(raw)
      if (!m) return { invalid: raw }
      return { provider: m[1], model: m[2].trim() }
    }

    async function askDistill(opts) {
      const sel = readModelOverride()
      if (sel?.invalid) {
        api.log.warn(`[群友蒸馏] 蒸馏模型配置「${sel.invalid}」格式不对（应为 provider::模型名），本次回退主模型`)
        return api.ask(opts)
      }
      if (sel) {
        try {
          return await api.ask({ ...opts, provider: sel.provider, model: sel.model })
        } catch (error) {
          api.log.warn(`[群友蒸馏] 蒸馏模型 ${sel.provider}/${sel.model} 调用失败（${error.message}），本次回退主模型`)
        }
      }
      return api.ask(opts)
    }

    function recordRecentChat(groupId, who, text) {
      let list = recentChatCache.get(groupId)
      if (!list) {
        list = []
        recentChatCache.set(groupId, list)
      }
      if (list.length && list[list.length - 1].text === text) return
      list.push({ who, text, t: Date.now() })
      while (list.length > RECENT_CACHE_MAX) list.shift()
    }

    api.on('message', async (msg) => {
      const isGroup = msg?.kind === 'group' || Boolean(msg?.groupId) || (msg?.chatId && String(msg.chatId).startsWith('group:'))
      if (!isGroup) return false

      const gid = String(msg.groupId || (msg.chatId ? String(msg.chatId).replace(/^group:/, '') : ''))
      if (!gid || !isGroupActive(gid)) return false

      const rootCfg = api.config?.() || {}
      const uid = String(msg.userId || '').trim()
      const who = String(msg.nickname || msg.sender?.card || msg.sender?.nickname || '').trim()

      // 自身 Bot、Q群管家、fishGuard 机器人一律不进缓存也不进蒸馏池
      if (isBotSender({ userId: uid, nickname: who, botQQ: rootCfg.botQQ, fishGuard: rootCfg.group?.fishGuard })) {
        return false
      }

      const clean = sanitizeHumanMessage(msg.text)
      if (!clean) return false

      recordRecentChat(gid, who || '群友', clean)

      let buf = buffers.get(gid)
      if (!buf) {
        buf = []
        buffers.set(gid, buf)
      }

      const prev = buf[buf.length - 1]
      if (!prev || prev.userId !== uid || prev.text !== clean) {
        buf.push({ name: who || '群友', userId: uid, isBot: false, text: clean, t: Date.now() })
      }

      const settings = api.settings()
      const threshold = Math.max(15, Number(settings.batchSize) || 35)
      const minGapMs = Math.max(30, Number(settings.minDistillIntervalSec) || 180) * 1000
      const now = Date.now()

      if (buf.length >= threshold && !distilling.has(gid) && now - (lastDistillAt.get(gid) || 0) >= minGapMs) {
        const lines = buf.splice(0, threshold)
        if (buf.length > threshold * 2) buf.splice(0, buf.length - threshold)
        lastDistillAt.set(gid, now)
        api.later(200, () => runDistillLines(gid, lines))
      }

      return false
    })

    async function runDistillLines(groupId, lines) {
      if (distilling.has(groupId)) return 0
      distilling.add(groupId)
      try {
        const { system, text } = buildDistillPrompt(lines)
        const out = await askDistill({ system, text, maxTokens: 1200, temperature: 0.2 })
        const rawRules = safeParseJsonArray(out)
        if (!rawRules.length) {
          api.log.debug(`[群友蒸馏] 群 ${groupId} 本批 ${lines.length} 条未提炼出高信噪比口癖`)
          return 0
        }

        const cleaned = verifyAndCleanRules(rawRules, lines, { maxPerBatch: 3 })
        if (cleaned.length > 0) {
          const cap = Math.max(20, Number(api.settings().maxCapacity) || 60)
          store.addRules(groupId, cleaned, cap)
          api.log.info(`[群友蒸馏] 群 ${groupId} 提炼入库 ${cleaned.length} 条短口癖（${cleaned.map(r => r.style).join('、')}）`)
        }
        return cleaned.length
      } catch (err) {
        api.log.warn(`[群友蒸馏] 群 ${groupId} 提炼异常:`, err.message)
        return 0
      } finally {
        distilling.delete(groupId)
      }
    }

    // 上下文注入：按群独立 + 高精度匹配 + 群冷却 + 概率节流 + 单条复读冷却 + 轻量非强制措辞
    api.context(({ chat }) => {
      if (!chat || chat.kind !== 'group' || !isGroupActive(chat.groupId)) return ''

      const settings = api.settings()
      const now = Date.now()
      const cooldownMs = Math.max(0, Number(settings.injectCooldownSec ?? 180)) * 1000
      if (cooldownMs > 0 && now - (lastInjectAt.get(chat.groupId) || 0) < cooldownMs) return ''

      const minCount = Math.max(2, Number(settings.minPromotionCount) || 4)
      const activeRules = store.getActiveRules(chat.groupId, minCount)
      if (!activeRules.length) return ''

      const recentLines = recentChatCache.get(chat.groupId) || []
      const freshLines = recentLines.filter(m => now - (m.t || 0) < 5 * 60_000)
      const recentText = freshLines.map(m => m.text).join(' ')
      if (!recentText) return ''

      const maxRules = Math.max(1, Math.min(Number(settings.maxInjectedRules) || 1, 2))
      const matched = store.matchRelevantRules(activeRules, recentText, maxRules, {
        now,
        ruleCooldownMs: RULE_REPEAT_COOLDOWN_MS,
      })
      if (!matched.length) return ''

      const rawChance = Number(settings.injectChance)
      const chance = Number.isFinite(rawChance) && rawChance >= 0 && rawChance <= 1 ? rawChance : 0.35
      if (Math.random() >= chance) return ''

      const prompt = formatHintPrompt(matched)
      if (!prompt) return ''

      lastInjectAt.set(chat.groupId, now)
      try {
        store.recordRuleUsage(chat.groupId, matched.map(r => r.id))
        api.log.info(`[群友蒸馏] 群 ${chat.groupId} 顺嘴参考: ${matched.map(r => `${r.situation}→${r.style}`).join('；')}`)
      } catch {}

      return prompt
    })

    // ---------------- 面板后端路由 ----------------
    const readBody = async (req) => (api.core?.http?.body ? api.core.http.body(req) : (req?.body || req || {}))

    api.route('/models', async () => {
      const sel = readModelOverride()
      let list = []
      try {
        const all = await (api.core?.listModels?.() || [])
        list = (Array.isArray(all) ? all : [])
          .filter(m => m && m.provider && m.model)
          .map(m => ({
            value: `${m.provider}::${m.model}`,
            label: `${m.name || m.model}（${m.provider}）`,
          }))
      } catch (error) {
        api.log.warn(`[群友蒸馏] 读取模型目录失败: ${error.message}`)
      }
      let defaultModel = ''
      try {
        const d = api.core?.defaultModel?.()
        if (d && d.provider && d.model) defaultModel = `${d.provider}::${d.model}`
      } catch {}
      return {
        ok: true,
        list,
        modelOverride: api.settings().modelOverride || '',
        invalid: sel?.invalid || '',
        defaultModel,
        active: sel && !sel.invalid ? `${sel.provider}::${sel.model}` : '',
      }
    })

    api.route('/save-settings', async (req) => {
      const body = await readBody(req)
      if (!body || !Object.prototype.hasOwnProperty.call(body, 'modelOverride')) {
        return { ok: false, message: '没有要保存的设置' }
      }
      const modelOverride = String(body.modelOverride || '').trim()
      try {
        api.saveSettings({ modelOverride })
      } catch (error) {
        return { ok: false, message: '保存失败：' + error.message }
      }
      return { ok: true, modelOverride, settings: api.settings() }
    })

    api.route('/status', async () => {
      const storeGroups = new Set(store.getAllGroupIds())
      for (const gid of buffers.keys()) storeGroups.add(gid)
      const historyStats = scanHistoryGroups(chatLogDir)
      for (const h of historyStats) storeGroups.add(h.groupId)

      const settings = api.settings()
      const minCount = Math.max(2, Number(settings.minPromotionCount) || 4)

      const list = await Promise.all(Array.from(storeGroups).map(async (gid) => {
        const raw = store.getRawRules(gid)
        const active = store.getActiveRules(gid, minCount)
        const candidates = store.getCandidateRules(gid, minCount)
        const buf = buffers.get(gid) || []
        const hStat = historyStats.find(h => h.groupId === gid)
        let groupName = gid
        try {
          groupName = (await api.core?.hub?.groupName?.(String(gid))) || gid
        } catch {}
        return {
          groupId: gid,
          groupName,
          isLiveActive: isGroupActive(gid),
          totalCount: raw.length,
          activeCount: active.length,
          candidateCount: candidates.length,
          lockedCount: raw.filter(r => r.locked).length,
          bufferCount: buf.length,
          historyCount: hStat?.totalCount || 0,
        }
      }))

      list.sort((a, b) => {
        if (a.isLiveActive !== b.isLiveActive) return a.isLiveActive ? -1 : 1
        return (b.activeCount * 1000 + b.historyCount) - (a.activeCount * 1000 + a.historyCount)
      })
      return { ok: true, list, settings }
    })

    api.route('/rules', async (req) => {
      const q = api.core?.http?.query ? api.core.http.query(req) : {}
      const gid = q.groupId || new URL(req.url, 'http://localhost').searchParams.get('groupId')
      if (!gid) return { ok: false, message: '缺少 groupId' }
      const minCount = Math.max(2, Number(api.settings().minPromotionCount) || 4)
      const activeRules = store.getActiveRules(gid, minCount)
      const candidateRules = store.getCandidateRules(gid, minCount)
      return {
        ok: true,
        groupId: gid,
        activeRules,
        candidateRules,
        minCount,
        totalCount: activeRules.length + candidateRules.length,
      }
    })

    api.route('/promote', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { ruleId } = body || {}
      if (!gid || !ruleId) return { ok: false, message: '参数不足' }
      const minCount = Math.max(2, Number(api.settings().minPromotionCount) || 4)
      const success = store.promoteCandidate(gid, ruleId, minCount)
      return { ok: success }
    })

    api.route('/prune-noise', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      if (!gid) return { ok: false, message: '缺少 groupId' }
      const pruned = store.pruneNoise(gid, 2)
      return { ok: true, pruned, message: `已清理 ${pruned} 条低频噪点与脏规则` }
    })

    api.route('/consolidate', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      if (!gid) return { ok: false, message: '缺少 groupId' }
      const reduced = store.consolidate(gid)
      return { ok: true, reduced, message: `近义规则聚类完成，精简了 ${reduced} 条重复规则` }
    })

    api.route('/toggle-lock', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { ruleId } = body || {}
      if (!gid || !ruleId) return { ok: false, message: '参数不足' }
      const locked = store.toggleLock(gid, ruleId)
      return { ok: true, locked }
    })

    api.route('/delete-rule', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { ruleId } = body || {}
      if (!gid || !ruleId) return { ok: false, message: '参数不足' }
      store.deleteRule(gid, ruleId)
      return { ok: true }
    })

    api.route('/add-manual', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { situation, style } = body || {}
      if (!gid || !situation || !style) return { ok: false, message: '情境和风格均不能为空' }
      store.addManualRule(gid, { situation, style })
      return { ok: true }
    })

    api.route('/clear-all', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      if (!gid) return { ok: false, message: '缺少 groupId' }
      store.clearRules(gid)
      return { ok: true }
    })

    api.route('/trigger-now', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      if (!gid) return { ok: false, message: '缺少 groupId' }
      const buf = buffers.get(gid) || []
      if (buf.length < 3) {
        return { ok: false, message: `当前实时短句缓存仅 ${buf.length} 条，不足以提炼（建议等待群友发言或使用历史提炼）` }
      }
      const lines = buf.splice(0, buf.length)
      const count = await runDistillLines(gid, lines)
      return { ok: true, message: `已分析 ${lines.length} 条短句，提炼出 ${count} 条干净口癖` }
    })

    api.route('/distill-history', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { days = 3, sampleSize = 40 } = body || {}
      if (!gid) return { ok: false, message: '缺少 groupId' }

      const rootCfg = api.config?.() || {}
      const lines = sampleGroupHistory(chatLogDir, gid, {
        days: Number(days) || 3,
        sampleSize: Math.min(60, Math.max(10, Number(sampleSize) || 40)),
        botQQ: rootCfg.botQQ || '',
        fishGuard: rootCfg.group?.fishGuard || null,
      })

      if (lines.length < 5) {
        return { ok: false, message: `该群在指定时段内的有效群友短句仅 ${lines.length} 条，不足以提炼（至少需 5 条）` }
      }

      const count = await runDistillLines(gid, lines)
      return {
        ok: true,
        message: count > 0
          ? `抽样 ${lines.length} 条群友短句，提炼出 ${count} 条高信噪比口癖！`
          : `抽样 ${lines.length} 条短句，未发现值得入库的通用口癖（已过滤业务台词与噪点）`,
        sampleCount: lines.length,
        extractedCount: count,
      }
    })

    api.route('/simulate', async (req) => {
      const body = await readBody(req)
      const gid = body?.groupId || body?.scope
      const { userText } = body || {}
      if (!gid || !userText?.trim()) return { ok: false, message: '缺少 groupId 或测试内容' }

      const settings = api.settings()
      const minCount = Math.max(2, Number(settings.minPromotionCount) || 4)
      const activeRules = store.getActiveRules(gid, minCount)
      const maxRules = Math.max(1, Math.min(Number(settings.maxInjectedRules) || 1, 2))
      const matched = store.matchRelevantRules(activeRules, userText, maxRules, { ruleCooldownMs: 0 })

      const stylePrompt = formatHintPrompt(matched)
      const basePersona = api.core?.personas?.currentPersonaText?.() || '你是一个真实在 QQ 群里摸鱼聊天的网友。'
      const system = stylePrompt ? `${basePersona}\n\n${stylePrompt}` : basePersona

      const reply = await askDistill({
        system,
        text: userText,
        maxTokens: 300,
        temperature: 0.7,
      })

      return {
        ok: true,
        matchedRules: matched,
        hit: matched.length > 0,
        stylePrompt,
        reply: reply || '（模型未输出文字）',
      }
    })

    return {
      getGroupRules: (gid) => store.getActiveRules(gid, Math.max(2, Number(api.settings().minPromotionCount) || 4)),
      clearGroupRules: (gid) => store.clearRules(gid),
      purgeDirtyRules: (gid) => store.purgeDirtyRules(gid),
      dispose: () => {
        buffers.clear()
        recentChatCache.clear()
        lastDistillAt.clear()
        lastInjectAt.clear()
        distilling.clear()
      },
    }
  },
}
