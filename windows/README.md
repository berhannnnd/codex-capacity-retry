# Windows 环境:容量报错自动续跑(keepalive)

Windows 上 Codex 桌面版对每个打开的会话持有独占写锁(`thread-writer-locks`),
桥接服务默认的 `thread/resume` + `turn/start` 续跑路径对**桌面 App 正打开的线程**
会失败:

```
thread <id> already has an active writer
```

这个目录提供 Windows 的补充路径,不经过 app-server,而是:

1. 增量监听 `CODEX_HOME/sessions` 下的 rollout JSONL(只读);
2. 发现回合以 `Selected model is at capacity`(`server_overloaded`)结束时,
   通过 `codex://threads/<id>` URL scheme 把桌面 App 导航到该会话;
3. 激活窗口,用 SendInput(Unicode,不受输入法/键盘布局影响)输入一条"继续"并回车;
4. 还原用户原来的前台窗口。

`server/codex-bridge.js` 的 `POST /api/threads/:id/continue` 在 Windows 上遇到
`active writer` 错误时,也会自动降级到同一条注入链路(复用 `send_keys.ps1`),
所以控制台里的"继续"按钮在 Windows 桌面会话上同样可用。

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
| `--message` | `继续` | 自动发送的文本 |
| `--initial-delay` | 8 秒 | 报错后等多久发第一次"继续" |
| `--max-attempts` | 8 | 同一会话连续自动续跑上限,超过则放弃 |
| `--poll` | 3 秒 | rollout 轮询间隔 |
| `--dry-run` | 关 | 只检测和记日志,不真正输入 |
| `--scan` | - | 打印最近 24h 落盘的容量报错并退出 |

日志:`keepalive.log`(JSONL,每次检测/取消/注入都有记录)。

## 安全机制

- 只处理监控启动**之后**发生的报错,不翻旧账
- 退避重试 8s→12s→18s→27s→40s→60s(封顶),回合成功后计数清零
- 报错后用户自己发了消息(`task_started`)或手动停止(`turn_aborted`)时自动取消
- 单实例文件锁
- 注入会把 Codex 窗口短暂(约 1~2 秒)调到前台再还原;若恰好在 Codex
  输入框里手动打字,自动内容会拼进草稿——可调大 `--initial-delay` 或用 `--dry-run`

## 文件

- `keepalive.js` — 监控主程序(Node 18+,纯标准库,ESM)
- `send_keys.ps1` — 窗口激活 + Unicode 按键注入(桥接服务降级路径也复用它)
- `start_keepalive.cmd` / `stop_keepalive.cmd` — 后台启停

## 已验证行为(Codex desktop 0.163 / Windows 11)

- `codex://threads/<id>` 可将桌面 App 导航到指定会话(含多会话并行时)
- SendInput 可向输入框注入中文并回车发送;`Ctrl+A`/`Del` 可清理草稿
- 桌面 App 持锁线程上,第二个 `codex app-server` 实例 `thread/resume` 稳定复现
  `already has an active writer`(这正是本目录存在的原因)
- 状态机(检测→退避→取消→恢复重置)经模拟事件流回归,检测逻辑对真实
  rollout 全量扫描比对通过
