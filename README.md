# Capacity Retry Console

一个本地运行的小型可视化控制台，用于处理 Codex/Agent 任务遇到 `Selected model is at capacity. Please try a different model` 时的恢复决策。

它展示当前任务、provider/model、重试次数、指数退避倒计时、事件日志，并提供三个动作：重试当前任务、从检查点继续新会话、切换到备用模型。默认使用模拟适配器，动作只更新本地界面和日志，不会伪装成已经控制了真实 Codex 桌面或 API。

## 运行

```bash
npm install
npm run dev
```

然后打开终端输出的本地地址（默认 `http://127.0.0.1:5173`）。生产构建：

```bash
npm run build
npm run preview
```

## 验证

```bash
npm test
npm run build
```

浏览器级验证可使用 Playwright（需要本机已有 Chromium/Chrome）：

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
python3 /Users/berhand/.codex/skills/webapp-testing/scripts/with_server.py \
  --server "npm run dev -- --port 4173" --port 4173 -- \
  .venv/bin/python path/to/check_retry_console.py
```

## 结构与边界

- `src/engine.js`：与 UI 无关的重试状态机、指数退避和倒计时格式化。
- `src/adapters.js`：`TaskAdapter` 抽象和 `SimulatedTaskAdapter`。真实 Codex API、桌面控制、权限、会话接管能力需要在这里实现并单独验证。
- `src/main.js`：模拟任务数据、页面渲染、动作编排和事件日志。
- `src/style.css`：深色控制室视觉样式与移动端布局。
- `test/engine.test.js`：退避上限、状态转移和时间格式测试。

### 接入真实运行时的建议顺序

1. 为目标运行时实现 `TaskAdapter`，先只读获取任务、模型和 checkpoint 信息。
2. 为 `retry`、`continueInNewSession`、`switchModel` 增加明确的能力探测和失败类型映射。
3. 保留 provider 返回的原始错误、request id、会话 id 和权限结果，写入事件日志。
4. 仅在真实控制链路通过独立验证后，把模拟适配器替换为真实适配器。

## 当前限制

本版本没有调用 Codex API、没有操作桌面窗口、没有自动创建或接管真实会话。它是可运行的本地控制台和接入骨架，便于先把重试策略和用户决策可视化。

## 真实监听模式

本机已有 Codex CLI 时，可以启动真实桥接服务：

```bash
npm run bridge
```

桥接服务默认监听 `127.0.0.1:8787`，使用当前用户的 `codex app-server` 和登录态，不读取或打印 OAuth token。它提供：

- `GET /api/threads`：通过 app-server `thread/list` 读取真实线程
- `GET /api/incidents`：扫描 `CODEX_HOME/sessions` 和 `archived_sessions` 的 JSONL，识别容量错误、`server_overloaded`、失败 turn
- `GET /api/threads/:id/read`：读取线程元数据
- `POST /api/threads/:id/continue`：通过 `thread/resume` + `turn/start` 继续指定线程；Windows 上线程被桌面 App 持锁时自动降级为桌面 UI 注入（见下）
- `GET /api/models`：读取 app-server 模型目录

前端仍用 `npm run dev` 启动；如果 8787 可用，页面会显示 `Live app-server` 并把动作发给真实线程，否则保持模拟模式。

监听覆盖范围：正在运行的 app-server 事件、已落盘的桌面 Codex rollout、归档 rollout、线程列表和手动恢复动作。桌面 UI 中尚未落盘的瞬时渲染状态、网络层内部未写入 rollout 的错误，以及没有经过此桥接启动的外部客户端，无法保证被捕获。文件扫描只读，不修改 Codex 数据。

如果打开 `http://127.0.0.1:8787`，这里是桥接服务的 API 根地址，不是网页；现在会返回可用接口和控制台地址。控制台在 `http://127.0.0.1:5173`。也可以尝试一键启动：

```bash
npm run live
```


## Windows 环境

Windows 上 Codex 桌面版对每个打开的会话持有独占写锁，桥接服务自起的第二个
app-server 实例对这类线程执行 `thread/resume` 会得到
`thread <id> already has an active writer`。`windows/` 目录提供对应的补充路径：

- **自动续跑守护**：`windows/keepalive/` 监听 rollout 文件，发现容量报错后通过
  `codex://threads/<id>` 把桌面 App 导航到出错会话，用 SendInput 输入"继续"并还原焦点。
  双击 `start_keepalive.cmd` 启动，`stop_keepalive.cmd` 停止。
- **桥接降级**：Windows 上 `POST /api/threads/:id/continue` 遇到 `active writer`
  错误时自动改走同一条 UI 注入链路（复用 `send_keys.ps1`），控制台的"继续"按钮
  在桌面会话上同样生效；`GET /api/health` 返回 `windowsUiFallback: true` 表示可用。

详见 `windows/README.md`。

## Homebrew 安装

当前 formula 使用 GitHub main 分支，适合内部试用：

```bash
brew install --HEAD https://raw.githubusercontent.com/berhannnnd/codex-capacity-retry/main/Formula/codex-capacity-retry.rb
codex-capacity-retry
```

它会启动本地桥接服务和管理后台，并在 macOS 上自动打开浏览器。
