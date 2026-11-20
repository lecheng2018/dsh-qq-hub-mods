# 模块 SDK 与面板接口参考（API 1）

审阅日期：2026-11-20；市场仓库快照：`3c2fadd2b0e2cd9743e4138f551530b763b99d6b`。

本文区分三类证据：**规范**为 [MODULE_SPEC](MODULE_SPEC.md) 的约定；**用法**为本仓代码依赖的调用或模块自身返回；**待验证**为必须对照目标宿主确认的行为。2026-11-20 新增固定宿主真实实现测试，具体已验证行为与 dataDir 缺口见 [HOST_CONTRACT](HOST_CONTRACT.md)；本表仍不是宿主完整公共 API。模块用法、测试替身和第三方 HTTP 服务不能代替契约保证。

发布 CLI、市场索引和撤回清单的数据契约另见 [开发基准](DEVELOPMENT_BASELINE.md)。接口改动与安全门禁见 [硬性要求](MANDATORY_REQUIREMENTS.md)。

## 1. 入口、配置与生命周期

| 接口 | 可证实的形状与行为 | 证据与边界 |
| --- | --- | --- |
| 清单 / 默认导出 | 14 份市场清单均 `api: 1`。入口默认导出定义，含 id、name、version、setup 等字段 | MODULE_SPEC 的 checkDef 描述为对象、id 一致、setup 可调用；不能把清单 schema 标题当成另一必填字段 |
| `setup(api)` | 有同步、异步及无返回实现；模块可返回自己的服务对象供其他模块使用 | 第二参数测试依赖注入不是宿主 SDK 保证；不可凭个别模块依赖 `this.defaults` 推断宿主 this 绑定 |
| `api.onDispose(fn)` / 返回的 `dispose` | 代码见注册 DB 关闭、停止轮询和中止操作；规范允许返回 dispose | 不承诺两种方式能叠加、执行顺序、异步等待或清理时序；无资源不必虚构清理函数 |
| `defaults` | 模块默认配置的键值对象 | 对照模块实际字段，不是宿主总配置 |
| `settings` | 自动表单描述数组，字段有 key、label、type，以及可选 hint/min/max/step | 代码见 switch/text/textarea/number；ai-brief 另用 boolean，不保证与 switch 等价。password 为规范约定；没有证据承诺 select/options 自动表单支持 |
| `panel` / `tab` | `panel: 'panel.js'` 指向自定义面板；tab 为现有模块页面落点 | 可与自动表单并存；tab 可选值全集需查宿主 |
| `api.settings()` | 模块配置读取 | 不等同 `api.config()` |
| `api.config()` | 宿主总配置读取 | 模块会读 ownerQQ、botQQ、enabled、dryRun 及部分宿主功能配置；不保证完整 schema |
| `api.setConfig(valueOrUpdater)` | 代码有对象补丁及 `cur => ({ ...cur, ... })` 两种用法 | 返回值、深合并、持久化及重载语义待查宿主 |
| `api.every(ms, fn, label)` / `api.later(ms, fn)` | 毫秒周期/延迟调度；price-watch 把 every 的有值返回当取消函数 | 首次触发、并发、异常处理和取消时序不是本仓可证明保证 |

来源：[规范](MODULE_SPEC.md)、[tophub 入口](../modules/tophub/index.mjs)、[price-watch 入口](../modules/price-watch/index.mjs)、[distill 入口](../modules/distill/index.mjs)、[meme-wiki 入口](../modules/meme-wiki/index.mjs)、[tieba-reader 入口](../modules/tieba-reader/index.mjs)。

### 最小模块骨架

以下仅为静态对齐当前规范的起点，需补齐 README、LICENSE 和测试，并在目标宿主安装验证；不是已运行的示例。

`modules/example-mod/module.json`：

```json
{
  "id": "example-mod",
  "name": "示例模块",
  "version": "1.0.0",
  "description": "模块说明",
  "author": "实际维护者",
  "license": "MIT",
  "api": 1
}
```

`modules/example-mod/index.mjs`：

