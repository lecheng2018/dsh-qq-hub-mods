# 开发指南

适用仓库：`lecheng2018/dsh-qq-hub-mods`。代码核对日期：2026-11-20；依据提交：`3c2fadd2b0e2cd9743e4138f551530b763b99d6b`。

本文规定模块贡献和维护流程；SDK 契约以现有 [MODULE_SPEC](docs/MODULE_SPEC.md) 为起点，实际调用边界见 [接口参考](docs/API_REFERENCE.md)，检查命令及自动化限制见 [开发基准](docs/DEVELOPMENT_BASELINE.md)。新增或变更贡献必须满足 [硬性要求](docs/MANDATORY_REQUIREMENTS.md)。这些文件是本次提出的仓库治理规则；新增要求需要维护者合并采纳，不能据此声称远端已经实施。

## 1. 仓库定位与开发边界

本仓库维护模块源码、清单、模块包和市场索引发布流程，不包含宿主 SDK 的完整实现。不要把模块调用方式直接当成宿主实现保证，也不要在本仓虚构一套 HTTP 服务路由。

- 一个可发布模块放在 `modules/<id>/`，不再按分类增加目录层级。
- 模块至少包含 `module.json`、`index.mjs`、`README.md`、`LICENSE`；按需求增加 `panel.js`、测试、资源及内部实现文件。
- `_` 或 `.` 开头的一级模块目录不进入发布集合。`modules/_qq-enhance/` 是归档材料，不能作为新模块直接可用的 SDK 模板。
- 新模块只使用 Node 内置模块作为运行时依赖；需要外部浏览器或宿主能力时，写明前置条件和不可用时的行为。
- 保持现有 ESM `.mjs` 组织方式，参考功能相近的活跃模块；不要一次重排无关模块。

## 2. 环境准备

使用最新补丁的 Node.js 22.x，与当前 CI 的主版本一致；Git 用于版本差异和发布 tag 校验。README 的支持说明为 Node ≥ 22，但本仓 CI 只配置 Node 22，不能声称所有更高主版本均已验证。

```sh
git clone https://github.com/lecheng2018/dsh-qq-hub-mods.git
cd dsh-qq-hub-mods
node --version
git status --short
```

仓库根没有统一的 `package.json` 安装流程，不要添加没有依据的 `npm install`、`npm run dev` 或端口说明。直接运行下文的 Node 命令。克隆后的首次运行前应检查要执行的模块和脚本；测试会执行实际 JavaScript。

## 3. 开始一项改动

1. 从最新 `main` 创建任务分支，确认已有未提交改动不属于其他任务。
2. 明确模块 id、变更目标、影响会话、外部服务、权限和数据范围。
3. 阅读目标模块 README、`module.json`、入口、相关测试及 [接口参考](docs/API_REFERENCE.md)。
4. 涉及宿主能力时记录目标宿主版本或提交；仓库内的 mock 不能替代宿主集成验证。
5. 只修改达成目标所需的文件。行为变化同步更新模块 README、配置说明和测试。

建议分支名为 `feat/<module-id>-<topic>`、`fix/<module-id>-<topic>` 或 `docs/<topic>`；这是协作建议，不是已有 CI 校验项。

## 4. 新建或修改模块

### 清单与入口

- 目录名、清单 id、入口导出 id 必须一致；版本字段保持一致。
- 按现有 MODULE_SPEC 声明 `api`、分类、能力、说明、许可和宿主兼容范围；字段校验与可选项见开发基准，不凭空增加 `entry` 等未核对字段。
- 入口保留 `export default` 的模块定义和 `setup(api)` 生命周期；不要复制归档区旧式插件注册方式。
- `capabilities` 要如实反映网络、存储、调度、工具和面板使用。它是展示声明，不是进程沙箱或访问授权。
- 工具名称、参数校验、权限、错误行为和配置默认值必须可从代码与文档相互核对。

### 生命周期与异常

- 在 `setup` 中注册能力；需要自行创建 timer、监听器、浏览器连接或其他资源时，按宿主支持的清理契约释放。
- 重复启停不得重复注册、重复投递或遗留后台任务。清理逻辑应允许部分初始化后调用。
- 外部输入和模型输出在使用前校验。网络调用设有限超时、有限重试和响应体边界，错误应能定位且不能泄漏秘密。
- 宿主能力不可用时给出明确的不可用结果，涉及权限和数据隔离时停止相关操作，不得绕行限制。

### 数据、发送与面板

