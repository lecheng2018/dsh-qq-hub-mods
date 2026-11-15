// 分发契约：模块从干净目录导入即可运行，零运行时依赖（不靠 node_modules）。
// 原 extension 的 buildExtension 打包测试不适用于 mods 仓库（这里由 scripts/pack.mjs 打包），
// 改为验证市场模块形态的核心承诺：入口契约 + 无外部依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));

test('入口在干净子进程里导入成功，id/version 与 manifest 一致，setup 是函数', () => {
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(fileURLToPath(new URL('./index.mjs', import.meta.url)))});` +
    `const d = m.default; console.log(JSON.stringify({ id: d.id, version: d.version, setup: typeof d.setup }));`],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim());
  assert.equal(info.id, manifest.id);
  assert.equal(info.version, manifest.version);
  assert.equal(info.setup, 'function');
});

test('运行时源码不 import 任何裸包名（零运行时依赖）', () => {
  const files = ['index.mjs', 'tieba.mjs', 'transport.mjs', 'browser-client.mjs', 'cookie-guide.mjs', 'external-browser.mjs', 'html-dom.mjs'];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    const bare = [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
    assert.deepEqual(bare, [], `${f} 里有裸包依赖：${bare.join(', ')}`);
  }
});
