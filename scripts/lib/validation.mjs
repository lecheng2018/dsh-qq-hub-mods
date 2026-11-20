const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}(?![\s\S])/u
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?![\s\S])/u
const MANIFEST_KEYS = new Set([
  '$schema', 'id', 'name', 'version', 'description', 'author', 'license', 'api',
  'category', 'tags', 'minPluginVersion', 'requires', 'capabilities', 'homepage', 'replacesBuiltin',
])
const REVOCATION_KEYS = new Set(['$schema', 'revoked'])
const REVOCATION_ENTRY_KEYS = new Set(['id', 'versions', 'reason'])

export function isModuleId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function isSemver(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

function parseSemver(value) {
  if (!isSemver(value)) throw new TypeError(`Invalid SemVer: ${String(value)}`)
  const match = SEMVER_PATTERN.exec(value)
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function compareVersions(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  }
  const count = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < count; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === y) continue
    const xNumeric = /^(0|[1-9]\d*)$/u.test(x)
    const yNumeric = /^(0|[1-9]\d*)$/u.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length > b.prerelease.length ? 1 : -1
}

function fail(label, issues) {
  throw new TypeError(`${label}: ${issues.join('; ')}`)
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label, ['must be an object'])
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(label, [`unknown field ${JSON.stringify(key)}`])
}

function assertUniqueStrings(value, label, { id = false } = {}) {
  if (!Array.isArray(value)) fail(label, ['must be an array'])
  const found = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.length || (id && !isModuleId(entry))) {
      fail(label, [`items must be ${id ? 'valid module IDs' : 'nonempty strings'}`])
    }
    if (found.has(entry)) fail(label, [`duplicate value ${JSON.stringify(entry)}`])
    found.add(entry)
  }
}

export function validateManifest(manifest, { expectedId, knownIds } = {}) {
  assertObject(manifest, 'module.json')
  assertKnownKeys(manifest, MANIFEST_KEYS, 'module.json')
  for (const key of ['id', 'name', 'version', 'description', 'author', 'license', 'api']) {
    if (!Object.hasOwn(manifest, key)) fail('module.json', [`missing required field ${key}`])
  }
  if (!isModuleId(manifest.id)) fail('module.json', ['id must match ^[a-z][a-z0-9-]{1,39}$'])
  if (expectedId !== undefined && manifest.id !== expectedId) fail('module.json', [`id ${JSON.stringify(manifest.id)} does not match ${JSON.stringify(expectedId)}`])
  for (const key of ['name', 'description', 'author', 'license']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) fail('module.json', [`${key} must be a nonempty string`])
  }
  if (!isSemver(manifest.version)) fail('module.json', ['version must be a complete SemVer version'])
  if (manifest.api !== 1) fail('module.json', ['api must be the integer 1'])
  if (Object.hasOwn(manifest, '$schema') && typeof manifest.$schema !== 'string') fail('module.json', ['$schema must be a string'])
  if (Object.hasOwn(manifest, 'category') && (typeof manifest.category !== 'string' || !manifest.category.length)) {
    fail('module.json', ['category must be a nonempty string'])
  }
  if (Object.hasOwn(manifest, 'tags')) assertUniqueStrings(manifest.tags, 'module.json tags')
  if (Object.hasOwn(manifest, 'minPluginVersion') && !isSemver(manifest.minPluginVersion)) {
    fail('module.json', ['minPluginVersion must be a complete SemVer version'])
  }
  if (Object.hasOwn(manifest, 'requires')) {
    assertUniqueStrings(manifest.requires, 'module.json requires', { id: true })
    if (manifest.requires.includes(manifest.id)) fail('module.json', ['requires cannot include the module itself'])
    if (knownIds !== undefined) {
      if (!(knownIds instanceof Set) && !Array.isArray(knownIds)) fail('module.json', ['knownIds must be a Set or array'])
      const known = knownIds instanceof Set ? knownIds : new Set(knownIds)
      for (const dependency of manifest.requires) {
        if (!known.has(dependency)) fail('module.json', [`requires references unknown module ${JSON.stringify(dependency)}`])
      }
    }
  }
  if (Object.hasOwn(manifest, 'capabilities')) assertUniqueStrings(manifest.capabilities, 'module.json capabilities')
  if (Object.hasOwn(manifest, 'homepage')) {
    if (typeof manifest.homepage !== 'string') fail('module.json', ['homepage must be an HTTPS URL'])
    let url
    try { url = new URL(manifest.homepage) } catch { fail('module.json', ['homepage must be an HTTPS URL']) }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /\s/u.test(manifest.homepage)) {
      fail('module.json', ['homepage must be an HTTPS URL without credentials or whitespace'])
    }
  }
  if (Object.hasOwn(manifest, 'replacesBuiltin') && typeof manifest.replacesBuiltin !== 'boolean') {
    fail('module.json', ['replacesBuiltin must be a boolean'])
  }
  return manifest
}

