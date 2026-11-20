# 开发基准

仓库：`lecheng2018/dsh-qq-hub-mods`。审阅日期：2026-11-20；固定快照：`3c2fadd2b0e2cd9743e4138f551530b763b99d6b`。

本文记录已核对的代码现状、命令和交付契约，不是测试通过报告。测试数量为文件发现统计；未运行本仓测试、构建或发布，也没有覆盖率和性能实测数据。新增强制评审要求见 [硬性要求](MANDATORY_REQUIREMENTS.md)，开发操作见 [开发指南](../CONTRIBUTING.md)，SDK 见 [接口参考](API_REFERENCE.md)。

## 1. 环境基线

| 项目 | 当前基线 | 边界 |
| --- | --- | --- |
| Node.js | CI / release 均为 `node-version: 22`；开发使用当前补丁的 22.x | README 声明 ≥22，但 CI 未验证所有更高主版本；未锁定补丁 |
| 操作系统 | CI 为 `ubuntu-latest` | 本地 Windows/macOS 不是现有 CI 矩阵 |
| 依赖 | 只用 Node 内置模块；根目录无 `package.json`、engines 或统一 npm 安装步骤 | 零运行时依赖是仓库规则，不是全仓自动扫描结果 |
| Git | 版本检查需要完整历史和 tag；workflow 的 checkout 配置 `fetch-depth: 0` | 缺少 Git 信息可能静默漏检 |
| Shell | CI 用 Bash 递归 glob 发现测试；registry 脚本用 Bash | PowerShell 等价命令见 CONTRIBUTING |
| 发布工具 | Git、GitHub CLI `gh`、适用的远端权限 | 本地检查不需要推送权限 |

`scripts/pack.mjs` 导入 `node:zlib` 的 `crc32`；部分测试使用 `node:sqlite` 和子进程实验开关。因此不能仅凭 README 的主版本说明，就假定任意早期 22.x 都能执行全部脚本。遵循当前 CI 同代补丁版本，并如实记录实际版本。

`.gitignore` 忽略 `node_modules/`、`dist/`、`.registry/`、`*.log`、`dbg.mjs`、`.mimosa/`。**Git 忽略规则不是打包过滤规则，也不是密钥防护。** 根目录 LICENSE 为 MIT，分发时保留适用许可及版权文字。

