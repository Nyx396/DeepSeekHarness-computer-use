import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pluginDir, resolveArtifactsDirectory } from './paths.mjs';

test('test artifacts default to a sibling records directory and accept an external override', () => {
  const expected = path.join(path.dirname(pluginDir), path.basename(pluginDir) + '-local-records', 'artifacts');
  assert.equal(resolveArtifactsDirectory(''), expected);
  const override = path.join(path.dirname(pluginDir), 'external-test-output');
  assert.equal(resolveArtifactsDirectory(override), override);
  // A sibling whose name shares the source prefix is still outside the source.
  assert.equal(resolveArtifactsDirectory(pluginDir + '-external'), pluginDir + '-external');
});

test('test artifacts reject the source root and normalized paths inside it', () => {
  for (const directory of [pluginDir, path.join(pluginDir, 'test', 'artifacts'), path.join(pluginDir, 'elsewhere', '..', 'records')]) {
    assert.throws(() => resolveArtifactsDirectory(directory), /outside the plugin source/);
  }
});