export function validateRevoked(document) {
  assertObject(document, 'revoked.json')
  assertKnownKeys(document, REVOCATION_KEYS, 'revoked.json')
  if (Object.hasOwn(document, '$schema') && typeof document.$schema !== 'string') fail('revoked.json', ['$schema must be a string'])
  if (!Array.isArray(document.revoked)) fail('revoked.json', ['revoked must be an array'])
  const ids = new Set()
  for (const [index, entry] of document.revoked.entries()) {
    const label = `revoked.json entry ${index}`
    assertObject(entry, label)
    assertKnownKeys(entry, REVOCATION_ENTRY_KEYS, label)
    for (const key of REVOCATION_ENTRY_KEYS) if (!Object.hasOwn(entry, key)) fail(label, [`missing required field ${key}`])
    if (!isModuleId(entry.id)) fail(label, ['id must be a valid module ID'])
    if (ids.has(entry.id)) fail(label, [`duplicate id ${JSON.stringify(entry.id)}`])
    ids.add(entry.id)
    if (!Array.isArray(entry.versions) || !entry.versions.length) fail(label, ['versions must be a nonempty array'])
    const versions = new Set()
    for (const version of entry.versions) {
      if (!isSemver(version)) fail(label, [`invalid SemVer version ${JSON.stringify(version)}`])
      if (versions.has(version)) fail(label, [`duplicate version ${JSON.stringify(version)}`])
      versions.add(version)
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) fail(label, ['reason must be a nonempty string'])
  }
  return document
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y
const REGEX_AFTER_WORD = new Set(['return', 'throw', 'case', 'delete', 'typeof', 'void', 'yield', 'await', 'else', 'do', 'in', 'of', 'instanceof', 'new'])

function readIdentifier(source, index) {
  IDENTIFIER.lastIndex = index
  const match = IDENTIFIER.exec(source)
  return match ? { value: match[0], end: IDENTIFIER.lastIndex } : null
}

function skipSpaceComments(source, index) {
  let cursor = index
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) { cursor++; continue }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2)
      cursor = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      if (end < 0) throw new SyntaxError('unterminated block comment')
      cursor = end + 2
      continue
    }
    break
  }
  return cursor
}

function readQuoted(source, index, quote) {
  let cursor = index + 1
  let value = ''
  while (cursor < source.length) {
    const char = source[cursor++]
    if (char === quote) return { value, end: cursor }
    if (char === '\n' || char === '\r') throw new SyntaxError('line break in string literal')
    if (char !== '\\') { value += char; continue }
    if (cursor >= source.length) throw new SyntaxError('unterminated string escape')
    const escape = source[cursor++]
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '/': '/', "'": "'", '"': '"' }
    if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue }
    if (escape === 'x') {
      const digits = source.slice(cursor, cursor + 2)
      if (!/^[0-9a-f]{2}$/iu.test(digits)) throw new SyntaxError('invalid hexadecimal escape')
      value += String.fromCharCode(Number.parseInt(digits, 16)); cursor += 2; continue
    }
    if (escape === 'u') {
      if (source[cursor] === '{') {
        const end = source.indexOf('}', cursor + 1)
        const digits = end < 0 ? '' : source.slice(cursor + 1, end)
        if (!/^[0-9a-f]{1,6}$/iu.test(digits) || Number.parseInt(digits, 16) > 0x10ffff) throw new SyntaxError('invalid Unicode escape')
        value += String.fromCodePoint(Number.parseInt(digits, 16)); cursor = end + 1; continue
      }
      const digits = source.slice(cursor, cursor + 4)
      if (!/^[0-9a-f]{4}$/iu.test(digits)) throw new SyntaxError('invalid Unicode escape')
      value += String.fromCharCode(Number.parseInt(digits, 16)); cursor += 4; continue
    }
    if (escape === '\n') continue
    if (escape === '\r') { if (source[cursor] === '\n') cursor++; continue }
    throw new SyntaxError(`unsupported string escape \\${escape}`)
  }
  throw new SyntaxError('unterminated string literal')
}

