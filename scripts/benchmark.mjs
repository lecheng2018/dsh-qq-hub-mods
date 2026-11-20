import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from './lib/artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function distribution(samples) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Benchmark needs nonnegative finite samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { samples: sorted.length, minMs: sorted[0], medianMs: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) };
}

export function measure(operation, count = 5) {
  operation();
  const samples = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return distribution(samples);
}

export function runBenchmark({ dist = path.join(root, 'dist'), samples = 5 } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 50) throw new Error('samples must be between 1 and 50');
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const records = JSON.parse(fs.readFileSync(path.join(dist, 'release.json'), 'utf8'));
  const startCheck = performance.now();
  const check = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { cwd: root, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`check failed during benchmark: ${check.stderr || check.stdout}`);
  const checkMs = performance.now() - startCheck;
  const memoryStart = process.memoryUsage();
  const modules = records.map(record => {
    const zip = fs.readFileSync(path.join(dist, record.file));
    const validated = validateArtifact(zip, record);
    return {
      id: record.id,
      version: record.version,
      zipBytes: zip.length,
      unpackedBytes: validated.unpackedBytes,
      files: validated.files,
      artifactValidation: measure(() => validateArtifact(zip, record), samples),
    };
  });
  return {
    schema: 1,
    measuredAt: new Date().toISOString(),
    commit,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    policy: { thresholdsEnforced: false, scope: 'Local check process and artifact validation; not runtime module latency or whole CI peak memory' },
    checkMs,
    totalZipBytes: modules.reduce((sum, module) => sum + module.zipBytes, 0),
    memory: { start: memoryStart, end: process.memoryUsage(), processMaxRssKiB: process.resourceUsage().maxRSS },
    modules,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argumentsList = process.argv.slice(2);
    let out = path.join(root, '.artifacts/benchmark.json');
    let dist = path.join(root, 'dist');
    let samples = 5;
    for (let index = 0; index < argumentsList.length; index++) {
      const name = argumentsList[index];
      const value = argumentsList[++index];
      if (!value) throw new Error(`Missing value for ${name}`);
      if (name === '--out') out = path.resolve(value);
      else if (name === '--dist') dist = path.resolve(value);
      else if (name === '--samples') samples = Number(value);
      else throw new Error(`Unknown argument ${name}`);
    }
    const report = runBenchmark({ dist, samples });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Benchmark: ${report.modules.length} modules, ${report.totalZipBytes} ZIP bytes; report ${out}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
