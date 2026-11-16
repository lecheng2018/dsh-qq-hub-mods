# dsh-qq-hub-mods

[dsh-qq-hub](https://github.com/lecheng2018/dsh-qq-hub) 的模块市场内容仓库：社区模块源码 + 打包 CI + registry 索引。

## 布局

```
modules/<id>/          一个模块一个文件夹（不按分类分层，分类是 module.json 里的字段）
  module.json          市场清单（必填）
  index.mjs            入口（export default { id, name, version, setup(api) }）
  README.md            说明（必填）
  LICENSE              许可（必填）
  panel.js             面板组件（可选）
  test/ 或 *.test.mjs  测试（可选，外部 HTTP 一律 mock）
scripts/               check / pack / publish-index / push-registry
docs/MODULE_SPEC.md    模块规范
revoked.json           撤回清单（发布过的版本出安全问题时登记，客户端拦截安装并提示已装用户）
```

`modules/_qq-enhance/` 是归档区（`_` 前缀不发布）：从主仓核心移除、待重新开发的「QQ 增强」七件套，详见其中的 README。

`_` 或 `.` 开头的目录不发布。

## 发布流程

1. PR 改 `modules/<id>`，CI 跑 `check.mjs`（清单校验 + 已发布版本不可变 + 改动必须升版本）
2. 合入 main 后 release workflow：check → pack（zip + sha256）→ 每模块一个 Release（`<id>-v<version>`）→ 推 registry 分支 `index.json`
3. 客户端面板「扩展 → 模块市场」读 registry 索引（多源 failover），主人确认后安装

## 安全须知

**装模块等于装进程内代码**：模块跑在插件进程里，`capabilities` 只是展示声明，不是安全边界。
只装你信任来源的模块；客户端会校验 sha256、zip 路径安全、入口契约（checkDef），但这些拦不住恶意代码本身。

模块 SDK 的硬约束（宿主强制）：发送必经 Outbox 台账；记忆按会话隔离（fail-closed）；
`api.dataDir` 沙箱；密钥走 password 字段不进日志。详见 [docs/MODULE_SPEC.md](docs/MODULE_SPEC.md)。

## 本地开发

```sh
node scripts/check.mjs            # 校验全部模块清单
node scripts/pack.mjs --out dist  # 打包 + release.json（sha256/size/commit）
node --test modules/<id>/*.test.mjs
```

零运行时依赖：只用 Node 内置模块（Node ≥ 22）。

## 许可

MIT
