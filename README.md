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
  *.test.mjs          测试（必需，外部 HTTP 一律 mock）
scripts/               check / test / quality / pack / release / host-contract / benchmark
templates/module/      可执行的最小模块模板
schemas/               清单和撤回数据的 JSON Schema
docs/MODULE_SPEC.md    模块规范
revoked.json           撤回清单（发布过的版本出安全问题时登记，客户端拦截安装并提示已装用户）
```

`modules/_qq-enhance/` 是归档区（`_` 前缀不发布）：从主仓核心移除、待重新开发的「QQ 增强」七件套，详见其中的 README。

`_` 或 `.` 开头的目录不发布。

## 发布流程

1. PR 及 main 使用同一质量工作流：清单/版本 → 全量测试 → 文档/秘密/模板 → 宿主契约 → 打包验收与基准。
2. 发布额外要求严格宿主契约通过，只消费同一提交的已验收产物；核验 tag、ZIP 和元信息后更新 registry。中断后可补缺失资产，不覆盖内容不同的已发布文件。
3. 客户端面板「扩展 → 模块市场」读 registry 索引，主人确认后安装。

**当前发布阻断：**固定宿主版本的 `api.dataDir` 未阻止 `..` 越界，严格契约测试会失败；本仓不会把它当作安全保证或绕过门禁。复现、支持矩阵及上游修复方向见 [宿主契约](docs/HOST_CONTRACT.md)。

## 安全须知

**装模块等于装进程内代码**：模块跑在插件进程里，`capabilities` 只是展示声明，不是安全边界。
只装你信任来源的模块；客户端会校验 sha256、zip 路径安全、入口契约（checkDef），但这些拦不住恶意代码本身。

模块必须遵守发送经 Outbox、记忆按会话隔离（fail-closed）、模块私有数据目录和密码脱敏等约束。规范要求与已验证实现分开记录：固定宿主的 dataDir 路径边界尚未满足严格测试，详见 [模块规范](docs/MODULE_SPEC.md) 和 [宿主契约](docs/HOST_CONTRACT.md)。

## 开发文档

| 文档 | 用途 |
| --- | --- |
| [开发指南](CONTRIBUTING.md) | 环境准备、模块开发、测试、评审和发布流程 |
| [模块规范](docs/MODULE_SPEC.md) | 现有模块清单与宿主 SDK 约定 |
| [接口参考](docs/API_REFERENCE.md) | 模块生命周期、SDK、面板桥接及接口证据边界 |
| [开发基准](docs/DEVELOPMENT_BASELINE.md) | 已核对的环境、CI、脚本参数、发布产物与现有缺口 |
| [硬性要求](docs/MANDATORY_REQUIREMENTS.md) | 必须满足的贡献规则、验收证据、阻断与例外流程 |
| [宿主契约](docs/HOST_CONTRACT.md) | 固定宿主真实测试、已知 dataDir 缺口与严格发布阻断 |
| [模块模板](templates/module/README.md) | 有配置、工具和测试的最小模块起点 |
| [安全报告](SECURITY.md) | 私密报告渠道、凭证轮换和撤回边界 |

2026-11-20 增加可执行的版本/产物/发布门禁、固定宿主契约、模板与质量检查。当前实施范围和保留限制见 [开发基准](docs/DEVELOPMENT_BASELINE.md)；实际 GitHub 保护设置以仓库规则为准。

## 本地开发

```sh
node scripts/check.mjs             # 严格清单、SemVer、Git 版本纪律
node scripts/test.mjs              # 模块、脚本、模板；缺测试失败；回环网络守卫
node scripts/quality.mjs           # 文档链接、凭证模式、模板、schema
node scripts/host-contract.mjs     # 固定宿主，报告已知缺口
node scripts/host-contract.mjs --strict  # 发布所需；当前 dataDir 缺口会失败
node scripts/pack.mjs --out dist   # 打包并验收 ZIP、摘要、入口一致性
node scripts/benchmark.mjs         # 写 .artifacts/benchmark.json，不虚构性能阈值
```

零运行时依赖：只用 Node 内置模块（Node ≥ 22）。

## 许可

MIT