```js
export default {
  id: 'example-mod',
  name: '示例模块',
  version: '1.0.0',
  description: '模块说明',
  api: 1,
  defaults: { enabled: false },
  settings: [{ key: 'enabled', label: '启用', type: 'switch' }],
  setup(api) {
    api.log.info('example-mod ready');
  },
};
```

入口示例显式写 `api: 1` 以保持清晰；bili、douyin、heybox、qzone-social、delivery-inbox 的当前导出未写该字段，因此不能宣称它是现有入口 checkDef 的已证必检条件。清单 `api: 1` 则由本仓 check 校验。

## 2. 工具、命令与权限

| 调用 | 模块实际依赖的形状 | 返回与安全边界 |
| --- | --- | --- |
| `api.tool(factory)` | 工厂按需取 `{ chat, sessionId, level }`，返回定义数组、单个定义或空数组 | 空数组用于不暴露工具；工厂可见性不能代替执行鉴权 |
| `api.defineTool(def)` | def 常见 name、description、properties、required、execute | properties 为参数描述；execute 中仍需校验实际输入 |
| `api.lib('tools/tools.js')` | 部分模块从宿主工具库取 defineTool、str | 属于对宿主内部路径的依赖；稳定性需目标宿主验证 |
| `execute(args, exec)` | 可异步；第二参数按模块需要读取本轮上下文 | `{ ok, message }` 是常见模块返回，不是统一结果或错误码 schema |
| `api.isOwner(userId)` | 消息处理中的主人判断 | 身份无法确定时，敏感操作应拒绝 |
| `api.command({ name, aliases, desc, run })` | run 接收 arg，可另取 msg；可返回字符串，或主动发送后返回 null | 命令文案写“主人”不等于已鉴权；aliases 等按实际需求可选 |

工具定义形状示例（不含副作用和授权假设）：

```js
api.tool(() => api.settings().enabled ? [api.defineTool({
  name: 'example_echo',
  description: '返回校验后的示例文本',
  properties: { text: { type: 'string', description: '示例文本' } },
  required: ['text'],
  execute: async ({ text } = {}) => {
    if (!api.settings().enabled) return { ok: false, message: '模块未启用' };
    if (typeof text !== 'string' || text.length > 200) {
      return { ok: false, message: 'text 必须为不超过 200 字符的字符串' };
    }
    return { ok: true, message: text };
  },
})] : []);
```

这只是无副作用工具的定义示意。涉及写配置、发送或私有数据时，execute 必须基于真实调用上下文重新验证权限；不可直接复制上例作为敏感工具的完整实现。

用法差异：douyin / heybox 用 profileToolVisible 控展示，在执行时结合 profilePermits 和 `hub.turnSendersAllOwner(sessionId)`；price-watch 从 exec 中解析当前 session，并依赖 `hub.turnHasOwner`，缺失信息拒绝。两个 hub 方法不能仅凭名称视为等价。

来源：[tophub](../modules/tophub/index.mjs)、[meme-wiki](../modules/meme-wiki/index.mjs)、[douyin](../modules/douyin/index.mjs)、[heybox](../modules/heybox/index.mjs)、[price-watch](../modules/price-watch/index.mjs)、[api-pool](../modules/api-pool/index.mjs)。

## 3. 消息与内容钩子

| 注册 | 模块回调形状 / 用法 | 待验证点 |
| --- | --- | --- |
| `api.on('message', fn)` | fn(msg)，可异步；读取 text/chatId/kind/groupId/userId，部分读 images/sender/nickname；true 用于接管 | 派发顺序、接管后传播规则 |
| `api.rule(rule)` | 字符串或函数；函数返回字符串或字符串数组，模块使用空串跳过 | 宿主完整类型与组合规则 |
| `api.context(provider)` | 如 `({ chat }) => string` 提供会话上下文 | 合并、优先级、长度边界 |
| `api.on('prompt', fn)` | fn(content, info) 保留 content 或追加 `{ type: 'text', text }`；读取 info.chat/queryText | 与 rule/context 的阶段关系 |
| `api.on('reply', fn)` | fn(text, info) 改写字符串 | 异步支持及抑制语义依宿主 |
| `api.on('reply/items', fn)` | fn(items, info)，条目如 `{ kind: 'text'/'voice', value }` | 不能与 OneBot segment 混用 |
| `api.on('send', fn)` | fn(segments, info)，片段如 `{ type, data }`；读取 chatId/note | 覆盖哪些发送入口、多钩子顺序 |

