# 版本更新（qqhub-updater）

为 [dsh-qq-hub](https://github.com/lecheng2018/dsh-qq-hub) 提供本体检查更新、通道切换（稳定版 / Beta 测试版）、可折叠更新日志与基于 DSH 插件管理器的自动更新能力。

## 功能概览

- **双通道切换**：支持在 **稳定版（`stable`）** 与 **Beta 测试版（`beta`）** 间一键切换。
  - 稳定版仅追踪正式 Release（过滤 `-test.*`、`-beta.*`、`-alpha.*`、`-rc.*` 等预发布）。
  - Beta 通道追踪全部非草稿发布（含预发布与正式版），按完整 SemVer 比较取最新版本。
- **更新日志与可折叠历史**：
  - 当前通道最新版本的更新日志默认展开（支持点击折叠），以安全 React 节点渲染标题、列表、引用、行内代码与 `https://` 链接（不使用 `dangerouslySetInnerHTML`）。
  - 历史更新日志外层默认折叠，展开后每条历史版本同样可独立折叠/展开，Beta 通道支持按「全部 / 正式版 / Beta」筛选；更早版本自动从 `CHANGELOG.md` 补齐只读历史记录。
- **自动检查与自动更新**：
  - 使用 GitHub Releases API 并带 `If-None-Match`（ETag / 304）减少配额消耗；接口不可达或限流时自动降级到 jsDelivr / raw.githubusercontent.com 与本机 `CHANGELOG.md`。
  - 开启自动更新后，仅在发现**更高版本**时触发升级（永不自动降级），支持配置静默更新时段（如 `03:00-05:00`）。
  - 升级通过 DSH 原生 `pluginManager` 服务执行（优先 `updateBundle`，支持 HMR 热重载与失败自动回滚）；若发现新版本或自动更新完成，可选经宿主 Outbox 私聊通知主人。
- **主人 QQ 命令**：支持 `/更新`（别名 `/update`、`/检查更新`），支持 `/更新 stable`、`/更新 beta`、`/更新 now`。

## 安装环境兼容

| DSH 中 `dsh-qq-hub` 的安装方式 | 检查与日志 | 一键/自动更新 | 说明 |
| --- | --- | --- | --- |
| Git 在线安装（`github:lecheng2018/dsh-qq-hub#<sha>`） | 支持 | 支持 | 调用 `pluginManager.updateBundle`，带连通性检查、HMR 热重载与失败自动回滚 |
| 离线包（`.tgz`）或未固定提交的 Git 安装 | 支持 | 支持 | 下载受信任 GitHub Release `.tgz`（存在 `sha256.txt` 时强制校验摘要），经 `pluginManager` 切换并支持失败回滚 |
| 包仓库安装（Registry） | 支持 | 支持 | 调用 `pluginManager.updateBundle` |
| 本地目录开发链接（`link:` / 本地目录） | 支持 | 禁用（防覆盖源码） | 展示手动更新命令与 Release 下载链接 |
| 无 `pluginManager` 服务的旧宿主环境 | 支持 | 禁用 | 展示手动 CLI 更新命令与 Release 下载链接 |

## 配置项与默认值

配置保存在宿主 `ext.qqhub-updater` 下，全部可在面板「系统 → 版本更新」直接修改：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `channel` | `'stable'` | 更新通道：`stable`（稳定版）或 `beta`（测试版） |
| `autoCheck` | `true` | 是否按频率在后台自动检查更新 |
| `checkIntervalHours` | `6` | 自动检查间隔（小时，范围 `1–168`） |
| `autoUpdate` | `false` | 发现更高版本时是否自动更新（默认关闭） |
| `autoUpdateWindow` | `''` | 可选静默更新时段，格式 `HH:MM-HH:MM`（支持跨午夜），留空不限制 |
| `notifyOwner` | `true` | 发现新版本或自动更新完成时是否私聊通知主人（走 Outbox，同版本去重） |
| `githubMirror` | `''` | 可选公网 `https://` 下载镜像前缀（仅用于 `.tgz` 离线包下载，禁止内网/回环与含凭据网址） |

## 面板接口

挂载在 `/qq-hub/api/ext/qqhub-updater`：

- `GET /state`：只读返回当前版本、安装环境探测、所选通道最新版本与历史日志、设置与最近更新状态（不触发网络或配置写入）。
- `POST /check`：手动检查更新（`{ force?: boolean, channel?: 'stable' | 'beta' }`）。
- `POST /config`：校验并保存配置补丁。
- `POST /update`：校验目标版本与安装环境并启动升级（`{ version?: string, channel?: 'stable' | 'beta', allowDowngrade?: boolean }`）。

## 安全与边界

- 零运行时第三方依赖，仅使用 Node.js 内置模块。
- 所有 QQ 通知走宿主 `api.sendText`（进入统一 Outbox），不直连 OneBot。
- 不执行任意 shell 命令；所有安装、卸载与重载均走 DSH `pluginManager` API。
- 下载链接限制为 GitHub 官方发布域名（或经 SSRF 校验的公网 HTTPS 镜像），并对响应体与安装包大小施加明确上限。
- 数据文件存放在宿主分配的 `api.dataDir()`（`state.json` 与 `downloads/`，下载目录自动清理旧包）。

## 许可

MIT
