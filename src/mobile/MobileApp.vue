<script setup lang="ts">
/**
 * 手机遥控端主组件。
 *
 * 职责：
 * 1. 显示连接状态 + 输入 WS 地址（骨架阶段：扫码 / 手输 / URL 携带）。
 * 2. 连接成功后挂载 MobileMirror，把手机触摸映射到桌面坐标系。
 * 3. 顶部一排精简工具条（笔颜色 / 粗细 / 橡皮 / 撤销 / 清空 / 指针模式），
 *    仅同步工具状态 + 显示远端笔迹。
 *
 * 不直接管理标注数据；状态权威在桌面端的 useDrawing。
 * 手机端 useDrawing 实例仅用作 MobileMirror 的"显示 + 输入"载体。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import MobileMirror from '../components/MobileMirror.vue'
import { useSyncDrawing } from '../composables/useSyncDrawing'
import { useDrawing } from '../composables/useDrawing'
import type { SyncConnectionState } from '../composables/syncTransport'
import jsQR from 'jsqr'

// ---------- 调试日志面板（手机上不方便看 console，直接显示在页面上）----------
const debugLogs = ref<string[]>([])
const showDebug = ref(true)
function log(msg: string) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  debugLogs.value.push(`${time} ${msg}`)
  if (debugLogs.value.length > 30) debugLogs.value.shift()
  console.log(msg)
}
// 劫持 console.log/warn/error，让关键日志也显示在页面上
const origLog = console.log
const origWarn = console.warn
const origError = console.error
function pushLog(level: string, args: unknown[]) {
  const msg = args.map(a => {
    if (typeof a === 'object' && a !== null) {
      try {
        // 处理 Vue ref 对象（避免循环引用）
        if (a && typeof (a as { value?: unknown }).value !== 'undefined' && typeof (a as { __v_isRef?: boolean }).__v_isRef === 'boolean') {
          return String((a as { value: unknown }).value)
        }
        return JSON.stringify(a, () => { return undefined })
      } catch {
        return String(a)
      }
    }
    return String(a)
  }).join(' ')
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  debugLogs.value.push(`${time} [${level}] ${msg}`)
  if (debugLogs.value.length > 50) debugLogs.value.shift()
}
console.log = (...args: unknown[]) => {
  origLog.apply(console, args as [unknown, ...unknown[]])
  pushLog('log', args)
}
console.warn = (...args: unknown[]) => {
  origWarn.apply(console, args as [unknown, ...unknown[]])
  pushLog('warn', args)
}
console.error = (...args: unknown[]) => {
  origError.apply(console, args as [unknown, ...unknown[]])
  pushLog('error', args)
}

// 一键复制全部日志到剪贴板（手机端方便回传给开发者）
async function copyLogs() {
  const text = debugLogs.value.join('\n')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      alert(`已复制 ${debugLogs.value.length} 行日志`)
    } else {
      // 回退：用 textarea + execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      alert(`已复制 ${debugLogs.value.length} 行日志`)
    }
  } catch (e) {
    alert('复制失败：' + String(e))
  }
}

const props = defineProps<{
  /** 通过 URL 注入：?ws=ws://host:port */
  wsUrl?: string
}>()

const emit = defineEmits<{
  (e: 'state-change', state: SyncConnectionState): void
}>()

const historyCanvas = shallowRef<HTMLCanvasElement | null>(null)
const previewCanvas = shallowRef<HTMLCanvasElement | null>(null)

const drawing = useDrawing(historyCanvas, previewCanvas)

// 预先构造好的 plain object，包含 ref 本身（不解包）。
// 模板里直接 `:canvas-refs="canvasRefsPayload"` 绑定即可，
// 避免 `:canvas-refs="{ history: historyCanvas, preview: previewCanvas }"`
// 这种写法被 Vue 模板编译器把 top-level ref 自动解包成 .value。
const canvasRefsPayload = {
  history: historyCanvas,
  preview: previewCanvas,
}

const desktopSize = ref<{ w: number; h: number }>({ w: 1920, h: 1080 })

