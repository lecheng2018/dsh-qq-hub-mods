/**
 * 群友蒸馏 v2 · 严格质量校验与清洗器（保留截断 JSON 对象抢救能力）
 * 防止具体话题台词、数字价格、产品术语、说教模板与 Bot 自毒进入规则库。
 */

const DOMAIN_NOISE_RE = /(?:gemini|claude|gpt|deepseek|qwen|openai|google|anthropic|aws|azure|github|magpie|antigravity|workbuddy|cursor|codex|flash|neon|carbon|plus|pro|ultra|api|token|error|bug|vps|tun|ip|bot|ai|反代|节点|机场|家宽|风控|封号|申诉|解封|白嫖|薅羊毛|薅一下|羊毛|鸡蛋|订阅|套餐|会员|额度|卡密|工作区|插件|模型|降智|破甲|按量计费|虚拟卡|学生认证|千问|豆包|华为云|阿里云|反重力|客户端|代理|梯子|群公告)/i

const META_TEMPLATE_RE = /(?:先.{1,6}再|再补|接着|并(?:夸张|用|在|附)|配合|艾特|@|无标点|标点|句式|省略号|报数字|数字|开头|结尾|起头|收尾|连说|反问句|长句|短句|例如|比如|[，,、\s]如\s|^如\s|括号|表情收尾|自嘲自己|欢迎新人|入群|被要求说话|测\s*ai|小作文|复读|贴标签|下定论|下判断|不解释|直接发|直接甩|打趣|感叹|比喻|叠词|反差|简洁陈述|贬低|形容|对比|起哄|事件描述|调侃语气|链接|攻略)/i

const PERSONAL_LIFE_RE = /我(?:被封|买过|在读|住在|工作在|破产|阳了|确诊|结婚|离婚|考研|买房|刚买|刚换|这随便|感觉不是|也不清楚|真的有点)/

const TEMPLATE_SLOT_RE = /(?:\.\.\.|…|[Xx]{2,}|【|】|\*\*|```|\d|\+|（\s*）|\(\s*\))/

/**
 * 抢救被 max_tokens 截断的 JSON 数组里已经写完整的对象（保留 1.0.0-beta.6 能力）
 */
function rescueObjectsFromTruncatedArray(text) {
  const clean = text.replace(/<\/?think>/gi, '').replace(/```(?:json)?/gi, '')
  const start = clean.search(/\[\s*\{/)
  if (start < 0) return []

  const out = []
  let i = start + 1
  while (i < clean.length) {
    const c = clean[i]
    if (c === ']') break
    if (c === '"') {
      i++
      while (i < clean.length && clean[i] !== '"') { if (clean[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c !== '{') { i++; continue }

    let depth = 0
    let j = i
    let inStr = false
    for (; j < clean.length; j++) {
      const ch = clean[j]
      if (inStr) {
        if (ch === '\\') j++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { j++; break }
      }
    }
    if (depth !== 0) break
    try {
      const obj = JSON.parse(clean.slice(i, j))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj)
    } catch {}
    i = j
  }
  return out
}

/**
 * 健壮地从模型输出中提取 JSON 数组（兼容 <think>、markdown 代码块、括号匹配与截断抢救）
 */
export function safeParseJsonArray(text) {
  if (!text || typeof text !== 'string') return []
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (!clean || /^\[\s*\]$/.test(clean)) return []

  // 1. markdown 代码块
  const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim())
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        for (const k of ['rules', 'candidates', 'data', 'styles', 'items']) {
          if (Array.isArray(parsed[k])) return parsed[k]
        }
      }
    } catch {}
  }

  // 2. 严格括号匹配第一个包含对象的数组
  const startIdx = clean.search(/\[\s*\{/)
  if (startIdx >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    let endIdx = -1

    for (let i = startIdx; i < clean.length; i++) {
      const ch = clean[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (!inString) {
        if (ch === '[') depth++
        else if (ch === ']') {
          depth--
          if (depth === 0) { endIdx = i; break }
        }
      }
    }

    if (endIdx > startIdx) {
      try {
        const parsed = JSON.parse(clean.slice(startIdx, endIdx + 1).trim())
        if (Array.isArray(parsed)) return parsed
      } catch {}
    }
  }

  // 3. 包装对象 { "rules": [...] }
  const objMatch = clean.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0].trim())
      for (const k of ['rules', 'candidates', 'data', 'styles', 'items']) {
        if (Array.isArray(obj[k])) return obj[k]
      }
    } catch {}
  }

  // 4. 截断抢救：模型写到一半被截断时抢救前面已经完整的对象
  return rescueObjectsFromTruncatedArray(clean)
}

export function normalizeStyle(raw) {
  let s = String(raw || '').trim()
  s = s
    .replace(/^(?:调侃|吐槽|附和|回应|回复|反问|口语化|随口|直接)?(?:使用|用|说|回|扔个|抛出|带一句|回复)\s*/g, '')
    .replace(/^[「“"']([^「」“”"']{2,14})[」”"']$/, '$1')
    .replace(/(?:来(?:简短)?(?:附和|吐槽|调侃|化解|表达|回应)|的(?:口癖|语调|语气|短句|表达))$/g, '')
    .trim()
  s = s.replace(/^[「“"']([^「」“”"']{2,14})[」”"']$/, '$1').trim()
  return s
}

export function normalizeSituation(raw) {
  return String(raw || '')
    .trim()
    .replace(/^(?:当|在|遇到|聊到|说到|看到)?/g, '')
    .replace(/(?:的时候|时)$/g, '')
    .trim()
}

export function isQualityRule(rule) {
  if (!rule || typeof rule !== 'object') return false
  const rawSit = String(rule.situation || '').trim()
  const rawStyle = String(rule.style || '').trim()

  if (DOMAIN_NOISE_RE.test(rawSit) || DOMAIN_NOISE_RE.test(rawStyle)) return false
  if (META_TEMPLATE_RE.test(rawSit) || META_TEMPLATE_RE.test(rawStyle)) return false
  if (PERSONAL_LIFE_RE.test(rawSit) || PERSONAL_LIFE_RE.test(rawStyle)) return false
  if (TEMPLATE_SLOT_RE.test(rawSit) || TEMPLATE_SLOT_RE.test(rawStyle)) return false

  const situation = normalizeSituation(rawSit)
  const style = normalizeStyle(rawStyle)

  if (situation.length < 2 || situation.length > 16) return false
  if (style.length < 2 || style.length > 14) return false

  const clauses = style.split(/[，,。！？!?；;]/).filter(Boolean)
  if (clauses.length > 2) return false

  if (/^[\s\p{P}\p{S}]+$/u.test(situation) || /^[\s\p{P}\p{S}]+$/u.test(style)) return false

  return true
}

export function verifyAndCleanRules(rawRules, lines, { maxPerBatch = 3 } = {}) {
  if (!Array.isArray(rawRules) || !Array.isArray(lines)) return []
  const valid = []
  const seen = new Set()

  for (const item of rawRules) {
    if (valid.length >= maxPerBatch) break
    if (!item || typeof item !== 'object') continue

    const sourceId = parseInt(item.source_id, 10)
    if (Number.isNaN(sourceId)) continue
    const idx = sourceId - 1
    if (idx < 0 || idx >= lines.length) continue

    const src = lines[idx]
    if (!src || src.isBot) continue
    if (!isQualityRule(item)) continue

    const situation = normalizeSituation(item.situation)
    const style = normalizeStyle(item.style)

    const dedupKey = `${situation}::${style}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    valid.push({ situation, style })
  }

  return valid
}
