import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { packRepository } from './pack.mjs'
import { validateArtifact } from './lib/artifact.mjs'
import { createRepository } from './fixtures/repository.mjs'

function recordFor(record, bytes) {
  return { ...record, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
function replaceEntry(bytes, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to))
  const changed = Buffer.from(bytes)
  let cursor = 0
  let count = 0
  for (;;) {
    const offset = changed.indexOf(Buffer.from(from), cursor)
    if (offset < 0) break
    changed.write(to, offset, 'utf8')
    cursor = offset + Buffer.byteLength(to)
    count++
  }
  assert.equal(count, 2, 'replace both local and central name')
  return changed
}

test('artifact rejects traversal, Windows paths and digest corruption in real ZIP bytes', t => {
  const { repository } = createRepository(t)
  const [record] = packRepository(repository, { requireClean: true })
  const bytes = readFileSync(join(repository, 'dist', record.file))
  const report = validateArtifact(bytes, record)
  assert.equal(report.files, 4)
  assert.ok(report.unpackedBytes > 0)
  for (const name of ['../xx.mjs', 'xx\\xx.mjs', 'x:x:xx.js', 'CON.x.mjs']) {
    const changed = replaceEntry(bytes, 'index.mjs', name)
    assert.throws(() => validateArtifact(changed, recordFor(record, changed)), /unsafe/i)
  }
  const corrupt = Buffer.from(bytes)
  corrupt[40] ^= 1
  assert.throws(() => validateArtifact(corrupt, record), /SHA-256/)
})

test('artifact rejects CRC mismatch, duplicate paths, ZIP byte and expanded-file limits', t => {
  const { repository } = createRepository(t)
  const [record] = packRepository(repository, { requireClean: true })
  const bytes = readFileSync(join(repository, 'dist', record.file))
  assert.throws(() => validateArtifact(bytes, record, { limits: { maxZipBytes: bytes.length - 1 } }), /ZIP exceeds/)
  assert.throws(() => validateArtifact(bytes, record, { limits: { maxUnpackedBytes: 1 } }), /unpacked/)
  assert.throws(() => validateArtifact(bytes, record, { limits: { maxFiles: 1 } }), /files/)
  const crc = Buffer.from(bytes)
  const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  crc.writeUInt32LE(0, 14)
  crc.writeUInt32LE(0, central + 16)
  assert.throws(() => validateArtifact(crc, recordFor(record, crc)), /CRC32/)
  const duplicate = replaceEntry(bytes, 'index.mjs', 'README.md')
  assert.throws(() => validateArtifact(duplicate, recordFor(record, duplicate)), /duplicate|conflicting/i)
})
