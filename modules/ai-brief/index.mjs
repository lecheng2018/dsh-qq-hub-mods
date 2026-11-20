// AI 早报 / 晚报：Bing 新闻 + 知乎热榜 + 全网热榜（可选）+ 媒体 RSS（可选），交给模型挑几条并写她的吐槽。
// 发送前把链接统一转成短链（is.gd / tinyurl），消息里不再出现超长 URL；知乎保留原问题页。
// 来源：移植自 aureth-labs/dsh-aurabot-qq-mods 的 ai-brief（作者 chienchen-png，MIT）。
//   QQ Hub 版去掉了上游的「午报·论坛速报」节点（依赖 Windows 本机 Edge/Chrome 的 CDP，
//   NAS / Docker 部署用不上），早报 / 晚报 / 短链 / 手动触发 / 面板全部保留。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULTS = {
  enabled: true,
  morningEnabled: true,
  eveningEnabled: true,
  morning: '09:31',
  evening: '21:30',
  morningCount: 5,
  eveningCount: 5,
  // qq-hub 的表情包库是用户自己配的，名字不一定有这些，默认关；想要就在面板打开
  sticker: false,
  banner: false,
  shortLinks: false,
  showLinks: true,
  // 媒体源：每行「url|来源名」；留空 = 只用 Bing 新闻 + 知乎
  feeds: '',
  // Bing 新闻查询词：留空 = 不用（默认只用知乎热榜 + 全网热榜）
  bingMorning: '',
  bingEvening: '',
  keywords: [
    'AI', '人工智能', '大模型', '模型', 'OpenAI', 'DeepSeek', 'Anthropic', 'Claude', 'Gemini', 'GPT',
    'Sora', 'Qwen', '通义', 'Kimi', '豆包', '元宝', '文心', '智谱', 'MiniMax', 'Llama', 'Mistral', 'Grok',
    '多模态', '智能体', 'Agent', 'AIGC', '算力', '芯片', '英伟达', 'NVIDIA', '开源', '推理', '微调', '蒸馏',
    'MoE', '上下文', 'API', 'token', '订阅', '定价', '融资', '估值', 'IPO', '财报', '发布会', '创始人',
    '裁员', '收购',
  ].join(', '),
  hotKeywords: [
    'AI', '人工智能', '大模型', '模型', '芯片', '算力', '机器人', '手机', '苹果', '华为', '小米', '荣耀',
    'OPPO', 'vivo', '三星', '谷歌', '微软', 'Meta', '特斯拉', '马斯克', '字节', '抖音', '腾讯', '阿里',
    '百度', '京东', '拼多多', '美团', '网易', 'B站', '小红书', '游戏', '发布会', '上新', '开源', '融资',
    '上市', '裁员', '收购', '涨价', '降价', '订阅', '会员', '价格', '创始人', 'CEO', '离职', '跳槽', '热点',
    '刷屏', '爆火',
  ].join(', '),
  prompt: [
    '你是一个在技术群里潜水冲浪的真实群友，懂点模型和硬件，说话随性自然、爱吐槽。你正在替群里挑今天真正值得聊的 AI/科技新鲜事。',
    '来源是知乎热榜和微博/抖音/头条等全网热榜，优先挑 AI 相关、有讨论度的。',
    '挑的时候按这个优先级：',
    '① **新模型发布**（最高优先）：任何厂商的新模型/新版本——OpenAI、Anthropic(Claude)、Google(Gemini)、DeepSeek、阿里(Qwen)、字节(豆包)、月之暗面(Kimi)、智谱、MiniMax、Meta(Llama)、Mistral、xAI(Grok) 等；关注能力/架构变化、上下文、开源权重、API、定价、订阅、限额。',
    '② **新 AI 产品 / 应用 / 工具**：新上线的 AI App、Agent/智能体、Skill、工作流、插件、玩法，谁家用起来更好。',
    '③ 公司与人：创始人的说法、内部八卦、融资收购裁员、发布会、争议和翻车。',
    '④ 网络热点：只要和 AI/科技沾边、有梗、大家会讨论的都行（和上面同等重要，别只挑前两类）。',
    '如果候选里有“新模型/新版本发布”的新闻，**至少选 2 条**（这是最重要的），其余按 ①-④ 均衡挑。',
    '少挑纯论文、纯基准测试、纯参数堆砌的稿子；金融/股价最多一条；同样的事只留一条。',
    '每条还要给一个中文标签，从【模型】【应用】【财报】【融资】【政策】【芯片】【人物】【热点】里选最贴切的一个，标签会显示在标题前面。',
    '【极其重要的语言风格要求：彻底去除人机感，说大白话】',
    '- 每条短评（comment）必须说人话、语气自然松弛（15~40字），直接聊槽点、实际影响或主观感受。',
    '- 严禁复述标题，严禁新闻公文腔。',
    '- 严禁营销号标题对仗口号（绝对禁止写「xx狂喜」「xx再升级」「来历成谜」「引人深思」等八股宣传语）。',
    '- 就像平时群友打字随手点评一样自然随性。只输出 JSON。',
  ].join('\n'),
  askTemplate: [
    '候选新闻：',
    '{items}',
    '',
    '请挑 {n} 条最重要的，优先顺序：① 新模型发布（新版本/能力/开源/API/定价），② 新 AI 产品/应用/工具，③ 公司八卦，④ 网络热点（和①同等关注，别忽略）。',
    '输出 JSON：{"picks":[{"id":序号,"tag":"模型","comment":"你的自然口语短评"}],"tomorrow":"明天群友可以随手留心的一句随想，没有就空字符串"}',
    'tag 只能从【模型】【应用】【财报】【融资】【政策】【芯片】【人物】【热点】里选一个。',
    '要求：id 必须来自上面列表；tag 必须是上面八个之一；comment 必须自然口语说人话（严禁八股文和标题党口号，15~40字）；不要输出 JSON 以外的东西。',
  ].join('\n'),
  hotNodes: ['微博热搜', '知乎热榜', '抖音热点'].join('\n'),
  hotNodesEnabled: true,
}

