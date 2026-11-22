/**
 * 健壮地从模型输出中提取 JSON 数组（兼容思维链 <think>、markdown 代码块、[id:x] 干扰与括号匹配）
 */
export function safeParseJsonArray(text) {
  if (!text || typeof text !== 'string') return []
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '')

  // 1. 尝试从 markdown 代码块提取
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

  // 2. 找到第一个包含对象的 '['（即匹配 '[' 后面跟着 '{' 的位置），做严格括号配对
  const startIdx = clean.search(/\[\s*\{/)
  if (startIdx >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    let endIdx = -1

    for (let i = startIdx; i < clean.length; i++) {
      const char = clean[i]
      if (escape) {
        escape = false
        continue
      }
      if (char === '\\') {
        escape = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (char === '[') depth++
        else if (char === ']') {
          depth--
          if (depth === 0) {
            endIdx = i
            break
          }
        }
      }
    }

    if (endIdx > startIdx) {
      try {
        const slice = clean.slice(startIdx, endIdx + 1).trim()
        const parsed = JSON.parse(slice)
        if (Array.isArray(parsed)) return parsed
      } catch {}
    }
  }

  // 3. 尝试如果模型返回的是一个包装对象 { "rules": [...] }
  const objMatch = clean.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0].trim())
      for (const k of ['rules', 'candidates', 'data', 'styles', 'items']) {
        if (Array.isArray(obj[k])) return obj[k]
      }
    } catch {}
  }

  // 4. 兜底：整体解析不出来，多半是被截断了。抢救里面已经写完整的对象，
  //    别让「最后一条没写完」把前面写好的一起丢掉（真机 2026-11-21：21 次解析失败）。
  return salvageTruncatedObjects(text)
}

/**
 * 从**被截断**的 JSON 数组里抢救出已经写完整的对象。
 *
 * 为什么需要这个：提炼提示词一次喂 15 条消息、只给 1500 maxTokens，模型经常写到一半被截停，
 * 数组没有右括号。上面 `safeParseJsonArray` 的严格括号配对这时找不到闭合位置 ——
 * 前面**已经完整写好的规则也一起丢掉**（日志回包里明明有完整对象）。这是纯粹的损失，
 * 不是模型没产出（真机 2026-11-21：当天 21 次「未解析出有效规则」）。
 *
 * 做法：从数组起点逐个对象做配对扫描，能完整闭合的照收，遇到写了一半的就停在那里
 * （只丢最后一个残缺对象，不牵连前面的）。字符串里的括号/逗号/转义一律按 JSON 规则跳过，
 * 免得 `{"style":"他说「]」"}` 这种被当成数组结束。
 * @param {string} text 模型原始回包。
 * @returns {object[]} 抢救出来的对象（可能为空数组）。
 */
export function salvageTruncatedObjects(text) {
  if (!text || typeof text !== 'string') return []
  const clean = text.replace(/<\/?think>/gi, '').replace(/```(?:json)?/gi, '')
  const start = clean.search(/\[\s*\{/)
  if (start < 0) return []

  const out = []
  let i = start + 1
  while (i < clean.length) {
    const c = clean[i]
    if (c === ']') break // 数组正常结束
    // 括号外的游离字符串（有的模型会往数组里夹说明文字）：整段跳过
    if (c === '"') {
      i++
      while (i < clean.length && clean[i] !== '"') { if (clean[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c !== '{') { i++; continue }

    // 配对单个对象：字符串里的 {} 不参与计数
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
    // depth 没归零 = 这个对象写到一半就被截断了，后面的更不完整，到此为止
    if (depth !== 0) break
    try {
      const obj = JSON.parse(clean.slice(i, j))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj)
    } catch { /* 单个对象畸形就跳过，继续看下一个 */ }
    i = j
  }
  return out
}

export function verifyAndCleanRules(rawRules, lines) {
  if (!Array.isArray(rawRules)) return []
  const valid = []

  for (const item of rawRules) {
    if (!item || typeof item !== 'object') continue
    const situation = String(item.situation || '').trim()
    const style = String(item.style || '').trim()
    const sourceId = parseInt(item.source_id, 10)

    if (!situation || !style || isNaN(sourceId)) continue
    if (situation.length > 30 || style.length > 30) continue

    const idx = sourceId - 1
    if (idx < 0 || idx >= lines.length) continue

    // 铁律 1：溯源消息不能是 Bot 自己发的话（防止复读机循环自毒）
    if (lines[idx].isBot) continue

    // 铁律 2：防冒充群友第一人称经历（资产、封号、生平、现实事件）
    if (/我(被封|买过|在读|住|工作在|破产|阳了|确诊|结婚|离婚|考研|买房)/.test(style) ||
        /我(被封|买过|在读|住|工作在|破产|阳了|确诊|结婚|离婚|考研|买房)/.test(situation)) {
      continue
    }

    // 铁律 3：过滤无意义单字或纯标点
    if (style.length < 2 || situation.length < 2) continue

    valid.push({ situation, style })
  }

  return valid
}