const wsParam = computed(() => {
  const fromProp = props.wsUrl
  if (fromProp) return fromProp
  const u = new URL(window.location.href)
  return u.searchParams.get('ws') ?? ''
})

const sync = useSyncDrawing(
  {
    getHistorySnapshot: drawing.getHistorySnapshot,
    applyHistorySnapshot: drawing.applyHistorySnapshot,
    subscribeHistoryChange: drawing.subscribeHistoryChange,
    isDrawing: () => drawing.isDrawing.value,
  },
  { desktopSize, isDesktop: false },
)

const connState = sync.connectionState
const hasInitialState = sync.hasInitialState
const remoteDesktopSize = sync.remoteDesktopSize

const cleanups: Array<() => void> = []

onMounted(() => {
  // useSyncDrawing 仅暴露 ref 形式的 connectionState，外层用 watch 订阅
  const stop = watch(
    connState,
    (s) => emit('state-change', s),
    { immediate: true },
  )
  cleanups.push(stop)
})

onBeforeUnmount(() => {
  for (const fn of cleanups) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
  cleanups.length = 0
  sync.disconnect()
  console.log = origLog
  console.warn = origWarn
  console.error = origError
})

const colors = ['#FF0000', '#FFFF00', '#00C853', '#2196F3', '#FFFFFF', '#000000']
const activeColor = ref(colors[0])
const activeWidth = ref(4)
const activeTool = ref<'pen' | 'highlighter' | 'laser' | 'eraser'>('pen')

function selectColor(c: string) {
  activeColor.value = c
  drawing.currentColor.value = c
  sync.pushToolState({
    currentTool: activeTool.value,
    currentColor: c,
    lineWidth: activeWidth.value,
    whiteboardMode: false,
  })
}

function selectWidth(w: number) {
  activeWidth.value = w
  drawing.setLineWidth(w)
  sync.pushToolState({
    currentTool: activeTool.value,
    currentColor: activeColor.value,
    lineWidth: w,
    whiteboardMode: false,
  })
}

function selectPen() {
  activeTool.value = 'pen'
  drawing.currentTool.value = 'pen'
  drawing.setLineWidth(activeWidth.value)
  sync.pushToolState({
    currentTool: 'pen',
    currentColor: activeColor.value,
    lineWidth: activeWidth.value,
    whiteboardMode: false,
  })
}

function selectEraser() {
  activeTool.value = 'eraser'
  drawing.currentTool.value = 'eraser'
  drawing.setLineWidth(activeWidth.value)
  sync.pushToolState({
    currentTool: 'eraser',
    currentColor: activeColor.value,
    lineWidth: activeWidth.value,
    whiteboardMode: false,
  })
}

function selectHighlighter() {
  activeTool.value = 'highlighter'
  drawing.currentTool.value = 'highlighter'
  drawing.setLineWidth(activeWidth.value)
  sync.pushToolState({
    currentTool: 'highlighter',
    currentColor: activeColor.value,
    lineWidth: activeWidth.value,
    whiteboardMode: false,
  })
}

function selectLaser() {
  activeTool.value = 'laser'
  drawing.currentTool.value = 'laser'
  drawing.setLineWidth(activeWidth.value)
  sync.pushToolState({
    currentTool: 'laser',
    currentColor: activeColor.value,
    lineWidth: activeWidth.value,
    whiteboardMode: false,
  })
}

function undoRemote() {
  sync.pushUndo()
}

function clearRemote() {
  // 立即在本地清空（不等桌面端回推 snapshot，减少延迟）
  drawing.applyHistorySnapshot([])
  // 同时通知桌面端执行清空（桌面端是权威方，会回推 snapshot 确认）
  sync.pushClear()
}

function toggleDrawing() {
  sync.pushToggleDrawing()
}

function togglePenetration() {
  sync.pushTogglePenetration()
}

function toggleWhiteboard() {
  sync.pushToggleWhiteboard()
}

// 工具栏折叠
const toolbarExpanded = ref(true)
function toggleToolbar() {
  toolbarExpanded.value = !toolbarExpanded.value
}

