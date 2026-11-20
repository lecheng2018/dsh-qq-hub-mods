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
| 模块间通过双方约定的 `modules-data` 相对路径共享文件 | supported |
| 模块 `sendText` 进入真实 Shared Outbox、OneBot raw 发信动作同样进入台账 | supported |
| 台账保存真实网关 message id 和来源 | supported |
| `password` 设置字段面板掩码、空串保留、`null` 清空 | supported |
| 两个私聊和一个群聊的记忆 scope 隔离 | supported |
| 无 `chat`/无显式 `scopes` 的记忆检索 fail-closed；无 scope 历史条目不可见 | supported |
| 模块停用撤销监听器并调用 dispose/onDispose 清理 | supported |

## `dataDir` 与模块间共享

固定宿主 `api.dataDir(...parts)` 将路径放在公共 `modules-data` 根下，并按模块 id 提供默认子目录。插件间数据共享是支持的协作方式，可以使用 `api.use(id)` 服务，也可以在该数据根内使用双方明确约定的相对路径。越过调用方默认子目录并不自动代表安全漏洞，也不作为发布失败条件。

契约测试在隔离临时根中验证：`contract-b` 写入共享的 `shared/contract.json`；`contract-a` 通过约定的 `../contract-b/shared/contract.json` 读取并核对内容。不会写入真实用户或宿主数据。使用共享路径时仍需确定 owner、数据 schema、并发/锁和迁移规则。

插件互通不意味着可绕过用户隐私规则。聊天记忆仍由 chat/scope 决定访问；跨插件共享文件也不授予任意聊天上下文读取这些文件的权限。用户、远程页面或模型提供的值进入文件路径前仍要做输入校验。ZIP 包内的解压路径检查继续强制，它保护安装边界，与运行期的有意共享不同。

## 验证模式

默认模式和 `--strict` 都运行完整的真实集成契约。严格模式用于阻断已定义的契约失败，包括 Outbox、记忆隔离、password 处理、生命周期和文档化的数据共享路径；它不会把允许的插件互通标为失败，也不代表恶意代码沙箱。

结果应显示六项用例全部通过：

```text
# tests 6
# pass 6
# fail 0
# skipped 0
CONTRACT RESULT: PINNED CONTRACT SUITE PASSED (strict; explicit module data sharing supported)
```

## 本地执行

```text
set HOST_REPO_DIR=C:\path\to\clean\dsh-qq-hub
node scripts/host-contract.mjs
node scripts/host-contract.mjs --strict
```
