# Codex 重试控制与 CC Switch 交互调研

日期：2026-10-22  
范围：Codex app-server 当前协议、真实本机 app-server 能力、CC Switch 公开文档与界面模式

## 结论先行

1. 当前公开 app-server 协议没有发现独立的 `turn/retry` 方法。对外可调用的核心路径是 `thread/resume`、`turn/start` 和 `turn/steer`。
2. Codex 自己已经有 turn 内部重试机制。错误通知包含 `willRetry`；`willRetry: true` 时，外部管理器必须等待 Codex 自己完成，不能再发第二个 turn。
3. 当内部重试耗尽并出现 `server_overloaded` / `Selected model is at capacity` 时，管理器只能在明确拥有线程写入权、保存了可重放输入、并完成幂等检查的前提下发起新的 `turn/start`。这不是原生 retry RPC。
4. 已打开的 Codex Desktop 线程可能被另一个 app-server 拒绝，错误是 `active writer`。Windows 可以通过 `codex://threads/<id>` + SendInput 做兼容兜底；macOS 的 Accessibility 自动化也应作为独立能力探针和显式兼容模式，不能默认宣称稳定。
5. 当前安装的 Codex app-server 实际支持 `account/rateLimits/read`、`account/usage/read`、`account/rateLimits/updated` 和 `account/rateLimitResetCredit/consume`。本机实测返回了真实的周窗口、已用百分比、重置时间、余额/credits、计划类型和 usage 统计。

## 本机协议实测

使用只读 JSON-RPC 客户端连接本机 `codex app-server --listen stdio://`：

- `account/rateLimits/read` 成功
  - `ordinaryUsageAllowed: true`
  - `rateLimits.primary.usedPercent: 4`
  - `windowDurationMins: 10080`
  - `resetsAt` 有值
  - `planType: pro`
  - `rateLimitResetCredits.availableCount: 1`
- `account/usage/read` 成功
  - `summary.lifetimeTokens`
  - `dailyUsageBuckets`
  - `peakDailyTokens`
  - `longestRunningTurnSec`
  - streak 统计

这些字段只证明当前账号接口提供了数据，不代表所有 Codex 版本、账号或 Provider 都保证提供。客户端必须按字段可用性展示可信度和采集时间。

## Codex 官方资料

- [Codex app-server 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)：说明 `initialize`、`thread/start`、`thread/resume`、`turn/start` 和事件流。
- [app-server protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：说明 `account/rateLimits/read`、`account/rateLimits/updated`、线程生命周期和 `willRetry` 语义。
- [Codex app-server JSON Schema](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json)：作为版本化协议事实来源。实现时应以本机 `codex app-server generate-json-schema` 生成的 schema 为准。

## CC Switch 可借鉴的交互

参考 [CC Switch provider switching guide](https://cc-switch.cc/en/tutorials/provider-switching)、[feature overview](https://cc-switch.cc/en/tutorials/feature-overview) 和 [GitHub README](https://github.com/farion1231/cc-switch)：

- Provider 卡片把名称、当前状态、用量、启用动作和编辑入口放在同一行，用户不用跳页才能完成最常用操作。
- 主窗口适合看清当前 Provider；系统托盘适合高频切换。
- “当前已启用”和“实际正在服务”是两个状态，不能混成一个绿色点。
- 用量查询有明确开关；不支持或未启用时不伪造数字。
- 切换动作要显示生效范围和何时需要重启。
- 轻量模式、状态徽标、搜索和分组比大段解释更适合后台工具。

## 对本项目的直接要求

- 首页第一层只保留：监听开关、自动重试开关、当前线程、当前错误、重试状态、官方用量和账号。
- “继续”降为兼容动作；主动作名称改为“重试此 turn”，并明确显示执行路径：`Codex 内部重试`、`app-server 新 turn`、`Windows UI 兜底` 或 `macOS UI 兜底`。
- 任何自动重试前必须展示线程所有权、重试次数、退避时间和可能的副作用。
- 使用官方 rate limit API 作为用量主来源；rollout token 统计只能作为 usage 辅助来源。
