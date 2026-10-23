# Codex 任务管家

> 把 Codex 的线程、容量错误和恢复动作，放进一个看得懂的本地控制台。

Codex 任务管家是一个面向个人开发者的本机管理后台。它连接当前电脑上的 `codex app-server`，读取真实线程和 rollout 记录，用一个深色、概览优先的界面告诉你：哪个任务正在运行、哪里发生了容量错误、当前账号是谁、模型是否真的可用，以及下一步可以安全做什么。

它不是一个伪造额度的监控面板，也不会未经确认重放原始请求。每个指标都会标明来源；当前接口没有提供的剩余用量，会明确显示为“当前接口未提供”。

## 30 秒启动

需要：Node.js 18+、已安装 Codex CLI，并且本机已经完成 Codex 登录。

```bash
git clone https://github.com/berhannnnd/codex-capacity-retry.git
cd codex-capacity-retry
npm install
npm run live
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，就能看到本机的真实数据。

`npm run live` 会同时启动管理后台和本地 bridge：

- 管理后台：`127.0.0.1:5173`
- 本地控制层：`127.0.0.1:8787`
- Codex app-server：由 bridge 启动和管理
- rollout watcher：扫描 `~/.codex/sessions` 与归档目录

如果页面显示 `Disconnected`，先确认 `codex` 命令可用，并单独运行：

```bash
codex login
```

## 你能看到什么

### 总览 Dashboard

10 秒判断有没有任务需要处理：

- Codex 服务和 app-server 是否 Running
- 当前线程、Thread ID、工作目录和模型
- 今日容量错误、严重告警和失败 turn
- 当前账号和认证方式
- 用量是否已验证、估算或暂不可读取
- 最近的容量错误、断联、登录过期和恢复事件

### Threads / 线程

查看本机线程列表，按标题、Thread ID、工作目录和状态查找任务。打开详情抽屉后，可以看到最近错误、模型、Provider、rollout 来源和恢复动作。

### Alerts / 告警

告警优先使用结构化错误码，并将同一线程的同类错误归并计数：

- `Critical`：认证失效、状态冲突、数据损坏
- `Error`：容量错误、`server_overloaded`、turn failed
- `Warning`：连接不稳定、连续重试、模型不可用
- `Info`：线程恢复、账号刷新、模型切换

### Account / 用量

只显示脱敏账号 ID、登录方式和刷新时间，不展示 access token、refresh token 或 API key。用量卡片会区分：

- 已验证
- 估算
- 当前接口未提供
- 采集失败

### Models / Providers

区分“目录存在”“配置存在”“曾经成功请求”和“当前请求失败”。模型出现在目录里，不代表它现在一定能继续当前线程。

## 真实恢复动作

恢复动作默认需要用户确认，并且会先检查：

1. Thread ID 是否仍然有效
2. 线程是否已经在运行
3. 是否存在 writer 冲突
4. 最近一次失败状态
5. action ID 是否重复

确认后才会执行 `thread/resume` 和 `turn/start`，并将结果写入本地操作审计。默认发送的是“从最新检查点继续”的新 turn，不会自动重放原始用户请求。

支持的动作：

- 继续当前工作
- 换模型继续
- 稍后再试
- 标记为人工处理

## Windows：监控桌面 Codex 并自动恢复

Windows Codex 桌面版会给已打开的线程持有独占 writer。此时第二个 app-server 无法直接写入同一线程，项目提供了逐级恢复阶梯（每一步都通过观察 rollout 出现 `task_started` 确认生效，未生效才升级）：

1. 监听 rollout JSONL，发现容量错误后定位 Thread ID
2. 通过 `codex://threads/<id>` 打开原线程
3. 线程设有 goal 且被容量错误置为 `blocked` 时，用 `thread/goal/set` 恢复目标（goal API 不受 rollout 写锁限制），等待目标引擎自行接管——零上下文开销
4. 用 UI Automation 点击报错卡片上的 Retry 按钮（同 turn 重试，不新增消息、不抢焦点）
5. 兜底：SendInput 输入目标感知的续跑消息并回车，尽量恢复用户原来的前台窗口

goal 只自动恢复 `blocked`；`paused`/用量/预算类状态视为用户决策保持不动。

启动持续监控：

```bat
windows\keepalive\start_keepalive.cmd
```

开发调试：

```bash
npm run keepalive -- --dry-run
```

只扫描最近 24 小时的容量错误：

```bash
node windows/keepalive/keepalive.js --scan
```

控制台的“继续”按钮遇到 `active writer` 时，也会自动尝试这条路径。监控只读 rollout 文件，带有退避、次数限制、用户输入取消和单实例锁。

## macOS 原生窗口

项目包含 Tauri 2 原生壳。开发模式：

```bash
# 终端 1：启动 bridge
npm run bridge

# 终端 2：启动 Tauri 窗口
npm run tauri:dev
```

也可以直接构建 debug 包：

```bash
npm run tauri:build -- --debug
```

当前原生包已经可以生成 `.app` 和 `.dmg`。生产分发还需要将 bridge 和 Node runtime 作为 sidecar，并完成 macOS 签名、notarization 和 Homebrew Cask 发布。

## Homebrew（内部试用）

```bash
brew install --HEAD https://raw.githubusercontent.com/berhannnnd/codex-capacity-retry/main/Formula/codex-capacity-retry.rb
codex-capacity-retry
```

当前 Homebrew 路径适合内部试用，会启动本地 bridge 和管理后台，并在 macOS 上打开浏览器。正式发布版本会补充签名、自动更新和卸载数据保留策略。

## API 与数据边界

本地 bridge 默认监听 `127.0.0.1:8787`，常用接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | app-server、平台和监听状态 |
| `GET /api/threads` | 读取真实线程 |
| `GET /api/threads/:id/read` | 读取线程详情 |
| `GET /api/alerts` | 读取归并后的结构化告警 |
| `GET /api/incidents` | 读取 rollout 原始事件 |
| `GET /api/models` | 读取模型目录 |
| `GET /api/account` | 读取脱敏账号信息 |
| `GET /api/audit` | 读取本次运行的操作审计 |
| `POST /api/threads/:id/continue` | 确认后恢复线程 |

监听覆盖已启动的 app-server 事件、已落盘的桌面 rollout、归档 rollout 和手动恢复动作。尚未落盘的瞬时 UI 状态、未写入 rollout 的网络错误，以及没有经过本 bridge 启动的外部客户端，无法保证被捕获；此时界面会标记数据可能不完整。

## 本地验证

```bash
npm test
npm run build
node --check server/codex-bridge.js
```

项目不会上传 Codex 线程、rollout 或凭据。文件监听只读；账号信息只展示脱敏 ID。

## 项目状态

当前版本已经具备真实本机监听、告警归并、账号读取、恢复审计、Windows 桌面续跑和 Tauri debug 构建能力。剩余用量适配器、系统通知、打包 sidecar、签名 notarization 和正式 Homebrew Cask 属于后续发布门禁。

欢迎提交 Issue，尤其是：新的 Codex app-server 错误码、不同版本 rollout 格式，以及 Windows 桌面注入兼容性问题。
