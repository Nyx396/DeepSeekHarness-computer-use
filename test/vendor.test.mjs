import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('vendored Windows engine matches every pinned upstream Git blob', async () => {
  const root = new URL('../vendor/windows-engine/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('UPSTREAM.json', root), 'utf8'));
  assert.equal(manifest.commit, 'a6d6c2e625e15ca322842b038b4e9165bee1d42f');
  assert.equal(manifest.files.length, 15);
  for (const file of manifest.files) {
    const bytes = await fs.readFile(new URL(file.path, root));
    const actual = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
    assert.equal(actual, file.gitBlob, file.path + ' drifted from the pinned upstream');
  }
});