export function linesOf(s) {
  return String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
}
export function wordsOf(s) {
  return String(s || '').split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean)
}
function regexOf(words, fallback) {
  const list = words.length ? words : wordsOf(fallback)
  if (!list.length) return /$^/
  const esc = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  try { return new RegExp('(' + esc.join('|') + ')', 'i') } catch { return /$^/ }
}
export function feedsOf(cfg) {
  const out = []
  for (const line of linesOf(cfg.feeds)) {
    const i = line.indexOf('|')
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
    else out.push([line, line.replace(/^https?:\/\//, '').split('/')[0]])
  }
  return out
}
export function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ') // 先剥真实标签，再解实体，避免 &lt; 被误当标签
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
export function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"')
}
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}
async function get(url, ms = 12000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}
export function parseFeed(xml, source) {
  const blocks = [...String(xml).matchAll(/<item[\s\S]*?<\/item>/gi)].map((m) => m[0])
  const out = []
  for (const b of blocks) {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const l = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
    const d = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)
    const title = decode(t && t[1])
    const url = decode(l && l[1])
    if (!title || !url) continue
    out.push({ title, url, at: Date.parse(d && d[1]) || Date.now(), source })
  }
  return out
}
/** Bing 新闻 RSS 的链接是 apiclick 跳转，把 url= 参数解出来才是发布方原链。 */
export function bingRealUrl(raw) {
  const link = decodeHtml(raw)
  const m = link.match(/[?&]url=([^&]+)/)
  if (!m) return link
  try { return decodeURIComponent(m[1]) } catch { return link }
}
async function bing(queries) {
  const out = []
  for (const q of queries) {
    try {
      const xml = await get(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`)
      for (const it of parseFeed(xml, 'Bing 新闻')) {
        out.push({ ...it, url: bingRealUrl(it.url), source: hostOf(bingRealUrl(it.url)) || 'Bing 新闻' })
      }
    } catch (e) { /* 单组失败跳过 */ }
  }
  return out
}
/** 知乎问题真实 ID：19 位雪花号在 JSON number 里会丢精度，只能从 url / card_id 里取字符串。 */
export function zhihuRealId(target, cardId) {
  const fromUrl = (String((target && target.url) || '').match(/questions\/(\d+)/) || [])[1]
  const fromCard = (String(cardId || '').match(/^Q_(\d+)/) || [])[1]
  return fromUrl || fromCard || String((target && target.id) || '')
}
async function zhihu() {
  const j = JSON.parse(await get('https://api.zhihu.com/topstory/hot-lists/total?limit=30'))
  return (j.data || [])
    .filter((d) => d?.target?.type === 'question')
    .map((d) => {
      const realId = zhihuRealId(d.target, d.card_id)
      return {
        title: d.target.title || '',
        url: `https://www.zhihu.com/question/${realId}`,
        at: Date.now(),
        source: '知乎热榜',
        hot: d.detail_text || '',
      }
    })
    .filter((x) => x.title && /\/question\/\d{6,}$/.test(x.url))
}
async function hotLists(api, nodes) {
  const out = []
  let th
  try { th = api.use?.('tophub') } catch (e) { th = null }
  if (!th || typeof th.hot !== 'function') return out
  for (const node of nodes) {
    try {
      const r = await th.hot(node)
      if (!r?.ok || !Array.isArray(r.items)) continue
      for (const it of r.items) {
        const title = decode(it.title)
        if (!title) continue
        out.push({
          title,
          url: String(it.url || '').trim() || `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`,
          at: Date.now(),
          source: node,
          hot: it.hot || '',
        })
      }
    } catch (e) { /* 单榜失败跳过 */ }
  }
  return out
}
function uniq(list) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    const k = x.title.replace(/[\s\p{P}]/gu, '').slice(0, 30)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

