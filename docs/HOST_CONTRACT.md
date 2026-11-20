# Host Contract

本仓的宿主联调针对固定宿主提交执行，不修改宿主源码，也不把模块本地 mock 当作宿主契约证明。

## 固定宿主

`.github/host-contract.json` 固定：

- owner: `lecheng2018`
- repo: `dsh-qq-hub`
- sha: `ee0c7f46c0ff5456fe73193d96c4f84de74472ac`

执行环境要求 Node `>=22.13.0`。宿主仓库不在本仓时，脚本会用 `git` 将该 SHA 拉到独立临时目录；临时目录在进程结束后删除。已有本地宿主可通过 `HOST_REPO_DIR` 提供。

```text
node scripts/host-contract.mjs
node scripts/host-contract.mjs --strict
```

可选环境变量：

- `HOST_REPO_DIR`：已有宿主 checkout 的绝对路径。必须 `HEAD` 精确等于固定 SHA，且 `git status --porcelain --untracked-files=normal` 为空。
- `HOST_GIT`：Git 可执行文件路径；未设置时使用 PATH 中的 `git`。

脚本不会静默跳过关键契约。拉取失败、宿主 SHA 不符、宿主工作树脏、测试失败均返回非零。子测试进程会移除 GitHub token 环境变量；运输边界使用内存 OneBot fake，不使用真实账号或外部 LLM。

## 覆盖范围

`tests/contract/host-contract.contract.mjs` 从固定宿主源码加载并执行真实实现：

| 契约 | 结果 |
| --- | --- |
| 用户模块真实加载、两个模块数据根隔离 | supported |
| 模块 `sendText` 进入真实 Shared Outbox、OneBot raw 发信动作同样进入台账 | supported |
| 台账保存真实网关 message id 和来源 | supported |
| `password` 设置字段面板掩码、空串保留、`null` 清空 | supported |
| 两个私聊和一个群聊的记忆 scope 隔离 | supported |
| 无 `chat`/无显式 `scopes` 的记忆检索 fail-closed；无 scope 历史条目不可见 | supported |
| 模块停用撤销监听器并调用 dispose/onDispose 清理 | supported |
| `api.dataDir(...parts)` 阻止 `..` 越出模块根目录 | known gap，strict 阻断 |

无 `chat` 的 `memory.list()` 是宿主明确的主人面板全库管理路径，不作为聊天隔离失败；契约测试使用 `recall`、`scopeVisible` 和聊天上下文路径验证隔离。

## 两种模式

默认模式会运行全部六个真实契约用例，并把已确认的 `SEC-03` 缺口作为报告输出。成功结论必须理解为：

```text
PINNED CONTRACT SUITE PASSED (baseline; NOT FULL SECURITY)
```

`--strict` 将同一越界行为作为真实失败断言。当前固定宿主预期为 5 个通过、1 个失败并返回非零；这不是 skip，也不是 expected failure 被吞掉。发布工作流应把 strict 非零视为阻断，直到宿主修复后在新的固定 SHA 上更新配置。

## SEC-03 复现与上游修复草案

固定宿主当前模块 API 的实现等价于：

```js
dataDir: (...parts) => join(dataDir('modules-data', id), ...parts)
```

因此模块 `contract-a` 请求 `api.dataDir('../contract-b/escaped.txt')` 时，返回路径落入 `contract-b` 数据根。契约测试只检查返回路径，没有在越界路径写文件。

建议上游在 `src/core/modules.js` 的 API 边界收紧子路径：

```js
const root = resolve(dataDir('modules-data', id))
const child = resolve(root, ...parts)
if (child !== root && !child.startsWith(root + sep)) {
  throw new Error(`模块 ${id} 的 dataDir 路径越界`)
}
return child
```

上游修复还应决定并测试符号链接边界（若模块目录允许符号链接，应使用真实路径校验或明确拒绝），再把修复后的提交 pin 到新的 `host-contract.json` SHA。此仓不修改宿主实现，也不把该缺口标成通过。

## 证据命令

使用本地固定宿主时：

```text
set HOST_REPO_DIR=C:\path\to\clean\dsh-qq-hub
node scripts/host-contract.mjs
node scripts/host-contract.mjs --strict
```

基线当前结果：6/6 passed，包含 `NOT FULL SECURITY` 缺口报告。

strict 当前结果：5/6 passed，`SEC-03` 越界断言失败，进程非零退出。
