import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// DSH's attachment objects have extensionless internal names. Export an
// explicitly named PNG for its ordinary Markdown file-preview API instead of
// asking the model to infer the attachment store layout.
export async function savePreview(directory, bytes, signal) {
  signal?.throwIfAborted();
  directory = path.resolve(directory);
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('预览需要有效的 PNG 截图。');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('预览目录不是普通目录。');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filename = path.join(directory, 'desktop-' + hash + '.png');
  try {
    const existing = await fs.lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length) throw new Error('预览文件与截图不匹配。');
    const stored = await fs.readFile(filename, { signal });
    if (!stored.equals(bytes)) throw new Error('预览文件校验失败。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  const displayPath = filename.replace(/\\/g, '/');
  const destination = displayPath.split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
  return { path: displayPath, markdown: `![桌面操作结果](<${destination}>)` };
}
