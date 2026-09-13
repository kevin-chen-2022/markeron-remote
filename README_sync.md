# MarkerOn 手机遥控桌面标注（方案 B：手机端镜像绘制）

> 教师在教室自由走动时，用手机触摸屏幕实时操控教室电脑做标注。
> 手机端不是"演示遥控器"——它直接**镜像桌面端画布**并在手机上落笔。

## 架构

```
┌──────────────────────────────────────────────────────┐
│ 桌面端（Tauri 进程）                                  │
│  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ useDrawing   │◄─┤ sync_server (tokio-tungstenite) │  │
│  │ (状态权威)   │  │ 0.0.0.0:<随机端口> 透传广播   │  │
│  └──────┬───────┘  └──────────────┬───────────────┘  │
│         │ snapshot / action-add     │ ws://<局域IP>:<port>
│         │ pointer / tool-state      │
│         ▼                          ▼
│   DrawingOverlay.vue         ┌─────────────────────┐  │
│   (startDraw/draw/endDraw)   │ MobileApp.vue       │  │
│                              │  + MobileMirror.vue │  │
│                              │  (触摸→桌面坐标)    │  │
│                              └─────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- **桌面端是状态权威**：所有 useDrawing 的标注 history / undo / redo 都在桌面端。
- **手机端是绘制入口 + 镜像**：触摸坐标映射到桌面坐标系，经 WS 转发到桌面端落笔；
  桌面端 history 变更后回送 snapshot，手机端 `applyHistorySnapshot` 重放显示。
- **传输层抽象**：`SyncTransport` 接口隔离"如何传输"。骨架阶段用裸 WS + 全量 snapshot；
  后续若需解决晚加入 / 断线重连的边缘冲突，把 `createWebSocketTransport` 换成
  `y-websocket provider` 即可，业务层无感知。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/composables/syncTransport.ts` | `SyncTransport` 接口 + WebSocket 实现（自动重连、消息收发） |
| `src/composables/useSyncDrawing.ts` | 桥接 `useDrawing` 与 `SyncTransport`：本地变更推送、远端重放、握手 |
| `src/composables/useDrawing.ts` | 增量导出 `getHistorySnapshot / applyHistorySnapshot / subscribeHistoryChange` |
| `src-tauri/src/sync_server.rs` | Tauri 命令 `start_sync_server` / `stop_sync_server`，tokio + tungstenite 广播 |
| `src/components/MobileMirror.vue` | 手机端画布组件：等比缩放渲染 + 触摸→桌面坐标映射 |
| `src/mobile/MobileApp.vue` | 手机端主组件：连接状态、工具条、镜像区域 |
| `index-mobile.html` | 手机端入口 HTML |
| `vite.config.ts` | 双入口构建：`main`(桌面) + `mobile`(手机) |
| `src-tauri/tauri.conf.json` | CSP 允许 `ws://*:*` / `wss://*:*` |

## 使用流程（骨架阶段）

### 桌面端

1. 启动 MarkerOn（开发：`npm run tauri dev`）。
2. DrawingOverlay 挂载时自动调用 `useSyncDrawing`，内部 `invoke('start_sync_server')`
   在 Tauri 进程内起一个 WS 广播服务（系统分配端口）。
3. 控制台会打印 `ws_url`（如 `ws://0.0.0.0:51234`）。
   骨架阶段教师把这台电脑的局域网 IP + 端口告诉手机端（或后续做二维码扫码）。

### 手机端

1. 开发模式：`npm run dev:fe` 起 Vite，访问 `http://<电脑IP>:1420/index-mobile.html?ws=ws://<电脑IP>:<端口>`。
2. 手机页面挂载 `MobileApp`，从 URL 取 `?ws=` 参数连 WS。
3. 连接成功后显示镜像画布，可触摸绘制。

### 打包

- **桌面端**：`npm run tauri build`（产物：可执行文件 + NSIS 安装包）。
- **手机端**：Capacitor 打包（`capacitor.config.json` 已配置）：
  ```
  npm run build:fe              # 输出到 dist/
  npx cap add android ios       # 首次
  npx cap copy                  # 拷贝 dist 到原生工程
  npx cap open android          # Android Studio 打包
  npx cap open ios              # Xcode 打包
  ```
  > 注意：`capacitor.config.json` 的 `webDir` 指向 `../dist-mobile`，
  > 打包前需把 `index-mobile.html` 与其依赖构建到该目录（或调整 `webDir` 到 `../dist`
  > 并让手机端单独发布 `index-mobile.html`）。

## 协议（骨架阶段）

```ts
type SyncMessage =
  | { type: 'hello'; role: 'desktop' | 'mobile' }
  | { type: 'welcome'; desktopSize: { w: number; h: number } }
  | { type: 'tool-state'; state: ToolStateSync }
  | { type: 'snapshot'; actions: DrawAction[] }
  | { type: 'action-add'; action: DrawAction }
  | { type: 'action-remove'; index: number }
  | { type: 'clear' }
  | { type: 'pointer'; x: number; y: number; phase: 'down' | 'move' | 'up' }
  | { type: 'ping' } | { type: 'pong' }
```

服务端**不解析语义**，只做透传广播（除自己以外的所有 peer）。所以协议升级只改客户端。

## 已知限制（TODO）

1. **晚加入握手竞态**：手机端连入后桌面端回送 snapshot；若此刻桌面端正在画笔中，
   手机端可能先收到不完整的 snapshot 后收到中间 pointer 事件导致笔迹断裂。
   → 长期方案：换 Yjs CRDT，连续状态自动合并。

2. **全量快照数据量**：长会话 + 大量笔迹时每次变更都推全量 snapshot。
   → 短期：用 `action-add` / `action-remove` 增量；长期：Yjs。

3. **工具状态同步不完整**：仅 `currentTool` / `currentColor` 跟随，`lineWidth` 未同步。
   → 需要扩 `pushToolState` 触发时机（用户在桌面端改 lineWidth 时也推送）。

4. **撤销 / 清空未跨端**：手机端"撤销 / 清空"按钮暂未连实际命令。
   → 协议已预留 `clear` / `action-remove`，需在桌面端 useDrawing 增加专门事件类型。

5. **二维码扫码**：骨架阶段手机端 URL 由用户手动输入；正式版应在桌面端
   生成 `http://<IP>:1420/index-mobile.html?ws=ws://<IP>:<port>` 二维码。

6. **CSP 宽松**：`tauri.conf.json` 的 `connect-src` 允许任意 `ws://*:*`。
   正式版应限定为局域网网段（如 `ws://192.168.*:*`）。

7. **Capacitor 入口隔离**：当前 `vite.config.ts` 双入口共用 `dist/`，
   Capacitor `webDir` 仍需手动调整或为手机端单独构建。