- 消息通过已核验进入 Outbox 的宿主发送链路；SDK 中存在原始 OneBot/NapCat 调用不代表它自动满足台账要求。
- 模块数据写入宿主分配的模块目录；会话数据按会话隔离。不得硬编码宿主安装目录或跨模块读写。
- 密钥使用 `password` 类配置字段，不写进日志、源码、fixture、截图或面板普通状态返回。
- 面板遵循现有 `React / h / ui / call` 桥接约定，动作名称和方法与后端注册保持一致。面板隐藏按钮不等于后端鉴权。
- 涉及用户可见效果、登录或浏览器能力的变更，补一项目标宿主中的手工验证记录。

具体阻断规则及存量例外处理见 [硬性要求](docs/MANDATORY_REQUIREMENTS.md)。

## 5. 本地验证

以下为仓库根执行命令。PowerShell 可使用第一个单模块命令；跨模块测试展开使用与 CI 一致的 Bash，或使用后面的 PowerShell 等价命令。

```sh
# 1. 清单和已有发布版本检查
node scripts/check.mjs

# 2. 目标模块测试；将 <id> 替换成实际目录名
node --test modules/<id>/*.test.mjs

# 3. 构建全部可发布模块，核对产物；这一步不会替代 check 或测试
node scripts/pack.mjs --out dist
```

与 CI 一致的 Bash 全量测试发现方式：

```bash
shopt -s globstar nullglob
files=(modules/**/*.test.mjs)
if [ ${#files[@]} -gt 0 ]; then
  node --test "${files[@]}"
else
  echo "没有测试文件"
fi
```

PowerShell 全量测试等价命令：

```powershell
$testFiles = @(Get-ChildItem -LiteralPath modules -Recurse -File -Filter *.test.mjs |
  ForEach-Object { $_.FullName })
if ($testFiles.Count -eq 0) { throw '没有测试文件' }
node --test @testFiles
if ($LASTEXITCODE -ne 0) { throw '模块测试失败' }
```

注意：PowerShell 版本在没有发现测试时主动失败，比当前 CI 的分支更严格。当前 CI 发现规则不包含 `*.test.js`；有意维护归档区时应另行运行相关测试，不能把它们计入上述命令的结果。

测试至少覆盖改动的成功路径、无效输入和一项失败路径；涉及会话隔离、发送、网络、计时器或凭证时，加相应回归用例。外部 HTTP 必须 mock，时间和随机数应可控。因缺少宿主代码而 skip 的用例需注明，不能把“无失败”报告成“全部执行通过”。

## 6. 版本与兼容性

- 可发布模块目录内任何交付文件变更都先检查其版本影响；不仅业务源码，README、测试、资源和 LICENSE 也可能进入版本不可变检查与打包。
- 已发布 `<id>-v<version>` 对应的模块内容不可覆盖或移动 tag；需要修正时发布新版本。
- 采用语义化版本表达兼容性意图：修复为 patch，向后兼容功能为 minor，不兼容变更为 major；同时满足当前检查脚本的实际版本比较规则。
- 当前比较器和 Git 检查存在局限，尤其是预发布版本、未提交工作区、缺失 Git 信息和已删除模块。不要依靠检查脚本的漏检规避升级；具体见开发基准。
- 根文档或工作流变更不会自动要求给全部模块升版；不要为纯仓库文档更新批量改模块版本。

## 7. 提交与评审

推荐按 `feat(module-id): ...`、`fix(module-id): ...`、`docs: ...` 描述目的。PR 必须说明：

1. 修改目的、影响模块和用户可见变化。
2. 版本变化、宿主兼容性、配置和数据迁移影响。
3. 验证命令及真实结果，包括失败、skip 和未执行原因。
4. 新增能力、网络目标、存储范围、消息副作用和密钥处理。
5. 回滚或撤回方式；若不适用，说明理由。

使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)，由维护者完成代码、契约与安全审查。绿色 CI 是必要证据之一，不等于宿主集成、安全或性能已全部验证。CI 中未实现的硬性规则由评审阻断，不能伪称自动检查。

## 8. 发布与撤回

当前发布链为合入 `main` 后 `check → pack → GitHub Release → registry`；发布标签为 `<id>-v<version>`。日常开发和验证只运行本地校验及打包，不运行 `push-registry.sh`、不手动覆盖已发布资产。发布 workflow、CLI 参数和产物契约见 [开发基准](docs/DEVELOPMENT_BASELINE.md)。

安全问题用 `revoked.json` 按现有格式登记，并通过维护流程更新 registry；不能仅从源码删掉模块就认为旧版本已撤回。涉及密钥泄漏时先撤销或轮换密钥，PR 和日志里仅提供脱敏信息。
