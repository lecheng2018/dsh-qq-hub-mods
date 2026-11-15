// 迷你 HTML DOM + CSS 选择器（零依赖，node 内置）。
// 只为 tieba.mjs 的解析需求实现：tag/.class/#id/[attr]/[attr^=v]/[attr*=v]、
// 后代与 > 组合、逗号并列；find/filter/parents/closest/clone/remove/replaceWith/text/attr。
// 不是通用浏览器引擎：不处理隐式闭合的复杂情形（贴吧页面与 fixtures 足够）。

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style'])

export function parseHTML(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0
  const s = String(html)
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) { pushText(s.slice(i)); break }
    if (lt > i) pushText(s.slice(i, lt))
    if (s.startsWith('<!--', lt)) { const end = s.indexOf('-->', lt + 4); i = end < 0 ? s.length : end + 3; continue }
    if (s.startsWith('<!', lt) || s.startsWith('<?', lt)) { const end = s.indexOf('>', lt); i = end < 0 ? s.length : end + 1; continue }
    if (s.startsWith('</', lt)) {
      const end = s.indexOf('>', lt)
      const name = s.slice(lt + 2, end < 0 ? s.length : end).trim().toLowerCase()
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break }
      i = end < 0 ? s.length : end + 1
      continue
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(lt))
    if (!m) { pushText('<'); i = lt + 1; continue }
    const tag = m[1].toLowerCase()
    let j = lt + m[0].length
    const attrs = {}
    let selfClose = false
    while (j < s.length) {
      while (j < s.length && /\s/.test(s[j])) j++
      if (s[j] === '>') { j++; break }
      if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break }
      const am = /^([^\s=/>]+)/.exec(s.slice(j))
      if (!am) { j++; continue }
      const name = am[1].toLowerCase()
      j += am[0].length
      while (j < s.length && /\s/.test(s[j])) j++
      let value = ''
      if (s[j] === '=') {
        j++
        while (j < s.length && /\s/.test(s[j])) j++
        const q = s[j]
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, j + 1)
          value = s.slice(j + 1, end < 0 ? s.length : end)
          j = end < 0 ? s.length : end + 1
        } else {
          const vm = /^[^\s>]*/.exec(s.slice(j))
          value = vm[0]; j += vm[0].length
        }
      }
      attrs[name] = decodeEntities(value)
    }
    const el = { tag, attrs, children: [], parent: top() }
    top().children.push(el)
    i = j
    if (RAW.has(tag)) {
      const close = s.toLowerCase().indexOf('</' + tag, i)
      const end = close < 0 ? s.length : close
      if (end > i) el.children.push({ text: s.slice(i, end), parent: el })
      i = close < 0 ? s.length : s.indexOf('>', close) + 1
      continue
    }
    if (!VOID.has(tag) && !selfClose) stack.push(el)
  }
  function pushText(t) { if (t) top().children.push({ text: decodeEntities(t), parent: top() }) }
  return root
}

function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    if (e === 'nbsp') return ' '
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : _ }
    return _
  })
}

const isEl = (n) => n && !n.text && n.tag !== undefined
const classes = (el) => String(el.attrs.class || '').split(/\s+/).filter(Boolean)

