# 开发基准

更新日期：2026-11-20。本轮在文档提交 `edc1b486` 的基础上，把原先六项建议落实为脚本、测试、共享工作流和固定宿主契约。本文描述本轮实现；GitHub 实际运行结果以对应提交的 Actions 为准。

## 环境与范围

- Node.js 22.x 当前补丁；本地验证使用 22.23.5。CI 的 Node 主版本为 22，同时覆盖 Ubuntu 与 Windows，不据此宣称其他主版本或平台已验证。
- Git 完整历史与 tag；Git 查询异常导致检查失败。根目录没有 npm 安装步骤，运行时和工程脚本只使用 Node 内置模块。
- 打包使用 `node:zlib.crc32`，部分测试需要 `node:sqlite`。不能假设所有早期 22.x 补丁均满足全部接口。
- 14 个活跃模块，`_`、`.` 前缀一级目录为归档/排除区；当前活跃模块原有 26 个 `*.test.mjs`，新增脚本与模板测试由统一 runner 发现。
- `.gitignore` 与打包过滤规则独立。构建与测试报告写入忽略目录 dist、artifacts 或 .artifacts，不能因为 Git 忽略就允许敏感文件进包。

## 统一验证入口

在仓库根执行，Bash/PowerShell 不依赖递归 glob：

```sh
node scripts/check.mjs
node scripts/test.mjs
node scripts/quality.mjs
node scripts/host-contract.mjs
node scripts/pack.mjs --out dist
node scripts/benchmark.mjs --out .artifacts/benchmark.json
```

PR 版本比较：`node scripts/check.mjs --base <base-sha>`。发布使用干净工作区产物，额外要求 `node scripts/host-contract.mjs --strict` 通过。严格模式目前因固定宿主 dataDir 越界而失败；这是有效发布阻断，不得删用例、改空断言或关闭门禁。

### 清单与版本

共享校验库 `scripts/lib/validation.mjs` 提供严格字段类型、额外字段拒绝、完整 SemVer 和比较规则。编辑器使用 [模块 schema](../schemas/module.schema.json) 与 [撤回 schema](../schemas/revoked.schema.json)；语义规则还包括 id/目录一致、依赖引用、不可变发布及撤回重复项等。

- major/minor/patch、预发布标识和 build metadata 按 SemVer 处理；`beta.2 → beta.3` 是升级，单改 build metadata 不是。
- 已发布 tag 内容与整个模块目录比较，包括 README、测试和资源，不能通过只改非入包文件绕过纪律。
- `--base` 的引用必须有效；检查 merge-base 和工作区变化，Git 执行失败不能当作无差异。
- 已发布模块删除、跨 id 改名或移入归档会被阻断；未发布模块删除可处理。普通退市不等同安全撤回，不自动往 revoked 填充虚假安全理由。
- 入口 id/version 与清单一致性在打包验收时核验；静态入口验证不是对任意 JavaScript 行为的安全证明。

### 测试发现与网络

`scripts/test.mjs` 发现活跃模块、scripts 和模板测试；活跃模块无测试或全局零发现会失败。归档 `_qq-enhance` 六个旧 `.test.js` 依赖旧宿主路径，不混入当前市场测试结果。固定宿主契约另走专用 runner，不依赖旧条件 skip。

本轮修复 `tieba-reader/build.test.mjs` 在 Windows 使用文件路径动态 import 的问题，改为 file URL；遵守全目录版本纪律，将清单和入口同步升级为 **1.5.2**。修复后，在 Node 网络守卫下原有模块用例实测 **205 通过、0 失败、1 条件跳过**；跳过项为旧宿主面板测试，不是新契约的通过证据。

测试进程通过 NODE_OPTIONS 加载 `scripts/network-guard.cjs`，限制常见 Node HTTP/HTTPS/TCP/TLS/fetch 外联，允许 localhost/127.0.0.1/::1 及本地 IPC；外部服务必须 mock。它不是 OS 沙箱，不防恶意代码绕过，不限制测试前 Git 拉取或发布的受控网络。

### 质量与秘密检查

`node scripts/quality.mjs` 执行：

- Markdown 相对链接、代码围栏与编码替换字符检查。
- 已跟踪及未忽略新文件的常见凭证模式扫描；报路径/行号/类型，不输出秘密值。
- [最小模块模板](../templates/module/README.md) 的清单、入口、必需文件与 schema 验证。
- schema 文档基础结构检查；回归测试核验 required 字段和 SemVer 正反例不漂移。

GitHub secret scanning 与 push protection 在本轮读回时已启用。非提供商模式和有效性检查虽提交启用请求，读回仍为 disabled，不能宣称已启用。模式检查不能保证发现所有秘密，password 和业务脱敏仍需真实宿主验证与评审。

## 打包与产物验收

```sh
node scripts/pack.mjs --out dist
node scripts/pack.mjs --out dist --require-clean
```

打包始终遵守脚本自身过滤策略，不把 `.gitignore` 当白名单。禁止符号链接、敏感/临时文件、越界路径和不安全输出；测试与 fixture 不作为运行时交付。输出目录中的旧产物不能混入本次 release 元信息。

`scripts/lib/artifact.mjs` 提供：

- `validateArtifact(zipBuffer, record, { limits })`：失败 throw，成功返回 `{ files, unpackedBytes }`。
- `validateReleaseDirectory(outDir, { limits })`：验收 release.json 及其全部包，返回记录数组，发布时拒绝 dirty 产物。

验收核对 ZIP 结构、压缩方式、加密标记、路径、重复条目、CRC32、摘要、大小、文件数，以及根清单/入口一致性。包体上限 25 MiB、解包合计 64 MiB；文件数与更细的上限见 artifact 库常量，不以压缩文件大小代替解包预算。

