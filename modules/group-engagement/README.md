# 群参与分级（group-engagement）

群插话参与分级模块：对宿主判定为 `interject` 的群插话回合做轻量评分，声明参与级别
（REACT / TEXT_LITE），或通过插话质量门拦下无意义的附和。**策略在插件、执行在宿主**——
本模块绝不直接发送任何 QQ 消息或表情。

## 宿主版本门槛

本模块依赖宿主的 `group/participate` 声明式钩子、`reply` / `reply/items` 钩子的回合身份
字段（`turnId` / `topicMode` / `participation`）与 `group/result` 终态事件。这些能力随宿主
Batch 1/2 版本发布；**`module.json.minPluginVersion` 将在宿主正式发布后按真实版本钉定
（本版本暂不填写）**。在旧宿主上：`group/participate` 与 `group/result` 不会触发，质量门
因缺 `info.topicMode` 自动跳过——模块处于完全旁观状态，禁止手动改成直接发送版本。

## 参与级别

| 级别 | 含义 | 模型调用 | 执行者 |
| --- | --- | --- | --- |
| FULL | 正常完整回复（默认） | 有 | 宿主 |
| TEXT_LITE | 仍调模型，只收紧自动分条与群合包（`maxBubbles` / `maxChars` 只能比现有规则更严） | **有（不减少）** | 宿主 |
| REACT | 给触发消息加一个表情回应，本轮零模型调用 | 无 | 宿主 Shared Outbox（`set_msg_emoji_like`） |
| Shadow | 只记录建议，不改变任何行为 | 不变 | 无 |

REACT 的 `sent` 只表示宿主网关接受了调用，**不代表所有 QQ 客户端视觉已显示**。

## 配置（首版默认值，需在 Shadow 样本后校准）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关，默认关闭 |
| `mode` | `shadow` | `shadow` 只记录建议；`engage` 真实声明 |
| `allowedGroupIds` | 空 | 生效群号（逗号分隔）；空 = 不在任何群生效 |
| `reactEnabled` | `false` | 允许声明 REACT |
| `textLiteEnabled` | `false` | 允许声明 TEXT_LITE |
| `guardEnabled` | `false` | 插话质量门 |
| `feedbackEnabled` | `false` | 反馈观察与结算 |
| `feedbackBiasEnabled` | `false` | 反馈偏置（调节内部评分） |
| `emojiIds` | `['66']` | REACT 可选表情 id（表情只从这里随机选，消息文本指定无效） |
| `reactScoreThreshold` | `0.72` | REACT 评分阈值 |
| `textLiteScoreThreshold` | `0.4` | TEXT_LITE 评分阈值 |
| `reactCooldownMs` | `90000` | REACT 冷却 |
| `reactFailureCircuit` | `3` | 连续明确 failed 熔断阈值 |
| `reactCircuitPauseMs` | `600000` | 熔断暂停时长 |
| `textLiteMaxBubbles` | `1` | TEXT_LITE 每轮气泡数 |
| `textLiteMaxChars` | `80` | TEXT_LITE 每条字数目标 |
| `feedbackWindowMs` | `180000` | 反馈观察窗口 |
| `feedbackBiasStep` | `0.02` | 偏置步长 |
| `feedbackBiasLimit` | `0.1` | 偏置绝对值上限 |
| `maxPendingPerGroup` | `32` | 每群 pending 上限 |
| `maxRecentTurnIdsPerGroup` | `128` | 每群已结算回合记录上限 |
| `maxGroups` | `200` | 覆盖群数量上限 |

以上全部是**首版工程默认值，不是生产校准结论**。请先在 Shadow 模式收集
「建议级别 vs 实际 FULL 结果」样本后再调整阈值。

## 状态含义（面板 / `/state`）

- **Shadow 建议**：内存计数（react / text_lite / full / total），重启清零。
- **pending**：等待反馈观察窗口结束的插话回合数。
- **bias**：反馈偏置（`connected`/`extended` 加步长、`ignored` 减步长，钳制在
  `±feedbackBiasLimit`；`feedbackBiasEnabled=false` 时仍统计但不调整）。
- **连败 / unknown**：REACT 连续明确失败次数与 unknown 谨慎计数（unknown 不当失败也不当成功）。
- **熔断中**：连续失败达到 `reactFailureCircuit` 后，暂停声明 REACT 至 `circuitUntil`。

## 数据与隐私边界

- 只写本模块自己的 `api.dataDir('feedback.json')` 一个文件；version 1；按群分桶。
- 只持久化白名单字段（pending、recentResultKeys、recentTurnIds、结果/反馈计数、bias、
  lastReactAt、连败数、circuitUntil），**绝不持久化聊天正文、完整 msg、raw、reply 或堆栈**。
- pending / recent / 群数量超上限时淘汰最旧项；质量门的「已发送文本」缓存在内存、按群隔离、
  容量有界。
- 单文件 rename 原子替换只保护这一份文件，不等于「事件+文件+QQ 副作用」事务；崩溃可少一条
  反馈样本，不追求 exactly-once。
- 群隔离：不跨群读取反馈；每个群的 pending / bias / 熔断互相独立。

## 真机未知项

- REACT 在不同 QQ 客户端（手机 / PC / Pad）的视觉呈现未逐一验证；`sent` 仅代表网关接受。
- `set_msg_emoji_like` 在部分网关实现可能返回失败或无回执（unknown）——已按不重试、不补发
  处理，视觉结果仍需真机确认。
- 评分阈值的误杀率 / 漏发率没有真机统计，全部阈值需要 Shadow 样本校准。

## 灰度步骤（任何一步出现误杀 / 重复 / 跨群 / 状态虚报，退回上一档）

1. 宿主升级后保持 `enabled=false`，验证旧行为无回归。
2. `enabled=true`、`mode=shadow`，只收集建议。
3. 测试群开启 `guardEnabled`（质量门）。
4. 测试群开启 `textLiteEnabled`。
5. 真机确认 REACT 视觉后，测试群开启 `reactEnabled`。
6. `feedbackEnabled=true`，只收集反馈。
7. 样本复核后才开启 `feedbackBiasEnabled`。

## 回滚

1. 关 `reactEnabled` / `feedbackBiasEnabled`，再关 `enabled`，最后停用模块。
2. 停用后确认没有新的 participation 接管（宿主日志无本模块 sourceModuleId）。
3. 不删除 `feedback.json` 与宿主 Outbox 台账；旧版本不读取新反馈文件即可。
4. 宿主回滚后，本模块的所有钩子都不会触发，恢复 FULL，无残留定时器或重复监听。
