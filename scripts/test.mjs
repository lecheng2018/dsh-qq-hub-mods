import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'fixtures']);

function testFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(target);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function discoverTests(repository = root) {
  const modulesRoot = path.join(repository, 'modules');
  const activeModules = fs.readdirSync(modulesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(entry => ({
      id: entry.name,
      files: testFiles(path.join(modulesRoot, entry.name)),
    }));
  const missing = activeModules.filter(module => module.files.length === 0).map(module => module.id);
  if (missing.length) {
    throw new Error(`Active modules require at least one *.test.mjs file: ${missing.join(', ')}`);
  }

  const templateFiles = testFiles(path.join(repository, 'templates', 'module'));
  const contractFiles = testFiles(path.join(repository, 'tests', 'contract'))
    .filter(file => !file.endsWith('.contract.mjs'));
  const files = [
    ...activeModules.flatMap(module => module.files),
    ...testFiles(path.join(repository, 'scripts')),
    ...templateFiles,
    ...contractFiles,
  ];
  return {
    activeModules,
    files: [...new Set(files)].sort((a, b) => a.localeCompare(b)),
    scriptFiles: testFiles(path.join(repository, 'scripts')),
    contractFiles,
  };
}

function configuredGit(repository) {
  let directory = path.resolve(repository);
  for (;;) {
    const runtimePaths = path.join(directory, 'runtime-paths.json');
    if (fs.existsSync(runtimePaths)) {
      try {
        const config = JSON.parse(fs.readFileSync(runtimePaths, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof config.git === 'string' && config.git) return config.git;
      } catch (error) {
        throw new Error(`Cannot read ${runtimePaths}: ${error.message}`);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return '';
    directory = parent;
  }
}

export function testEnvironment(repository = root) {
  const environment = { ...process.env };
  if (!environment.GIT_EXECUTABLE) {
    const git = configuredGit(repository);
    if (git) environment.GIT_EXECUTABLE = git;
  }
  for (const name of Object.keys(environment)) {
    if (/^(?:GH|GITHUB|ACTIONS|NPM|NODE_AUTH)_.+(?:TOKEN|SECRET|PASSWORD|KEY)$/.test(name) ||
        /^(?:GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/.test(name)) {
      delete environment[name];
    }
  }
  const guard = path.join(repository, 'scripts', 'network-guard.cjs');
  if (fs.existsSync(guard)) {
    const requireOption = `--require="${guard.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
    environment.NODE_OPTIONS = [environment.NODE_OPTIONS, requireOption].filter(Boolean).join(' ');
  }
  return environment;
}

export function runTests(repository = root, run = spawnSync) {
  const discovered = discoverTests(repository);
  console.log(`Test discovery: ${discovered.activeModules.length} active modules, ${discovered.files.length} files (${discovered.scriptFiles.length} scripts, ${discovered.contractFiles.length} contract)`);
  for (const module of discovered.activeModules) console.log(`  ${module.id}: ${module.files.length} test file(s)`);
  const result = run(process.execPath, ['--test', '--test-reporter=spec', ...discovered.files], {
    cwd: repository,
    env: testEnvironment(repository),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Node test runner exited with status ${result.status ?? 'unknown'}`);
  return discovered;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