发布记录保留模块元数据及 tag/file/size/sha256/commit；本地脏工作区可测量，但须明确 dirty，不能作为可信发布来源。缺 Git commit 不再填空继续发布。SHA-256 是完整性摘要，CRC32 是格式校验；当前没有发布者签名或客户端验签，不能宣称具备。

## 共享 CI 与发布流程

CI 和 release 调用 `.github/workflows/quality.yml` 的同一验证链。Ubuntu 与 Windows 执行清单、统一测试、质量检查和宿主基线；Linux 产物经打包验收，记录性能报告。发布只下载自身 run、同一提交的已验证 Linux 产物，不接受任意跨 run 名称相同的附件。

release 额外启用严格宿主契约，失败就不能进入远端发布。发布任务串行，默认权限只读，只有执行远端写入的任务获得 contents:write。旧 Bash registry 入口不允许独立绕过验收推索引。

```sh
node scripts/release.mjs --dist <产物目录> --revoked revoked.json --commit <40位提交>
```

此命令会写 GitHub Release/tag/registry，只在明确授权的发布环境执行。凭证使用受控环境变量，不写源码、产物或日志。

发布器的关键规则：

1. 本地验收成功且记录来源 commit 等于指定提交。
2. 新 tag 必须绑定该 commit；已经存在但指向其他提交时拒绝。
3. 区分远端 404 与网络/401/403 等错误，不能把查询失败当成不存在。
4. 检查 Release 中的 ZIP 与单条元信息资产；缺失可以补齐，内容不同拒绝覆盖。
5. 所有待发布/保留条目的远端资产核验完成后，再生成和推送 registry；并发引用变化采用受限重试，不能 force-push 丢掉其他提交。
6. 重跑不重写可信历史文件；无实质索引变化不应只因生成时间制造无效提交。

### 历史来源偏差

当前已有两个 tag 与索引 commit 存在精确历史差异：

| Tag | 历史索引 commit | 实际 tag commit |
| --- | --- | --- |
| meme-wiki-v0.2.7 | `bcb5b18b1d4e8f43a4f35859425fdda12a7530e6` | `3c2fadd2b0e2cd9743e4138f551530b763b99d6b` |
| tophub-v0.3.1 | `bcb5b18b1d4e8f43a4f35859425fdda12a7530e6` | `3c2fadd2b0e2cd9743e4138f551530b763b99d6b` |

只允许对这些精确历史组合按 registry 已钉住的摘要和元信息做只读核验；这不是新版本豁免。历史资产缺失、摘要不同或无法精确复原时失败，需要可信原产物或新版本，不能用当前源码重新打包覆盖旧资产。

## 固定宿主与发布阻断

宿主版本固定在 `.github/host-contract.json`；本地可设 HOST_REPO_DIR，CI 默认克隆指定提交到临时目录。被测 Outbox、记忆、密码、生命周期和路径逻辑使用真实宿主实现，外部运输/服务才可替身。

- 默认模式验证已支持行为，并明确报告 known gaps，不代表完整安全验收。
- `--strict` 要求目录边界等全部安全契约成立；固定宿主当前 dataDir 直接拼接路径，`..` 可逃逸，因此严格模式应失败。
- 记忆缺少 chat/scope 的 recall 为 fail-closed；主人管理 list 的全库语义不混同聊天读取。

复现步骤、已验证行为和上游修复方向见 [HOST_CONTRACT](HOST_CONTRACT.md)。本轮不修改或推送宿主远端，也不静默升级固定版本来隐藏失败。

## 性能基线

```sh
node scripts/benchmark.mjs --dist dist --out .artifacts/benchmark.json --samples 5
```

报告包含 Node/平台/CPU/提交、清单检查进程耗时、ZIP/解包字节与文件数、包验收的预热和多次测量（min/median/p95/max），以及基准进程内存与 maxRSS。它不测外部 API，不等同所有模块运行时延迟、全 CI 峰值内存或生产吞吐。

本轮 Windows x64 / Node 22.23.5 本地实测：14 个 ZIP 合计 264,081 字节，解包合计 662,445 字节；一次完整 check 进程约 6.93 秒。这是指定开发机的一次记录，不是跨平台性能保证；机器信息和逐包样本由 benchmark JSON 保存，CI 再独立测量。

现阶段先保存可复现测量并在 CI 上传，不设置没有实测依据的延迟/覆盖率阈值；现有 25/64 MiB 限制属于交付安全预算，仍自动执行。积累代表性负载后，再单独审定性能回归预算。

## 维护责任与剩余工作

CODEOWNERS 指向仓库维护者，Actions 依赖由 Dependabot 每周检查。本轮已通过 GitHub API 配置并读回 main 保护：必需 `Quality Gate` 且分支保持最新，要求 PR、解决讨论，禁止强推与删除。仓库目前只有一名维护者，批准数为 0，未假设存在可提供非作者批准的第二人；管理员强制检查未启用以保留引导/紧急维护能力，该边界必须透明。另已启用仓库 ruleset：`*-v*` 发布 tag 禁止更新和删除，registry 分支禁止非快进更新和删除；新 tag 创建和正常索引更新仍允许。私密漏洞报告已启用。发布安全阻断属于有意保护，不能用管理员绕过当作修复。

仍需上游修复 dataDir 目录边界并更新固定契约版本；完整进程隔离、所有业务输入鉴权、生产浏览器/媒体效果和覆盖率目标不是本轮可由脚本自动证明的内容。任何报告必须区分普通测试成功、条件跳过和严格宿主失败。
