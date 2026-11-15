// 校验全部模块清单。node scripts/check.mjs [--base <git引用>]
// 带 --base：改过的模块必须升版本；已发布版本（tag <id>-v<version>）内容不可变。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const API_MAX = 1
const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const listModules = () => readdirSync(join(ROOT, 'modules'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
  .map((d) => ({ id: d.name, dir: join(ROOT, 'modules', d.name) }))
const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'))
const compareVersions = (a, b) => {
  const x = String(a).split('-')[0].split('.').map(Number)
  const y = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  return 0
}

function checkModule(mod, known) {
  const errors = []
  let m
  try { m = readManifest(mod.dir) } catch (e) { return { errors: [`module.json 读不到或不是 JSON：${e.message}`], warnings: [] } }
  if (m.id !== mod.id) errors.push(`id「${m.id}」和文件夹名「${mod.id}」不一致`)
  if (!ID_RE.test(String(m.id || ''))) errors.push('id 要小写字母开头，只含小写字母/数字/连字符，2-40 位')
  for (const key of ['name', 'version', 'description', 'author', 'license']) if (!m[key] || typeof m[key] !== 'string') errors.push(`缺必填字段 ${key}`)
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ''))) errors.push('version 要是 semver（x.y.z）')
  if (m.api !== API_MAX) errors.push(`api 要是 ${API_MAX}（当前宿主接口版本）`)
  if (m.minPluginVersion && !/^\d+\.\d+\.\d+/.test(String(m.minPluginVersion))) errors.push('minPluginVersion 要是 semver')
  for (const dep of m.requires || []) if (!known.has(dep)) errors.push(`requires 里的「${dep}」不存在`)
  if (!existsSync(join(mod.dir, 'index.mjs')) && !existsSync(join(mod.dir, 'index.js'))) errors.push('缺入口 index.mjs')
  if (!existsSync(join(mod.dir, 'README.md'))) errors.push('缺 README.md')
  if (!existsSync(join(mod.dir, 'LICENSE'))) errors.push('缺 LICENSE')
  const warnings = []
  if (!Array.isArray(m.capabilities)) warnings.push('建议声明 capabilities（展示用，不是安全边界）')
  return { errors, warnings }
}

const baseIndex = process.argv.indexOf('--base')
const base = baseIndex > 0 ? process.argv[baseIndex + 1] : ''
const mods = listModules()
const known = new Set(mods.map((m) => m.id))
let failed = false
for (const mod of mods) {
  const { errors, warnings } = checkModule(mod, known)
  if (!errors.length) {
    const version = readManifest(mod.dir).version
    const tag = `${mod.id}-v${version}`
    if (git('tag', '-l', tag)) {
      if (git('diff', '--name-only', tag, 'HEAD', '--', `modules/${mod.id}`)) errors.push(`${version} 已经发布过，内容又变了：要升版本号`)
    } else if (base && git('diff', '--name-only', `${base}...HEAD`, '--', `modules/${mod.id}`)) {
      let before = ''
      try { before = JSON.parse(git('show', `${base}:modules/${mod.id}/module.json`)).version } catch { /* 新模块 */ }
      if (before && compareVersions(version, before) <= 0) errors.push(`模块改了，version 要比 ${before} 高`)
    }
  }
  for (const w of warnings) console.log(`⚠ ${mod.id}：${w}`)
  for (const e of errors) console.error(`✗ ${mod.id}：${e}`)
  if (errors.length) failed = true
  else console.log(`✓ ${mod.id}`)
}
// revoked.json 校验
try {
  const rv = JSON.parse(readFileSync(join(ROOT, 'revoked.json'), 'utf8'))
  for (const r of rv.revoked || []) {
    if (!r.id || !Array.isArray(r.versions) || !r.versions.length || !r.reason) { console.error('✗ revoked.json 条目缺 id/versions/reason'); failed = true }
  }
} catch (e) { console.error(`✗ revoked.json：${e.message}`); failed = true }
console.log(`检查了 ${mods.length} 个模块`)
process.exit(failed ? 1 : 0)
