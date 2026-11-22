// 模块测试共用的小工具（不参与运行，只被 *.test.mjs 引用）。
//
// 为什么要有它：1.2.0 起 B 站模块不再 import 插件内部文件，数据目录靠注入。
// 测试里给一个和插件 core/store.js 同形的真文件实现，就能断言落盘、去重、清理这些行为，
// 又不需要起插件进程或改环境变量。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 和插件 core/store.js 同形的最小实现：真文件，每个实例一个临时目录。 */
export function fakeStore() {
  const root = mkdtempSync(join(tmpdir(), 'bili-store-'))
  return {
    root,
    dataDir: (...parts) => join(root, ...parts),
    ensureDir: (p) => mkdirSync(p, { recursive: true }),
    existsSync: (p) => { try { readFileSync(p); return true } catch (error) { return false } },
    readJson: (p, fallback) => {
      try { return JSON.parse(readFileSync(p, 'utf8')) } catch (error) { return typeof fallback === 'function' ? fallback() : fallback }
    },
    writeJson: (p, value) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(value))
    },
  }
}

export const noopLog = { info() {}, warn() {}, debug() {} }
