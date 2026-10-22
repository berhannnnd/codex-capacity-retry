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
