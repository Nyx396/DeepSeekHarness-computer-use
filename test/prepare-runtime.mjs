import fs from 'node:fs';
import path from 'node:path';
import { artifactsDir } from './paths.mjs';

// Read-only extraction of the INSTALLED app, used only by host/UI tests.
const archive = process.env.DSH_TEST_ASAR;
if (!archive || !path.isAbsolute(archive)) throw Error('Set DSH_TEST_ASAR to the installed resources/app.asar.');
const root = path.join(artifactsDir, 'runtime');
const fd = fs.openSync(archive, 'r');
try {
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
  const bytes = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, bytes, 0, bytes.length, 16);
  const header = JSON.parse(bytes.toString('utf8')), offset = 8 + prefix.readUInt32LE(4);
  let count = 0;
  const visit = (entry, member = '') => {
    for (const [name, child] of Object.entries(entry.files || {})) {
      const key = member ? member + '/' + name : name;
      if (child.files) { visit(child, key); continue; }
      if (!key.startsWith('dsh/node_modules/') || !/\.(?:js|mjs|cjs|json|node|dll)$/.test(key) || key.includes('/libreoffice-kit-') || key.includes('/office-engine')) continue;
      const target = path.resolve(root, key);
      if (!target.startsWith(path.resolve(root) + path.sep)) throw Error('Archive path escapes fixture root.');
      let data;
      if (child.unpacked) data = fs.readFileSync(path.join(archive + '.unpacked', key));
      else { data = Buffer.alloc(Number(child.size)); fs.readSync(fd, data, 0, data.length, offset + Number(child.offset)); }
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); count++;
    }
  };
  visit(header);
  console.log(JSON.stringify({ files: count, runtime: path.join(root, 'dsh') }));
} finally { fs.closeSync(fd); }
