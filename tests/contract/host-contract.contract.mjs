import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hostDir = process.env.HOST_REPO_DIR
if (!hostDir) throw new Error('HOST_REPO_DIR must be set by scripts/host-contract.mjs')
const strict = process.env.HOST_CONTRACT_STRICT === '1'
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-module-host-contract-'))
const quiet = () => {}
const logger = {
  info: quiet, warn: quiet, error: quiet, debug: quiet,
  child() { return this },
}
const hostUrl = (path) => pathToFileURL(join(hostDir, path)).href

let modulesApi
let configApi
let memoryApi
let mods
let hub
let cfg
let ledgerFile
let transportCalls
let dataRoot

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

before(async () => {
  process.env.DSH_QQ_HUB_DATA_DIR = join(tempDir, 'host-data')
  dataRoot = process.env.DSH_QQ_HUB_DATA_DIR
  mkdirSync(dataRoot, { recursive: true })
  const [loadedModules, loadedConfig] = await Promise.all([
    import(hostUrl('src/core/modules.js')),
    import(hostUrl('src/core/config.js')),
  ])
  modulesApi = loadedModules
  configApi = loadedConfig
  memoryApi = await import(hostUrl('src/features/memory.js'))
  cfg = configApi.normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    botQQ: '20001',
    allow: { private: ['10001', '10002'], groups: ['30001'] },
    security: { identityGuard: { enabled: false } },
    memory: { enabled: true, recallCount: 8, dailyHour: 23, keepDays: 30, autoExtract: false },
  })
  transportCalls = []
  const onebot = {
    async call(action, params, opts) {
      transportCalls.push({ action, params, opts })
      return { message_id: `transport-${transportCalls.length}` }
    },
  }
  ledgerFile = join(tempDir, 'deliveries.json')
  const sharedOutbox = (await import(hostUrl('src/host/shared-outbox.js'))).createSharedOutbox({
    onebot,
    getConfig: () => cfg,
    log: logger,
    ledgerFile,
  })
  const egress = (await import(hostUrl('src/host/hub-egress.js'))).createHubEgress({ outbox: sharedOutbox, log: logger })
  const currentHub = (await import(hostUrl('src/host/current-hub.js'))).createCurrentHub({
    modular: { services: {} },
    chatLog: {},
    recentMedia: { get: () => null },
    inboundAudio: { transcribeLocally: async () => null },
    interactions: {
      approvals: { handleReply: () => false, clear: quiet },
      questions: { has: () => false, handleReply: quiet, ask: quiet },
    },
    stickerOf: () => null,
    stickers: { collect: async () => ({ ok: false }) },
    getConfig: () => cfg,
    log: logger,
    egress,
  })
  hub = (await import(hostUrl('src/host/module-send-bridge.js'))).createModuleSendBridge({
    hub: currentHub,
    outbox: sharedOutbox,
    log: logger,
    unified: true,
  })

  const fixture = join(repoDir, 'tests', 'contract', 'fixtures', 'contract-module.mjs')
  for (const id of ['contract-a', 'contract-b']) {
    const moduleDir = join(dataRoot, 'modules', id)
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'index.mjs'), readFileSync(fixture, 'utf8').replaceAll('__MODULE_ID__', id), 'utf8')
  }
  mods = modulesApi.createModules({
    ctx: {},
    core: { hub, onebot, logger },
    getConfig: () => cfg,
    setConfig: (next) => { cfg = next; return cfg },
    logger,
    version: 'host-contract-test',
    builtins: [],
  })
  await mods.sync()
})

after(() => {
  try { mods?.dispose() } catch {}
  try { memoryApi?.dispose?.() } catch {}
  delete process.env.DSH_QQ_HUB_DATA_DIR
  delete globalThis.__hostContractEvents
  delete globalThis.__hostContractOffCalls
  delete globalThis.__hostContractDisposeCalls
  rmSync(tempDir, { recursive: true, force: true })
})

test('real module loader starts both fixtures and assigns distinct data directories', () => {
  assert.equal(mods.running('contract-a'), 'user')
  assert.equal(mods.running('contract-b'), 'user')
  const a = mods.use('contract-a').dataPath()
  const b = mods.use('contract-b').dataPath()
  assert.ok(inside(dataRoot, a))
  assert.ok(inside(dataRoot, b))
  assert.notEqual(resolve(a), resolve(b))
  assert.equal(readFileSync(join(a, 'owned.txt'), 'utf8'), 'contract-a')
  assert.equal(readFileSync(join(b, 'owned.txt'), 'utf8'), 'contract-b')
})

test('module sendText and raw api.onebot use the real shared Outbox and delivery ledger', async () => {
  const a = mods.use('contract-a')
  await a.sendText('private:10001', 'contract text outbound')
  await a.sendRaw('private:10001', {
    user_id: 10001,
    message: [{ type: 'text', data: { text: 'contract raw outbound' } }],
  })
  assert.deepEqual(transportCalls.map((call) => call.action), ['send_private_msg', 'send_private_msg'])
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')).deliveries
  assert.equal(ledger.length, 2)
  assert.ok(ledger.every((entry) => entry.state === 'sent'))
  assert.deepEqual(ledger.map((entry) => entry.sourceModuleId), ['module', 'contract-a'])
  assert.ok(ledger.every((entry) => entry.gatewayMessageId?.startsWith('transport-')))
})

