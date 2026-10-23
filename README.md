# Codex 任务管家

一个面向个人开发者的本机 Codex 管理后台：统一查看线程、容量告警、账号状态、模型目录和需要确认的恢复动作。当前实现是真实 app-server + rollout 监听，Tauri 2 原生壳用于 macOS 开发和后续分发。

它展示真实线程、provider/model、容量告警、账号与用量可信度、事件日志，并提供需要确认的继续当前工作和换模型动作。模拟重试状态机仍保留在 `src/engine.js` 作为单元测试和退避策略基础。

## 运行

```bash
npm install
npm run live
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
- `POST /api/threads/:id/continue`：通过 `thread/resume` + `turn/start` 继续指定线程
- `GET /api/models`：读取 app-server 模型目录

前端通过 `npm run live` 与桥接服务一起启动；页面会显示连接状态，并把线程、告警和恢复动作发给真实 app-server。桥接不可用时，界面明确显示 Disconnected，不伪造实时数据。

监听覆盖范围：正在运行的 app-server 事件、已落盘的桌面 Codex rollout、归档 rollout、线程列表和手动恢复动作。桌面 UI 中尚未落盘的瞬时渲染状态、网络层内部未写入 rollout 的错误，以及没有经过此桥接启动的外部客户端，无法保证被捕获。文件扫描只读，不修改 Codex 数据。

如果打开 `http://127.0.0.1:8787`，这里是桥接服务的 API 根地址，不是网页；现在会返回可用接口和控制台地址。控制台在 `http://127.0.0.1:5173`。也可以尝试一键启动：

```bash
npm run live
```


## Tauri 原生开发

```bash
npm run tauri:dev
```

Tauri 窗口加载 Vite 页面。开发阶段仍需要单独运行 `npm run bridge`；正式包需要将 bridge 与 Node runtime 作为 sidecar 打包，当前未把未签名构建描述成正式发布版本。

## Windows 桌面线程续跑

Windows Codex 桌面版会给已打开的线程持有独占 writer。`windows/keepalive/` 提供真实 rollout 监听和桌面注入兜底：检测到容量错误后通过 `codex://threads/<id>` 导航到原线程，再用 `SendInput` 发送“继续”，并尽量恢复用户原来的前台窗口。桥接的 `POST /api/threads/:id/continue` 遇到 `active writer` 时也会自动走这条路径。

```bat
windows\keepalive\start_keepalive.cmd
```

开发调试可以运行 `npm run keepalive -- --dry-run`；只扫描最近 24 小时落盘错误而不常驻运行，可以运行 `node windows/keepalive/keepalive.js --scan`。该路径只读 rollout 文件，自动动作仍受退避次数、用户输入和单实例锁保护。

## Homebrew 安装

当前 formula 使用 GitHub main 分支，适合内部试用：

```bash
brew install --HEAD https://raw.githubusercontent.com/berhannnnd/codex-capacity-retry/main/Formula/codex-capacity-retry.rb
codex-capacity-retry
```

它会启动本地桥接服务和管理后台，并在 macOS 上自动打开浏览器。
