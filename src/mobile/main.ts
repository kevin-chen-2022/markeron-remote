/**
 * 手机遥控端入口。
 *
 * 与桌面端 main.ts 完全分离：
 * - 不依赖 Tauri / overlayBridge，纯 Web 实现，方便 Capacitor 直接打包；
 * - 通过 URL 查询参数 ?ws=ws://host:port 拿到桌面端 WebSocket 地址；
 * - 渲染 MobileMirror 组件，把手机触摸事件映射到桌面坐标系。
 *
 * 设计原则：桌面端是"标注状态权威"，手机端是"绘制入口 + 镜像"，
 * 通过 useSyncDrawing 桥接，逻辑层共享 useDrawing。
 */
import { createApp } from 'vue'
import MobileApp from './MobileApp.vue'
import './mobile.css'

createApp(MobileApp).mount('#app')