依据：`README.md`、`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`.gitignore`、`LICENSE`、`scripts/pack.mjs`、`modules/meme-wiki/meme-wiki.test.mjs`。

## 2. 模块与测试快照

`modules/<id>/` 一个一级目录一个模块；`_` 或 `.` 开头的一级目录不进入 check/pack 的发布模块集合。当前 14 个可发布目录均有 `module.json` 且 `api: 1`；这不表示这些版本已经在远端发布。

| 模块 | 清单版本 | `*.test.mjs` 文件数 |
| --- | --- | ---: |
| ai-brief | 2.2.1 | 2 |
| api-pool | 1.6.0 | 1 |
| bili | 1.1.1 | 1 |
| delivery-inbox | 1.0.1 | 1 |
| distill | 1.0.0-beta.2 | 1 |
| douyin | 2.0.0 | 1 |
| group-topic-boundary | 1.0.0 | 1 |
| heybox | 1.0.0 | 1 |
| meme-wiki | 0.2.7 | 1 |
| multi-parser | 1.0.2 | 1 |
| price-watch | 1.1.0 | 4 |
| qzone-social | 1.0.0 | 1 |
| tieba-reader | 1.5.1 | 9 |
| tophub | 0.3.1 | 1 |
| **合计** | **14 个模块** | **26** |

归档 `modules/_qq-enhance/tests/` 另有 6 个 `*.test.js`，不在上述测试发现结果内。原因是扩展名不匹配，不能解释为 CI 特意排除了 `_` 目录。归档测试还有指向缺失宿主源码的旧导入，不能仅改 glob 就声称可运行。

## 3. 脚本接口

### 3.1 清单与版本检查

```sh
node scripts/check.mjs [--base <git引用>]
```

脚本以自身所在仓库定位输入，不写构建产物。正常成功退出 0，校验失败退出非零；无通用 `--help` 或完整 CLI 参数校验保证。

已实现检查：

- `module.json` 能解析，id 等于目录名且匹配 `^[a-z][a-z0-9-]{1,39}$`。
- `name`、`version`、`description`、`author`、`license` 为非空字符串；`api` 为数字 `1`。
- `version` 以及有值的 `minPluginVersion` 只检查 `^\d+\.\d+\.\d+` 前缀，并非完整 SemVer 校验。
- `requires` 引用可发布目录；必须有 `index.mjs` 或 `index.js`、README、LICENSE。
- 非数组 `capabilities` 只产生警告。
- 检查已有发布 tag 对应的目录差异；PR 可额外传 `--base` 检查升级。
- 读取 `revoked.json`，逐项检查 id、reason 和非空 versions 数组的基本存在性。

**不保证**入口可导入、导出定义合法、入口版本与清单一致、完整字段类型、依赖环、许可正文、运行时依赖或秘密扫描。撤回清单也没有完整顶层/条目 schema 与模块版本存在性校验。

依据：`scripts/check.mjs`，特别是清单循环、版本比较和 revoked 检查。

### 3.2 打包

```sh
node scripts/pack.mjs [--out dist] [--only a,b] [--missing]
```

| 参数 | 当前行为 |
| --- | --- |
| `--out` | 默认仓库根 `dist/`；按仓库根拼接输出路径 |
| `--only` | 一级模块目录名的逗号分隔列表；不自动去空白，未知目录可得到空结果 |
| `--missing` | 当前 `<id>-v<version>` 本地 tag 已存在时跳过，不查询远端资产是否齐全 |

递归过滤点前缀项、`node_modules`、`test/`、`fixtures/` 目录及 `*.test.mjs` 文件；不普遍排除 `tests/`、`*.test.js`，也不读取 `.gitignore`。例如 `meme-wiki/run.mjs` 会入包，`tieba-reader/fixtures/` 不入包。

输出 `<id>.zip`，包根是模块内容；使用 UTF-8 相对条目、deflate 和 CRC32，不加密。另始终写 `release.json` 数组，没有包时为 `[]`。每项在原清单基础上增加或覆盖：

| 字段 | 含义 |
| --- | --- |
| `tag` | `<id>-v<version>` |
| `file` | `<id>.zip` |
| `size` | ZIP 字节数 |
| `sha256` | ZIP 内容的小写十六进制 SHA-256 |
| `commit` | `git rev-parse HEAD`；失败时为空字符串 |

pack **不先运行 check 或测试，不清空输出目录**，读取的是工作区文件；有未提交改动时，包内容不一定与记录的 HEAD 一致。成功退出 0，文件等异常产生非零退出。

依据：`scripts/pack.mjs`。

### 3.3 生成市场索引

```sh
node scripts/publish-index.mjs [--release <file>] [--previous <file>] [--out <file>]
```

默认读仓库 `dist/release.json`，写仓库 `index.json`；显式相对路径按进程当前目录解释。未传 `--previous` 时从空模块表开始；传入时本次 release 按 id 覆盖旧条目，保留未在本次打包的旧模块。源码删除或进入撤回清单不会自行从 modules 中删除历史条目。

索引结构：

```json
{
  "schema": 1,
  "generatedAt": "<ISO 时间>",
  "assetsBase": "https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/",
  "modules": [],
  "revoked": []
}
```

`modules` 按 id 排序。新条目包含 `id/name/version/description/category/tags/author/license/api/minPluginVersion/requires/capabilities/replacesBuiltin/path/sha256/size/commit`；`path` 为 `<tag>/<file>`。说明、分类、作者、许可、宿主最低版本、commit 的缺省值为 `""`；tags、requires、capabilities 缺省为 `[]`；replacesBuiltin 缺省为 `false`。

生成器读取当前 `revoked.json` 覆写顶层 revoked；不下载、不上传、不签名，不验证实际 Release 资产或完整输入 schema。文件/JSON/写入失败通常退出非零。

撤回清单的当前空值为 `{"revoked":[]}`；条目使用 `id`、`versions` 数组、`reason`。新增条目前应对照现有脚本及目标客户端验证版本匹配语义，不能假定支持通配符。

依据：`scripts/publish-index.mjs`、`revoked.json`、`scripts/check.mjs`。

### 3.4 推送 registry

```sh
bash scripts/push-registry.sh [release.json]
```

切到仓库根，默认使用 `dist/release.json`；fetch `origin/registry`，建立 `.registry` worktree，以上次索引合并生成新索引，提交并推送 `origin registry`。没有暂存差异时跳过；生成器每次更新 generatedAt，通常会形成新差异。

该命令**写本地 Git 状态并访问、修改远端，无 dry-run**。现有 worktree、fetch 失败和中途失败需要人工诊断；脚本不自动清理 worktree、不自动重试。正常开发验证不运行此命令。

依据：`scripts/push-registry.sh`。

## 4. 当前 CI 和版本纪律

`.github/workflows/ci.yml` 在 PR 和 `main` push 运行，权限为读取。步骤为：

1. `check.mjs`；PR 传入 base SHA。
2. Bash 发现并运行模块测试。
3. `pack.mjs --out dist`。

实际测试命令：

```bash
shopt -s globstar nullglob
files=(modules/**/*.test.mjs)
if [ ${#files[@]} -gt 0 ]; then
  node --test "${files[@]}"
else
  echo "没有测试文件"
fi
```

没有匹配文件时当前任务不会据此失败，也不强制每个模块都带测试。根目录和 scripts 的测试不在该 glob 内；它没有额外按 `_`、`test/`、`tests/`、`fixtures/` 或 `node_modules/` 排除。CI 不生成或验证市场索引、不解包验收、不测覆盖率。GitHub 的实际分支保护设置不在源码快照内，未核实。

版本校验的精确边界：

- 只处理仍存在、未归档且清单通过的目录。
- 若当前版本 tag 存在，比较 `git diff --name-only <tag> HEAD -- modules/<id>`；目录内文档、测试和资源变化同样算差异。
- 若当前 tag 不存在且提供 base，检查 `base...HEAD`，从 base 清单读取旧版本；旧版存在时要求 major/minor/patch 的数值严格增长。
- 已有 tag 的分支不会再次做 base 升级比较；仅改变预发布后缀不算数字升级。
- 非 PR 的普通检查没有 base 增量门禁；删除目录、改为归档、目录外变更、未提交变化不靠这两个 diff 覆盖。
- Git 不可用、无效 base、缺少 tag 或执行失败可能被当作空结果，不能以成功退出证明完整版本纪律。

这些是当前脚本行为，不是允许规避升版的规则。贡献者仍需遵守已发布内容不可变原则。

## 5. 当前发布流程

`.github/workflows/release.yml` 仅在 `main` push 且路径命中 `modules/**` 或 `revoked.json` 时触发；归档和测试变动也可能触发。根文档和工作流自身变化不是该路径触发条件。

1. build job 运行 check、`pack --out dist --missing`，上传 dist。
2. publish job 取得 `contents: write` 权限，下载产物。
3. 通过 `gh release view/create` 为每项创建 `<id>-v<version>` Release；已查询到的 Release 跳过。
4. 资产为 `<id>.zip` 和 `<id>-release.json`，后者是单条元信息对象。
5. 推送 registry 分支。撤回不会自动删除旧 Release。

现有 workflow 没有直接依赖独立 CI 的测试成功，未配置发布并发约束，没有显式将新 tag 通过 `--target` 绑定到出包 commit，也没有将 SemVer 预发布自动设为 GitHub Pre-release。下载构建产物后不重算 ZIP 摘要或核对远端已有资产；`gh release view` 的失败未区分不存在与权限/网络错误。

SHA-256 是内容摘要、CRC32 是 ZIP 校验；两者都不是发布者签名。当前没有代码签名或 provenance/验签流程；`GH_TOKEN` 是远端操作凭据，不是模块签名。

## 6. 测试范围与副作用

静态确认 14/14 可发布模块包含匹配测试，总计 26 个文件；这不是用例执行数、成功数或覆盖率。

- `tieba-reader/host-panel.test.mjs` 在缺少宿主 `client/client.js` 时条件跳过。本仓快照不含该宿主文件。
- `meme-wiki/meme-wiki.test.mjs` 会启动 SQLite 子进程并执行 `run.mjs`；不能把驱动脚本算第 27 个发现入口。
- `tieba-reader/build.test.mjs` 的入口和裸包 import 检查只针对该模块，不能推广为全仓检查。
- 外部 HTTP 按 README 规则应 mock；测试中的回环 HTTP/TCP、Node 子进程、临时目录和 SQLite 写删仍是真实副作用。
- CI 没有限制所有出站网络；静态审查未见测试入口直接调用生产外部 API，但没有执行测试，也未证明所有被导入模块均无外网或其他副作用。

check/pack 的 Git 操作查询本地信息；索引生成器读写本地文件；push-registry 和 release 明确写远端。pack 和索引生成会覆盖目标产物，不能把它们描述为纯只读校验。

## 7. 未自动化要求与后续工程

| 项目 | 当前缺口 | 后续可验收结果 |
| --- | --- | --- |
| 清单和版本 | schema、SemVer 和 Git 失败处理不完整 | 完整类型校验，Git 异常 fail-closed，删除/改名/预发布边界用例 |
| 宿主契约 | 本仓无完整宿主实现 | 固定宿主版本的工具、面板、Outbox、隔离、password、存储联调 |
| 产物 | 没有统一解包大小和内容验收 | 对照 MODULE_SPEC 的 ZIP 25 MB / 解包 64 MB 限制，检查路径、链接、数量、摘要和入口一致性 |
| 测试 | 零发现成功，条件 skip；归档测试不可直接运行 | 明确零发现策略、受控 skip、归档处理；适用时增加真实宿主 CI |
| 发布一致性 | 独立 CI 与 release 未直接串联，tag/资产存在性检查有限 | 发布同提交的已验证产物，tag 绑定来源，远端摘要核对，并发和重试策略 |
| 安全检查 | 没有专门秘密扫描和测试网络隔离 | 适用 secret scan、路径/权限测试、允许回环的出站限制 |
| 性能 | 无可复现的统一基准、覆盖率阈值或 SLO | 先记录环境、代表性操作、耗时、峰值资源、ZIP/解包大小，再制定预算 |

上述属于后续实施项。本次新增文档不改变 CI、workflow、分支保护或宿主能力；不得将建议写成已完成的安全或性能保证。
