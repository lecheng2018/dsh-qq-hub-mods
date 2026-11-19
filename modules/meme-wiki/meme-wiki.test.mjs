// 梗百科模块测试：跑 run.mjs 自测链路（不联网、不读外部数据）。
// 移植自上游 meme-wiki 的 rules.test；node:sqlite 在 Node 22 需要 --experimental-sqlite，
// 新版本（23.4+）不带 flag 也有这个内建模块——flag 在新旧版本上都被接受。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('梗百科：提示词稳定、面板统计与原有查梗功能', () => {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', fileURLToPath(new URL('./run.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
})