/** 复合选择器：tag#id.class[attr][attr^=v][attr*=v] */
function matchCompound(el, comp) {
  if (!isEl(el)) return false
  const tokens = comp.match(/([a-zA-Z][a-zA-Z0-9-]*)|(#[^\s.#[]+)|(\.[^\s.#[]+)|(\[[^\]]*\])/g) || []
  if (!tokens.length) return false
  for (const t of tokens) {
    if (t[0] === '#') { if (el.attrs.id !== t.slice(1)) return false }
    else if (t[0] === '.') { if (!classes(el).includes(t.slice(1))) return false }
    else if (t[0] === '[') {
      const am = /^\[\s*([^\s\]^$*=~]+)\s*(?:([\^$*~]?=)\s*(.*?)\s*)?\]$/.exec(t)
      if (!am) return false
      const [, name, op, rawVal] = am
      if (!(name in el.attrs)) return false
      if (op) {
        const val = String(rawVal || '').replace(/^["']|["']$/g, '')
        const have = String(el.attrs[name])
        if (op === '=' && have !== val) return false
        if (op === '^=' && !have.startsWith(val)) return false
        if (op === '$=' && !have.endsWith(val)) return false
        if (op === '*=' && !have.includes(val)) return false
        if (op === '~=' && !have.split(/\s+/).includes(val)) return false
      }
    } else if (el.tag !== t.toLowerCase()) return false
  }
  return true
}

/** 单段选择器（可含 后代/ > 组合），从右往左匹配。 */
function matchSelector(el, sel) {
  const parts = sel.trim().split(/\s*(>)\s*|\s+/).filter((p) => p !== undefined && p !== '')
  // parts 形如 [comp, '>', comp, comp...]；重组为 {comp, comb} 链
  const chain = []
  let comb = ' '
  for (const p of parts) {
    if (p === '>') { comb = '>'; continue }
    chain.push({ comp: p, comb })
    comb = ' '
  }
  if (!chain.length) return false
  const last = chain[chain.length - 1]
  if (!matchCompound(el, last.comp)) return false
  let node = el
  for (let k = chain.length - 2; k >= 0; k--) {
    const c = chain[k + 1].comb // chain[k+1] 与 chain[k] 之间的组合符
    const comp = chain[k].comp
    if (c === '>') {
      node = node.parent
      if (!node || !matchCompound(node, comp)) return false
    } else {
      node = node.parent
      while (node && node.tag !== '#root' && !matchCompound(node, comp)) node = node.parent
      if (!node || node.tag === '#root' || !matchCompound(node, comp)) return false
    }
  }
  return true
}

function matchesAny(el, selector) {
  return String(selector).split(',').some((s) => s.trim() && matchSelector(el, s.trim()))
}

function* walk(el) {
  for (const c of el.children || []) {
    if (isEl(c)) { yield c; yield* walk(c) }
  }
}

function textOf(node) {
  if (node.text !== undefined) return node.text
  return (node.children || []).map(textOf).join('')
}

function cloneNode(node, parent = null) {
  if (node.text !== undefined) return { text: node.text, parent }
  const copy = { tag: node.tag, attrs: { ...node.attrs }, children: [], parent }
  copy.children = (node.children || []).map((c) => cloneNode(c, copy))
  return copy
}

class Collection {
  constructor(els, root) { this.els = els; this.root = root }
  get length() { return this.els.length }
  first() { return new Collection(this.els.slice(0, 1), this.root) }
  each(fn) { this.els.forEach((el, i) => fn(i, el)); return this }
  text() { return this.els.map(textOf).join('') }
  attr(name) { return this.els.length ? this.els[0].attrs[name] : undefined }
  find(sel) {
    if (typeof sel !== 'string') {
      const target = sel
      return new Collection(this.els.filter((el) => { for (const d of walk(el)) if (d === target) return true; return false }), this.root)
    }
    const out = []
    const seen = new Set()
    for (const el of this.els) for (const d of walk(el)) if (matchesAny(d, sel) && !seen.has(d)) { seen.add(d); out.push(d) }
    return new Collection(out, this.root)
  }
  filter(fn) { return new Collection(this.els.filter((el, i) => fn(i, el)), this.root) }
  parents(sel) {
    const out = []
    const seen = new Set()
    for (const el of this.els) {
      let p = el.parent
      while (p && p.tag !== '#root') { if (matchesAny(p, sel) && !seen.has(p)) { seen.add(p); out.push(p) } p = p.parent }
    }
    return new Collection(out, this.root)
  }
  closest(sel) {
    const out = []
    const seen = new Set()
    for (const el of this.els) {
      let p = el
      while (p && p.tag !== '#root') { if (matchesAny(p, sel)) { if (!seen.has(p)) { seen.add(p); out.push(p) } break } p = p.parent }
    }
    return new Collection(out, this.root)
  }
  clone() { return new Collection(this.els.map((el) => cloneNode(el)), this.root) }
  remove() {
    for (const el of this.els) {
      const p = el.parent
      if (p) p.children = p.children.filter((c) => c !== el)
      el.parent = null
    }
    return this
  }
  replaceWith(text) {
    for (const el of this.els) {
      const p = el.parent
      if (!p) continue
      const idx = p.children.indexOf(el)
      if (idx >= 0) p.children[idx] = { text: String(text), parent: p }
    }
    return this
  }
}

export function load(html) {
  const root = parseHTML(html)
  const $ = (arg) => {
    if (typeof arg === 'string') {
      const out = []
      for (const d of walk(root)) if (matchesAny(d, arg)) out.push(d)
      return new Collection(out, root)
    }
    if (arg && arg.tag !== undefined) return new Collection([arg], root)
    return new Collection([], root)
  }
  $.root = () => ({
    append(fragment) {
      const sub = parseHTML(fragment)
      for (const c of sub.children) { c.parent = root; root.children.push(c) }
      return this
    },
  })
  return $
}
