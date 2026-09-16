import { onUnmounted, shallowRef, type Ref } from 'vue'
import {
  createWebSocketTransport,
  type SyncMessage,
  type SyncTransport,
  type SyncConnectionState,
  type ToolStateSync,
} from './syncTransport'
import type { DrawAction } from './drawingTypes'

/**
 * 注意：故意不静态 import `@tauri-apps/api/core`。
 * 手机端（Capacitor）打包时 Tauri 模块不存在，静态 import 会导致构建失败 /
 * 运行时找不到模块。这里改用动态 import，仅在桌面端 isDesktop=true 时调用。
 */

/**
 * 把 useDrawing 的标注状态桥接到 SyncTransport，让桌面端与手机端镜像。
 *
 * 双向同步：
 *   本地 mutation → markHistoryStacksChanged → 全量 snapshot 推送（骨架阶段简单稳妥）
 *   远端 snapshot / action-add / clear → 调 useDrawing 的 applyHistorySnapshot 等入口重放
 *
 * 防回环：远端重放触发的本地 change 不再回推（isApplyingRemote 标志）。
 *
 * 晚加入握手（已修复竞态）：
 *   1. 手机端连接后发 hello（携带 requestId）
 *   2. 桌面端收到 hello → 回送 snapshot（携带相同 requestId）+ welcome
 *   3. 手机端收到匹配 requestId 的 snapshot → hasInitialState=true，开始接受后续更新
 *   4. 初始状态到达前，手机端丢弃非握手响应的 snapshot（避免应用过期状态）
 *   5. 3 秒超时未收到响应 → 重发 hello（最多 3 次）
 *   6. 断线重连时自动重置 hasInitialState，重新走握手流程
 *
 * 局限（后续用 Yjs CRDT 一次性解决）：
 *   - 全量快照数据量随画笔数线性增长，不适合长会话高频笔迹。
 *   - 增量 action-add 已预留协议位，当前简化为"每次本地变更都发 snapshot"。
 */
export interface UseSyncDrawingOptions {
  /** 桌面端的画布逻辑尺寸（CSS 像素），用于手机端坐标映射 */
  desktopSize: Ref<{ w: number; h: number }>
  /** 是否为桌面端（true：作为快照提供者并起 sidecar；false：作为消费者） */
  isDesktop: boolean
}

export interface SyncDrawingHandle {
  /** 当前连接状态 */
  connectionState: Ref<SyncConnectionState>
  /** 是否已收到桌面端初始状态快照（晚加入握手完成标志） */
  hasInitialState: Ref<boolean>
  /** 同步通道就绪后，桌面端会暴露的画布尺寸（手机端用来计算坐标映射） */
  remoteDesktopSize: Ref<{ w: number; h: number } | null>
  /** 桌面端：启动 sync_server 后的连接信息（ws_url / lan_ip / port）；手机端为 null */
  serverInfo: Ref<{ wsUrl: string; lanIp: string; port: number } | null>
  /** 推送当前工具元状态到对端 */
  pushToolState(state: ToolStateSync): void
  /** 推送指针位置（手机触摸时把坐标发给桌面，便于在桌面端做"指针预览"） */
  pushPointer(x: number, y: number, phase: 'down' | 'move' | 'up'): void
  /** 请求桌面端撤销（手机端按钮触发，桌面端执行后回送 snapshot） */
  pushUndo(): void
  /** 请求桌面端重做 */
  pushRedo(): void
  /** 请求桌面端清空 */
  pushClear(): void
  /** 请求桌面端切换标注模式（开/关标注） */
  pushToggleDrawing(): void
  /** 请求桌面端切换穿透模式 */
  pushTogglePenetration(): void
  /** 请求桌面端切换白板模式 */
  pushToggleWhiteboard(): void
  /** 手机端：请求桌面端截取屏幕 */
  pushCaptureScreen(): void
  /** 桌面端：推送截图数据回手机端 */
  pushScreenShot(dataUrl: string): void
  /** 手机端：注册截图数据回调（桌面端截屏后回送） */
  onScreenShot(cb: (dataUrl: string) => void): () => void
  /** 注册远端指针事件回调（桌面端用来显示手机指针） */
  onRemotePointer(cb: (x: number, y: number, phase: 'down' | 'move' | 'up') => void): () => void
  /** 注册远端工具状态回调 */
  onRemoteToolState(cb: (state: ToolStateSync) => void): () => void
  /** 注册远端撤销/重做/清空意图回调（桌面端执行对应操作） */
  onRemoteIntent(cb: (intent: 'undo' | 'redo' | 'clear') => void): () => void
  /** 注册远端命令回调（toggle-drawing / toggle-penetration / toggle-whiteboard / capture-screen，桌面端执行） */
  onRemoteCommand(cb: (cmd: 'toggle-drawing' | 'toggle-penetration' | 'toggle-whiteboard' | 'capture-screen') => void): () => void
  /** 主动断开 */
  disconnect(): void
}