function skipTemplate(source, index) {
  let cursor = index + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') { cursor += 2; continue }
    if (source[cursor] === '`') return cursor + 1
    cursor++
  }
  throw new SyntaxError('unterminated template literal')
}

function skipRegex(source, index) {
  let cursor = index + 1
  let inClass = false
  while (cursor < source.length) {
    const char = source[cursor++]
    if (char === '\\') { cursor++; continue }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      while (/[A-Za-z]/u.test(source[cursor] || '')) cursor++
      return cursor
    } else if (char === '\n' || char === '\r') throw new SyntaxError('unterminated regular expression literal')
  }
  throw new SyntaxError('unterminated regular expression literal')
}

function nextRegexStateForWord(word) {
  return REGEX_AFTER_WORD.has(word)
}

function skipBalanced(source, index, opening, closing) {
  const stack = [closing]
  let cursor = index + 1
  let canRegex = true
  while (cursor < source.length) {
    cursor = skipSpaceComments(source, cursor)
    if (cursor >= source.length) break
    const char = source[cursor]
    if (char === "'" || char === '"') { cursor = readQuoted(source, cursor, char).end; canRegex = false; continue }
    if (char === '`') { cursor = skipTemplate(source, cursor); canRegex = false; continue }
    if (char === '/' && source[cursor + 1] !== '/' && source[cursor + 1] !== '*' && canRegex) {
      cursor = skipRegex(source, cursor); canRegex = false; continue
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push(char === '(' ? ')' : char === '[' ? ']' : '}'); cursor++; canRegex = true; continue
    }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.at(-1) !== char) throw new SyntaxError(`mismatched ${char} in module entry`)
      stack.pop(); cursor++
      if (!stack.length) return cursor
      canRegex = false; continue
    }
    const word = readIdentifier(source, cursor)
    if (word) { cursor = word.end; canRegex = nextRegexStateForWord(word.value); continue }
    if (/\d/u.test(char)) {
      cursor++
      while (/[A-Za-z0-9_.]/u.test(source[cursor] || '')) cursor++
      canRegex = false; continue
    }
    if (char === '/' && source[cursor + 1] === '/') { cursor = source.indexOf('\n', cursor + 2); if (cursor < 0) return source.length; continue }
    if (char === '/' && source[cursor + 1] === '*') { cursor = skipSpaceComments(source, cursor); continue }
    if (char === '.' || char === '?.') { cursor++; canRegex = false; continue }
    const operator = source.slice(cursor, cursor + 3)
    if (['===', '!==', '>>>', '**=', '&&=', '||=', '??='].includes(operator)) cursor += 3
    else if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '**', '++', '--', '<<', '>>'].some(value => source.startsWith(value, cursor))) {
      cursor += source[cursor + 1] === '=' || source[cursor + 1] === source[cursor] ? 2 : 2
    } else cursor++
    canRegex = true
  }
  throw new SyntaxError(`unterminated ${opening} block in module entry`)
}

function skipValue(source, index) {
  let cursor = index
  let canRegex = true
  while (cursor < source.length) {
    cursor = skipSpaceComments(source, cursor)
    const char = source[cursor]
    if (char === ',' || char === '}') return cursor
    if (char === "'" || char === '"') { cursor = readQuoted(source, cursor, char).end; canRegex = false; continue }
    if (char === '`') { cursor = skipTemplate(source, cursor); canRegex = false; continue }
    if (char === '(' || char === '[' || char === '{') {
      cursor = skipBalanced(source, cursor, char, char === '(' ? ')' : char === '[' ? ']' : '}'); canRegex = false; continue
    }
    if (char === '/' && source[cursor + 1] !== '/' && source[cursor + 1] !== '*' && canRegex) {
      cursor = skipRegex(source, cursor); canRegex = false; continue
    }
    if (char === '/' && source[cursor + 1] === '/') { cursor = source.indexOf('\n', cursor + 2); if (cursor < 0) return source.length; continue }
    if (char === '/' && source[cursor + 1] === '*') { cursor = skipSpaceComments(source, cursor); continue }
    const word = readIdentifier(source, cursor)
    if (word) { cursor = word.end; canRegex = nextRegexStateForWord(word.value); continue }
    if (/\d/u.test(char)) { cursor++; while (/[A-Za-z0-9_.]/u.test(source[cursor] || '')) cursor++; canRegex = false; continue }
    canRegex = !')]}'.includes(char) && !'.'.includes(char)
    cursor++
  }
  throw new SyntaxError('unterminated module entry property value')
}

