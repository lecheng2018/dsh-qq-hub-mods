// 群参与分级 · 有界版本化存储（T3.4）。
//
// 红线：
//   · 只写 api.dataDir('feedback.json') 一个文件，绝不读其他模块目录；
//   · 只序列化白名单字段（pending / recentResultKeys / recentTurnIds / 结果计数 / 反馈计数 /
//     bias / lastReactAt / 连续失败数 / circuitUntil / lastActiveAt），绝不持久化聊天正文、
//     完整 msg、raw、reply 或异常堆栈；
//   · 单一写入 Promise 队列串行化；同目录临时文件写完 rename 原子替换；写盘失败保留旧正式
//     文件并报告，绝不先删旧文件；
//   · 启动校验 version 与字段类型：版本不匹配 = degraded 且拒绝覆盖；字段非法回默认；
//   · pending / recentResultKeys / recentTurnIds / 群数量超上限时淘汰最旧项；
//   · dispose 停止接收新变更，已排队写入收尾（不宣称宿主一定 await 异步 dispose）。
//
// 文件系统边界可注入（fsOps），供测试模拟写盘失败 / 重启；默认走真实 node:fs。

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STORE_VERSION = 1

const PENDING_WHITELIST = new Set(['turnId', 'chatId', 'participation', 'triggerMessageIds', 'createdAt', 'expiresAt', 'followupCount', 'followupSpeakerIds'])
const NUMERIC_FIELDS = ['bias', 'lastReactAt', 'consecutiveFailures', 'circuitUntil', 'lastActiveAt', 'reactUnknownCount']
const COUNT_FIELDS = ['resultCounts', 'feedbackCounts']

const realFsOps = {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
}

const defaultBucket = () => ({
  pending: [],
  recentResultKeys: [],
  recentTurnIds: [],
  resultCounts: {},
  feedbackCounts: {},
  bias: 0,
  lastReactAt: 0,
  consecutiveFailures: 0,
  circuitUntil: 0,
  reactUnknownCount: 0,
  lastActiveAt: 0,
})

function sanitizePending(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const out = {}
  for (const key of PENDING_WHITELIST) {
    if (entry[key] === undefined) continue
    if (key === 'triggerMessageIds') {
      out[key] = Array.isArray(entry[key]) ? entry[key].map(String).slice(0, 64) : []
    } else if (key === 'turnId' || key === 'chatId' || key === 'participation') {
      out[key] = String(entry[key] || '')
    } else if (key === 'followupSpeakerIds') {
      out[key] = Array.isArray(entry[key]) ? entry[key].map(String).slice(0, 16) : []
    } else {
      const n = Number(entry[key])
      out[key] = Number.isFinite(n) ? n : 0
    }
  }
  return out.turnId && out.chatId ? out : null
}

function sanitizeBucket(raw) {
  const bucket = defaultBucket()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bucket
  if (Array.isArray(raw.pending)) {
    for (const entry of raw.pending) {
      const clean = sanitizePending(entry)
      if (clean) bucket.pending.push(clean)
    }
  }
  for (const key of ['recentResultKeys', 'recentTurnIds']) {
    if (Array.isArray(raw[key])) bucket[key] = raw[key].filter((v) => typeof v === 'string' && v)
  }
  for (const key of COUNT_FIELDS) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
      for (const [name, count] of Object.entries(raw[key])) {
        const n = Number(count)
        if (typeof name === 'string' && name && Number.isFinite(n) && n >= 0) bucket[key][name] = n
      }
    }
  }
  for (const key of NUMERIC_FIELDS) {
    const n = Number(raw[key])
    if (Number.isFinite(n)) bucket[key] = n
  }
  return bucket
}

/**
 * @param {string} filePath 完整文件路径（调用方固定传 api.dataDir('feedback.json')）
 * @param {object} o
 * @param {number} o.maxGroups 群数量上限（超出淘汰最旧 lastActiveAt）
 * @param {number} o.maxPendingPerGroup 每群 pending 上限
 * @param {number} o.maxRecentKeysPerGroup 每群 recentResultKeys / recentTurnIds 上限
 * @param {(message: string) => void} [o.onError] 写盘失败 / degraded 报告口
 * @param {object} [o.fsOps] 文件系统边界注入（测试用）
 */
