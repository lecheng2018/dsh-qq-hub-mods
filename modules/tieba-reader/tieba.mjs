import { load, htmlToText } from './html-dom.mjs';

// 2026-11 起贴吧 PC 版（/、/f、/p/<tid>）对非浏览器 UA 只回前端空壳（约 7–11 KB，无帖子节点），
// 仍服务端渲染的只有手机版 /mo/q/m（kw= 列表，kz= 帖子）。所以 HTTP 读取一律先走手机版。
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const cleanTitle = raw => clean(raw)
  .replace(/\s*[-_]\s*百度贴吧\s*icon_[\s\S]*$/i, '')
  .replace(/\s*[-_]\s*百度贴吧\s*$/, '').trim().slice(0, 250);
const nodeText = node => { const copy = node.clone(); copy.find('svg,script,style,noscript').remove(); return copy.text(); };
const documentTitle = $ => $('head > title').first().text() || $('title').filter((_i, el) => !$(el).parents('svg').length).first().text();
export function barNames(raw) {
  return [...new Set(String(raw || '').split(/[\n,，;；]+/).map((s) => clean(s).replace(/吧$/, '')).filter(Boolean))].slice(0, 20);
}
export function postUrl(raw) {
  const s = String(raw || '').trim();
  if (/^\d{5,20}$/.test(s)) return `https://tieba.baidu.com/p/${s}`;
  let u;
  try { u = new URL(s, 'https://tieba.baidu.com'); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'tieba.baidu.com' || u.port || u.username || u.password) return null;
  // 手机版列表的链接带 ?lp=...&mo_device=1，PC 版带 ?pn=2，都必须归一成裸帖地址。
  const m = u.pathname.match(/^\/p\/(\d{5,20})\/?$/);
  if (m) return `https://tieba.baidu.com/p/${m[1]}`;
  // 手机版帖子页形如 /mo/q/m?kz=<tid>（部分场景是 tid=）。
  if (u.pathname.replace(/\/+$/, '') === '/mo/q/m') {
    const tid = u.searchParams.get('kz') || u.searchParams.get('tid');
    if (tid && /^\d{5,20}$/.test(tid)) return `https://tieba.baidu.com/p/${tid}`;
  }
  return null;
}
export function cookieHeader(raw) {
  if (/[\r\n]/.test(String(raw || ''))) throw new Error('Cookie 不能含换行。');
  const allowed = new Set(['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'BAIDUID', 'BAIDUID_BFESS', 'TIEBAUID', 'USER_JUMP', 'PSTM']);
  return String(raw || '').split(';').map((p) => p.trim()).filter((p) => allowed.has(p.split('=')[0])).join('; ');
}
export function checkPage(html) {
  const $ = load(html);
  const title = documentTitle($);
  if (/百度安全验证|安全验证|访问验证|验证码/.test(title) || $('#captcha,#vcode,#wappassverify').length) {
    throw new Error('贴吧要求安全验证，请在浏览器登录贴吧并完成验证；本模块不自动绕过验证。');
  }
  return $;
}
export function parseList(html, mode = 'forum') {
  const $ = checkPage(html);
  // Tieba sometimes puts the forum list inside an HTML comment.
  if (!$('.j_thread_list').length) {
    const block = String(html).match(/<!--[\s\S]*?j_thread_list[\s\S]*?-->/);
    if (block) $.root().append(block[0].slice(4, -3));
  }
  const out = [];
  const selector = mode === 'search' ? '.s_post' : '.thread-card, .j_thread_list, .threadlist_li';
  $(selector).each((_i, el) => {
    const root = $(el);
    const a = root.find(mode === 'search' ? '.p_title a, a.bluelink' : 'a.thread-content-link, a.j_th_tit, .threadlist_title a, a[href*="/p/"]').first();
    const url = postUrl(a.attr('href'));
    const title = cleanTitle(a.attr('title') || nodeText(root.find('.thread-title').first()) || nodeText(a));
    if (url && title && !out.some((p) => p.url === url)) out.push({ url, title,
      snippet: clean(root.find('.thread-content,.threadlist_abs,.p_content').first().text()).slice(0, 700), source: '贴吧列表（尚未读取正文）' });
  });
  return out.slice(0, 8);
}
// 手机版列表页（/mo/q/m?kw=）：每条是 a.ti_item，标题在 .ti_title，角标在 .ti_title_icon。
export function parseMobileList(html, bar = '') {
  const $ = checkPage(html);
  const out = [];
  $('a.ti_item').each((_i, el) => {
    const a = $(el);
    const url = postUrl(a.attr('href'));
    const box = a.find('.ti_title').first().clone();
    box.find('.ti_title_icon').remove();
    const title = cleanTitle(box.text() || a.attr('title'));
    if (!url || !title || out.some((p) => p.url === url)) return;
    out.push({ url, title, snippet: '', bar, imageCount: a.find('.medias_wrap img').length,
      source: `贴吧${bar ? `「${bar}」吧` : ''}列表（手机版网页，尚未读取正文）` });
  });
  return out.slice(0, 12);
}

// 手机版帖子页（/mo/q/m?kz=<tid>）：楼层是 li.j_post_list_item，正文在 .content，
// 楼中楼（.fr_list）、图片占位（.pb_less_imgs）要剔除，只留这一楼的文字。
export function parseMobileThread(html, url) {
  const $ = checkPage(html);
  const title = cleanTitle(nodeText($('.post_title_embed').first()) || documentTitle($));
  const posts = [];
  $('.j_post_list_item').each((_i, el) => {
    const root = $(el);
    const content = root.find('.content').first().clone();
    if (!content.length) return;
    content.find('.pb_less_imgs, .fr_list, .lzl_list, .lzl_wrap, .post_bottom_tip, script, style, noscript').remove();
    content.find('br').replaceWith('\n');
    const text = clean(content.text());
    if (!text) return;
    const floor = Number(root.attr('fn')) || posts.length + 1;
    posts.push({ author: clean(root.find('.user_name').first().text()), floor,
      section: floor === 1 ? '楼主正文' : '可见回复（手机版网页，按楼层顺序，未展开楼中楼）',
      text: text.slice(0, 2500) });
  });
  if (!posts.length) throw new Error('未读到帖子正文，可能需要登录、帖子已删除或页面结构已变化。');
  return { url, title, posts: posts.slice(0, 10), imageCount: $('.pb_img_item').length,
    source: '贴吧正文（手机版网页，第 1 页，最多 10 楼）' };
}

export function parseHome(html) {
  const $ = checkPage(html);
  const seen = new Set(); const items = [];
  $('a[href]').each((_i, el) => {
    const a = $(el); const url = postUrl(a.attr('href'));
    if (!url || seen.has(url)) return;
    const card = a.closest('.thread-card,.feed-card,.feed-item,.feed_item,.feed_card,.threadlist_li,li,article').first();
    const title = cleanTitle(a.attr('title') || nodeText(card.find('.thread-title,.feed-title,.post-title,h2,h3').first()) || nodeText(a));
    if (title.length < 2 || /^\d+[万亿]?$/.test(title)) return;
    const hot = a.closest('.hot-list,.hot_list,.hot-thread,.hot_thread,.rank-list,.rank_list,[class^="hot-"],[class^="hot_"],[class^="rank-"],[class^="rank_"]').length > 0;
    const forum = card.find('a[href*="/f?"]').first();
    let bar = '';
    try { bar = clean(new URL(forum.attr('href'), 'https://tieba.baidu.com').searchParams.get('kw')).replace(/吧$/, ''); } catch {}
    seen.add(url);
    items.push({ url, title: title.slice(0, 250), bar, section: hot ? '首页热门' : '首页推荐',
      source: `贴吧${hot ? '首页热门' : '首页推荐'}（尚未读取正文）` });
  });
  return items.slice(0, 12);
}
export function parsePost(html, url) {
  const $ = checkPage(html);
  const title = cleanTitle(nodeText($('.core_title_txt').first()) || documentTitle($));
  const posts = [];
  const textOf = node => {
    const content = node.clone();
    content.find('svg,script,style,noscript').remove();
    content.find('br').replaceWith('\n');
    return clean(content.text());
  };
  const opening = $('.pb-content-wrap').first();
  if (opening.length) {
    const imageCount = opening.find('img').length;
    const text = textOf(opening);
    posts.push({ section: '楼主正文', text: text.slice(0, 3000) || (imageCount ? '[楼主主要发布图片，此工具未识别图片内容。]' : '[楼主没有可读取的文字正文。]') });
    $('.d_post_content,.pb-content-item').each((_i, el) => {
      if (opening.find(el).length || $(el).parents('.d_post_content,.pb-content-item').length) return;
      const text = textOf($(el));
      if (text) posts.push({ section: '可见回复（顺序，不代表楼层号）', text: text.slice(0, 2500) });
    });
    return { url, title, posts: posts.slice(0, 10), imageCount, source: '贴吧正文（第 1 页，最多 10 段，未展开全部楼中楼）' };
  }
  $('.l_post').each((_i, el) => {
    const root = $(el);
    const content = root.find('.d_post_content').first().clone();
    content.find('svg,script,style').remove();
    content.find('br').replaceWith('\n');
    const text = clean(content.text());
    if (!text) return;
    let field = {};
    try { field = JSON.parse(root.attr('data-field') || '{}'); } catch {}
    posts.push({ author: clean(root.find('.p_author_name').first().text()),
      floor: field.content?.post_no || posts.length + 1, text: text.slice(0, 2500) });
  });
  if (!posts.length) throw new Error('未读到帖子正文，可能需要登录、帖子已删除或页面结构已变化。');
  return { url, title, posts: posts.slice(0, 10), source: '贴吧正文（第 1 页，最多 10 楼）' };
}
export function createTieba({ getCookie, searchWeb, fetchImpl = fetch, renderPage, browserAvailable = () => true, signal }) {
  const assertActive = () => signal?.throwIfAborted();
  async function request(path, { mobile = false } = {}) {
    assertActive();
    const url = new URL(path, 'https://tieba.baidu.com');
    if (url.origin !== 'https://tieba.baidu.com') throw new Error('只允许访问百度贴吧。');
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'user-agent': mobile ? UA_MOBILE : UA_PC,
        referer: 'https://tieba.baidu.com/', cookie: cookieHeader(getCookie()) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400) throw new Error('贴吧要求跳转或登录，请先在浏览器打开贴吧并完成登录/验证。');
    if (!res.ok) throw new Error(`贴吧返回 HTTP ${res.status}`);
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > 2500000) throw new Error('贴吧页面过大，已停止读取。'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function indexed(q, reason) {
    assertActive();
    const r = await searchWeb(q);
    assertActive();
    const items = []; const seen = new Set();
    for (const s of r.sources || []) {
      const url = postUrl(s.url);
      if (!url || seen.has(url)) continue;
      seen.add(url); items.push({ url, title: clean(s.title), snippet: clean(s.snippet).slice(0, 700), source: '搜索引擎收录摘要，尚未读取正文' });
    }
    return { ok: true, mode: 'indexed', warning: `${reason}；以下为搜索收录，可能不是最新帖子，也不保证严格属于目标贴吧。`, items: items.slice(0, 6) };
  }
  return {
    async home() {
      if (renderPage && browserAvailable()) {
        try {
          const page = await renderPage('https://tieba.baidu.com/', 'home');
          assertActive();
          const items = page.html ? parseHome(page.html) : (page.links || []).map(p => ({ ...p, url: postUrl(p.url), source: '贴吧首页列表（尚未读取正文）' })).filter(p => p.url && p.title).slice(0, 12);
          if (items.length) return { ok: true, mode: 'browser', origin: 'home', items };
        } catch { assertActive(); }
      }
      try {
        const items = parseHome(await request('/'));
        if (items.length) return { ok: true, mode: 'direct', origin: 'home', items };
      } catch { assertActive(); }
      // 首页（/、/f、/p）都换成前端空壳后没有服务端列表；如实说明，不假装浏览过。
      const result = await indexed('site:tieba.baidu.com/p/ 百度贴吧 热门帖子', '贴吧首页已改为前端渲染');
      if (result.items.length) return { ...result, origin: 'indexed' };
      return { ok: false, mode: 'none', origin: 'none', items: [],
        message: '贴吧首页已改为前端渲染，没有内置浏览器组件时读不到首页。请在设置里填写关注的吧名（例如 deepseek），或直接说“逛某某吧”。' };
    },
    async account() {
      assertActive();
      if (renderPage && browserAvailable()) {
        try { return await renderPage('https://tieba.baidu.com/', 'account'); }
        catch { assertActive(); return { ok: false, loggedIn: null, message: '扩展浏览器登录检查失败，请检查组件、网络或打开扩展登录窗口完成验证。' }; }
      }
      if (!cookieHeader(getCookie()).includes('BDUSS=')) return { ok: true, loggedIn: false, message: '未配置 BDUSS 登录 Cookie，可匿名尝试读取。' };
      try {
        const raw = await request('/f/user/json_userinfo');
        const j = JSON.parse(raw);
        const user = j?.data?.user || j?.data || j?.user || j;
        const name = user?.user_name || user?.name_show || user?.user_name_show;
        return name ? { ok: true, loggedIn: true, name: clean(name), message: `已登录：${clean(name)}` }
          : { ok: false, loggedIn: null, message: 'Cookie 已保存，但未能确认登录有效，请在浏览器登录后更新 Cookie。' };
      } catch { return { ok: false, loggedIn: null, message: '登录状态检查失败，可能被验证拦截或 Cookie 失效。' }; }
    },
    async search(query, bar = '') {
      const q = clean(query); if (!q || q.length > 160) throw new Error('搜索词应为 1～160 字符。');
      try {
        const json = JSON.parse(await request('/mo/q/search/thread?' + new URLSearchParams({ word: q, pn: 1 })));
        const results = json.data?.post_list;
        if (Array.isArray(results)) {
          const items = results.filter(p => !bar || clean(p.forum_name) === clean(bar).replace(/吧$/, '')).map(p => ({
            url: postUrl(String(p.tid)), title: clean(htmlToText(String(p.title || ''))),
            snippet: clean(htmlToText(String(p.content || ''))).slice(0, 1000),
            bar: p.forum_name, source: '贴吧搜索接口（实时结果摘要，尚未读取全文）',
          })).filter(p => p.url).slice(0, 8);
          return { ok: true, mode: 'direct', items };
        }
        const params = new URLSearchParams({ ie: 'utf-8', qw: q, ...(bar ? { kw: clean(bar) } : {}) });
        const items = parseList(await request('/f/search/res?' + params), 'search');
        if (!items.length) throw new Error('贴吧搜索页未返回可解析的帖子');
        return { ok: true, mode: 'direct', items };
      } catch (e) {
        assertActive();
        if (renderPage && browserAvailable()) {
          try {
            const page = await renderPage('https://tieba.baidu.com/f/search/res?' + new URLSearchParams({ ie: 'utf-8', qw: q, ...(bar ? { kw: clean(bar).replace(/吧$/, '') } : {}) }), 'search');
            const items = parseList(page.html, 'search');
            if (items.length) return { ok: true, mode: 'browser', items };
          } catch { assertActive(); }
        }
        return indexed(`site:tieba.baidu.com/p/ ${bar ? '"' + clean(bar) + '吧" ' : ''}${q}`, e.message);
      }
    },
    async browse(bar) {
      const name = clean(bar).replace(/吧$/, '');
      if (!name || name.length > 60) throw new Error('请填写 1～60 字的贴吧名称。');
      let firstError;
      if (renderPage && browserAvailable()) {
        try {
          const page = await renderPage('https://tieba.baidu.com/f?' + new URLSearchParams({ kw: name, ie: 'utf-8' }), 'browse');
          assertActive();
          if (page.html) {
            const items = parseList(page.html);
            if (!items.length) throw new Error('浏览器页面没有可解析的帖子，可能是空吧、需要验证或页面结构变化。');
            return { ok: true, mode: 'browser', bar: name, items };
          }
          const seen = new Set();
          const items = (page.links || []).map(p => ({ ...p, url: postUrl(p.url), source: '贴吧浏览器实际加载的列表' }))
            .filter(p => p.url && p.title && !seen.has(p.url) && seen.add(p.url)).slice(0, 8);
          if (!items.length) throw new Error('浏览器未加载出帖子列表，可能需要登录或安全验证');
          return { ok: true, mode: 'browser', bar: name, items };
        } catch (e) { firstError = e; assertActive(); }
      }
      // 没有内置浏览器：手机版列表页仍是服务端渲染，先读它；PC 版只作兜底（现已多为前端空壳）。
      try {
        const items = parseMobileList(await request('/mo/q/m?' + new URLSearchParams({ kw: name, ie: 'utf-8' }), { mobile: true }), name);
        if (items.length) return { ok: true, mode: 'direct', bar: name, items };
        firstError ??= new Error('手机版贴吧列表没有可解析的帖子');
      } catch (e) { firstError = e; assertActive(); }
      try {
        const items = parseList(await request('/f?' + new URLSearchParams({ kw: name, ie: 'utf-8' })));
        if (items.length) return { ok: true, mode: 'direct', bar: name, items };
      } catch (e) { firstError = e; assertActive(); }
      return { ...await indexed(`site:tieba.baidu.com/p/ "${name}吧"`, firstError?.message || '贴吧列表未返回可解析的帖子'), bar: name };
    },
    async read(link) {
      const url = postUrl(link); if (!url) throw new Error('请输入 https://tieba.baidu.com/p/帖子编号，只允许读取贴吧帖子。');
      try {
        if (renderPage && browserAvailable()) {
          const page = await renderPage(url, 'read');
          assertActive();
          if (page.html) return { ok: true, mode: 'browser', ...parsePost(page.html, url) };
          const posts = (page.contents || []).map((text,i) => ({ section: page.hasOpening && i === 0 ? '楼主正文' : '可见回复（顺序，不代表楼层号）', text: clean(text).slice(0,3000) })).filter(p => p.text);
          if (!posts.length) throw new Error('浏览器未读到帖子正文，可能已删除或需要验证');
          return { ok: true, mode: 'browser', url, title: cleanTitle(page.title), posts, imageCount: page.imageCount || 0,
            source: '贴吧正文（浏览器实际加载内容，最多10段，未展开全部楼中楼）' };
        }
        // PC 版帖子页已改为前端空壳；手机版 /mo/q/m?kz=<tid> 仍是服务端渲染，先读它。
        const tid = url.match(/\/p\/(\d{5,20})/)?.[1];
        let firstError;
        if (tid) {
          try {
            const mobile = parseMobileThread(await request('/mo/q/m?' + new URLSearchParams({ kz: tid }), { mobile: true }), url);
            if (mobile.posts.length) return { ok: true, mode: 'direct', ...mobile };
          } catch (e) { firstError = e; assertActive(); }
        }
        try {
          return { ok: true, mode: 'direct', ...parsePost(await request(url), url) };
        } catch (e) { throw firstError || e; }
      }
      catch (e) { return { ok: false, url, message: e.message + '。未读取到正文，不能声称已看帖。' }; }
    },
  };
}
