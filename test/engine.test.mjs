import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WindowsEngine, resultData } from '../lib/engine.js';
test('stdio MCP startup, Unicode, abort and timeout do not replay requests', async t => {
  const engine = new WindowsEngine({ args: [fileURLToPath(new URL('./fake-engine.mjs', import.meta.url))], timeoutMs: 1000 });
  t.after(() => engine.close());
  assert.deepEqual(resultData(await engine.call('health', { text: '中文\n换行' })), { text: '中文\n换行' });
  const abort = new AbortController();
  const cancelled = engine.call('health', { hang: true }, { signal: abort.signal });
  setTimeout(() => abort.abort(new Error('test cancellation')), 50);
  await assert.rejects(cancelled, /test cancellation/);
  await assert.rejects(engine.call('health', { hang: true }, { timeoutMs: 100 }), /超时/);
  assert.equal(engine.pending.size, 0);
  assert.deepEqual(resultData(await engine.call('health', { after: true })), { after: true });
});