未改写时源码常返回 undefined；price-watch 部分路径用 null 表示抑制，不能据此推断每个宿主钩子都接受同一抑制值。MODULE_SPEC 的 `inject` 只收纯字符串数组，但本仓未见 `api.inject` 调用；不要把上述钩子都改写成它。

来源：[group-topic-boundary](../modules/group-topic-boundary/index.mjs)、[multi-parser](../modules/multi-parser/index.mjs)、[price-watch](../modules/price-watch/index.mjs)、[MODULE_SPEC](MODULE_SPEC.md)。

## 4. 发送与主动投递

| 调用 | 用法证据 | 返回边界 |
| --- | --- | --- |
| `api.sendText(chatId, text)` | chatId 示例 `private:<QQ>`、`group:<群号>` | 部分模块以真值判断受理成功；不能写统一回执类型或等同终端送达 |
| `api.reply(msg, text)` | 对消息回复 | 完整错误和台账关联需查宿主 |
| `api.send(chatId, text)` | 普通文本或贴纸标记用法 | 不等同原始 OneBot 接口 |
| `api.sendSegments(chatId, segments, note)` | segments 如 `{ type: 'text', data: { text } }`；note 按需传 | 各片段类型支持、长度上限待核验 |
| `api.sendFile(chatId, path, name)` | 模块先检查函数存在 | 可用性、大小边界和失败回执待核验 |
| `api.proactive?.submit({ itemId, to, channel: 'qq', text })` | tophub 读取 deliveryId/state；有单号的 sent/sending/pending 视为受理 | 受理不等于送达；不可用或失败时该模块回退 sendText；dryRun 不提交 broker |

**规范要求所有用户消息进入 Outbox。** `multi-parser/delivery.mjs` 还使用 `api.onebot` 合并转发；是否进入同一台账必须核验宿主，不能因它是 SDK 方法就认定合规，也不能以现有写法作为新增绕行的依据。

来源：[tieba-reader](../modules/tieba-reader/index.mjs)、[api-pool](../modules/api-pool/index.mjs)、[multi-parser 投递](../modules/multi-parser/delivery.mjs)、[tophub 浏览](../modules/tophub/lib/browse.mjs)。

## 5. 存储、日志、记忆与模型

| 调用 | 可观察用法 | 边界 |
| --- | --- | --- |
| `api.dataDir(...parts)` | 模块数据路径，如 `state.json` 或多段相对路径 | 仅写模块自己的目录；路径安全不能由调用名称证明 |
| `api.dir` | 模块源码和资源位置 | 不作为可写用户数据目录 |
| `api.workspaceDir(relative)` | 可选的 QQ 媒体工作区路径 | 按能力存在性处理并清理临时媒体 |
| `api.log.debug/info/warn/error` | 字符串及多参日志 | 密钥、私聊和敏感响应不得直接输出；本仓不是 api.logger 用法 |
| `api.use(id)` / `api.lazy(id)` | 获取其他模块返回的服务面；如 memory | 缺失降级；lazy 的完整解析规则未在此实现 |
| memory 的 add/list/update/remove/recall/addEvent | 代码有 `add({ text, tags, importance, source, chatId })`、`list('')`、`update(id, { text })`、`remove(id)`、`recall(query, { limit })`、`addEvent({ text, tags, importance })` | 这些是模块服务用法，不是统一 `api.memory.*` 类型承诺；省略字段不能理解为全局访问授权 |
| `api.ask({ system, text, maxTokens, temperature })` | await 后当模型文本处理，自行解析 | 未证完整参数全集、结构化返回或统一错误 |
| `api.think(prompt, opts)` | opts 见 title、timeoutMs；结果用于文本提取 | 不改写成 `api.llm.*` |
| `api.dsh.get('web')` | 贴吧兜底 web.search({ query, maxResults: 8 }, signal)，读取 sources 的 url/title/snippet | 外部搜索插件可用性及完整返回需验证 |

