// 生成 Android 各分辨率图标
// 用法：node scripts/gen-android-icons.mjs
import { Jimp } from 'jimp'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC_ICON = join(ROOT, 'src-tauri', 'icons', 'icon.png')
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res')

// Android mipmap 尺寸映射 (mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192)
const sizes = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
]

// foreground 尺寸 (自适应图标 foreground 是 108dp，对应倍数)
const fgSizes = [
  { dir: 'mipmap-mdpi', size: 108 },
  { dir: 'mipmap-hdpi', size: 162 },
  { dir: 'mipmap-xhdpi', size: 216 },
  { dir: 'mipmap-xxhdpi', size: 324 },
  { dir: 'mipmap-xxxhdpi', size: 432 },
]

async function gen() {
  const src = await Jimp.read(SRC_ICON)

  // 生成 ic_launcher.png（普通图标）
  for (const { dir, size } of sizes) {
    const out = join(RES, dir, 'ic_launcher.png')
    await src.clone().resize({ w: size, h: size }).write(out)
    console.log(`  ${dir}/ic_launcher.png (${size}x${size})`)
  }

  // 生成 ic_launcher_round.png（圆形图标，同一图片即可）
  for (const { dir, size } of sizes) {
    const out = join(RES, dir, 'ic_launcher_round.png')
    await src.clone().resize({ w: size, h: size }).write(out)
    console.log(`  ${dir}/ic_launcher_round.png (${size}x${size})`)
  }

  // 生成 ic_launcher_foreground.png（自适应图标前景）
  for (const { dir, size } of fgSizes) {
    const out = join(RES, dir, 'ic_launcher_foreground.png')
    // foreground 需要留边距（safe zone 中心 66dp），简单处理：缩放图标到 62% 居中放在白底上
    const bg = new Jimp({ width: size, height: size, color: 0xFFFFFFFF }) // 白底
    const fgSize = Math.floor(size * 0.62)
    const fg = src.clone().resize({ w: fgSize, h: fgSize })
    const x = Math.floor((size - fgSize) / 2)
    const y = Math.floor((size - fgSize) / 2)
    bg.composite(fg, x, y)
    await bg.write(out)
    console.log(`  ${dir}/ic_launcher_foreground.png (${size}x${size})`)
  }

  console.log('Done!')
}

gen().catch(e => { console.error(e); process.exit(1) })
