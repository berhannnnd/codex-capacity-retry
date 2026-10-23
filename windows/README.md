# Windows 环境:容量报错自动恢复(keepalive)

Windows 上 Codex 桌面版对每个打开的会话持有独占写锁(`thread-writer-locks`),
桥接服务默认的 `thread/resume` + `turn/start` 续跑路径对**桌面 App 正打开的线程**
会失败:

```
thread <id> already has an active writer
```

这个目录提供 Windows 的补充路径。它增量监听 `CODEX_HOME/sessions` 下的
rollout JSONL(只读),发现回合以 `Selected model is at capacity`
(`server_overloaded`)结束后,执行**逐级恢复阶梯**,每一步都通过观察
rollout 中出现 `task_started` 来确认生效,未生效才升级到下一步:

1. **导航**:通过 `codex://threads/<id>` 把桌面 App 切到出错会话
   (Retry 卡片需要出现在当前 DOM 中);
2. **目标恢复**:线程设有 goal 且状态为 `blocked` 时,用
   `thread/goal/set` 恢复为 `active`(goal API 走中央存储,**不受 rollout
   写锁限制**),给目标引擎约 12 秒自行接管——引擎级恢复,零上下文开销;
   `paused`/`usage_limited`/`budget_limited`/`complete` 视为用户或引擎意图,不动;
3. **Retry 按钮**:用 UI Automation 直接 Invoke 报错卡片上的 Retry
   (同一 turn 重试,不新增用户消息、不抢焦点;Chromium 的无障碍树默认不开启,
   脚本会短暂打开 `SPI_SETSCREENREADER` 标记让树物化,点完立即还原);
4. **输入兜底**:目标感知的续跑消息(含 objective 摘要)经 SendInput 输入并回车
   (Unicode,不受输入法/键盘布局影响),完成后还原用户原来的前台窗口。

`server/codex-bridge.js` 的 `POST /api/threads/:id/continue` 在 Windows 上遇到
`active writer` 错误时,会降级到输入注入链路(复用 `send_keys.ps1`),
控制台里的"继续"按钮在 Windows 桌面会话上同样可用。

## 使用

双击(或命令行运行):

```bat
windows\keepalive\start_keepalive.cmd   :: 后台启动监控(无窗口)
windows\keepalive\stop_keepalive.cmd    :: 停止
```

或在仓库根目录前台运行(方便观察,Node 18+,与项目其他部分同一运行时):

```bat
npm run keepalive -- --dry-run
node windows\keepalive\keepalive.js --dry-run
```

参数:

| 参数 | 默认 | 说明 |
|---|---|---|
| `--message` | `继续当前任务,从中断处继续…` | 无 goal 时的兜底消息文本 |
| `--initial-delay` | 8 秒 | 报错后等多久开始第一次恢复 |
| `--max-attempts` | 8 | 同一会话连续自动恢复上限,超过则放弃 |
| `--poll` | 3 秒 | rollout 轮询间隔 |
| `--no-goal-restore` | - | 关闭 goal 恢复阶梯(第 2 步) |
| `--no-retry-click` | - | 关闭 Retry 按钮点击(第 3 步) |
| `--dry-run` | 关 | 只检测和记日志,不执行恢复 |
| `--scan` | - | 打印最近 24h 落盘的容量报错并退出 |

日志:`keepalive.log`(JSONL,每次检测/取消/恢复/升级都有记录,
`recover_done` 的 `mode` 字标明本次生效的阶梯层级:
`goal-restore` / `retry-button` / `typed`)。

## 安全机制

- 只处理监控启动**之后**发生的报错,不翻旧账
- 退避重试 8s→12s→18s→27s→40s→60s(封顶),回合成功后计数清零
- 报错后用户自己发了消息(`task_started`)或手动停止(`turn_aborted`)时自动取消
- goal 只自动恢复 `blocked`;暂停、用量、预算类状态是用户决策,保持不动
- 单实例文件锁
- 阶梯 1~3 不触碰输入框;只有最终兜底(第 4 步)会把 Codex 窗口短暂调到前台
  (约 1~2 秒)再还原。若恰好在 Codex 输入框里手动打字,兜底消息会拼进草稿
  ——可调大 `--initial-delay` 或用 `--dry-run`

## 文件

- `keepalive.js` — 监控主程序(Node 18+,纯标准库,ESM)
- `send_keys.ps1` — 窗口激活 + Unicode 按键注入(桥接服务降级路径也复用它)
- `click_retry.ps1` — UIA 点击 Retry 按钮(含 a11y 树开关与还原)
- `start_keepalive.cmd` / `stop_keepalive.cmd` — 后台启停

## 已验证行为(Codex desktop 0.163 / Windows 11)

- `codex://threads/<id>` 可将桌面 App 导航到指定会话(含多会话并行时)
- SendInput 可向输入框注入中文并回车发送;`Ctrl+A`/`Del` 可清理草稿
- 桌面 App 持锁线程上,第二个 `codex app-server` 实例 `thread/resume` 稳定复现
  `already has an active writer`(这正是本目录存在的原因)
- `thread/goal/get` / `thread/goal/set` 不受写锁限制,可从第二个实例读写
  goal(实测 blocked 目标可恢复;goal 状态也可能被引擎自行恢复,如流重连后)
- `SPI_SETSCREENREADER` 短暂置位后,Electron 渲染层 UIA 树物化(72+ 控件,
  含 Retry、目标卡片操作),可 Invoke;还原标志位后不影响系统
- 状态机(检测→退避→取消→恢复重置)经模拟事件流回归,检测逻辑对真实
  rollout 全量扫描比对通过;首晚生产运行中自动续跑 3 次、让位用户 3 次、
  线程最终恢复
