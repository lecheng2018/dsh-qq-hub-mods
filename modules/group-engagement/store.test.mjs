// T3.4 存储真实行为测试：注入文件系统边界（任务书允许 mock 文件系统边界），
// 覆盖串行化写入、tmp+rename 原子替换、写失败保留旧文件、degraded、版本拒绝、
// 类型回默认、容量淘汰、dispose 收尾。
import test from 'node:test'
import assert from 'node:assert/strict'

const FILE = '/data/group-engagement/feedback.json'

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const ops = {
    existsSync: (p) => files.has(String(p)),
    readFileSync: (p) => {
      if (!files.has(String(p))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return files.get(String(p))
    },
    writeFileSync: (p, text) => { files.set(String(p), text) },
    renameSync: (from, to) => {
      if (!files.has(String(from))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      files.set(String(to), files.get(String(from)))
      files.delete(String(from))
    },
    mkdirSync: () => {},
  }
  return { ops, files }
}

const mkStore = (fsOps, over = {}, errors = []) => import('./store.mjs').then(({ createGroupEngagementStore }) =>
  createGroupEngagementStore(FILE, { onError: (m) => errors.push(m), fsOps, ...over }))

test('首次使用：无文件 → 空库；mutate 后 tmp+rename 落盘（version 1）', async () => {
  const { ops, files } = memoryFs()
  const store = await mkStore(ops)
  assert.equal(store.health().degraded, null)
  assert.deepEqual(store.getBucket('group:30001').pending, [])
  await store.mutate('group:30001', (b) => { b.bias = 0.05 })
  await store.flush()
  const onDisk = JSON.parse(files.get(FILE))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.groups['group:30001'].bias, 0.05)
  assert.equal(files.has(FILE + '.tmp'), false, '临时文件已 rename 消失')
  await store.dispose()
})

test('mutate 串行化：并发多次变更全部按序落盘，不交错', async () => {
  const { ops, files } = memoryFs()
  const store = await mkStore(ops)
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate('group:30001', (b) => { b.bias = i / 100 })))
  await store.flush()
  const onDisk = JSON.parse(files.get(FILE))
  assert.equal(onDisk.groups['group:30001'].bias, 0.19, '最后一次变更生效（队列串行）')
  await store.dispose()
})

test('写盘失败：保留旧正式文件、不删旧内容、错误上报', async () => {
  const { ops, files } = memoryFs()
  const store = await mkStore(ops)
  await store.mutate('group:30001', (b) => { b.bias = 0.1 })
  await store.flush()
  const before = files.get(FILE)
  assert.ok(before, '第一次落盘成功')
  // 注入失败：rename 失败（临时文件写成功、替换失败）
  ops.renameSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e }
  const errors = []
  const store2 = await mkStore(ops, {}, errors)
  // store2 启动加载旧文件（正常），随后写盘失败 → 旧文件保留 + 报告
  await store2.mutate('group:30001', (b) => { b.bias = 0.9 })
  await store2.flush()
  assert.equal(files.get(FILE), before, '旧正式文件原样保留')
  assert.equal(files.has(FILE + '.tmp') && files.get(FILE + '.tmp').includes('0.9'), true, '失败的 tmp 不覆盖正式文件')
  await store2.dispose()
})

test('版本不匹配：degraded + 拒绝覆盖', async () => {
  const { ops, files } = memoryFs({ [FILE]: JSON.stringify({ version: 99, groups: { 'group:30001': { bias: 0.3 } } }) })
  const errors = []
  const store = await mkStore(ops, {}, errors)
  assert.ok(store.health().degraded, '进入 degraded')
  await store.mutate('group:30001', (b) => { b.bias = 0.7 })
  await store.flush()
  const onDisk = JSON.parse(files.get(FILE))
  assert.equal(onDisk.version, 99, '旧文件未被覆盖')
  assert.ok(errors.some((m) => m.includes('degraded')), 'degraded 已上报')
  await store.dispose()
})