test('registered password field is masked; empty saves preserve and null clears', () => {
  cfg = configApi.normalize({ ...cfg, ext: { 'contract-a': { credential: 'contract-secret-value' } } })
  const publicSettings = configApi.publicConfig(cfg).ext['contract-a']
  assert.equal(publicSettings.credential, '')
  assert.equal(publicSettings.credentialSet, true)
  assert.equal(JSON.stringify(publicSettings).includes('contract-secret-value'), false)
  const unchanged = configApi.mergeFromPanel(cfg, { ext: { 'contract-a': { credential: '' } } })
  assert.equal(unchanged.ext['contract-a'].credential, 'contract-secret-value')
  const cleared = configApi.mergeFromPanel(cfg, { ext: { 'contract-a': { credential: null } } })
  assert.equal(cleared.ext['contract-a'].credential, '')
})

test('real memory store isolates two private chats and one group; unknown scope is fail-closed', (t) => {
  const store = memoryApi.createMemoryStore({
    dsh: { get: () => null },
    getConfig: () => cfg,
    hub: { ask: async () => '' },
    log: logger,
  })
  t.after(() => store.dispose())
  const privateA = { chatId: 'private:10001', kind: 'private', userId: '10001' }
  const privateB = { chatId: 'private:10002', kind: 'private', userId: '10002' }
  const group = { chatId: 'group:30001', kind: 'group', groupId: '30001' }
  store.add({ text: 'AsterionQuartz private record for user one', chat: privateA, chatId: privateA.chatId, scope: 'private:10001' })
  store.add({ text: 'BorealisCobalt private record for user two', chat: privateB, chatId: privateB.chatId, scope: 'private:10002' })
  store.add({ text: 'CinnabarJuniper group record for group one', chat: group, chatId: group.chatId, scope: 'group:30001' })
  assert.ok(store.recall('AsterionQuartz', { chat: privateA }).length > 0)
  assert.equal(store.recall('AsterionQuartz', { chat: privateB }).length, 0)
  assert.equal(store.recall('AsterionQuartz', { chat: group }).length, 0)
  assert.ok(store.recall('BorealisCobalt', { chat: privateB }).length > 0)
  assert.equal(store.recall('BorealisCobalt', { chat: privateA }).length, 0)
  assert.equal(store.recall('BorealisCobalt', { chat: group }).length, 0)
  assert.ok(store.recall('CinnabarJuniper', { chat: group }).length > 0)
  assert.equal(store.recall('CinnabarJuniper', { chat: privateA }).length, 0)
  assert.equal(store.recall('CinnabarJuniper', { chat: privateB }).length, 0)
  assert.equal(store.recall('AsterionQuartz').length, 0, 'no chat/scopes is not a chat read')
  assert.equal(store.scopeVisible('', group), false, 'legacy entries without scope are not exposed')
  assert.equal(store.scopeVisible(undefined, privateA), false, 'missing legacy scope is not exposed')
})

test('api.dataDir child paths stay inside each module root (known gap: baseline records real escape)', (t) => {
  const aRoot = mods.use('contract-a').dataPath()
  const bRoot = mods.use('contract-b').dataPath()
  const escapedToOtherModule = mods.use('contract-a').dataPath('../contract-b/escaped.txt')
  assert.ok(inside(dataRoot, aRoot))
  assert.ok(inside(dataRoot, bRoot))
  if (!strict) {
    assert.equal(resolve(escapedToOtherModule), resolve(bRoot, 'escaped.txt'))
    assert.ok(existsSync(join(bRoot, 'owned.txt')))
    console.warn('KNOWN GAP SEC-03: host api.dataDir("../contract-b/escaped.txt") resolves into contract-b data; baseline is NOT FULL SECURITY')
    return
  }
  assert.ok(inside(aRoot, escapedToOtherModule), `api.dataDir escaped module root: ${escapedToOtherModule}`)
})

test('disabling a loaded module removes listeners and invokes both cleanup hooks', async () => {
  globalThis.__hostContractEvents = 0
  globalThis.__hostContractOffCalls = 0
  globalThis.__hostContractDisposeCalls = 0
  mods.emit('host-contract:tick')
  assert.equal(globalThis.__hostContractEvents, 2)
  cfg = { ...cfg, modules: { ...(cfg.modules || {}), 'contract-a': { enabled: false } } }
  await mods.sync()
  assert.equal(mods.running('contract-a'), null)
  assert.equal(globalThis.__hostContractOffCalls, 1)
  assert.equal(globalThis.__hostContractDisposeCalls, 1)
  mods.emit('host-contract:tick')
  assert.equal(globalThis.__hostContractEvents, 3, 'disabled module listener no longer receives events')
  cfg = { ...cfg, modules: { ...(cfg.modules || {}), 'contract-b': { enabled: false } } }
  await mods.sync()
  assert.equal(mods.running('contract-b'), null)
  assert.equal(globalThis.__hostContractOffCalls, 2)
  assert.equal(globalThis.__hostContractDisposeCalls, 2)
})