function parseStaticValue(source, index) {
  const cursor = skipSpaceComments(source, index)
  if (source[cursor] === "'" || source[cursor] === '"') return { kind: 'literal', ...readQuoted(source, cursor, source[cursor]) }
  const identifier = readIdentifier(source, cursor)
  if (identifier) return { kind: 'identifier', value: identifier.value, end: identifier.end }
  throw new TypeError('module entry contract value must be a string literal or top-level string constant')
}

function parseCallable(source, index, label) {
  let cursor = skipSpaceComments(source, index)
  if (source.startsWith('async', cursor) && !/[A-Za-z0-9_$]/u.test(source[cursor + 5] || '')) cursor = skipSpaceComments(source, cursor + 5)
  if (source.startsWith('function', cursor) && !/[A-Za-z0-9_$]/u.test(source[cursor + 8] || '')) {
    cursor = skipSpaceComments(source, cursor + 8)
    if (source[cursor] === '*') cursor = skipSpaceComments(source, cursor + 1)
    const name = readIdentifier(source, cursor)
    if (name) cursor = skipSpaceComments(source, name.end)
    if (source[cursor] !== '(') throw new TypeError(`${label} must be a function expression`)
    cursor = skipBalanced(source, cursor, '(', ')')
    cursor = skipSpaceComments(source, cursor)
    if (source[cursor] !== '{') throw new TypeError(`${label} must have a function body`)
    return skipBalanced(source, cursor, '{', '}')
  }
  if (source[cursor] === '(') {
    cursor = skipBalanced(source, cursor, '(', ')')
    cursor = skipSpaceComments(source, cursor)
    if (!source.startsWith('=>', cursor)) throw new TypeError(`${label} must be an arrow function`)
    cursor = skipSpaceComments(source, cursor + 2)
    return source[cursor] === '{' ? skipBalanced(source, cursor, '{', '}') : skipValue(source, cursor)
  }
  const argument = readIdentifier(source, cursor)
  if (argument) {
    cursor = skipSpaceComments(source, argument.end)
    if (source.startsWith('=>', cursor)) {
      cursor = skipSpaceComments(source, cursor + 2)
      return source[cursor] === '{' ? skipBalanced(source, cursor, '{', '}') : skipValue(source, cursor)
    }
  }
  throw new TypeError(`${label} must be a function, method, or arrow function`)
}

function topLevelStringConstants(source, limit) {
  const values = new Map()
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"])/gu
  let match
  while ((match = declaration.exec(source)) && match.index < limit) {
    const quoteIndex = declaration.lastIndex - 1
    let parsed
    try { parsed = readQuoted(source, quoteIndex, match[2]) } catch { continue }
    if (parsed.end > limit) continue
    const immediate = source.slice(parsed.end, Math.min(source.length, parsed.end + 2))
    const hasLineTerminator = /[\r\n]/u.test(immediate)
    const after = skipSpaceComments(source, parsed.end)
    if (!hasLineTerminator && after < source.length && !',;'.includes(source[after])) continue
    if (!values.has(match[1])) values.set(match[1], parsed.value)
    else if (values.get(match[1]) !== parsed.value) values.set(match[1], undefined)
  }
  return values
}

