# ADR-0001：重试控制面不伪造原生 retry API

状态：Accepted for vNext design

## 背景

当前 app-server schema 暴露 `thread/resume`、`turn/start`、`turn/steer`，错误通知包含 `willRetry`；没有公开的 `turn/retry` RPC。Codex 内部已经会在同一个 turn 内重试。

## 决策

- `willRetry: true` 时只观察，不重复提交。
- 内部重试耗尽后，只有在输入、线程所有权和幂等信息完整时，才允许通过 `thread/resume + turn/start` 创建“新 turn 重试”。
- 产品和代码中不称其为“原生 retry”。
- 由桌面持有 writer 的线程进入平台兼容模式；默认关闭并需要用户授权。
- 官方额度/重置动作只走 `account/rateLimits/read` 和 `account/rateLimitResetCredit/consume`。

## 结果

这会让 vNext 的自动重试能力覆盖更多情况，同时避免重复工具副作用和错误的能力承诺。macOS UI 自动化必须先做能力探针和真实桌面回归，不能因为 Windows 路径可用就假设两端相同。