// 屏幕模式：fit（填满手机屏幕）vs virtual（虚拟电脑屏幕，可缩放拖动）
const screenMode = ref<'fit' | 'virtual'>('fit')
function toggleScreenMode() {
  screenMode.value = screenMode.value === 'fit' ? 'virtual' : 'fit'
}

// ---------- 扫码连接 ----------
const scanning = ref(false)
const scanError = ref('')
let scanStream: MediaStream | null = null
let scanRAF: number | null = null
let barcodeDetector: { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> } | null = null
// jsQR fallback 用 canvas 抓帧解码
let scanCanvas: HTMLCanvasElement | null = null
let scanCtx: CanvasRenderingContext2D | null = null

async function startScan() {
  scanError.value = ''
  if (scanning.value) return

  // 先打开弹窗，让用户看到状态和错误信息
  scanning.value = true

  // 检查 mediaDevices（HTTP 下某些浏览器仍可用，先试再说）
  if (!navigator.mediaDevices?.getUserMedia) {
    scanError.value = '浏览器不支持摄像头 API（可能需要 HTTPS 访问）'
    return
  }

  // 优先用原生 BarcodeDetector（Android Chrome 支持）
  const BC = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector
  if (BC) {
    try { barcodeDetector = new BC({ formats: ['qr_code'] }) } catch { barcodeDetector = null }
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch (e) {
    scanError.value = '无法访问摄像头：' + String(e) + '（可能需要 HTTPS 访问）'
    return
  }

  await nextTick()
  const v = document.querySelector<HTMLVideoElement>('#scan-video')
  if (!v) { scanError.value = '视频元素未找到'; return }
  v.srcObject = scanStream
  await v.play().catch(() => {})

  // 初始化 jsQR fallback 用的 canvas
  if (!scanCanvas) {
    scanCanvas = document.createElement('canvas')
    scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true })
  }

  const tick = async () => {
    if (!scanning.value) return
    if (v.readyState >= 2 && v.videoWidth > 0) {
      // 方式 1: 原生 BarcodeDetector
      if (barcodeDetector) {
        try {
          const results = await barcodeDetector.detect(v)
          if (results.length > 0 && results[0].rawValue) {
            await onScanResult(results[0].rawValue)
            return
          }
        } catch { /* 降级到 jsQR */ }
      }
      // 方式 2: jsQR 纯 JS 解码（HTTP 下也能工作）
      if (scanCtx) {
        const w = v.videoWidth, h = v.videoHeight
        scanCanvas!.width = w
        scanCanvas!.height = h
        scanCtx.drawImage(v, 0, 0, w, h)
        try {
          const imgData = scanCtx.getImageData(0, 0, w, h)
          const code = jsQR(imgData.data, w, h, { inversionAttempts: 'attemptBoth' })
          if (code?.data) {
            await onScanResult(code.data)
            return
          }
        } catch { /* 继续 */ }
      }
    }
    scanRAF = requestAnimationFrame(tick)
  }
  scanRAF = requestAnimationFrame(tick)
}

async function onScanResult(raw: string) {
  stopScan()
  log('扫码结果: ' + raw)
  let wsUrl = ''
  try {
    if (raw.startsWith('http')) {
      wsUrl = new URL(raw).searchParams.get('ws') ?? ''
    } else if (raw.startsWith('ws')) {
      wsUrl = raw
    }
  } catch { wsUrl = raw }
  if (!wsUrl) { scanError.value = '二维码内容无法识别'; return }
  const u = new URL(window.location.href)
  u.searchParams.set('ws', wsUrl)
  window.history.replaceState({}, '', u.toString())
  sync.disconnect()
  window.location.reload()
}

function stopScan() {
  scanning.value = false
  if (scanRAF !== null) { cancelAnimationFrame(scanRAF); scanRAF = null }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null }
  barcodeDetector = null
  scanCanvas = null
  scanCtx = null
}

function refreshPage() {
  window.location.reload()
}
</script>