function findDefaultObject(source) {
  const pattern = /\bexport\s+default\s*\{/gu
  const match = pattern.exec(source)
  if (!match) throw new TypeError('Module entry must use an `export default { ... }` object literal')
  return { opening: source.indexOf('{', match.index), constants: topLevelStringConstants(source, match.index) }
}

function parseDefaultObject(source, opening) {
  const properties = new Map()
  let cursor = opening + 1
  while (true) {
    cursor = skipSpaceComments(source, cursor)
    if (source[cursor] === '}') return { properties, end: cursor + 1 }
    if (source.startsWith('...', cursor)) throw new TypeError('module entry default object cannot use spread properties')
    if (source[cursor] === '[') throw new TypeError('module entry default object cannot use computed properties')
    let key
    if (source[cursor] === "'" || source[cursor] === '"') {
      const parsed = readQuoted(source, cursor, source[cursor]); key = parsed.value; cursor = parsed.end
    } else {
      const identifier = readIdentifier(source, cursor)
      if (!identifier) throw new TypeError('module entry default object has a dynamic property key')
      key = identifier.value; cursor = identifier.end
    }
    cursor = skipSpaceComments(source, cursor)
    if ((key === 'get' || key === 'set') && source[cursor] !== ':') throw new TypeError('module entry default object cannot use accessors')
    if (key === 'async' && source[cursor] !== ':' && source[cursor] !== ',' && source[cursor] !== '}') {
      const methodName = readIdentifier(source, cursor)
      if (!methodName) throw new TypeError('module entry async property is dynamic')
      const afterName = skipSpaceComments(source, methodName.end)
      if (source[afterName] === '(') {
        key = methodName.value; cursor = afterName
      }
    }
    const property = { kind: 'other' }
    if (source[cursor] === ':') {
      cursor = skipSpaceComments(source, cursor + 1)
      if (key === 'id' || key === 'version') {
        const parsed = parseStaticValue(source, cursor)
        property.kind = parsed.kind; property.value = parsed.kind === 'literal' ? parsed.value : parsed.value
        cursor = parsed.end
        const next = skipSpaceComments(source, cursor)
        if (source[next] !== ',' && source[next] !== '}') throw new TypeError(`module entry ${key} must be a static string value`)
        cursor = next
      } else if (key === 'setup') {
        cursor = parseCallable(source, cursor, 'module entry setup')
        property.kind = 'callable'
      } else {
        cursor = skipValue(source, cursor)
      }
    } else if (source[cursor] === '(') {
      if (key === 'id' || key === 'version') throw new TypeError(`module entry ${key} cannot be a method`)
      cursor = skipBalanced(source, cursor, '(', ')')
      cursor = skipSpaceComments(source, cursor)
      if (source[cursor] !== '{') throw new TypeError(`module entry method ${key} has no body`)
      cursor = skipBalanced(source, cursor, '{', '}')
      if (key === 'setup') property.kind = 'callable'
    } else if (source[cursor] === ',' || source[cursor] === '}') {
      if (key === 'id' || key === 'version' || key === 'setup') throw new TypeError(`module entry ${key} cannot be shorthand`)
    } else {
      throw new TypeError(`module entry property ${key} is dynamic or uses an accessor`)
    }
    if (properties.has(key)) throw new TypeError(`duplicate module entry property ${key}`)
    properties.set(key, property)
    cursor = skipSpaceComments(source, cursor)
    if (source[cursor] === ',') { cursor++; continue }
    if (source[cursor] === '}') return { properties, end: cursor + 1 }
    throw new TypeError('module entry default object must use comma-separated properties')
  }
}

export function readEntryContract(source) {
  if (typeof source !== 'string') throw new TypeError('Module entry source must be text')
  const { opening, constants } = findDefaultObject(source)
  const { properties } = parseDefaultObject(source, opening)
  const result = {}
  for (const key of ['id', 'version']) {
    const property = properties.get(key)
    if (!property || !['literal', 'identifier'].includes(property.kind)) throw new TypeError(`Module entry ${key} must be a string literal or a top-level string constant`)
    const value = property.kind === 'literal' ? property.value : constants.get(property.value)
    if (typeof value !== 'string') throw new TypeError(`Module entry ${key} does not resolve to a top-level string constant`)
    result[key] = value
  }
  const setup = properties.get('setup')
  if (!setup || setup.kind !== 'callable') throw new TypeError('Module entry setup must be a method, function, or arrow function')
  return result
}

export function validateEntrySource(source, manifest) {
  const entry = readEntryContract(source)
  if (entry.id !== manifest.id) throw new TypeError(`Module entry id ${JSON.stringify(entry.id)} does not match manifest id ${JSON.stringify(manifest.id)}`)
  if (entry.version !== manifest.version) throw new TypeError(`Module entry version ${JSON.stringify(entry.version)} does not match manifest version ${JSON.stringify(manifest.version)}`)
  return entry
}
