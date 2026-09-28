// resources/ 의 대용량 모델·실행 파일을 원래 출처에서 내려받아 SHA-256으로 검증합니다.
// 주소와 해시는 resources/*/PROVENANCE.txt 에 기록된 값과 같습니다.
//   node scripts/fetch-resources.mjs          이미 있는 파일은 건너뜀
//   node scripts/fetch-resources.mjs --force  모두 다시 받음
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')

// whisper.cpp 빌드: 압축 파일 하나에서 필요한 파일만 꺼냅니다.
const WHISPER_ZIP = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip',
  sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
  files: ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-alderlake.dll', 'ggml-cpu-cannonlake.dll',
    'ggml-cpu-cascadelake.dll', 'ggml-cpu-haswell.dll', 'ggml-cpu-icelake.dll', 'ggml-cpu-sandybridge.dll', 'ggml-cpu-skylakex.dll',
    'ggml-cpu-sse42.dll', 'ggml-cpu-x64.dll', 'ggml-cuda.dll', 'cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll',
    'msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
}

const DOWNLOADS = [
  { to: 'resources/speech/models/ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { to: 'resources/speech/models/ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  { to: 'resources/speech/models/ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin', sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf' },
  { to: 'resources/face/face_detection_yunet_2023mar.onnx', url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx', sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  { to: 'resources/face/face_recognition_sface_2021dec.onnx', url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx', sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
  { to: 'resources/separation/UVR-MDX-NET-Voc_FT.onnx', url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx', sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111' }
]

// resources/vcruntime 은 speech/bin 에 받은 같은 이름 파일을 복사해 채웁니다.
const VCRUNTIME = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

const hashOf = file => {
  const h = createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let got = 0, shown = 0
  for await (const chunk of res.body) {
    got += chunk.length
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
    if (got - shown > 20 * 1024 * 1024) { shown = got; process.stdout.write(`\r    ${mb(got)}${total ? ` / ${mb(total)}` : ''}   `) }
  }
  await new Promise((r, j) => out.end(e => e ? j(e) : r()))
  process.stdout.write('\r')
  fs.renameSync(tmp, dest)
}

// 검증에 통과한 파일이 이미 있으면 true.
function present(file, sha256) {
  if (force || !fs.existsSync(file)) return false
  if (hashOf(file) === sha256) return true
  console.log(`  해시가 달라 다시 받습니다: ${path.relative(root, file)}`)
  return false
}

async function fetchOne({ to, url, sha256 }) {
  const dest = path.join(root, to)
  if (present(dest, sha256)) { console.log(`  건너뜀 (이미 있음): ${to}`); return }
  console.log(`  받는 중: ${to}`)
  await download(url, dest)
  const got = hashOf(dest)
  if (got !== sha256) { fs.rmSync(dest, { force: true }); throw new Error(`해시 불일치: ${to}\n  기대: ${sha256}\n  실제: ${got}`) }
  console.log(`  완료: ${to} (${mb(fs.statSync(dest).size)})`)
}

async function fetchWhisper() {
  const bin = path.join(root, 'resources/speech/bin')
  const have = WHISPER_ZIP.files.every(f => fs.existsSync(path.join(bin, f)))
  if (have && !force) { console.log('  건너뜀 (이미 있음): resources/speech/bin'); return false }
  const zip = path.join(root, 'resources/speech/whisper-bin.zip')
  if (!present(zip, WHISPER_ZIP.sha256)) {
    console.log('  받는 중: whisper.cpp b5130 (CUDA 12.4) 압축 파일')
    await download(WHISPER_ZIP.url, zip)
    const got = hashOf(zip)
    if (got !== WHISPER_ZIP.sha256) { fs.rmSync(zip, { force: true }); throw new Error(`해시 불일치: whisper 압축 파일\n  기대: ${WHISPER_ZIP.sha256}\n  실제: ${got}`) }
  }
  const staging = path.join(root, 'resources/speech/.unzip')
  fs.rmSync(staging, { recursive: true, force: true })
  console.log('  압축 푸는 중…')
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staging}' -Force`], { windowsHide: true })
  fs.mkdirSync(bin, { recursive: true })
  const found = new Map()
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!found.has(e.name)) found.set(e.name, p) } }
  walk(staging)
  const missing = []
  for (const f of WHISPER_ZIP.files) {
    const src = found.get(f)
    if (!src) { missing.push(f); continue }
    fs.copyFileSync(src, path.join(bin, f))
  }
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(zip, { force: true })
  if (missing.length) throw new Error(`압축 파일에 없는 항목: ${missing.join(', ')}`)
  console.log(`  완료: resources/speech/bin (${WHISPER_ZIP.files.length}개)`)
  return true
}

function fillVcruntime() {
  const from = path.join(root, 'resources/speech/bin'), to = path.join(root, 'resources/vcruntime')
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const f of VCRUNTIME) {
    const src = path.join(from, f)
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(to, f)); n++ }
  }
  // 이 세 개는 whisper 압축 파일에 없습니다. 설치된 Windows에서 가져옵니다.
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  for (const f of ['msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'concrt140.dll']) {
    const src = path.join(system32, f), dest = path.join(to, f)
    if (fs.existsSync(dest)) { n++; continue }
    if (fs.existsSync(src)) { fs.copyFileSync(src, dest); n++ }
    else console.log(`  안내: ${f} 를 찾지 못했습니다. Visual C++ 2015-2022 재배포 패키지를 설치한 뒤 다시 실행하세요.`)
  }
  console.log(`  완료: resources/vcruntime (${n}개)`)
}

async function main() {
  console.log('Veil Studio — 모델·실행 파일 내려받기\n')
  const fresh = await fetchWhisper()
  for (const d of DOWNLOADS) await fetchOne(d)
  fillVcruntime()
  if (fresh) {
    console.log('\n  whisper-cli.exe 매니페스트를 UTF-8 코드 페이지로 바꾸는 중 (한글 경로 대응)…')
    execFileSync(process.execPath, [path.join(root, 'scripts/utf8-manifest.cjs'), path.join(root, 'resources/speech/bin/whisper-cli.exe')], { stdio: 'inherit' })
  }
  console.log('\n끝났습니다. `npm start` 로 실행하거나 `npm run dist` 로 설치 파일을 만드세요.')
}

main().catch(e => { console.error(`\n실패: ${e.message}`); process.exit(1) })