<template>
  <div class="mobile-app">
    <header class="status-bar">
      <button class="scan-btn" @click="startScan">扫码</button>
      <div class="state-dot" :data-state="connState"></div>
      <span class="state-text">
        {{
          connState === 'connected'
            ? '已连接'
            : connState === 'connecting'
              ? '连接中…'
              : connState === 'closed' || connState === 'idle'
                ? '未连接'
                : '错误'
        }}
      </span>
      <span v-if="remoteDesktopSize" class="desktop-size">
        {{ remoteDesktopSize.w }}×{{ remoteDesktopSize.h }}
      </span>
      <span v-if="connState === 'connected' && !hasInitialState" class="syncing-hint">
        同步中…
      </span>
    </header>

    <main class="mirror-area" :class="{ 'virtual-mode': screenMode === 'virtual' }">
      <MobileMirror
        v-if="connState === 'connected' && remoteDesktopSize && hasInitialState"
        :drawing="drawing"
        :sync="sync"
        :desktop-size="remoteDesktopSize"
        :canvas-refs="canvasRefsPayload"
        :screen-mode="screenMode"
      />
      <div v-else-if="connState === 'connected' && !hasInitialState" class="hint">
        <div class="spinner"></div>
        <p>正在同步桌面端标注状态…</p>
      </div>
      <div v-else class="hint">
        <p>请使用桌面端"遥控"按钮打开二维码，扫码或访问此页面。</p>
        <p v-if="wsParam" class="ws-url">WebSocket: {{ wsParam }}</p>
      </div>
    </main>

    <footer class="tool-bar">
      <!-- 顶部快捷命令行（始终可见） -->
      <div class="row commands">
        <button class="cmd-btn" @click="toggleWhiteboard">白板</button>
        <button class="cmd-btn" @click="toggleDrawing">标注</button>
        <button class="cmd-btn" @click="togglePenetration">穿透</button>
        <button class="cmd-btn danger" @click="clearRemote">清除</button>
        <button class="cmd-btn" @click="undoRemote">撤销</button>
        <button class="cmd-btn" :data-active="screenMode === 'virtual'" @click="toggleScreenMode">
          {{ screenMode === 'fit' ? '全屏' : '虚拟' }}
        </button>
        <button class="cmd-btn toggle-fold" @click="toggleToolbar">
          {{ toolbarExpanded ? '▾' : '▸' }}
        </button>
      </div>
      <!-- 可折叠的画笔设置区 -->
      <template v-if="toolbarExpanded">
        <div class="row colors">
          <button
            v-for="c in colors"
            :key="c"
            class="color-btn"
            :style="{ background: c }"
            :data-active="activeColor === c"
            @click="selectColor(c)"
          ></button>
        </div>
        <div class="row tools">
          <button :data-active="activeTool === 'pen'" @click="selectPen">画笔</button>
          <button :data-active="activeTool === 'highlighter'" @click="selectHighlighter">荧光笔</button>
          <button :data-active="activeTool === 'laser'" @click="selectLaser">激光笔</button>
          <button :data-active="activeTool === 'eraser'" @click="selectEraser">橡皮</button>
        </div>
        <div class="row widths">
          <button
            v-for="w in [2, 4, 8, 16]"
            :key="w"
            :data-active="activeWidth === w"
            @click="selectWidth(w)"
          >
            {{ w }}
          </button>
        </div>
      </template>
    </footer>

    <!-- 调试日志面板（右上角折叠按钮 + 半透明浮层）-->
    <button class="refresh-btn" @click="refreshPage">刷新</button>
    <button
      class="debug-toggle"
      @click="showDebug = !showDebug"
    >{{ showDebug ? '_hide' : 'log' }}</button>
    <div v-if="showDebug" class="debug-panel">
      <button class="debug-copy" @click="copyLogs">复制全部</button>
      <div
        v-for="(line, i) in debugLogs"
        :key="i"
        class="debug-line"
        @click="copyLogs"
      >{{ line }}</div>
    </div>

    <!-- 扫码弹窗 -->
    <div v-if="scanning" class="scan-overlay" @click.self="stopScan">
      <div class="scan-modal">
        <video id="scan-video" autoplay playsinline muted></video>
        <p class="scan-hint">将二维码对准摄像头</p>
        <p v-if="scanError" class="scan-error">{{ scanError }}</p>
        <button class="scan-cancel" @click="stopScan">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mobile-app {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: #2a2a2a;
  font-size: 13px;
  border-bottom: 1px solid #3a3a3a;
  flex: 0 0 auto;
  height: 28px;
  line-height: 28px;
}

