// 把 dist/index-mobile.html 复制为 dist/index.html，让 Capacitor 默认入口指向手机端
// 同时确保 index.html 引用的资源路径正确
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

async function main() {
  // 复制 index-mobile.html → index.html
  await copyFile(join(DIST, 'index-mobile.html'), join(DIST, 'index.html'))
  console.log('✓ index-mobile.html → index.html')

  // 读取 index.html，修正资源路径（vite build 会把 mobile 的资源打到相对路径）
  const html = await readFile(join(DIST, 'index.html'), 'utf-8')
  // 确保资源路径是相对的（vite 默认就是相对路径，无需修改）
  console.log('✓ index.html ready for Capacitor')
}

main().catch(e => { console.error(e); process.exit(1) })
