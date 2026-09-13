import type { DrawAction, Tool } from './drawingTypes'

/**
 * 同步传输层抽象 —— 把"标注状态如何到达另一端"和"业务逻辑"解耦。
 *
 * 设计目标：业务层（useDrawing / MobileMirror）只面向 SyncTransport 接口，
 * 不关心底下是 WebSocket、Tauri 进程内事件，还是 Yjs CRDT。
 * 骨架阶段用裸 WebSocket + 全量快照 + 增量事件混合协议；
 * 后续如需解决断线重连 / 晚加入的边缘冲突，可在保持接口不变的前提下
 * 把实现换成 y-websocket provider。
 */

// ---------- 协议消息类型 ----------

/** 当前活动工具/颜色等元状态 —— 等价于 overlayBridge 的 OverlayStateSync */
export interface ToolStateSync {
  currentTool: Tool
  currentColor: string
  lineWidth: number
  /** 是否处于白板模式（影响坐标映射） */
  whiteboardMode: boolean
}

/** 客户端 → 服务端 / 服务端 → 客户端 的同步消息 */
export type SyncMessage =
  | { type: 'hello'; role: 'desktop' | 'mobile'; requestId?: string }
  | { type: 'welcome'; desktopSize: { w: number; h: number } }
  | { type: 'tool-state'; state: ToolStateSync }
  | { type: 'snapshot'; actions: DrawAction[]; requestId?: string }
  | { type: 'action-add'; action: DrawAction }
  | { type: 'action-remove'; index: number }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'pointer'; x: number; y: number; phase: 'down' | 'move' | 'up' }
  | { type: 'toggle-drawing' }
  | { type: 'toggle-penetration' }
  | { type: 'toggle-whiteboard' }
  | { type: 'ping' }
  | { type: 'pong' }

// ---------- 传输层接口 ----------

export interface SyncTransport {
  /** 已连接且握手完成 */
  readonly ready: boolean
  /** 连接状态变化回调 */
  onStateChange(cb: (state: SyncConnectionState) => void): () => void
  /** 收到远端消息回调 */
  onMessage(cb: (msg: SyncMessage) => void): () => void
  /** 发送消息（异步，失败时 resolve(false) 不抛） */
  send(msg: SyncMessage): Promise<boolean>
  /** 主动断开 */
  disconnect(): void
}

export type SyncConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

// ---------- WebSocket 实现 ----------

/**
 * 创建一个基于 WebSocket 的 SyncTransport。
 *
 * 骨架阶段采用"纯透传广播"模型：服务端不解析消息语义，只把任意客户端
 * 发来的消息原样转发给其他连接。因此 SyncMessage 直接以 JSON 文本帧承载。
 *
 * 重连策略：指数退避，最大 10 秒，无限次重试（教师场景需要"手机息屏再亮就能恢复"）。
 * 局限：裸 WebSocket + 全量快照在"晚加入"时依赖服务端缓存最新 snapshot；
 *        骨架阶段通过客户端首次连接时主动发 hello → 对端（桌面）回 snapshot 实现。
 *        这套握手在断线重连场景会有竞态，TODO 后续用 Yjs CRDT 一次性消除。
 */
export function createWebSocketTransport(url: string): SyncTransport {
  let ws: WebSocket | null = null
  let ready = false
  let manuallyClosed = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const stateSubs = new Set<(s: SyncConnectionState) => void>()
  const msgSubs = new Set<(m: SyncMessage) => void>()

  function notifyState(s: SyncConnectionState) {
    for (const cb of stateSubs) {
      try {
        cb(s)
      } catch (e) {
        console.error('[syncTransport] state callback error', e)
      }
    }
  }

  function notifyMessage(m: SyncMessage) {
    for (const cb of msgSubs) {
      try {
        cb(m)
      } catch (e) {
        console.error('[syncTransport] message callback error', e)
      }
    }
  }

  function scheduleReconnect() {
    if (manuallyClosed) return
    if (reconnectTimer !== null) return
    const delay = Math.min(10000, 500 * Math.pow(2, reconnectAttempts))
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (manuallyClosed) return
    notifyState('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (e) {
      console.error('[syncTransport] WebSocket construction failed', e)
      notifyState('error')
      scheduleReconnect()
      return
    }
    ws = socket
    socket.binaryType = 'arraybuffer'

    socket.addEventListener('open', () => {
      reconnectAttempts = 0
      ready = true
      notifyState('connected')
    })

    socket.addEventListener('message', (ev) => {
      let msg: SyncMessage | null = null
      try {
        if (typeof ev.data === 'string') {
          msg = JSON.parse(ev.data) as SyncMessage
        } else if (ev.data instanceof ArrayBuffer) {
          msg = JSON.parse(new TextDecoder().decode(ev.data)) as SyncMessage
        }
      } catch (e) {
        console.error('[syncTransport] parse message failed', e)
        return
      }
      if (msg) notifyMessage(msg)
    })

    socket.addEventListener('close', () => {
      ready = false
      ws = null
      notifyState('closed')
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      notifyState('error')
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    })
  }

  connect()

  return {
    get ready() {
      return ready
    },
    onStateChange(cb) {
      stateSubs.add(cb)
      return () => stateSubs.delete(cb)
    },
    onMessage(cb) {
      msgSubs.add(cb)
      return () => msgSubs.delete(cb)
    },
    async send(msg: SyncMessage): Promise<boolean> {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(msg))
        return true
      } catch (e) {
        console.error('[syncTransport] send failed', e)
        return false
      }
    },
    disconnect() {
      manuallyClosed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        ws = null
      }
      ready = false
      notifyState('closed')
    },
  }
}
