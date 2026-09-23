// 打包完成后：把 portable exe 复制到 release/ 单独存放（避免与 vite 的 dist/ 输出目录混在一起被下次 build 清空）
import fs from 'fs'
import path from 'path'

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const exe = path.join('dist', `AnimeShelf-${version}-portable.exe`)
if (!fs.existsSync(exe)) {
  console.error('未找到打包产物:', exe)
  process.exit(1)
}
fs.mkdirSync('release', { recursive: true })
const dest = path.join('release', 'AnimeShelf-portable.exe')
fs.copyFileSync(exe, dest)
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'docs/THIRD-PARTY.md', 'docs/ASSET-PROVENANCE.md', 'docs/PRIVACY.md']) {
  fs.copyFileSync(file, path.join('release', path.basename(file)))
}
fs.cpSync('licenses', 'release/licenses', { recursive: true })
for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
  fs.copyFileSync(path.join('node_modules/electron/dist', file), path.join('release', file === 'LICENSE' ? 'LICENSE.electron.txt' : file))
}
console.log(`✓ 产物已复制到 ${dest}`)