test('损坏 JSON：degraded + 空库运行 + 不覆盖', async () => {
  const { ops, files } = memoryFs({ [FILE]: '{not-json' })
  const errors = []
  const store = await mkStore(ops, {}, errors)
  assert.ok(store.health().degraded)
  assert.deepEqual(store.getBucket('group:30001').pending, [])
  await store.mutate('group:30001', (b) => { b.bias = 0.2 })
  await store.flush()
  assert.equal(files.get(FILE), '{not-json', '损坏文件不被覆盖')
  await store.dispose()
})

test('字段类型校验：非法字段回默认，白名单外字段不落盘', async () => {
  const { ops } = memoryFs({ [FILE]: JSON.stringify({
    version: 1,
    groups: {
      'group:30001': {
        pending: [{ turnId: 't1', chatId: 'group:30001', junk: 'x', followupCount: 'not-a-number', raw: { big: 'object' } }, null, 'junk'],
        recentResultKeys: [42, 'k'],
        bias: 'oops',
        secretChatLog: '不该有这个字段',
      },
    },
  }) })
  const store = await mkStore(ops)
  const b = store.getBucket('group:30001')
  assert.equal(b.pending.length, 1, '非法 pending 条目被剔除')
  assert.equal(b.pending[0].turnId, 't1')
  assert.equal(b.pending[0].followupCount, 0, '非法数字回默认')
  assert.equal('raw' in b.pending[0], false, '白名单外字段被剔除')
  assert.equal(b.recentResultKeys.length, 1, '非法键被过滤后保留合法项')
  assert.equal(b.bias, 0, '非法 bias 回默认')
  await store.mutate('group:30001', () => {})
  await store.flush()
  await store.dispose()
})

test('容量淘汰：pending / recent / 群数量超上限淘汰最旧项', async () => {
  const { ops } = memoryFs()
  const store = await mkStore(ops, { maxGroups: 3, maxPendingPerGroup: 4, maxRecentKeysPerGroup: 6 })
  // 先建他群（40005 钉最旧：必被淘汰），最后 push 30001（自动 touch = 最新，不被群淘汰）
  for (const g of ['group:40002', 'group:40003', 'group:40004']) {
    await store.mutate(g, (b) => { b.lastActiveAt = Date.now() })
  }
  await store.mutate('group:40005', (b) => { b.lastActiveAt = 1 })
  for (let i = 0; i < 8; i++) {
    await store.mutate('group:30001', (b) => {
      b.pending.push({ turnId: `t${i}`, chatId: 'group:30001', createdAt: i, expiresAt: Infinity })
      b.recentResultKeys.push(`k${i}`)
      b.recentTurnIds.push(`t${i}`)
    })
  }
  const b = store.getBucket('group:30001')
  assert.equal(b.pending.length, 4, 'pending 淘汰最旧（留 4）')
  assert.equal(b.pending[0].turnId, 't4')
  assert.equal(b.recentResultKeys.length, 6, 'recentResultKeys 留 6')
  assert.equal(b.recentTurnIds.length, 6)
  assert.equal(store.groupIds().length, 3, '群数量淘汰到 3')
  assert.equal(store.groupIds().includes('group:40005'), false, 'lastActiveAt 最旧的群被淘汰')
  await store.dispose()
})

test('dispose：停止接收新变更、已排队写入收尾、重复 dispose 幂等', async () => {
  const { ops, files } = memoryFs()
  const store = await mkStore(ops)
  await store.mutate('group:30001', (b) => { b.bias = 0.3 })
  await store.dispose()
  await store.dispose()
  const after = JSON.parse(files.get(FILE))
  assert.equal(after.groups['group:30001'].bias, 0.3, '已排队写入完成')
  const ok = await store.mutate('group:30001', (b) => { b.bias = 0.8 })
  assert.equal(ok, false, 'dispose 后拒绝新变更')
  assert.equal(JSON.parse(files.get(FILE)).groups['group:30001'].bias, 0.3)
  assert.equal(store.health().disposed, true)
})
