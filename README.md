<div align="center">
  <h1>MarkerOn Remote</h1>
  <p><strong>桌面标注 + 手机远程控制</strong> — 在电脑屏幕上标注，用手机远程落笔、截图、同步白板。</p>
  <p>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
    <a href="https://github.com/kevin-chen-2022/markeron-remote"><img src="https://img.shields.io/badge/repo-GitHub-181717?logo=github" alt="GitHub" /></a>
  </p>
</div>

## 简介

MarkerOn Remote 是 [MarkerOn](https://github.com/ifer47/markeron) 的分支版本，在原有的桌面屏幕标注功能之上，增加了**手机远程标注**与**桌面截图底图**能力。

- **桌面端**：全屏透明覆盖层，支持画笔、荧光笔、激光笔、箭头、矩形、椭圆、直线、橡皮、文字、印章、选择等 11 种工具，以及白板模式、穿透点击、批量编辑。
- **手机端**：通过 WebSocket 与桌面端实时同步标注笔迹，可在手机上直接落笔标注到电脑屏幕；支持捏合平移缩放、虚拟画布、二维码连接。
- **截图底图**：手机端一键截取桌面屏幕作为标注底层背景，无需看电脑屏幕即可精准落笔。
- **白板同步**：桌面端切换白板模式时，手机端背景自动变为白色，保持视觉一致。

## 功能特性

### 桌面标注
- 11 种标注工具，全键盘快捷键操作
- 白板模式（纯白背景）与屏幕标注自由切换
- 穿透点击模式：标注可见的同时操作底层应用
- 框选批量编辑、撤销/重做、复制白板为图片

### 手机远程标注
- WebSocket 实时双向同步笔迹
- 二维码扫码连接（或手动输入 WS 地址）
- 捏合缩放、双指平移、虚拟画布扩展
- 蓝色虚线标注边界，实时区分标注区与非标注区
- 乐观渲染：手机落笔即时显示，无需等待桌面端回执

### 截图底图
- 手机端点击"截图"按钮 → 桌面端自动截取屏幕 → 回传手机作为标注底层
- 再次点击"隐藏"按钮清空底图（本地操作，零延迟）
- 截图与白板互斥：进入白板模式自动让位给白色背景
- JPEG 压缩 + Base64 传输，平衡画质与带宽

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面端框架 | Tauri v2 (Rust) |
| 前端 | Vue 3 + TypeScript + Vite + Canvas API |
| 手机端 | Capacitor (Android) + Vue 3 |
| 通信 | WebSocket (桌面端内置 sync server) |
| 截屏 | Win32 BitBlt (Windows) / xcap (macOS) |
| 图片编码 | JPEG (quality 80) + Base64 Data URL |

## 项目结构

```
markeron/
├── src/                      # Vue 前端（桌面 overlay + 设置）
│   ├── components/           #   DrawingOverlay, MobileMirror, ToolbarWindow 等
│   ├── composables/          #   useDrawing, useSyncDrawing, syncTransport 等
│   ├── mobile/               #   手机端入口 (MobileApp.vue)
│   └── utils/                #   工具函数
├── src-tauri/                # Rust 后端
│   └── src/                  #   clipboard(截屏), sync_server, overlay, commands 等
├── android/                  # Capacitor Android 工程
├── assets/                   # 图标与截图资源
├── scripts/                  # 构建脚本 (build-portable.sh 等)
└── index-mobile.html         # 手机端入口 HTML
```

## 构建

### 环境要求

- Node.js 24.15.0+ (见 `.node-version`)
- npm 11.12.1+
- Rust toolchain (stable)
- Android SDK + Gradle（仅手机端需要）

### 安装依赖

```bash
npm install
```

### 桌面端

```bash
# 开发模式
npm run dev

# 构建 release exe
npm run build

# 打包便携版 zip（含 WebView2Loader.dll + markeron.portable 标记）
npm run build:portable
```

便携版产物：`src-tauri/target/release/bundle/portable/MarkerOn_<version>_x64_portable.zip`

### 手机端

```bash
# 构建前端 + Capacitor 同步
npm run build:mobile

# 生成 debug APK
cd android
.\gradlew.bat assembleDebug
```

APK 产物：`android/app/build/outputs/apk/debug/app-debug.apk`

### 开发模式下手机连接

桌面端 `npm run dev` 启动后，overlay 工具条"遥控"按钮会显示二维码。手机扫码即可连接。

如需手机浏览器直接访问 Vite dev server，需让 Vite 监听局域网地址：

```powershell
# PowerShell
$env:TAURI_DEV_HOST = "192.168.x.x"; npm run dev
```

或修改 `vite.config.ts` 让 host 默认监听 `0.0.0.0`。

## 使用说明

### 桌面标注
1. 启动后程序驻留系统托盘
2. 按 `Ctrl+Shift+D` 进入标注模式
3. 数字键 `1-8` 切换工具，`V` 选择，`T` 文字，`N` 印章
4. `Space` 呼出工具条，`Esc` 退出

### 手机远程标注
1. 桌面端工具条点击"遥控" → 显示二维码
2. 手机扫码（或手动输入 WS 地址）连接
3. 手机镜像区实时显示桌面端标注
4. 直接在手机上落笔，笔迹同步到桌面
5. 双指捏合缩放、平移调整视图

### 截图底图
1. 手机端工具条点击"截图"按钮
2. 桌面端自动隐藏覆盖层 → 截屏 → 恢复
3. 手机端显示桌面截图作为标注底层
4. 再次点击"隐藏"清空底图
5. 截图与白板互斥，进入白板自动让位

## 许可证

MIT License — 见 [LICENSE](./LICENSE)

上游项目：[ifer47/markeron](https://github.com/ifer47/markeron)