.state-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #888;
}
.state-dot[data-state='connected'] {
  background: #4caf50;
}
.state-dot[data-state='connecting'] {
  background: #ffc107;
}
.state-dot[data-state='error'] {
  background: #f44336;
}

.state-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-size {
  color: #aaa;
  font-size: 12px;
}

.syncing-hint {
  color: #ffc107;
  font-size: 12px;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #444;
  border-top-color: #4a86e8;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.mirror-area {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
  background: #1a1a1a;
  border-top: 2px dashed #555;
  border-bottom: 2px dashed #555;
}

.mirror-area.virtual-mode {
  background: #0a0a0a;
  border-color: #4a86e8;
}

.hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  color: #bbb;
  font-size: 14px;
  gap: 12px;
}

.ws-url {
  color: #888;
  font-size: 12px;
  word-break: break-all;
}

.tool-bar {
  flex: 0 0 auto;
  background: #2a2a2a;
  border-top: 1px solid #3a3a3a;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.row.commands {
  gap: 6px;
}

.cmd-btn {
  flex: 1 1 0;
  min-height: 40px;
  background: #3a3a3a;
  color: #f5f5f5;
  border: none;
  border-radius: 8px;
  font-size: 14px;
}
.cmd-btn:active {
  background: #555;
}
.cmd-btn.danger {
  background: #c62828;
}
.cmd-btn.danger:active {
  background: #d32f2f;
}
.cmd-btn.toggle-fold {
  flex: 0 0 40px;
  background: #2a2a2a;
  font-size: 18px;
}

.row.tools button {
  flex: 1 1 0;
  min-height: 40px;
  background: #3a3a3a;
  color: #f5f5f5;
  border: none;
  border-radius: 8px;
  font-size: 14px;
}
.row.tools button[data-active='true'] {
  background: #4a86e8;
}

.row.colors .color-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid #555;
}
.row.colors .color-btn[data-active='true'] {
  border-color: #fff;
}

.row.widths button {
  width: 36px;
  height: 32px;
  background: #3a3a3a;
  color: #f5f5f5;
  border: none;
  border-radius: 8px;
  font-size: 12px;
}
.row.widths button[data-active='true'] {
  background: #4a86e8;
}

.debug-toggle {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.7);
  color: #0f0;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: monospace;
}

.refresh-btn {
  position: fixed;
  top: 8px;
  right: 48px;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.7);
  color: #4a9eff;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: monospace;
  cursor: pointer;
}

.scan-btn {
  background: rgba(74, 134, 232, 0.35);
  color: #fff;
  border: 1px solid #4a86e8;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  flex: 0 0 auto;
}
.scan-btn:active {
  background: rgba(74, 134, 232, 0.6);
}

.scan-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.scan-modal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.scan-modal video {
  width: 80vw;
  max-width: 360px;
  height: auto;
  border-radius: 8px;
  object-fit: cover;
}
.scan-hint {
  color: #fff;
  font-size: 14px;
}
.scan-error {
  color: #f44336;
  font-size: 12px;
}
.scan-cancel {
  background: #333;
  color: #fff;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 14px;
  cursor: pointer;
}

.debug-panel {
  position: fixed;
  top: 36px;
  right: 8px;
  z-index: 9998;
  width: 90%;
  max-width: 360px;
  max-height: 40vh;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.85);
  color: #0f0;
  font-family: monospace;
  font-size: 10px;
  line-height: 1.4;
  padding: 6px;
  border-radius: 6px;
  border: 1px solid #444;
}

.debug-line {
  word-break: break-all;
  margin-bottom: 2px;
}

.debug-copy {
  display: block;
  width: 100%;
  margin-bottom: 6px;
  background: #333;
  color: #0f0;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 6px;
  font-size: 12px;
  font-family: monospace;
}
</style>