export default {
  id: 'ai-brief',
  name: 'AI 新闻推送',
  version: '2.2.2',
  api: 1,
  description: '每天早晚 AI 简报（Bing 新闻 + 知乎热榜 + 全网热榜 + 自定义 RSS），模型挑重点并带一句吐槽，群友发「早报 / 晚报」也能要一份',
  panel: 'panel.js',
  defaults: DEFAULTS,
  // 自动表单只留总开关；三个节点的全部参数在面板「AI 新闻推送」里
  settings: [
    { key: 'enabled', label: '总开关', type: 'boolean' },
  ],
  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings?.() || {}) })
    const stateFile = () => join(api.dataDir(), 'state.json')
    const load = () => { try { return JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return { seen: [], days: {}, links: {} } } }
    const save = (s) => { try { writeFileSync(stateFile(), JSON.stringify(s)) } catch {} }
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const pick = (a) => a[Math.floor(Math.random() * a.length)]
    const dayText = (kind) => {
      const st = load()
      const d = (st.days && st.days[dayKey(new Date())]) || {}
      return (d.text && d.text[kind]) || ''
    }
    function saveDayText(kind, text) {
      if (!text) return
      const st = load()
      const day = dayKey(new Date())
      st.days = st.days || {}
      const d = (st.days[day] = st.days[day] || {})
      d.text = d.text || {}
      d.text[kind] = text
      save(st)
    }

    /** 短链缓存：url → {short, at}，存在 state 里，重启也不丢。 */
    async function shortLink(url) {
      if (!url || cfg().shortLinks === false) return url
      const st = load()
      st.links = st.links || {}
      const hit = st.links[url]
      if (hit && Date.now() - hit.at < 7 * 24 * 3600_000) return hit.short
      const enc = encodeURIComponent(url)
      for (const endpoint of [
        `https://is.gd/create.php?format=simple&url=${enc}`,
        `https://tinyurl.com/api-create.php?url=${enc}`,
      ]) {
        try {
          const r = await fetch(endpoint, { signal: AbortSignal.timeout(8000) })
          const text = (await r.text()).trim()
          if (/^https?:\/\//i.test(text)) {
            st.links[url] = { short: text, at: Date.now() }
            // 缓存上限，防止无限增长
            const keys = Object.keys(st.links)
            if (keys.length > 400) for (const k of keys.slice(0, keys.length - 200)) delete st.links[k]
            save(st)
            return text
          }
        } catch (e) { /* 换下一个 */ }
      }
      return url
    }

    async function gather(kind, exclude = new Set()) {
      const c = cfg()
      const today8 = new Date()
      today8.setHours(8, 0, 0, 0)
      const start = kind === 'morning'
        ? today8.getTime() - 24 * 3600_000
        : (Date.now() < today8.getTime() ? today8.getTime() - 24 * 3600_000 : today8.getTime())
      let list = []
      for (const [url, source] of feedsOf(c)) {
        try {
          const parsed = parseFeed(await get(url), source)
          api.log?.info?.(`早报源 ${source}: ${parsed.length} 条`)
          list = list.concat(parsed)
        } catch (e) { api.log?.info?.(`早报源失败 ${source}: ${e.message}`) }
      }
      const bingQueries = linesOf(kind === 'morning' ? c.bingMorning : c.bingEvening)
      if (bingQueries.length) {
        try {
          const b = await bing(bingQueries)
          api.log?.info?.(`早报源 Bing 新闻: ${b.length} 条`)
          list = list.concat(b)
        } catch (e) { api.log?.info?.('早报源失败 Bing: ' + e.message) }
      }
      try { const z = await zhihu(); api.log?.info?.(`早报源 知乎: ${z.length} 条`); list = list.concat(z) } catch (e) { api.log?.info?.('早报源失败 知乎: ' + e.message) }
      let hot = []
      if (c.hotNodesEnabled !== false) {
        hot = await hotLists(api, linesOf(c.hotNodes))
        if (hot.length) api.log?.info?.(`早报源 热榜: ${hot.length} 条`)
      }

      const AI_KEY = regexOf(wordsOf(c.keywords), DEFAULTS.keywords)
      const HOT_KEY = regexOf(wordsOf(c.hotKeywords), DEFAULTS.hotKeywords)
      let media = list.filter((x) => x.at >= start && AI_KEY.test(x.title) && !exclude.has(x.url))
      media.sort((a, b) => b.at - a.at)
      const hotTech = hot.filter((x) => HOT_KEY.test(x.title) && !exclude.has(x.url))
      const hotRest = hot.filter((x) => !HOT_KEY.test(x.title) && !exclude.has(x.url)).slice(0, 4)
      const picks = uniq([...media, ...hotTech]).slice(0, 16)
      const filler = uniq(hotRest).filter((x) => !picks.some((p) => p.title === x.title)).slice(0, 4)
      const u = [...picks, ...filler]
      api.log?.info?.(`早报抓取：窗口内 AI 相关 ${media.length} 条，热榜 ${hotTech.length}+${filler.length} 条，合计 ${u.length} 条`)
      return u
    }

    async function compose(kind, items) {
      const c = cfg()
      const n = Math.max(1, Math.min(8, Number(kind === 'morning' ? c.morningCount : c.eveningCount) || 5))
      const top = items.slice(0, 22)
      if (!top.length) return { text: '', urls: [] }
      const lines = top.map((x, i) => `${i + 1}. ${x.title}（${x.source}）`)
      let picks = []
      let tomorrow = ''
      try {
        const out = await api.ask({
          system: String(c.prompt || DEFAULTS.prompt),
          text: String(c.askTemplate || DEFAULTS.askTemplate)
            .replaceAll('{items}', lines.join('\n'))
            .replaceAll('{n}', String(n)),
          maxTokens: 1400,
          temperature: 0.6,
        })
        const m = String(out).match(/\{[\s\S]*\}/)
        const j = m ? JSON.parse(m[0]) : null
        if (j && Array.isArray(j.picks)) {
          const TAGS = ['模型', '应用', '财报', '融资', '政策', '芯片', '人物', '热点']
          picks = j.picks
            .map((p) => ({
              item: top[Number(p.id) - 1],
              comment: String(p.comment || '').slice(0, 80),
              tag: TAGS.includes(String(p.tag || '').trim()) ? String(p.tag).trim() : '热点',
            }))
            .filter((p) => p.item)
            .slice(0, n)
          tomorrow = String(j.tomorrow || '').slice(0, 60)
        }
      } catch (e) { api.log?.warn?.('早报提炼失败，用原始标题：' + (e?.message || e)) }
      if (!picks.length) picks = top.slice(0, n).map((item) => ({ item, comment: '', tag: '热点' }))

      return {
        picks: picks.map((p) => ({ title: p.item.title, comment: p.comment, tag: p.tag || '热点', url: p.item.url })),
        tomorrow,
      }
    }

    /** 拼消息：序号 + 【标签】 + 标题 / 吐槽 / 链接（长链，短链国内打不开）。 */
    async function formatBrief(kind, picks, tomorrow) {
      const c = cfg()
      const head = kind === 'morning' ? '【AI 早报】' : '【AI 晚报】'
      const rows = [head]
      let i = 0
      for (const p of picks) {
        i += 1
        const tag = p.tag ? `【${p.tag}】` : ''
        rows.push(`${i}. ${tag}${p.title}`)
        if (p.comment) rows.push(p.comment)
        if (c.showLinks !== false) {
          const short = await shortLink(p.url)
          if (short) rows.push(short)
        }
      }
      if (kind === 'evening' && tomorrow) rows.push(`明天可以留意：${tomorrow}`)
      return rows.join('\n')
    }

    /** 发消息：标题/吐槽保持原样，链接逐条换成短链。 */
    async function sendBrief(kind, chatId, exclude = new Set()) {
      const c = cfg()
      const cached = dayText(kind)
      if (cached) {
        if (chatId) { try { await api.sendText(chatId, cached) } catch (e) {} }
        return { text: cached, urls: [] }
      }
      const items = await gather(kind, exclude)
      if (!items.length) { api.log?.info?.(`${kind} 没有抓到合适的新闻`); return { text: '', urls: [] } }
      const built = await compose(kind, items)
      if (!built.picks?.length) return { text: '', urls: [] }
      const text = await formatBrief(kind, built.picks, built.tomorrow)
      const urls = built.picks.map((p) => p.url)
      saveDayText(kind, text)
      if (chatId) {
        if (c.banner !== false) {
          try { await api.sendText(chatId, kind === 'morning' ? '早报来了。' : '晚报来了。') } catch (e) {}
        }
        try { await api.sendText(chatId, text) } catch (e) { api.log?.warn?.('发简报失败：' + (e?.message || e)) }
        if (c.sticker) {
          try { await api.send(chatId, '<sticker:' + pick(['开心', '卖萌', '无语', '疑惑']) + '>') } catch (e) {}
        }
      }
      return { text, urls }
    }

    async function tick() {
      const c = cfg()
      if (!c.enabled) return
      const now = new Date()
      const t = hm(now)
      const day = dayKey(now)
      const st = load()
      st.days = st.days || {}
      const d = (st.days[day] = st.days[day] || {})
      const groups = (api.config()?.allow?.groups || []).map((g) => `group:${g}`)
      if (!groups.length) return
      const due = (time) => t >= time && t < addMin(time, 20)
      const exclude = new Set(d.sent || [])
      const addSent = (urls) => { d.sent = [...(d.sent || []), ...urls] }
      let dirty = false
      if (c.morningEnabled !== false && !d.morning && due(c.morning)) {
        for (const g of groups) {
          const r = await sendBrief('morning', g, exclude)
          addSent(r.urls); for (const u of r.urls) exclude.add(u)
        }
        d.morning = t; dirty = true
      }
      if (c.eveningEnabled !== false && !d.evening && due(c.evening)) {
        for (const g of groups) {
          const r = await sendBrief('evening', g, exclude)
          addSent(r.urls); for (const u of r.urls) exclude.add(u)
        }
        d.evening = t; dirty = true
      }
      if (dirty) {
        const fresh = load()
        fresh.days = fresh.days || {}
        const fd = (fresh.days[day] = fresh.days[day] || {})
        if (d.morning) fd.morning = d.morning
        if (d.evening) fd.evening = d.evening
        save(fresh)
      }
    }

    function addMin(hhmm, mins) {
      const [h, m] = String(hhmm).split(':').map(Number)
      const dt = new Date(2000, 0, 1, h || 0, m || 0)
      dt.setMinutes(dt.getMinutes() + mins)
      return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
    }

    /** 三节点状态：给面板顶部的状态卡用 */
    api.route('/status', async () => {
      const c = cfg()
      const now = new Date()
      const t = hm(now)
      const st = load()
      const d = (st.days && st.days[dayKey(now)]) || {}
      const nextAt = (time) => {
        const [h, m] = String(time || '00:00').split(':').map(Number)
        const dt = new Date(now)
        dt.setHours(h || 0, m || 0, 0, 0)
        if (dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1)
        return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
      }
      return {
        ok: true,
        enabled: c.enabled !== false,
        now: t,
        nodes: {
          morning: {
            enabled: c.morningEnabled !== false,
            time: c.morning,
            sent: d.morning || '',
            next: d.morning ? nextAt(c.morning) : (t >= c.morning ? nextAt(c.morning) : c.morning),
          },
          evening: {
            enabled: c.eveningEnabled !== false,
            time: c.evening,
            sent: d.evening || '',
            next: d.evening ? nextAt(c.evening) : (t >= c.evening ? nextAt(c.evening) : c.evening),
          },
        },
        counts: { morning: Number(c.morningCount) || 5, evening: Number(c.eveningCount) || 5 },
      }
    })
    api.route('/preview', async (req) => {
      const q = api.core?.http?.query?.(req) || {}
      const kind = String(q.kind || 'morning') === 'evening' ? 'evening' : 'morning'
      const items = await gather(kind)
      const built = await compose(kind, items)
      const text = built.picks?.length ? await formatBrief(kind, built.picks, built.tomorrow) : ''
      return { ok: true, kind, count: items.length, text }
    })
    api.route('/sources', async () => {
      const c = cfg()
      return {
        ok: true,
        feeds: feedsOf(c).map(([url, name]) => ({ name, url })),
        bingMorning: linesOf(c.bingMorning),
        bingEvening: linesOf(c.bingEvening),
        hotNodes: linesOf(c.hotNodes),
        keywords: wordsOf(c.keywords).length,
        hotKeywords: wordsOf(c.hotKeywords).length,
        shortLinks: c.shortLinks !== false,
      }
    })
    api.route('/send', async (req) => {
      const q = api.core?.http?.query?.(req) || {}
      const kind = String(q.kind || 'morning') === 'evening' ? 'evening' : 'morning'
      const owner = 'private:' + String(api.config()?.ownerQQ || '')
      const built = await sendBrief(kind, owner)
      return { ok: true, kind, text: built.text }
    })

    // 群友直接发「早报 / 晚报」也能要一份
    const lastManual = new Map()
    api.on('message', async (msg) => {
      if (!cfg().enabled || !msg) return
      const text = String(msg.text || '').trim()
      const m = text.match(/^(?:来(?:一)?[份个]?|发(?:一)?[份个]?|看(?:看|下)?|给我|我要)?\s*(?:AI\s*)?(早报|晚报)\s*$/)
      if (!m) return
      const key = String(msg.chatId || '')
      if (Date.now() - (lastManual.get(key) || 0) < 3 * 60_000) return true
      lastManual.set(key, Date.now())
      const kind = m[1] === '早报' ? 'morning' : 'evening'
      try {
        const cached = dayText(kind)
        if (cached) await api.sendText(msg.chatId, cached)
        else await sendBrief(kind, msg.chatId)
      } catch (e) { api.log?.warn?.('手动简报失败：' + (e?.message || e)) }
      return true
    })

    /** 面板/调试用：手动触发某份简报发到指定聊天 */
    api.route('/manual', async (req) => {
      const q = api.core?.http?.query?.(req) || {}
      const kind = String(q.kind || '')
      const chat = String(q.chat || 'private:' + (api.config()?.ownerQQ || ''))
      if (!['morning', 'evening'].includes(kind)) return { ok: false, message: 'kind 要 morning / evening' }
      try {
        const t = dayText(kind)
        if (t) await api.sendText(chat, t)
        else await sendBrief(kind, chat)
        return { ok: true }
      } catch (e) { return { ok: false, message: e.message } }
    })
    api.every(30_000, tick, 'AI 早报晚报')
    api.command({ name: '早报', desc: '发今天的 AI 早报（主人可用）', run: async (arg, msg) => {
      const t = dayText('morning')
      if (t) await api.sendText(msg.chatId, t)
      else await sendBrief('morning', msg.chatId)
      return null
    } })
    api.command({ name: '晚报', desc: '发今天的 AI 晚报（主人可用）', run: async (arg, msg) => {
      const t = dayText('evening')
      if (t) await api.sendText(msg.chatId, t)
      else await sendBrief('evening', msg.chatId)
      return null
    } })
  },
}
