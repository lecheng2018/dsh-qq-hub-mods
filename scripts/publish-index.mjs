// 生成 registry 索引 index.json（schema:1）。
// node scripts/publish-index.mjs --release dist/release.json [--previous 旧index.json] --out index.json
// 本次没打包的模块保留旧条目（幂等）；revoked 从 revoked.json 同步。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : '' }
const release = JSON.parse(readFileSync(arg('--release') || join(ROOT, 'dist/release.json'), 'utf8'))
const previousPath = arg('--previous')
const previous = previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')) : { modules: [] }
const revoked = JSON.parse(readFileSync(join(ROOT, 'revoked.json'), 'utf8')).revoked || []

const ASSETS_BASE = 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/'
const byId = new Map()
for (const e of previous.modules || []) byId.set(e.id, e)
for (const e of release) {
  byId.set(e.id, {
    id: e.id, name: e.name, version: e.version, description: e.description || '',
    category: e.category || '', tags: e.tags || [], author: e.author || '', license: e.license || '',
    api: e.api, minPluginVersion: e.minPluginVersion || '', requires: e.requires || [],
    capabilities: e.capabilities || [], replacesBuiltin: e.replacesBuiltin || false,
    path: `${e.tag}/${e.file}`, sha256: e.sha256, size: e.size, commit: e.commit || '',
  })
}
const index = { schema: 1, generatedAt: new Date().toISOString(), assetsBase: ASSETS_BASE, modules: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), revoked }
writeFileSync(arg('--out') || join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n')
console.log(`索引写好了：${index.modules.length} 个模块，${revoked.length} 条撤回`)