export function createGroupEngagementStore(filePath, {
  maxGroups = 200,
  maxPendingPerGroup = 32,
  maxRecentKeysPerGroup = 128,
  onError = () => {},
  fsOps = realFsOps,
} = {}) {
  const buckets = new Map() // chatId -> bucket（内存真相）
  let degraded = ''
  let disposed = false
  let writeQueue = Promise.resolve()

  // ---- 启动加载 + 校验 ----
  try {
    if (fsOps.existsSync(filePath)) {
      const text = String(fsOps.readFileSync(filePath, 'utf8'))
      let data
      try { data = JSON.parse(text) } catch (error) {
        degraded = `损坏的 JSON（${error.message}）；保持旧文件不动，本轮全部按空库运行`
      }
      if (!degraded) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          degraded = '结构不是对象；保持旧文件不动'
        } else if (Number(data.version) !== STORE_VERSION) {
          degraded = `版本不匹配（文件 ${String(data.version)} ≠ ${STORE_VERSION}）；拒绝覆盖`
        } else {
          const groups = data.groups && typeof data.groups === 'object' && !Array.isArray(data.groups) ? data.groups : {}
          for (const [chatId, raw] of Object.entries(groups)) {
            if (typeof chatId !== 'string' || !chatId) continue
            buckets.set(chatId, sanitizeBucket(raw))
          }
        }
      }
      if (degraded) onError(`[群参与] feedback.json 进入 degraded：${degraded}`)
    }
  } catch (error) {
    degraded = `读取失败：${error.message}`
    onError(`[群参与] feedback.json 进入 degraded：${degraded}`)
  }

  function evictGroups() {
    while (buckets.size > Math.max(1, maxGroups)) {
      // 淘汰最旧的 lastActiveAt（保持相对顺序稳定）
      let oldestKey = null
      let oldestAt = Infinity
      for (const [chatId, bucket] of buckets) {
        const at = Number(bucket.lastActiveAt) || 0
        if (at < oldestAt || (at === oldestAt && oldestKey === null)) { oldestAt = at; oldestKey = chatId }
      }
      if (!oldestKey) break
      buckets.delete(oldestKey)
    }
  }

  function sanitizeForDisk(data) {
    // 只允许白名单结构出盘：version + groups + savedAt
    const groups = {}
    for (const [chatId, bucket] of buckets) {
      groups[chatId] = sanitizeBucket(bucket)
    }
    return { version: STORE_VERSION, savedAt: Date.now(), groups }
  }

  function persistNow() {
    // 同目录临时文件写完再 rename：崩溃/失败都保留旧正式文件
    const tmpPath = `${filePath}.tmp`
    const dir = dirname(filePath)
    fsOps.mkdirSync(dir, { recursive: true })
    fsOps.writeFileSync(tmpPath, JSON.stringify(sanitizeForDisk(buckets)), 'utf8')
    fsOps.renameSync(tmpPath, filePath)
  }

  function enqueueWrite() {
    if (degraded) return writeQueue // degraded：拒绝覆盖文件
    writeQueue = writeQueue.then(() => { persistNow() }).catch((error) => {
      onError(`[群参与] feedback.json 写盘失败（旧文件已保留）：${error.message}`)
    })
    return writeQueue
  }

  return {
    /** 只读快照（含默认桶）；缺省字段一律回默认值。 */
    getBucket(chatId) {
      const key = String(chatId || '')
      return { ...defaultBucket(), ...(buckets.get(key) || {}) }
    },

    /** 串行化变更：mutator 拿到白名单桶对象就地改，返回后进入写入队列。 */
    mutate(chatId, mutator) {
      if (disposed) return Promise.resolve(false)
      const key = String(chatId || '')
      if (!key) return Promise.resolve(false)
      const beforeActiveAt = Number(buckets.get(key)?.lastActiveAt) || 0
      const bucket = { ...defaultBucket(), ...(buckets.get(key) || {}) }
      try { mutator(bucket) } catch (error) {
        onError(`[群参与] 变更被拒绝：${error.message}`)
        return Promise.resolve(false)
      }
      // 上限淘汰
      if (bucket.pending.length > maxPendingPerGroup) bucket.pending = bucket.pending.slice(-maxPendingPerGroup)
      for (const key2 of ['recentResultKeys', 'recentTurnIds']) {
        if (bucket[key2].length > maxRecentKeysPerGroup) bucket[key2] = bucket[key2].slice(-maxRecentKeysPerGroup)
      }
      bucket.pending = bucket.pending.map((p) => sanitizePending(p)).filter(Boolean)
      // 自动 touch：mutator 显式设置过 lastActiveAt 时不覆盖（结算/测试需要确定性时间戳）
      if (Number(bucket.lastActiveAt) === Number(beforeActiveAt)) bucket.lastActiveAt = Date.now()
      buckets.set(key, bucket)
      evictGroups()
      return enqueueWrite()
    },

    /** 全部群（只读键列表，淘汰后）。 */
    groupIds() { return [...buckets.keys()] },

    /** 存储健康（degraded 原因 / 版本 / 群数）。 */
    health() { return { degraded: degraded || null, version: STORE_VERSION, groups: buckets.size, disposed } },

    /** 等待已排队写入收尾（测试/优雅关闭用）。 */
    flush() { return writeQueue },

    /** 停止接收新变更；已排队写入收尾。幂等。 */
    dispose() {
      if (disposed) return Promise.resolve(true)
      disposed = true
      return writeQueue.then(() => true).catch(() => true)
    },
  }
}
