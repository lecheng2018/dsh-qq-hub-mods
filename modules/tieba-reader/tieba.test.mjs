import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barNames, postUrl, cookieHeader, parseList, parsePost, parseMobileList, parseMobileThread, createTieba } from './tieba.mjs';
import moduleDef from './index.mjs';

const list = '<title>测试吧</title><ul><li class="j_thread_list"><a class="j_th_tit" href="/p/12345678">一个有趣的帖子</a><div class="threadlist_abs">摘要</div></li></ul>';
const post = '<title>测试帖</title><h3 class="core_title_txt">真正的标题</h3><div class="l_post" data-field=\'{"content":{"post_no":1}}\'><a class="p_author_name">作者</a><div class="d_post_content">第一楼<br>正文<script>坏代码</script></div></div>';
test('forum names normalize; links reject non-Tieba and non-post paths', () => {
  assert.deepEqual(barNames('deepseek吧，图拉丁\ndeepseek'), ['deepseek','图拉丁']);
  assert.equal(postUrl('https://tieba.baidu.com/p/12345678?pn=2'), 'https://tieba.baidu.com/p/12345678');
  for (const x of ['http://127.0.0.1/p/12345678','https://tieba.baidu.com.evil/p/12345678','https://tieba.baidu.com@evil/p/12345678','https://tieba.baidu.com/f?kw=a','https://tieba.baidu.com:99/p/12345678']) assert.equal(postUrl(x), null);
});
test('cookies filtered, newline refused, HTML list/comments and post parse', () => {
  assert.equal(cookieHeader('BDUSS=secret; evil=x; STOKEN=abc'), 'BDUSS=secret; STOKEN=abc');
  assert.throws(() => cookieHeader('BDUSS=x\r\nevil:y'));
  assert.equal(parseList(list)[0].title, '一个有趣的帖子');
  assert.equal(parseList('<!--' + list + '-->')[0].url, 'https://tieba.baidu.com/p/12345678');
  assert.equal(parsePost(post,'url').posts[0].text, '第一楼 正文');
  assert.throws(() => parseList('<title>百度安全验证</title>'), /安全验证/);
  assert.throws(() => parsePost('<title>空白页面</title>','url'), /未读到/);
});
test('requests read-only, cookies only sent to Tieba; verification falls back to indexed results', async () => {
  const requests=[];
  const client=createTieba({getCookie:()=> 'BDUSS=private; Other=discard', fetchImpl:async (url,init)=>{
    requests.push({url:String(url),init}); return new Response('<title>百度安全验证</title>');
  },searchWeb:async ()=>({sources:[{url:'https://evil.test/p/12345678',title:'evil'},{url:'https://tieba.baidu.com/p/12345678',title:'结果'}]})});
  const r=await client.browse('deepseek');
  assert.equal(r.mode,'indexed'); assert.equal(r.items.length,1);
  assert.match(r.warning,/可能不是最新/);
  assert.equal((await client.read('https://tieba.baidu.com/p/12345678')).ok,false);
  for(const {url,init} of requests){assert.equal(new URL(url).hostname,'tieba.baidu.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.cookie,'BDUSS=private');}
});
test('mobile forum list and thread pages parse (2026-11 PC pages are front-end shells)', () => {
  const fixture = (name) => readFileSync(new URL('fixtures/' + name, import.meta.url), 'utf8');
  const items = parseMobileList(fixture('forum-mobile.html'), 'deepseek');
  assert.deepEqual(items.map((i) => i.title), ['吧规与导航索引', '手机版帖子标题', '第二篇手机版帖子']);
  assert.equal(items[1].url, 'https://tieba.baidu.com/p/11201536695');
  assert.equal(items[1].bar, 'deepseek');
  assert.equal(items[1].imageCount, 1);
  const p = parseMobileThread(fixture('post-mobile.html'), 'https://tieba.baidu.com/p/146250804019');
  assert.equal(p.title, '手机版帖子标题');
  assert.equal(p.posts[0].section, '楼主正文');
  assert.equal(p.posts[0].text, '楼主第一段正文 楼主第二段正文');
  assert.equal(p.posts[0].floor, 1);
  assert.ok(!/看高清大图|楼中楼回复/.test(p.posts.map((x) => x.text).join(' ')));
  assert.equal(p.posts[1].text, '回复正文');
  assert.equal(p.posts[1].author, '回复者');
  assert.equal(p.posts[1].floor, 2);
  assert.equal(p.imageCount, 2);
  assert.throws(() => parseMobileThread('<title>百度贴吧</title><div id="app"></div>', 'url'), /未读到/);
});
test('without a browser component browse/read go through the server-rendered mobile pages', async () => {
  const requests = [];
  const mobileList = '<title>deepseek吧_百度贴吧</title><ul><li><a href="/p/12345678?lp=5028&amp;mo_device=1" class="j_common ti_item"><div class="ti_title"><span>手机版帖子</span></div></a></li></ul>';
  const mobilePost = '<title>手机版帖子</title><div class="post_title_embed">手机版帖子</div><ul><li fn="1" class="j_post_list_item"><span class="user_name">楼主</span><div class="content">楼主正文</div></li></ul>';
  const client = createTieba({ getCookie: () => 'BDUSS=private', browserAvailable: () => false,
    fetchImpl: async (url, init) => { requests.push({ url: String(url), ua: init.headers['user-agent'] });
      return new Response(String(url).includes('kz=') ? mobilePost : mobileList); },
    searchWeb: async () => ({ sources: [] }) });
  const list = await client.browse('deepseek');
  assert.equal(list.mode, 'direct'); assert.equal(list.items.length, 1);
  assert.match(requests[0].url, /\/mo\/q\/m\?kw=deepseek/); assert.match(requests[0].ua, /Mobile/);
  const post = await client.read(list.items[0].url);
  assert.equal(post.ok, true); assert.equal(post.posts[0].text, '楼主正文');
  assert.match(requests[1].url, /\/mo\/q\/m\?kz=12345678/);
  assert.equal((await client.read('https://tieba.baidu.com/mo/q/m?kz=12345678')).title, '手机版帖子');
});
test('home without a browser component says so instead of pretending it browsed', async () => {
  const client = createTieba({ getCookie: () => '', browserAvailable: () => false,
    fetchImpl: async () => new Response('<title>百度贴吧</title><div id="app"></div>'),
    searchWeb: async () => ({ sources: [] }) });
  const r = await client.home();
  assert.equal(r.ok, false); assert.equal(r.items.length, 0); assert.match(r.message, /首页已改为前端渲染/);
});
test('automatic browse obeys switches, shares a read post once, and deduplicates', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-test-'));
  const opts={...moduleDef.defaults,bars:'deepseek',autoBrowse:true,startHour:0,endHour:0,intervalMinutes:10};
  const cfg={enabled:true,dryRun:true,ownerQQ:'12345'};
  let sent=0, modelCalls=0;
  const previous=globalThis.fetch;
  globalThis.fetch=async (url)=>new Response(String(url).includes('/p/')?post:list);
  try {
    const api={lib:()=>({registerSecretField(){}}),settings:()=>opts,config:()=>cfg,dataDir:(f)=>join(dir,f),dsh:{get:()=>null},tool:()=>{},rule:()=>{},every:()=>{},route:()=>{},
      core:{onebot:{state:'connected'},mutes:{muted:()=>false},personas:{current:()=> '人格'}},
      ask:async ()=>{modelCalls++;return '{"share":true,"index":0,"text":"这个挺有意思"}';},
      sendText:async ()=>{sent++;return {message_id:1};},use:()=>null,log:{warn:()=>{}}};
    const ext=moduleDef.setup(api,{renderPage:async (url,kind)=>kind==='browse'
      ? {links:[{url:'https://tieba.baidu.com/p/12345678',title:'一个有趣的帖子'}]}
      : {title:'真正的标题',contents:['第一楼正文']}});
    await ext.tick();assert.equal(sent,0);assert.equal(modelCalls,0);
    cfg.dryRun=false;opts.autoBrowse=false;await ext.tick();assert.equal(sent,0);
    opts.autoBrowse=true;await ext.tick();assert.equal(sent,1);assert.equal(ext.state().shares,1);
    await ext.tick();assert.equal(sent,1);assert.equal(modelCalls,1);
    assert.ok(ext.state().seen.includes('https://tieba.baidu.com/p/12345678'));
  } finally {globalThis.fetch=previous;}
});
test('already-bound tools resolve current module exports after a hot reload', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-binding-'));
  const builders=[];
  let current={version:'old',read:async()=>({ok:true,title:'old'})};
  const api={lib:()=>({registerSecretField(){}}),dataDir:f=>join(dir,f),settings:()=>moduleDef.defaults,config:()=>({}),
    dsh:{get:()=>null},tool:b=>builders.push(b),defineTool:t=>t,rule:()=>{},every:()=>{},route:()=>{},
    use:()=>current};
  moduleDef.setup(api,{renderPage:async()=>({})});
  const tools=builders[0]({chat:{kind:'private'},level:'social'});
  assert.ok(tools.some(t=>t.name==='tieba_reader_status'));
  const boundRead=tools.find(t=>t.name==='tieba_read');
  current={version:'new',read:async()=>({ok:true,title:'NEW_BROWSER_RESULT'})};
  const r=await boundRead.execute({url:'https://tieba.baidu.com/p/12345678'});
  assert.equal(r.title,'NEW_BROWSER_RESULT');
});
