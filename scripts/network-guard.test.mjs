import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./network-guard.cjs', import.meta.url));

test('test guard rejects external HTTP, TCP, TLS and fetch without a network request', () => {
  const script = `
    const assert = require('node:assert/strict');
    const calls = [
      () => require('node:http').get('http://example.com'),
      () => require('node:https').get('https://example.com'),
      () => require('node:net').connect({host:'example.com',port:80}),
      () => require('node:tls').connect({host:'example.com',port:443}),
      () => fetch('https://example.com')
    ];
    for (const call of calls) assert.throws(call, {code:'ERR_TEST_EXTERNAL_NETWORK'});
  `;
  const result = spawnSync(process.execPath, ['--require', guard, '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('test guard permits real loopback HTTP used by module integration tests', async t => {
  const server = http.createServer((_request, response) => response.end('local'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--require', guard, '-e', `
    fetch('http://127.0.0.1:${server.address().port}').then(r=>r.text()).then(t=>{
      if(t!=='local')process.exitCode=1;
    }).catch(()=>{process.exitCode=1});
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
});