记忆规范为 fail-closed：私聊物理隔离，群聊不可读私聊，无 scope 老数据默认不可见。不得根据 memory 方法缺少 scope 参数就推断数据可跨会话读取。price-watch 的本地 TTL 管理也不代表通用记忆服务带同等 TTL 保证。

存储差异：规范提及裸 `dataDir()` 静态拦截，但 ai-brief、meme-wiki、distill 有无参 `api.dataDir()`，distill 还有读取全局 chatlog 的路径依赖。这些需要结合目标宿主与实际授权澄清；本仓 check 不是全面存储安全检查器。

来源：[ai-brief](../modules/ai-brief/index.mjs)、[meme-wiki](../modules/meme-wiki/index.mjs)、[distill](../modules/distill/index.mjs)、[price-watch 记忆桥](../modules/price-watch/lib/memory-bridge.mjs)、[tophub 浏览](../modules/tophub/lib/browse.mjs)、[tieba-reader](../modules/tieba-reader/index.mjs)、[MODULE_SPEC](MODULE_SPEC.md)。

## 6. 宿主内部依赖

`api.lib(path)` 按宿主内部相对路径取得导出，本仓没有可宣称稳定的完整白名单。`api.core` 实见 http、hub、chatLog、onebot、personas、mutes；用例包括 onebot.state、mutes.muted(chatId)、personas.current()、hub.groupName(groupId)。

`api.onebot(action, params)` 实见 upload_group_file 及群/私聊合并转发。调用代码 await 或捕获错误并不能证明统一返回类型、权限隔离或 Outbox 覆盖；它也不是已证的 `api.napcat.*` 命名空间。

bili、douyin、heybox、qzone-social 很大程度依赖宿主功能，不能只靠包装模块补写其底层完整 API。当前源码也没有支持顶层 `api.http`、`api.kv`、`api.logger`、`api.llm`、`api.notify`、`api.scheduler`、`api.panel` 等接口的充分证据；使用实际的 core.http、log、ask/think、调度函数和面板闭包描述。

归档 `_qq-enhance` 的 saveSettings、activity、onebot/state、config 事件等不列为当前市场 SDK 的已证能力。

来源：[bili](../modules/bili/index.mjs)、[qzone-social](../modules/qzone-social/index.mjs)、[tieba-reader](../modules/tieba-reader/index.mjs)、[multi-parser 投递](../modules/multi-parser/delivery.mjs)、[归档说明](../modules/_qq-enhance/README.md)。

## 7. 面板桥接与模块动作

`panel.js` 是宿主包装后执行的函数体文本，结尾 `return` 组件，而不是 ESM 的 export default。模块面板使用注入的 React、h、ui 与 `call(path, body)`；body 按需传。已见 ui.Card/Btn/Row/Switch/Select/Empty，以目标宿主组件集为准。

组件读取 `props.settings`，调用 `props.save(patch)`，使用 toast；tieba-reader 检测 draftSettings / setSettings 并写入宿主草稿，等待统一保存。不能仅由一个模块解构 reload 就推断通用刷新协议。HTML 的 `type='password'` 本身不登记宿主秘密；tieba-reader 另通过宿主配置库 registerSecretField 登记 cookie 字段。

`api.route(path, handler)` 注册模块动作。处理器见无参、req、req/res 形态，常返回对象，或委托宿主库返回。代码使用 `api.core.http.query(req)`、`await api.core.http.body(req)`，也有直接读取 req.url/req.query；bili 的图像动作直接调用 http.send 写 JPEG 或 404。

面板用法示例：

