# QQ 增强（归档，未发布）

这里存放 dsh-qq-hub 1.4.6 内置的「QQ 增强」七个模块的**原始实现**，留作日后重新开发。

- **状态**：归档。目录名以 `_` 开头，`scripts/check.mjs`、`scripts/pack.mjs` 都会跳过，不会进 registry，也不会被面板市场列出。
- **移除原因**：这批能力依赖 SnowLuma / QQ 侧的扩展动作（闪传、群文件、在线状态、表情回应、Ark、AI 变声）。在 2026-11 的当前网关/QQ 版本上已无法工作，留在核心里只会让面板显示「在跑」却实际不生效。2026-11-17 从核心移除，转存到这里。
- **为什么先不发布**：实现直接 import 了宿主源码（`../../tools/tools.js` 等），未适配市场模块 SDK；且网关不支持时用户装了也用不了。等重新开发、验证过可用网关后再拆成正式模块发布。

## 内容映射

| 归档路径 | 原核心路径（1.4.6） | 说明 |
|---|---|---|
| `flash-transfer/index.js` | `src/modules/flash-transfer/index.js` | 闪传：清单进上下文、下载到工作区、转发白名单 |
| `group-files/index.js` | `src/modules/group-files/index.js` | 群文件：browse / download / manage |
| `online-status/index.js` | `src/modules/online-status/index.js` | 在线与已读：已读上报 + 自定义在线状态 |
| `social-actions/index.js` | `src/modules/social-actions/index.js` | 表情回应 / 精华 / QZone 写扩展 |
| `ark-cards/index.js` | `src/modules/ark-cards/index.js` | Ark 卡片 + 三级降级 |
| `ai-voice/index.js` | `src/modules/ai-voice/index.js` | QQ 官方 AI 变声（`/变声`） |
| `workspace-files/index.js` | `src/modules/workspace-files/index.js` | `qq_write_file` / `qq_read_file` |
| `shared/flash-transfer.js` | `src/chat/flash-transfer.js` | 闪传能力层（纯函数 + 显式注入网关），只被闪传模块使用 |
| `panel/enhance.js` | `client/src/views/enhance.js` | 「QQ 增强」面板页（能力一览） |
| `tests/*.test.js` | `test/{flash-transfer,group-files,online-status,social-actions,ark-ai-voice,file-ops}.test.js` | 原始回归测试，可直接改 import 路径复用 |

## 重新开发时要注意

1. **改用模块 SDK**：市场模块不能直接 `import ../../tools/tools.js`，要换成：
   - `../../tools/tools.js` → `api.lib('tools/tools.js')`
   - `../../chat/inbound.js` → `api.lib('chat/inbound.js')`
   - `../../onebot/read-actions.js` → `api.lib('onebot/read-actions.js')`
   - `../../chat/flash-transfer.js` → 优先把 `shared/flash-transfer.js` 打进模块自己；宿主已随核心移除该文件。
2. **`tab` 落点**：`enhance` 标签页已随核心删除。新模块可写 `tab: 'voice'`（语音相关），或不写 `tab` 自成一页（`ext:<id>`）。
3. **补市场清单**：每个模块需要 `module.json`、`README.md`、`LICENSE`、`index.mjs`；发布前按 `docs/MODULE_SPEC.md` 校验，版本必须是 semver 且发布后不可变。
4. **网关能力先探测**：重做时先调 `api.onebot('get_version_info')` 或用现有动作探测实际支持情况，不支持就明确降级/报错，不要默认「在跑」。
5. **测试**：市场 CI 只跑 `modules/<id>/*.test.mjs`，本归档目录不跑；拆成正式模块时把测试放到对应模块目录并改 import。

## 网关动作依赖（原实现）

| 模块 | 用到的 OneBot / SnowLuma 动作 |
|---|---|
| flash-transfer | `get_fileset_id`、`get_flash_file_list`、`download_fileset`、`send_flash_msg` |
| group-files | `get_group_file_system_info`、`get_group_root_files`、`get_group_files_by_folder`、`get_group_file_url`、`create_group_file_folder`、`move_group_file`、`trans_group_file`、`delete_group_file`、`upload_group_file` |
| online-status | `mark_all_as_read`、`set_diy_online_status` |
| social-actions | `set_msg_emoji_like`、`set_essence_msg`、`delete_essence_msg`；QZone：`like_qzone`、`unlike_qzone`、`comment_qzone`、`set_qzone_msg_right` |
| ark-cards | `check_url_safely`、`send_tuwen_ark` |
| ai-voice | `get_ai_characters`、`send_group_ai_record` |
| workspace-files | 无（纯本地工作区文件读写） |

## 许可

与 dsh-qq-hub 主仓一致：MIT。