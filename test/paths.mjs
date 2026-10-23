import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const testDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginDir = path.dirname(testDir);
// Keep screenshots, extracted host code and local task records outside source.
export function resolveArtifactsDirectory(requested = process.env.DSH_TEST_ARTIFACTS, source = pluginDir) {
  const directory = path.resolve(requested ||
    path.join(path.dirname(source), path.basename(source) + '-local-records', 'artifacts'));
  const relative = path.relative(path.resolve(source), directory);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('DSH_TEST_ARTIFACTS must be outside the plugin source directory.');
  }
  return directory;
}
export const artifactsDir = resolveArtifactsDirectory();
