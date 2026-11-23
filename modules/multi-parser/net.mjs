import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function isPrivateIp(ip) {
  if (!ip) return true
  if (ip.includes(':')) {
    const s = ip.toLowerCase()
    if (s.startsWith('::ffff:')) {
      const rest = s.slice(7)
      if (rest.includes('.')) {
        if (isIP(rest) === 4) return isPrivateIp(rest)
      } else {
        const hex = rest.split(':').map((h) => parseInt(h, 16))
        if (hex.length === 2 && !hex.some(isNaN)) {
          const v4 = [(hex[0] >> 8) & 0xff, hex[0] & 0xff, (hex[1] >> 8) & 0xff, hex[1] & 0xff].join('.')
          return isPrivateIp(v4)
        }
      }
    }
    return s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
      /^fe[89ab]/i.test(s) || s === '::' || s.startsWith('100::')
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
}

export async function assertPublicUrl(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http / https')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((x) => x.address)
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('不允许访问内网地址')
}
