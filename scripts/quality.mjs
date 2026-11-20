import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'dist', '.registry', '.artifacts', '.cache']);
const textExtensions = new Set(['.md', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.sh', '.txt']);

export function findSecrets(text) {
  const rules = [
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
    ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g],
    ['credential assignment', /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_+/.=-]{24,}['"]/gi],
  ];
  return rules.flatMap(([kind, pattern]) => [...text.matchAll(pattern)].map(match => ({
    kind,
    line: text.slice(0, match.index).split('\n').length,
  })));
}

export function markdownLinks(text) {
  const withoutFences = text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
  return [...withoutFences.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)]
    .map(match => match[1]);
}

function filesUnder(directory, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...filesUnder(path.join(directory, entry.name), name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}

export function checkDocuments(repository = root) {
  const errors = [];
  for (const relative of filesUnder(repository).filter(file => file.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(repository, relative), 'utf8');
    if (text.includes('\uFFFD')) errors.push(`${relative}: invalid replacement character`);
    if ((text.match(/^\s*```/gm)?.length ?? 0) % 2) errors.push(`${relative}: unclosed code fence`);
    for (const link of markdownLinks(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#')) continue;
      let target;
      try { target = decodeURIComponent(link.split('#')[0]); }
      catch { errors.push(`${relative}: invalid link encoding`); continue; }
      if (!target) continue;
      const destination = path.resolve(path.dirname(path.join(repository, relative)), target);
      if (!fs.existsSync(destination)) errors.push(`${relative}: missing link ${link}`);
    }
  }
  return errors;
}

export function checkSecrets(repository = root) {
  let files;
  try {
    files = execFileSync('git', ['-C', repository, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  } catch {
    throw new Error('Secret scan requires a working Git repository; refusing an incomplete scan');
  }
  const errors = [];
  for (const relative of files) {
    const basename = path.basename(relative);
    if ((/^\.env(?:\.|$)/i.test(basename) && !/\.(?:example|sample|template)$/i.test(basename))
      || /\.(?:pem|p12|pfx|key)$/i.test(basename) || /^id_(?:rsa|ed25519)$/i.test(basename)) {
      errors.push(`${relative}: sensitive credential file is not allowed`);
      continue;
    }
    if (!textExtensions.has(path.extname(relative).toLowerCase()) && basename !== 'LICENSE') continue;
    const target = path.resolve(repository, relative);
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) continue;
    if (stat.size > 4 * 1024 * 1024) throw new Error(`Text file exceeds secret scan limit: ${relative}`);
    const text = fs.readFileSync(target, 'utf8');
    for (const finding of findSecrets(text)) errors.push(`${relative}:${finding.line}: possible ${finding.kind}`);
  }
  return errors;
}

export async function checkTemplate(repository = root) {
  const template = path.join(repository, 'templates', 'module');
  const { validateManifest, validateEntrySource } = await import('./lib/validation.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(template, 'module.json'), 'utf8'));
  validateManifest(manifest, { expectedId: 'example-module' });
  validateEntrySource(fs.readFileSync(path.join(template, 'index.mjs'), 'utf8'), manifest);
  for (const name of ['README.md', 'LICENSE', 'module.test.mjs']) {
    if (!fs.existsSync(path.join(template, name))) throw new Error(`Module template missing ${name}`);
  }
}

export async function runQuality(repository = root) {
  const errors = [...checkDocuments(repository), ...checkSecrets(repository)];
  await checkTemplate(repository);
  for (const schema of ['module.schema.json', 'revoked.schema.json']) {
    const document = JSON.parse(fs.readFileSync(path.join(repository, 'schemas', schema), 'utf8'));
    if (document.$schema !== 'https://json-schema.org/draft/2020-12/schema' || document.type !== 'object') {
      errors.push(`schemas/${schema}: invalid schema declaration`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { documents: 'passed', secrets: 'passed', template: 'passed', schemas: 'passed' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runQuality(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
