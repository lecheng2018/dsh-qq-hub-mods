# 模块规范（api = 1）

市场模块与内置模块用同一套 SDK。完整 API 见主仓库 `src/modules/API.md`；本文是市场侧的硬约束摘要。

## 入口契约

```js
export default {
  id: 'my-mod',            // 必须与 module.json 的 id、文件夹名一致
  name: '我的模块',
  version: '1.0.0',
  description: '一句话说明',
  panel: 'panel.js',       // 可选
  settings: [],            // 可选：面板自动表单
  setup(api) { /* 注册监听/工具/命令；返回 dispose 可选 */ },
}
```

宿主 `checkDef` 校验：default 导出是对象、id 一致、setup 是函数。不过校验的包不会落位。

## module.json（市场清单，schema:1）

必填：`id`（`^[a-z][a-z0-9-]{1,39}$`）、`name`、`version`（semver）、`description`、`author`、`license`、`api`（当前 1）、`path`/`sha256` 由 CI 生成。
可选：`category`、`tags`、`minPluginVersion`、`requires`（依赖的其他模块 id）、`capabilities`（展示用声明）。

## 宿主强制的安全约束（不是建议，是架构）

- **发送必经 Outbox**：`api.sendText` / hub 出站统一台账，模块不能直连 onebot 发消息
- **记忆 fail-closed**：私聊物理隔离、群聊读不到私聊、无 scope 老数据默认不可见
- **api.dataDir(...)** 沙箱：模块数据只写自己的目录；裸 `dataDir()`（不带 id 参数）会被静态检查拦截
- **密钥**：settings 里 `type: 'password'`，自动登记掩码、不回显、留空不清空；密钥绝不进日志
- **inject 只收纯字符串数组**；工具必须走 `api.tool(defineTool(...))` 工厂，裸对象会被拦截

## 打包约束（与客户端 market.js 四重防护兼容）

- zip 只用 store(0) / deflate(8)，不加密，CRC32 正确
- 包内路径不得含 `..`、绝对路径、反斜杠、盘符
- 解压后 ≤ 64MB，包体 ≤ 25MB
- `module.json` 的 id/version 必须与索引条目一致

## 版本纪律

- 已发布的版本（git tag `<id>-v<version>`）内容不可变；改了必须升版本
- 撤回走 `revoked.json`（登记 id + versions + reason），不删 Release

## 测试

`node --test`，放模块目录内；外部 HTTP 一律 mock，CI 不访问真实网络。
