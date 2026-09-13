<script setup lang="ts">
/**
 * 手机端标注镜像组件。
 *
 * 职责：
 *   1. 在手机屏幕上以桌面端的宽高比"等比例缩放"渲染画布（黑边留白）；
 *   2. 把手指触摸坐标映射到桌面端坐标系，发给桌面端的 useDrawing；
 *   3. 同时把桌面端的 currentAction / history 实时镜像出来，让教师看到自己画什么。
 *
 * 坐标映射核心：手机屏幕上一块"镜像区"对应桌面端 (0,0)-(w,h)，
 * 因此（client - 镜像区原点） × (desktopW / mirrorW) = desktopX。
 *
 * 注意：此处直接复用 useDrawing 的渲染逻辑（drawActionOn / cacheCanvas），
 * 但画布尺寸要按桌面端的逻辑尺寸设置（CSS 像素，DPR 由内部自动处理）。
 * 这样标注位与桌面端像素对齐，笔迹不会因缩放产生抖动。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Point } from '../composables/drawingTypes'
import type { useDrawing } from '../composables/useDrawing'
import type { useSyncDrawing } from '../composables/useSyncDrawing'

interface Props {
  /** 来自桌面端 useDrawing 实例 */
  drawing: ReturnType<typeof useDrawing>
  /** 同步通道 */
  sync: ReturnType<typeof useSyncDrawing>
  /** 桌面端画布逻辑尺寸 */
  desktopSize: { w: number; h: number }
  /** 由 MobileApp 提供的 canvas refs（同一份 useDrawing 实例引用） */
  canvasRefs: {
    history: Ref<HTMLCanvasElement | null>
    preview: Ref<HTMLCanvasElement | null>
  }
  /** 屏幕模式：fit = 填满手机屏幕，virtual = 虚拟电脑屏幕（可缩放拖动） */
  screenMode?: 'fit' | 'virtual'
}

const props = defineProps<Props>()

const containerRef = ref<HTMLDivElement | null>(null)
const historyCanvasEl = ref<HTMLCanvasElement | null>(null)
const previewCanvasEl = ref<HTMLCanvasElement | null>(null)

// 镜像区在屏幕上的实际位置与大小（CSS 像素）
const mirrorRect = ref({ x: 0, y: 0, w: 0, h: 0 })

// 虚拟屏幕模式：缩放和平移
const virtualScale = ref(1)
const virtualX = ref(0)
const virtualY = ref(0)

function computeMirrorRect() {
  const container = containerRef.value
  if (!container) return
  const cw = container.clientWidth
  const ch = container.clientHeight
  const { w: dw, h: dh } = props.desktopSize
  if (!dw || !dh || !cw || !ch) return

  if (props.screenMode === 'virtual') {
    // 虚拟模式：竖屏按高度填满（虚拟屏高度=电脑屏高度），横屏按宽度填满（虚拟屏宽度=电脑屏宽度），
    // 另一方向居中或超出可拖动查看。消除黑边 = 消除不可标注区域。
    const isLandscape = cw > ch
    const scale = isLandscape ? cw / dw : ch / dh
    virtualScale.value = scale
    virtualX.value = isLandscape ? 0 : (cw - dw * scale) / 2
    virtualY.value = isLandscape ? (ch - dh * scale) / 2 : 0
    mirrorRect.value = isLandscape
      ? { x: 0, y: 0, w: cw, h: dh * scale }
      : { x: 0, y: 0, w: dw * scale, h: ch }
  } else {
    // Fit 模式：等比缩放填满
    const containerRatio = cw / ch
    const desktopRatio = dw / dh
    let w: number, h: number, x: number, y: number
    if (containerRatio > desktopRatio) {
      h = ch
      w = h * desktopRatio
      x = (cw - w) / 2
      y = 0
    } else {
      w = cw
      h = w * desktopRatio
      x = 0
      y = (ch - h) / 2
    }
    mirrorRect.value = { x, y, w, h }
  }
  applyCanvasSize()
}

function applyCanvasSize() {
  const { w: dw, h: dh } = props.desktopSize
  const mirrorW = mirrorRect.value.w
  const mirrorH = mirrorRect.value.h
  for (const c of [historyCanvasEl.value, previewCanvasEl.value]) {
    if (!c) continue
    // 内部坐标系 = 桌面坐标系 (0..dw, 0..dh)
    c.width = Math.round(dw)
    c.height = Math.round(dh)
    // 关键：让 style.width 等于 canvas.width（数字 + px），
    // 这样 useDrawing 的 getEffectiveDpr 反算 canvas.width/cssW 得到 1，
    // cacheCanvas 不会被建成巨幅位图。
    // 真正的视觉缩放靠外层容器 transform: scale 完成。
    c.style.width = `${dw}px`
    c.style.height = `${dh}px`
    const ctx = c.getContext('2d', { alpha: true })
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }
  }
  // 注入回 MobileApp 持有的 refs，useDrawing 才能渲染
  props.canvasRefs.history.value = historyCanvasEl.value
  props.canvasRefs.preview.value = previewCanvasEl.value
  // 画布尺寸变化后，重画一次
  props.drawing.redrawAll()
  console.log('[MobileMirror] applyCanvasSize done', { dw, dh, mirrorW, mirrorH, historyLen: props.drawing.getHistorySnapshot().length })
}

