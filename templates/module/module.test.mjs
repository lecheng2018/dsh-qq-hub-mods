import test from 'node:test';
import assert from 'node:assert/strict';
import definition from './index.mjs';

function setup() {
  let enabled = true;
  let factory;
  definition.setup({
    settings: () => ({ enabled }),
    tool: value => { factory = value; },
    defineTool: value => value,
  });
  return { tools: () => factory({}), disable: () => { enabled = false; } };
}

test('template validates input and does not expose disabled tools', async () => {
  const state = setup();
  const tool = state.tools()[0];
  assert.deepEqual(await tool.execute({ text: 'hello' }), { ok: true, message: 'hello' });
  assert.equal((await tool.execute({ text: 'x'.repeat(201) })).ok, false);
  assert.equal((await tool.execute()).ok, false);
  state.disable();
  assert.deepEqual(state.tools(), []);
  assert.equal((await tool.execute({ text: 'stale invocation' })).ok, false);
});
