# Agent Framework Architecture

## 原则

本项目是一个本地控制面，不是把 UI 直接绑到 Codex 进程。所有动作经过四层：

```text
Observer -> Event Normalizer -> Policy Engine -> Action Dispatcher -> Adapter
```

- Observer 只读事件，不执行副作用。
- Event Normalizer 把 app-server、rollout、桌面状态转换为统一事件。
- Policy Engine 决定是否允许重试，不知道 Windows API 或 HTTP 细节。
- Action Dispatcher 负责幂等、锁、确认和审计。
- Adapter 只实现平台/协议调用，并返回结构化结果。

## 所有权边界

| 层 | 可以做什么 | 禁止做什么 |
| --- | --- | --- |
| Observer | 订阅、扫描、去重 | 发起重试、修改 rollout |
| Normalizer | 分类错误、提取 turn/thread | 推断额度、隐藏不确定性 |
| Policy | 判断路径、退避和风险 | 直接 spawn、直接发键盘 |
| Dispatcher | 授权、幂等、审计、执行编排 | 拼接 UI 文案作为协议 |
| Adapter | 调用 app-server 或 OS | 自己决定自动重试 |
| UI | 展示状态、请求确认 | 直接调用 Codex 或系统 API |

## Agent 运行时

`AgentRuntime` 只维护一个事件循环和可取消的 retry job。每个 job 绑定：

- `threadId`
- `failedTurnId`
- `retryAttemptId`
- `policySnapshot`
- `ownershipSnapshot`

事件到达后先检查 job 的版本和幂等键，再决定继续、取消或等待。状态写入本地 event store，应用重启后可以恢复为 `awaiting_user_confirmation`，不能自动恢复为 `executing`。

## 真实副作用规则

以下动作必须经 `ActionDispatcher`：

- `turn/start`
- `turn/steer`
- `thread/resume`
- `account/rateLimitResetCredit/consume`
- 桌面 UI 输入
- 登录、退出、账号切换

每个动作都要保存请求前快照、执行路径、结果、错误码和用户确认时间。
