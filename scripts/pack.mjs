// 打包模块：zip（deflate，不加密）+ release.json（sha256/size/commit）。
// node scripts/pack.mjs [--out dist] [--only a,b] [--missing]
// --missing：跳过已打 tag 的版本。测试文件（*.test.mjs / test/ / fixtures/）不进包。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : '' }
const out = join(ROOT, arg('--out') || 'dist')
const only = new Set(arg('--only').split(',').filter(Boolean))
const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const commit = git('rev-parse', 'HEAD')
const tags = new Set(process.argv.includes('--missing') ? git('tag', '-l').split('\n') : [])

function walk(dir, base = dir) {
  const files = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'test' || e.name === 'fixtures') continue
      files.push(...walk(p, base))
    } else if (!/\.test\.mjs$/.test(e.name)) files.push(p)
  }
  return files
}

/** 最小 zip 写入器：deflate(8)，UTF-8 文件名，正确 CRC32 —— 与客户端四重防护兼容。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of files) {
    const path = Buffer.from(name, 'utf8')
    const body = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // UTF-8
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

mkdirSync(out, { recursive: true })
const built = []
for (const e of readdirSync(join(ROOT, 'modules'), { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue
  if (only.size && !only.has(e.name)) continue
  const dir = join(ROOT, 'modules', e.name)
  const m = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'))
  const tag = `${m.id}-v${m.version}`
  if (tags.has(tag)) continue
  const files = walk(dir).map((p) => [relative(dir, p).split('\\').join('/'), readFileSync(p)])
  const buf = makeZip(files)
  const file = `${m.id}.zip`
  writeFileSync(join(out, file), buf)
  built.push({ ...m, tag, file, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), commit })
  console.log(`✓ ${file}（${buf.length} 字节，sha256 ${built[built.length - 1].sha256}）`)
}
writeFileSync(join(out, 'release.json'), JSON.stringify(built, null, 2) + '\n')
console.log(`打包了 ${built.length} 个模块`)