/**
 * 在桌面端启动同步服务并返回连接信息（wsUrl + 端口）。
 * 桌面端在 Tauri 进程内通过 sidecar 起一个 WebSocket 服务，手机端连入。
 *
 * 动态 import `@tauri-apps/api/core`：手机端构建产物中没有这个模块，
 * 静态 import 会让 Capacitor 打包失败；只在桌面端运行时才 require。
 */
async function startDesktopServer(): Promise<{ wsUrl: string; lanIp: string; port: number } | null> {
  try {
    const tauriCore = await import('@tauri-apps/api/core')
    const info = await tauriCore.invoke<{
      port: number
      ws_url: string
      lan_ip: string
      addr: string
    } | null>('start_sync_server')
    if (!info) return null
    return { wsUrl: info.ws_url, lanIp: info.lan_ip, port: info.port }
  } catch (e) {
    console.error('[useSyncDrawing] start_sync_server failed', e)
    return null
  }
}

/**
 * 给定 useDrawing 实例（已包含出口 getHistorySnapshot/applyHistorySnapshot/subscribeHistoryChange），
 * 把它接入同步传输层。
 */
export function useSyncDrawing(
  drawingApi: {
    getHistorySnapshot: () => DrawAction[]
    applyHistorySnapshot: (snapshot: DrawAction[]) => void
    subscribeHistoryChange: (cb: () => void) => () => void
    /** 当前是否正在本地绘制（乐观渲染中）。手机端正在画时跳过远端 snapshot 应用，避免打断 */
    isDrawing?: () => boolean
  },
  options: UseSyncDrawingOptions,
): SyncDrawingHandle {
  const connectionState = shallowRef<SyncConnectionState>('idle')
  const hasInitialState = shallowRef(false)
  const remoteDesktopSize = shallowRef<{ w: number; h: number } | null>(null)
  const serverInfo = shallowRef<{ wsUrl: string; lanIp: string; port: number } | null>(null)
  let transport: SyncTransport | null = null
  let isApplyingRemote = false
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  let pendingRequestId: string | null = null
  let helloTimeout: ReturnType<typeof setTimeout> | null = null
  let helloRetryCount = 0
  const pointerSubs = new Set<(x: number, y: number, phase: 'down' | 'move' | 'up') => void>()
  const toolStateSubs = new Set<(state: ToolStateSync) => void>()
  const intentSubs = new Set<(intent: 'undo' | 'redo' | 'clear') => void>()
  const commandSubs = new Set<(cmd: 'toggle-drawing' | 'toggle-penetration' | 'toggle-whiteboard' | 'capture-screen') => void>()
  const screenShotSubs = new Set<(dataUrl: string) => void>()

  /** 生成唯一请求 ID */
  function genRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 手机端：发送 hello（携带 requestId），启动超时重试。
   * 桌面端收到后回送带相同 requestId 的 snapshot，手机端据此标记 hasInitialState=true。
   * 超时 3s 未收到响应则重发，最多重试 3 次。
   */
  function sendHello() {
    if (!transport || !transport.ready) return
    pendingRequestId = genRequestId()
    helloRetryCount = 0
    void transport.send({
      type: 'hello',
      role: options.isDesktop ? 'desktop' : 'mobile',
      requestId: pendingRequestId,
    })
    startHelloTimeout()
  }

  function startHelloTimeout() {
    if (helloTimeout !== null) clearTimeout(helloTimeout)
    helloTimeout = setTimeout(() => {
      helloTimeout = null
      if (hasInitialState.value) return
      if (helloRetryCount >= 3) {
        console.warn('[useSyncDrawing] hello retry limit reached, giving up')
        return
      }
      helloRetryCount++
      console.warn(`[useSyncDrawing] hello response timeout, retry ${helloRetryCount}/3`)
      pendingRequestId = genRequestId()
      void transport?.send({
        type: 'hello',
        role: options.isDesktop ? 'desktop' : 'mobile',
        requestId: pendingRequestId,
      })
      startHelloTimeout()
    }, 3000)
  }

  function clearHelloTimeout() {
    if (helloTimeout !== null) {
      clearTimeout(helloTimeout)
      helloTimeout = null
    }
  }

  /** 节流推送快照（避免高频笔迹期间每帧都发全量 JSON） */
  function scheduleSnapshotPush() {
    // 只有桌面端（权威方）才 push snapshot
    // 手机端乐观渲染的 historyChange 不应回传给桌面端（否则桌面端 applyHistorySnapshot 会清空 undoStack）
    if (!options.isDesktop) return
    if (isApplyingRemote) return
    if (snapshotTimer !== null) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      void pushSnapshot()
    }, 150)
  }

  /**
   * 命令消息带重试：WS 广播 channel 在洪峰时可能丢弃消息（Lagged），
   * 命令（标注/穿透/白板）丢失后用户无反馈。发送后 500ms 无响应则重发，最多 3 次。
   */
  const pendingCommands = new Map<string, { retries: number; timer: ReturnType<typeof setTimeout> | null }>()

  function sendCommandWithRetry(msg: SyncMessage) {
    const key = (msg as { type: string }).type
    // 清除已有重试
    const existing = pendingCommands.get(key)
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const entry: { retries: number; timer: ReturnType<typeof setTimeout> | null } = { retries: 0, timer: null }
    pendingCommands.set(key, entry)

    const attempt = () => {
      void transport?.send(msg)
      entry.timer = setTimeout(() => {
        // 超时未确认 → 重试
        const cur = pendingCommands.get(key)
        if (!cur) return
        cur.retries++
        if (cur.retries > 3) {
          pendingCommands.delete(key)
          return
        }
        console.warn(`[useSyncDrawing] command ${key} retry ${cur.retries}/3`)
        attempt()
      }, 500)
    }
    attempt()
  }

  async function pushSnapshot() {
    if (!transport) return
    await transport.send({ type: 'snapshot', actions: drawingApi.getHistorySnapshot() })
  }

  async function bootstrap() {
    let wsUrl: string
    if (options.isDesktop) {
      const server = await startDesktopServer()
      if (!server) {
        connectionState.value = 'error'
        return
      }
      // 桌面端自己连 sync_server 用 loopback（127.0.0.1），避免被 Windows 防火墙拦截；
      // 手机端才需要用 lan_ip。serverInfo.wsUrl 保留 lan_ip 版本供生成手机端 URL。
      wsUrl = `ws://127.0.0.1:${server.port}`
      serverInfo.value = server
      console.info(
        '%c[MarkerOn 同步服务已启动]%c\n  手机端访问：\n  http://' +
          server.lanIp +
          ':1420/index-mobile.html?ws=' +
          encodeURIComponent(server.wsUrl),
        'color:#4caf50;font-weight:bold',
        'color:#bbb',
      )
    } else {
      // 手机端：URL 通过 ?ws= 查询参数注入（桌面端生成的二维码携带）
      const url = new URL(window.location.href)
      const paramWs = url.searchParams.get('ws')
      if (!paramWs) {
        console.error('[useSyncDrawing] mobile client missing ?ws=ws://host:port param')
        connectionState.value = 'error'
        return
      }
      wsUrl = paramWs
    }

    transport = createWebSocketTransport(wsUrl)
    transport.onStateChange((s) => {
      connectionState.value = s
      if (s === 'connected') {
        if (options.isDesktop) {
          // 桌面端是权威方，自带初始状态，不需要握手
          hasInitialState.value = true
          void transport?.send({
            type: 'welcome',
            desktopSize: options.desktopSize.value,
          })
        } else {
          // 手机端：发 hello 请求初始状态
          hasInitialState.value = false
          sendHello()
        }
      } else if (s === 'closed' || s === 'error') {
        hasInitialState.value = false
        pendingRequestId = null
        clearHelloTimeout()
      }
    })
    transport.onMessage((msg: SyncMessage) => {
      switch (msg.type) {
        case 'welcome': {
          remoteDesktopSize.value = msg.desktopSize
          break
        }
        case 'snapshot': {
          // 晚加入握手：收到任何 snapshot 都标记初始状态已收到
          if (!hasInitialState.value) {
            hasInitialState.value = true
            pendingRequestId = null
            clearHelloTimeout()
          }
          // 乐观渲染：手机端正在本地画图时跳过 snapshot 应用，避免打断进行中的笔画
          // 笔画结束后下一次 snapshot 会自然修正
          if (drawingApi.isDrawing?.()) break
          isApplyingRemote = true
          try {
            drawingApi.applyHistorySnapshot(msg.actions)
          } finally {
            isApplyingRemote = false
          }
          break
        }
        case 'action-add': {
          if (!hasInitialState.value && !options.isDesktop) break
          if (drawingApi.isDrawing?.()) break
          isApplyingRemote = true
          try {
            const cur = drawingApi.getHistorySnapshot()
            cur.push(msg.action)
            drawingApi.applyHistorySnapshot(cur)
          } finally {
            isApplyingRemote = false
          }
          break
        }
        case 'clear': {
          if (!hasInitialState.value && !options.isDesktop) break
          // 手机端立即本地清空（乐观渲染），桌面端走 intent 回调执行 clearAll
          if (!options.isDesktop) {
            isApplyingRemote = true
            try {
              drawingApi.applyHistorySnapshot([])
            } finally {
              isApplyingRemote = false
            }
          }
          // fall-through 到 intent 处理（桌面端执行 clearAll 并回 pong）
        }
        // eslint-disable-next-line no-fallthrough
        case 'undo':
        case 'redo': {
          for (const cb of intentSubs) {
            try {
              cb(msg.type === 'undo' ? 'undo' : msg.type === 'redo' ? 'redo' : 'clear')
            } catch (e) {
              console.error('[useSyncDrawing] intent callback error', e)
            }
          }
          // 桌面端回送 pong 确认，让手机端清除重试计时器
          if (options.isDesktop) {
            void transport?.send({ type: 'pong' })
          }
          break
        }
        case 'pointer': {
          for (const cb of pointerSubs) {
            try {
              cb(msg.x, msg.y, msg.phase)
            } catch (e) {
              console.error('[useSyncDrawing] pointer callback error', e)
            }
          }
          break
        }
        case 'toggle-drawing':
        case 'toggle-penetration':
        case 'toggle-whiteboard':
        case 'capture-screen': {
          for (const cb of commandSubs) {
            try {
              cb(msg.type)
            } catch (e) {
              console.error('[useSyncDrawing] command callback error', e)
            }
          }
          // 桌面端回送 pong 确认（capture-screen 不走命令重试，
          // 但回 pong 无害且保持协议一致性）
          if (options.isDesktop) {
            void transport?.send({ type: 'pong' })
          }
          break
        }
        case 'screen-shot': {
          // 手机端：收到桌面端截屏数据 → 通知回调渲染底图
          for (const cb of screenShotSubs) {
            try {
              cb(msg.dataUrl)
            } catch (e) {
              console.error('[useSyncDrawing] screen-shot callback error', e)
            }
          }
          break
        }
        case 'pong': {
          // 手机端收到桌面端确认 → 清除所有待重试命令
          for (const [, entry] of pendingCommands) {
            if (entry.timer) clearTimeout(entry.timer)
          }
          pendingCommands.clear()
          break
        }
        case 'tool-state': {
          for (const cb of toolStateSubs) {
            try {
              cb(msg.state)
            } catch (e) {
              console.error('[useSyncDrawing] tool-state callback error', e)
            }
          }
          break
        }
        case 'hello': {
          // 桌面端：有手机端连进来，立即推送当前快照让其"晚加入"
          if (options.isDesktop) {
            const snapshot = drawingApi.getHistorySnapshot()
            void transport?.send({
              type: 'snapshot',
              actions: snapshot,
              requestId: msg.requestId,
            })
            void transport?.send({
              type: 'welcome',
              desktopSize: options.desktopSize.value,
            })
          }
          break
        }
        default:
          break
      }
    })
  }

  // 订阅 useDrawing 的本地变更
  drawingApi.subscribeHistoryChange(() => {
    if (isApplyingRemote) return
    scheduleSnapshotPush()
  })

  bootstrap().catch((e) => {
    console.error('[useSyncDrawing] bootstrap failed', e)
    connectionState.value = 'error'
  })

  onUnmounted(() => {
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer)
      snapshotTimer = null
    }
    clearHelloTimeout()
    transport?.disconnect()
    transport = null
  })

  return {
    connectionState,
    hasInitialState,
    remoteDesktopSize,
    serverInfo,
    pushToolState(state) {
      void transport?.send({ type: 'tool-state', state })
    },
    pushPointer(x, y, phase) {
      void transport?.send({ type: 'pointer', x, y, phase })
    },
    pushUndo() {
      void sendCommandWithRetry({ type: 'undo' })
    },
    pushRedo() {
      void sendCommandWithRetry({ type: 'redo' })
    },
    pushClear() {
      void sendCommandWithRetry({ type: 'clear' })
    },
    pushToggleDrawing() {
      void sendCommandWithRetry({ type: 'toggle-drawing' })
    },
    pushTogglePenetration() {
      void sendCommandWithRetry({ type: 'toggle-penetration' })
    },
    pushToggleWhiteboard() {
      void sendCommandWithRetry({ type: 'toggle-whiteboard' })
    },
    pushCaptureScreen() {
      // 截图请求不走命令重试：桌面端会异步截屏并回送 screen-shot，
      // 手机端通过 onScreenShot 回调接收，无需 pong 确认。
      void transport?.send({ type: 'capture-screen' })
    },
    pushScreenShot(dataUrl) {
      void transport?.send({ type: 'screen-shot', dataUrl })
    },
    onScreenShot(cb) {
      screenShotSubs.add(cb)
      return () => screenShotSubs.delete(cb)
    },
    onRemotePointer(cb) {
      pointerSubs.add(cb)
      return () => pointerSubs.delete(cb)
    },
    onRemoteToolState(cb) {
      toolStateSubs.add(cb)
      return () => toolStateSubs.delete(cb)
    },
    onRemoteIntent(cb) {
      intentSubs.add(cb)
      return () => intentSubs.delete(cb)
    },
    onRemoteCommand(cb) {
      commandSubs.add(cb)
      return () => commandSubs.delete(cb)
    },
    disconnect() {
      transport?.disconnect()
    },
  }
}