```js
const status = await call('/status');
const preview = await call('/preview?kind=evening');
const result = await call('/search', { query: '商品名' });
```

以上分别是模块上下文中的桥接调用，不应混用到任意模块。**下表是原样注册的动作字符串，不是完整 HTTP URL。** q 表示查询参数，body 表示请求体；除代码明确检查的方法外，不推定默认 HTTP 方法、宿主前缀、鉴权、错误码或统一 JSON 包装。不同面板注释给出不同宿主前缀，必须在目标宿主确认。

| 模块及源码 | 动作与可证明的输入/输出 |
| --- | --- |
| [ai-brief](../modules/ai-brief/index.mjs) | `/status` → nodes/counts；`/sources` → 来源配置；`/preview`（q: kind）→ kind/count/text；`/send`（q: kind）→ kind/text；`/manual`（q: kind、chat 可选）→ ok/message。kind 为 morning/evening；ok 不能作为终端送达回执 |
| [api-pool](../modules/api-pool/index.mjs) | `/pool` → pool；`/save`（body: api）、`/del`（id）；`/groups` 与 `/settings`（groups/scope/blacklist 可选，scope 为 owner/everyone）；`/libs`、`/libSave`（lib）、`/libDel`（id）；`/export` → path，密钥不导出；`/import`（data JSON 字符串）、`/importUrl`（url）；`/test`（api）、`/testAll` → 测试结果。test 成功可更新已存项有效标记 |
| [bili](../modules/bili/index.mjs) | `/bili/state`、`/bili/account`、`/bili/run`、`/bili/replies`、`/bili/shots`；`/bili/shot/image`（q: file）直接写 JPEG 或 404；`/bili/shot/delete`（body: file）。大部分返回委托宿主 bili |
| [delivery-inbox](../modules/delivery-inbox/index.mjs) | `/deliveries/exceptions`（req.query.limit，默认/上限 50）→ ok/items/counts/total/file，成功另有 savedAt，失败含 reason；只读 unknown/failed/cancelled 台账，无重发动作 |
| [distill](../modules/distill/index.mjs) | `/status` → list/settings；`/rules`（q: groupId）；写动作 body 均读 groupId：`/promote`、`/toggle-lock`、`/delete-rule` 另读 ruleId；`/prune-noise`、`/consolidate`、`/clear-all`、`/trigger-now`；`/add-manual` 另读 situation/style；`/distill-history` 另读可选 days/sampleSize；`/simulate` 另读 userText → matchedRules/hit/stylePrompt/reply |
| [douyin](../modules/douyin/index.mjs) | `/douyin/state`、`/douyin/account`、`/douyin/login`、`/douyin/login/status`、`/douyin/run`、`/douyin/dms`；`/douyin/window`（body: visible）、`/douyin/confirm-owner`（body: input）。委托宿主 dy |
| [heybox](../modules/heybox/index.mjs) | `/heybox/state`、`/heybox/feed`、`/heybox/hot`、`/heybox/topics`、`/heybox/topics/refresh`、`/heybox/account`、`/heybox/run`、`/heybox/clear-quota`、`/heybox/styles`；`/heybox/login-cookie`（body: cookie）验证保存，仅返回 ok/message。其余多委托宿主 hb |
| [meme-wiki](../modules/meme-wiki/index.mjs) | `/stats` → total/keywords/p50/p90/maxLen/lastSync；`/peek`（q: q）→ ok/text；`/sync` → added；`/import` 启动后台导入，`/import-status` 查进度；`/add`（body: title/text/可选 aliases）；`/manual` → items；`/del`（body: title） |
| [multi-parser](../modules/multi-parser/index.mjs) | `/multi-parser/test`（body: url）→ ok/result 或 ok:false/message；`/multi-parser/status` → active/recentCount/cookieStatus/platforms，cookie 仅回是否已配置 |
| [price-watch](../modules/price-watch/index.mjs) | `/state` → 监控、最近记录、统计和记忆状态；`/search`（body: query）→ groups/topN/memory；`/add`（query、可选 articleId/pick）→ options 或 watch；`/remove`（id）；`/check`（可选 id）→ checked/alerts。search/add/remove/check 显式要求 POST；`/memory` 默认列表，DELETE 或 body.clear 进入删除分支，读取可选 id/query |
| [qzone-social](../modules/qzone-social/index.mjs) | `/qzone/social/run` 委托 social.run({ force: true })；`/qzone/social/state` 展开 social.state() |
| [tieba-reader](../modules/tieba-reader/index.mjs) | `/state` → 状态、计数、browser/cookieSet/bars/browseMode；`/login`、`/logout`、`/account`、`/share`；`/preview`（body: 可选 bar/home）→ 列表或失败 |
| [tophub](../modules/tophub/index.mjs) | `/state` → 巡游状态；`/run` 调用 tour({ fresh: true })；`/history` → items；`/hot`（q: 可选 node）→ 热榜结果 |
| [group-topic-boundary](../modules/group-topic-boundary/index.mjs) | 无 api.route，只有规则与 reply / reply/items / send 钩子 |

