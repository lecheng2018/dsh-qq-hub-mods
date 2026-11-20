// Build the registry index without performing I/O so release orchestration can verify assets first.
// CLI: node scripts/publish-index.mjs --release dist/release.json [--previous index.json] --out index.json
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './lib/validation.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_BASE = 'https://github.com/lecheng2018/dsh-qq-hub-mods/releases/download/'

export function buildIndex({ release = [], previous = { modules: [] }, revoked = [], generatedAt = new Date().toISOString(), assetsBase = ASSETS_BASE } = {}) {
  if (!Array.isArray(release)) throw new TypeError('release must be an array')
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new TypeError('previous must be an object')
  if (!Array.isArray(revoked)) throw new TypeError('revoked must be an array')
  const byId = new Map()
  for (const entry of previous.modules || []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  for (const entry of release) {
    if (!entry || typeof entry.id !== 'string') throw new TypeError('release entries need an id')
    const existing = byId.get(entry.id)
    if (existing) {
      const order = compareVersions(entry.version, existing.version)
      if (order < 0) continue
      if (order === 0) {
        if (existing.version !== entry.version) {
          throw new Error(`Refusing to replace ${entry.id} ${existing.version} with equivalent-precedence ${entry.version}`)
        }
        const nextPath = `${entry.tag}/${entry.file}`
        if (existing.sha256 && (existing.sha256 !== entry.sha256 || existing.size !== entry.size || existing.path !== nextPath)) {
          throw new Error(`Refusing to replace ${entry.id} ${entry.version} with different release content`)
        }
        byId.set(entry.id, {
          id: entry.id, name: entry.name, version: entry.version, description: entry.description || '',
          category: entry.category || '', tags: entry.tags || [], author: entry.author || '', license: entry.license || '',
          api: entry.api, minPluginVersion: entry.minPluginVersion || '', requires: entry.requires || [],
          capabilities: entry.capabilities || [], replacesBuiltin: entry.replacesBuiltin || false,
          path: nextPath, sha256: entry.sha256, size: entry.size, commit: entry.commit || '',
        })
        continue
      }
    }
    byId.set(entry.id, {
      id: entry.id, name: entry.name, version: entry.version, description: entry.description || '',
      category: entry.category || '', tags: entry.tags || [], author: entry.author || '', license: entry.license || '',
      api: entry.api, minPluginVersion: entry.minPluginVersion || '', requires: entry.requires || [],
      capabilities: entry.capabilities || [], replacesBuiltin: entry.replacesBuiltin || false,
      path: `${entry.tag}/${entry.file}`, sha256: entry.sha256, size: entry.size, commit: entry.commit || '',
    })
  }
  return {
    schema: 1,
    generatedAt,
    assetsBase,
    modules: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    revoked,
  }
}

function arg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] || '' : ''
}

export function main(argv = process.argv.slice(2)) {
  const releasePath = resolve(arg(argv, '--release') || join(ROOT, 'dist/release.json'))
  const previousPath = arg(argv, '--previous')
  const outputPath = resolve(arg(argv, '--out') || join(ROOT, 'index.json'))
  const release = JSON.parse(readFileSync(releasePath, 'utf8'))
  const previous = previousPath ? JSON.parse(readFileSync(resolve(previousPath), 'utf8')) : { modules: [] }
  const revoked = JSON.parse(readFileSync(join(ROOT, 'revoked.json'), 'utf8')).revoked || []
  const index = buildIndex({ release, previous, revoked })
  writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`索引写好了：${index.modules.length} 个模块，${revoked.length} 条撤回`)
  return index
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
