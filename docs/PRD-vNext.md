# Codex 任务管家 vNext PRD

状态：设计评审稿，先完成能力验证，再进入实现  
目标版本：v0.4（重试控制面 + 简洁后台）  
用户：个人开发者，单机 macOS / Windows Codex 用户

## 1. 产品目标

让用户在 `Selected model is at capacity` 出现时，能清楚知道：

- Codex 是否正在自行重试
- 当前重试是否已经失败并停止
- 管理器是否正在监听
- 是否开启了自动重试
- 管理器将调用哪条真实路径
- 本次动作会不会重新执行工具或产生副作用
- 当前账号的官方限额和重置时间

核心价值是“控制和可解释”，不是堆更多指标。

## 2. 非目标

- 不伪造官方接口没有提供的剩余额度。
- 不默认操作 Codex Desktop 的输入框。
- 不自动重放不完整或来源不明的用户请求。
- 不把 `thread/resume + turn/start` 命名为官方 retry API。
- 不在 vNext 引入团队、多机和云端控制面。

## 3. 核心用户流程

### 3.1 启动监听

用户打开应用后，顶部只有两个明确开关：

- `监听 Codex`：关闭时停止 app-server 事件订阅和 rollout watcher；只保留静态页面和最近一次快照。
- `自动重试`：关闭时只告警，不执行动作；打开时必须先选择策略并确认一次。

默认：监听开启，自动重试关闭。

### 3.2 发现容量错误

事件归一化顺序：

1. app-server `error` 通知
2. `turn/completed` / turn history 中的结构化 `codexErrorInfo`
3. rollout JSONL 中的 `codex_error_info`
4. 文本匹配作为最后兜底

若事件包含 `willRetry: true`：

- 状态显示 `Codex 正在重试`
- 倒计时和尝试次数来自事件/turn 事实
- 管理器禁止发起第二个 turn

若事件最终为 `server_overloaded` 且 `willRetry: false`：

- 状态显示 `Codex 内部重试已耗尽`
- 出现一个主卡片：`重试此 turn`
- 用户可以选择只告警、手动重试或开启本线程自动重试

### 3.3 开启自动重试

用户在错误卡片点击 `开启自动重试`，弹出简短设置：

- 作用范围：仅容量错误 / 所有可重试网络错误
- 最大尝试次数：1、3、5
- 退避：15 秒、30 秒、60 秒、指数退避
- 模型策略：保持当前模型 / 选择备用模型
- 线程范围：仅当前线程 / 后续所有线程

确认后，策略写入本地设置并立即作用于当前事件。没有确认，不执行真实请求。

## 4. 重试执行策略

### 4.1 路径 A：Codex 内部重试（首选、零干预）

条件：app-server 已发出 `willRetry: true`。

行为：只监听，不发送 `turn/start`、不发送“继续”、不切模型。Codex 自己负责当前 turn 的重试预算。UI 显示 `Codex 正在重试`。

### 4.2 路径 B：app-server 新 turn（可验证时）

当前协议未提供公开 `turn/retry`。只有在以下条件同时满足时才允许管理器发起新的 turn：

- 管理器持有该 app-server 连接的线程控制权
- 线程不在运行中且没有 writer 冲突
- 最近失败 turn 的原始用户输入可从 app-server history 精确读取
- 已生成新的幂等 `retryAttemptId`
- 用户已开启自动重试或确认了本次手动重试
- UI 显示“这会通过 `thread/resume + turn/start` 创建一个新 turn”

实现上使用 `thread/resume` + `turn/start`，但产品文案必须叫“新 turn 重试”，不能叫“调用 Codex 原生 retry 接口”。

### 4.3 路径 C：桌面 UI 兼容模式

条件：app-server 返回 `active writer`，说明线程由桌面 Codex 持有。

- Windows：已有 `codex://threads/<id>` + SendInput 方案，可进入独立兼容模式。
- macOS：新增 Accessibility 能力探针、前台窗口确认、输入框定位和可回滚测试；默认关闭，用户手动授权后才能启用。

UI 必须明确显示：`桌面 UI 兼容模式，可靠性低于 app-server`。失败不得静默重试。

### 4.4 路径 D：账号限额重置 credit

若 `account/rateLimits/read` 返回可用 `rateLimitResetCredits`，显示独立按钮：`使用一次官方重置额度`。

- 永远需要二次确认
- 调用 `account/rateLimitResetCredit/consume`
- 必须使用幂等 `idempotencyKey`
- 消费前显示 reset 类型、过期时间和剩余次数
- 消费后重新读取 rate limits，不自动发起 turn

这不是容量错误的默认修复，而是用户主动授权的账号动作。

## 5. UI 信息架构

### 顶部控制条

固定显示：

- `监听 Codex` 开关
- `自动重试` 开关
- app-server 状态
- 当前账号脱敏 ID
- 最后同步时间

### 首页只保留四块

1. **当前异常**：错误码、模型、线程、Codex 内部重试状态、主动作
2. **当前任务**：标题、状态、模型、工作目录、最近 turn
3. **账号与用量**：计划、已用百分比、窗口重置时间、usage 来源和采集时间
4. **最近动作**：自动重试、手动重试、切换模型、兼容模式、账号操作

删除首页大段指标解释。解释改为 tooltip、详情抽屉和诊断页。

### 设置页

- 监听开关
- 自动重试开关
- 策略范围、次数和退避
- 模型 fallback 策略
- Windows / macOS UI 兼容模式授权
- 系统通知
- 本地数据与审计保留时间

### 线程详情抽屉

显示一个明确的执行路径卡片：

```text
当前控制权：Codex Desktop / app-server bridge
重试能力：内部 retry / 新 turn / UI 兼容 / 不可用
最近 turn：failed
副作用风险：需要确认
```

