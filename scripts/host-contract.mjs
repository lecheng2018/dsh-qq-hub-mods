import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptDir, '..')
const strict = process.argv.slice(2).includes('--strict')
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--strict' && arg !== '--help')

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: node scripts/host-contract.mjs [--strict]\n')
  process.exit(0)
}
if (unknownArgs.length) throw new Error(`Unknown arguments: ${unknownArgs.join(' ')}`)

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function runGit(git, args, options = {}) {
  const result = spawnSync(git, args, { encoding: 'utf8', windowsHide: true, ...options })
  if (result.error) throw new Error(`Cannot run git (${git}): ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`)
  }
  return (result.stdout || '').trim()
}

function verifyHost(hostDir, pinnedSha, git) {
  const head = runGit(git, ['-C', hostDir, 'rev-parse', 'HEAD'])
  if (head.toLowerCase() !== pinnedSha.toLowerCase()) {
    throw new Error(`HOST_REPO_DIR must be at ${pinnedSha}; found ${head} at ${hostDir}`)
  }
  const dirty = runGit(git, ['-C', hostDir, 'status', '--porcelain', '--untracked-files=normal'])
  if (dirty) throw new Error(`HOST_REPO_DIR must be clean at pinned SHA; worktree changes found:\n${dirty}`)
  return head
}

function checkoutPinnedHost({ config, git }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-qq-hub-host-contract-'))
  try {
    runGit(git, ['init', '--quiet', tempDir])
    runGit(git, ['-C', tempDir, 'remote', 'add', 'origin', `https://github.com/${config.owner}/${config.repo}.git`])
    runGit(git, ['-C', tempDir, 'fetch', '--quiet', '--depth', '1', 'origin', config.sha])
    runGit(git, ['-C', tempDir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
    verifyHost(tempDir, config.sha, git)
    return tempDir
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

const git = process.env.HOST_GIT || 'git'
const contractPath = join(repoDir, '.github', 'host-contract.json')
const contract = readJson(contractPath)
const githubPart = /^[A-Za-z0-9_.-]+$/
if (!githubPart.test(contract.owner || '') || !githubPart.test(contract.repo || '') || !/^[a-f0-9]{40}$/i.test(contract.sha || '')) {
  throw new Error(`${contractPath} must pin safe GitHub owner/repo names and a full 40-character commit SHA`)
}
const major = Number(process.versions.node.split('.')[0])
const minor = Number(process.versions.node.split('.')[1])
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(`Host contract requires Node >=22.13.0; found ${process.versions.node}`)
}

let hostDir = ''
let ownedTempDir = ''
try {
  if (process.env.HOST_REPO_DIR) {
    if (!isAbsolute(process.env.HOST_REPO_DIR)) throw new Error('HOST_REPO_DIR must be an absolute path')
    hostDir = resolve(process.env.HOST_REPO_DIR)
    verifyHost(hostDir, contract.sha, git)
  } else {
    ownedTempDir = checkoutPinnedHost({ config: contract, git })
    hostDir = ownedTempDir
  }

  process.stdout.write(`Host contract: ${contract.owner}/${contract.repo}@${contract.sha}\n`)
  process.stdout.write(`Mode: ${strict ? 'STRICT (release-blocking)' : 'BASELINE (known gaps reported)'}\n`)
  const testFile = join(repoDir, 'tests', 'contract', 'host-contract.contract.mjs')
  const childEnv = { ...process.env, HOST_REPO_DIR: hostDir, HOST_CONTRACT_STRICT: strict ? '1' : '0' }
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_APP_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']) delete childEnv[key]
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: repoDir,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`Unable to launch Node contract tests: ${result.error.message}`)
  if (result.status !== 0) process.exitCode = result.status || 1
  else process.stdout.write(`CONTRACT RESULT: PINNED CONTRACT SUITE PASSED${strict ? ' (strict)' : ' (baseline; NOT FULL SECURITY)'}\n`)
} finally {
  if (ownedTempDir) rmSync(ownedTempDir, { recursive: true, force: true })
}