// ---------- 触摸事件 → 桌面坐标 ----------
function eventToDesktopPoint(e: PointerEvent | Touch): Point {
  // 用 history canvas 的真实渲染矩形做坐标映射，避免 interaction-layer
  // 与 canvas 可见区域因浮点/transform 渲染误差导致顶部/底部不能标注。
  const canvas = historyCanvasEl.value
  if (canvas) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const dx = (localX / rect.width) * props.desktopSize.w
      const dy = (localY / rect.height) * props.desktopSize.h
      return { x: dx, y: dy }
    }
  }
  // 回退：用 container + 手动计算
  const containerRect = containerRef.value!.getBoundingClientRect()
  const localX = e.clientX - containerRect.left
  const localY = e.clientY - containerRect.top

  if (props.screenMode === 'virtual') {
    const dx = (localX - virtualX.value) / virtualScale.value
    const dy = (localY - virtualY.value) / virtualScale.value
    return { x: dx, y: dy }
  } else {
    const r = mirrorRect.value
    const localRX = localX - r.x
    const localRY = localY - r.y
    const dx = (localRX / r.w) * props.desktopSize.w
    const dy = (localRY / r.h) * props.desktopSize.h
    return { x: dx, y: dy }
  }
}

let drawingNow = false

// pointer 推送节流：手机触摸事件可达 120Hz，限制到 60fps 减少 WS 消息量
let pendingPointerMove: { x: number; y: number } | null = null
let pointerMoveTimer: ReturnType<typeof requestAnimationFrame> | null = null

function throttledPushPointer(x: number, y: number, phase: 'down' | 'move' | 'up') {
  if (phase !== 'move') {
    if (pointerMoveTimer !== null) {
      cancelAnimationFrame(pointerMoveTimer)
      pointerMoveTimer = null
    }
    pendingPointerMove = null
    props.sync.pushPointer(x, y, phase)
    return
  }
  // move: 用 rAF 节流到每帧最多一次
  pendingPointerMove = { x, y }
  if (pointerMoveTimer !== null) return
  pointerMoveTimer = requestAnimationFrame(() => {
    pointerMoveTimer = null
    if (pendingPointerMove) {
      const p = pendingPointerMove
      pendingPointerMove = null
      props.sync.pushPointer(p.x, p.y, 'move')
    }
  })
}

// 虚拟模式手势状态
let panStartX = 0
let panStartY = 0
let panOriginX = 0
let panOriginY = 0
let pinchStartDist = 0
let pinchStartScale = 1
let activePointers = new Map<number, { x: number; y: number }>()

function getPinchDist(): number {
  const pts = [...activePointers.values()]
  if (pts.length < 2) return 0
  const dx = pts[0].x - pts[1].x
  const dy = pts[0].y - pts[1].y
  return Math.hypot(dx, dy)
}

function onPointerDown(e: PointerEvent) {
  if (e.pointerType === 'mouse') return
  e.preventDefault()

  const rect = containerRef.value!.getBoundingClientRect()
  activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })

  if (props.screenMode === 'virtual' && activePointers.size >= 2) {
    // 双指 = 缩放/平移
    drawingNow = false
    pinchStartDist = getPinchDist()
    pinchStartScale = virtualScale.value
    const pts = [...activePointers.values()]
    panStartX = (pts[0].x + pts[1].x) / 2
    panStartY = (pts[0].y + pts[1].y) / 2
    panOriginX = virtualX.value
    panOriginY = virtualY.value
  } else if (activePointers.size === 1) {
    // 单指 = 画图（乐观渲染：本地立即 startDraw + 异步推送桌面端）
    drawingNow = true
    const p = eventToDesktopPoint(e)
    try { props.drawing.startDraw({ x: p.x, y: p.y }) } catch { /* ignore */ }
    throttledPushPointer(p.x, p.y, 'down')
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType === 'mouse') return
  e.preventDefault()

  const rect = containerRef.value!.getBoundingClientRect()
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  if (props.screenMode === 'virtual' && activePointers.size >= 2 && pinchStartDist > 0) {
    // 双指缩放 + 平移
    const dist = getPinchDist()
    const scale = Math.max(0.1, Math.min(5, pinchStartScale * (dist / pinchStartDist)))
    const pts = [...activePointers.values()]
    const cx = (pts[0].x + pts[1].x) / 2
    const cy = (pts[0].y + pts[1].y) / 2
    // 以双指中心为锚点缩放
    const dx = cx - panStartX
    const dy = cy - panStartY
    virtualScale.value = scale
    virtualX.value = panOriginX + dx - (cx - panOriginX) * (scale / pinchStartScale - 1)
    virtualY.value = panOriginY + dy - (cy - panOriginY) * (scale / pinchStartScale - 1)
  } else if (drawingNow) {
    const p = eventToDesktopPoint(e)
    try { props.drawing.draw({ x: p.x, y: p.y }) } catch { /* ignore */ }
    throttledPushPointer(p.x, p.y, 'move')
  }
}