## 6. 数据与协议

### 6.1 AppServerClient

必须实现并记录：

- `initialize` / `initialized`
- `thread/list`
- `thread/read`
- `thread/resume`
- `turn/start`
- `turn/steer`（仅在明确的 active turn 场景）
- `model/list`
- `account/rateLimits/read`
- `account/usage/read`
- `account/rateLimitResetCredit/consume`
- `account/rateLimits/updated` 通知
- `error` 通知的 `willRetry`

### 6.2 核心模型

```ts
interface RetryPolicy {
  enabled: boolean;
  scope: 'capacity' | 'transient' | 'all-safe';
  maxAttempts: 1 | 3 | 5;
  backoff: 'fixed-15s' | 'fixed-30s' | 'fixed-60s' | 'exponential';
  modelStrategy: 'same' | 'fallback';
  desktopUiFallback: boolean;
}

interface RetryAttempt {
  id: string;
  threadId: string;
  failedTurnId: string;
  path: 'codex-internal' | 'app-server-new-turn' | 'windows-ui' | 'macos-ui';
  attempt: number;
  startedAt: string;
  result: 'pending' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  errorCode: string | null;
}

interface UsageSnapshot {
  source: 'account/rateLimits/read' | 'account/usage/read' | 'rollout-estimate';
  confidence: 'verified' | 'estimated' | 'unavailable' | 'failed';
  planType: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
  credits: { balance: string | null; hasCredits: boolean | null } | null;
  collectedAt: string;
}
```

### 6.3 状态机

```text
idle
  -> listening
  -> detected
  -> codex_internal_retrying
  -> retry_exhausted
  -> awaiting_user_confirmation
  -> auto_retry_scheduled
  -> executing
  -> succeeded | failed | blocked | cancelled
```

同一 `threadId + failedTurnId + attempt` 只能有一个执行记录。

## 7. Agent 标准目录

下一版开始按职责拆分，不再把 UI、协议、策略和副作用写在一个文件里：

```text
src/
  app/
    bootstrap.ts
    config.ts
  agent/
    contracts/
      retry-policy.ts
      thread-record.ts
      usage-snapshot.ts
      events.ts
    runtime/
      agent-runtime.ts
      action-dispatcher.ts
      idempotency.ts
    policies/
      retry-policy-engine.ts
      ownership-policy.ts
      side-effect-policy.ts
    observers/
      app-server-observer.ts
      rollout-observer.ts
      desktop-observer.ts
    adapters/
      codex-app-server/
        client.ts
        protocol.ts
        capabilities.ts
      desktop-ui/
        windows-adapter.ts
        macos-adapter.ts
        capability-probe.ts
      account/
        rate-limits-provider.ts
        usage-provider.ts
    actions/
      retry-turn.ts
      consume-reset-credit.ts
      switch-account.ts
    state/
      state-store.ts
      event-store.ts
      audit-store.ts
  bridge/
    http-server.ts
    routes/
      health.ts
      threads.ts
      alerts.ts
      account.ts
      settings.ts
  ui/
    shell/
    pages/
    components/
    state/
  platform/
    tauri/
    windows/
    macos/

tests/
  unit/
  contract/
  integration/
  fixtures/

docs/
  PRD-vNext.md
  research/
  architecture/
  adr/
  runbooks/
```

目录规则：协议适配器不能决定产品策略；策略不能直接操作进程或桌面；UI 只能调用 action API；所有真实副作用都必须经过 `ActionDispatcher` 并写审计。

## 8. 分阶段交付

### Phase 0：协议与能力探针

- 生成并锁定本机 app-server schema fixture
- 读取 `account/rateLimits/read` 和 `account/usage/read`
- 记录 `willRetry`、`turn/completed` 和 `active writer`
- 明确每个线程的控制权
- 不做自动动作

### Phase 1：监听控制面

- 开启/关闭监听
- 开启/关闭自动重试设置
- 简化首页
- 告警状态机和审计
- 只展示官方用量

### Phase 2：真实重试引擎

- Codex 内部重试识别
- app-server 新 turn 重试
- 幂等和并发保护
- 重试策略设置与确认
- 自动重试通知

### Phase 3：桌面兼容模式

- Windows 保持现有 keepalive
- macOS Accessibility 能力探针和显式授权
- 桌面 UI 失败回滚与人工接管

### Phase 4：账号与额度动作

- 账号档案
- 官方 rate limit 展示
- usage 趋势
- reset credit 二次确认和审计
- 账号切换后重新验证 app-server

### Phase 5：标准化工程结构与发布

- 按本 PRD 的 Agent 目录拆分
- 单元、协议契约、真实本机集成测试
- Tauri sidecar、签名、notarization、Homebrew Cask

## 9. 验收标准

### 功能

- 用户可以独立开启/关闭监听
- 用户可以独立开启/关闭自动重试
- `willRetry: true` 时不重复发送 turn
- `server_overloaded` 终态出现后，能显示准确执行路径
- 重试策略可配置且动作有幂等记录
- macOS / Windows 分别显示实际可用能力
- 官方 rate limit 和 usage 字段正确展示来源、时间和可信度
- reset credit 只在用户确认后消费

### 可靠性

- 同一失败 turn 不会重复执行
- writer 冲突不会发第二个 writer
- app-server 断开后自动重连并标注数据不完整
- 所有动作可在审计中追溯
- 不展示 token、API key 或原始认证内容

### 可理解性

- 首页不出现大段产品说明
- 用户能在 5 秒内找到监听开关和自动重试开关
- 用户能在 10 秒内判断当前是 Codex 自己重试、管理器重试还是无法重试
- 每个数字旁边都有来源和采集时间
