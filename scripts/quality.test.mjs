import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets, markdownLinks, checkDocuments, checkTemplate } from './quality.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('secret detection reports location without returning secret values', () => {
  const token = ['gh', 'p_', 'a'.repeat(36)].join('');
  const text = `safe\ncredential=${token}\n`;
  const result = findSecrets(text);
  assert.deepEqual(result, [{ kind: 'GitHub token', line: 2 }]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(findSecrets('apiKey: process.env.API_KEY'), []);
});

test('document links ignore code examples and identify missing relative files', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-docs-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, 'ok.md'), '# Present\n');
  const content = '[present](ok.md)\n[missing](gone.md)\n```md\n[example](placeholder.md)\n```\n';
  fs.writeFileSync(path.join(temporary, 'README.md'), content);
  assert.deepEqual(markdownLinks(content), ['ok.md', 'gone.md']);
  assert.deepEqual(checkDocuments(temporary), ['README.md: missing link gone.md']);
  fs.writeFileSync(path.join(temporary, 'gone.md'), '# Added\n');
  assert.deepEqual(checkDocuments(temporary), []);
});

test('template has a validated manifest and matching executable entry', async () => {
  await checkTemplate(root);
});

test('schema documents stay aligned with exported manifest field rules', async () => {
  const { validateManifest, validateRevoked } = await import('./lib/validation.mjs');
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/module.schema.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'templates/module/module.json'), 'utf8'));
  for (const required of schema.required) {
    const value = { ...manifest };
    delete value[required];
    assert.throws(() => validateManifest(value), undefined, `missing ${required}`);
  }
  assert.throws(() => validateManifest({ ...manifest, extraField: true }));
  for (const version of ['1.0.0', '1.0.0-beta.2', '1.0.0+build.1', '0.0.1']) {
    assert.match(version, new RegExp(schema.$defs.semver.pattern));
    validateManifest({ ...manifest, version });
  }
  for (const version of ['v1.0.0', '1.0.0junk', '1.0.0-01', '01.0.0']) {
    assert.equal(new RegExp(schema.$defs.semver.pattern).test(version), false);
    assert.throws(() => validateManifest({ ...manifest, version }));
  }
  validateRevoked({ revoked: [] });
  assert.throws(() => validateRevoked({}));
});