面板桥接证据：[api-pool 面板](../modules/api-pool/panel.js)、[ai-brief 面板](../modules/ai-brief/panel.js)、[price-watch 面板](../modules/price-watch/panel.js)、[tieba-reader 面板](../modules/tieba-reader/panel.js)。表中字段是摘要，不是完整响应 schema；必须以对应 handler 及委托宿主为准。

## 8. 跨模块服务

本仓可观察的 setup 返回面如下；它们是版本相关的模块服务，不表示任意宿主都有这些内置能力。

| 模块 | 返回服务面 |
| --- | --- |
| tophub | hot / search / nodes / tour / history / status |
| multi-parser | parse / recent |
| price-watch | version / tick / check / search / list / state |
| tieba-reader | version / tick / run / search / browse / read / browserStatus / state |
| distill | getGroupRules / clearGroupRules / dispose |

ai-brief 可选调用 `api.use?.('tophub')`，即使其清单 requires 为空；缺失或单榜失败时跳过。tophub 的 `hot(nameOrId, { fresh })` 成功返回 ok/source/items，条目含 title/url/hot；失败为 ok:false/error。search(keyword, opts) 见 names/maxNodes/liveNodes/limit 选项，成功含 ok/hits，命中含 node/title/url。这只是本模块定义，不是统一 SDK 查询 schema。

推荐保留能力探测和失败降级：

```js
let service;
try { service = api.use?.('tophub'); } catch { /* 宿主或模块未就绪 */ }
if (typeof service?.hot === 'function') {
  try {
    const result = await service.hot('微博热搜');
    if (result?.ok && Array.isArray(result.items)) {
      // 只消费已经核对的字段，例如 item.title。
    }
  } catch {
    // 可选依赖失败：跳过该来源，不绕过权限或改读私有存储。
  }
}
```

来源：[ai-brief](../modules/ai-brief/index.mjs)、[tophub](../modules/tophub/index.mjs)、[tophub fetch](../modules/tophub/lib/fetch.mjs) 及表内其他模块入口。

## 9. 宿主集成核验清单

合并涉及这些行为的变更前，记录目标宿主版本/提交，并补足对应验证：

- 异步 setup、装卸/重载、清理形态及执行时序。
- 工具执行上下文、权限默认值、消息和内容钩子传播规则。
- settings 类型、配置更新和深合并、秘密登记、掩码、清空与留空语义。
- 路由前缀、HTTP 方法、认证/同源限制、请求与响应封装。
- 各发送入口的回执、重试、Outbox 覆盖，尤其是原始 OneBot 合并转发。
- dataDir 沙箱、存量无参调用与 chatlog 读取边界，以及记忆 fail-closed 的实际保证。
- api.lib/core/dsh 兼容范围与稳定能力；缺失能力的降级效果。

宿主缺失时条件 skip 的测试不能作为以上验证通过的证据，示例见 [tieba-reader 宿主面板测试](../modules/tieba-reader/host-panel.test.mjs)。