function onPointerUp(e: PointerEvent) {
  e.preventDefault()
  activePointers.delete(e.pointerId)

  if (activePointers.size < 2) {
    pinchStartDist = 0
  }

  if (drawingNow && activePointers.size === 0) {
    drawingNow = false
    const p = eventToDesktopPoint(e)
    try { props.drawing.endDraw() } catch { /* ignore */ }
    throttledPushPointer(p.x, p.y, 'up')
  }
}

// ---------- 生命周期 ----------
let resizeObs: ResizeObserver | null = null

onMounted(() => {
  computeMirrorRect()
  resizeObs = new ResizeObserver(() => computeMirrorRect())
  if (containerRef.value) resizeObs.observe(containerRef.value)
  window.addEventListener('resize', computeMirrorRect)
  window.addEventListener('orientationchange', computeMirrorRect)
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  window.removeEventListener('resize', computeMirrorRect)
  window.removeEventListener('orientationchange', computeMirrorRect)
})

watch(
  () => props.desktopSize,
  () => computeMirrorRect(),
  { deep: true },
)

watch(
  () => props.screenMode,
  () => {
    activePointers.clear()
    drawingNow = false
    computeMirrorRect()
  },
)

const containerStyle = computed(() => ({
  width: '100%',
  height: '100%',
  position: 'relative' as const,
  background: '#000',
  overflow: 'hidden',
}))

const canvasLayerStyle = computed(() => {
  const dw = props.desktopSize.w || 1
  const dh = props.desktopSize.h || 1

  if (props.screenMode === 'virtual') {
    // 虚拟模式：用 translate + scale 实现
    return {
      position: 'absolute' as const,
      left: '0px',
      top: '0px',
      width: `${dw}px`,
      height: `${dh}px`,
      transform: `translate(${virtualX.value}px, ${virtualY.value}px) scale(${virtualScale.value})`,
      transformOrigin: 'top left' as const,
      touchAction: 'none' as const,
      pointerEvents: 'none' as const,
    }
  } else {
    // Fit 模式
    const r = mirrorRect.value
    const scaleX = r.w / dw
    const scaleY = r.h / dh
    return {
      position: 'absolute' as const,
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${dw}px`,
      height: `${dh}px`,
      transform: `scale(${scaleX}, ${scaleY})`,
      transformOrigin: 'top left' as const,
      touchAction: 'none' as const,
      pointerEvents: 'none' as const,
    }
  }
})

// interaction-layer 与 canvas 使用相同的 transform/尺寸，确保两者可见区域完全重合，
// 避免因浮点/transform 渲染误差导致顶部/底部不能标注。
const interactionLayerStyle = computed(() => {
  const dw = props.desktopSize.w || 1
  const dh = props.desktopSize.h || 1

  if (props.screenMode === 'virtual') {
    return {
      left: '0px',
      top: '0px',
      width: `${dw}px`,
      height: `${dh}px`,
      transform: `translate(${virtualX.value}px, ${virtualY.value}px) scale(${virtualScale.value})`,
      transformOrigin: 'top left' as const,
    }
  } else {
    const r = mirrorRect.value
    const scaleX = r.w / dw
    const scaleY = r.h / dh
    return {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${dw}px`,
      height: `${dh}px`,
      transform: `scale(${scaleX}, ${scaleY})`,
      transformOrigin: 'top left' as const,
    }
  }
})
</script>

<template>
  <div ref="containerRef" :style="containerStyle">
    <canvas ref="historyCanvasEl" :style="canvasLayerStyle"></canvas>
    <canvas ref="previewCanvasEl" :style="canvasLayerStyle"></canvas>
    <div
      class="interaction-layer"
      :style="interactionLayerStyle"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    ></div>
  </div>
</template>

<style scoped>
.interaction-layer {
  position: absolute;
  touch-action: none;
  background: transparent;
  z-index: 10;
}
</style>
