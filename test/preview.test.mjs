import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {artifactsDir} from './paths.mjs';
import path from 'node:path';
import {savePreview} from '../lib/preview.js';
import {createSkillProvider,SKILL_NAME} from '../lib/skill.js';
import {resolveDataHome} from '../lib/index.js';
import os from 'node:os';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64');
test('PNG preview is a verified, deduplicated file with an exact Markdown destination',async t=>{
  await fs.mkdir(artifactsDir,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifactsDir,'preview-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'中文 path #1 100%');
  const first=await savePreview(directory,png),second=await savePreview(directory,png);
  assert.deepEqual(second,first);assert.equal((await fs.readdir(directory)).length,1);
  assert.deepEqual(await fs.readFile(first.path),png);
  assert.match(first.path,/desktop-[a-f0-9]{64}\.png$/);
  const destination=first.markdown.match(/<(.+)>/u)[1];
  assert.equal(decodeURIComponent(destination),first.path);assert.ok(destination.includes('%23'));assert.ok(destination.includes('%25'));
  assert.equal(first.path.includes('\\'),false);assert.ok(path.isAbsolute(first.path));
  await fs.writeFile(first.path,'corrupt');await assert.rejects(savePreview(directory,png),/不匹配|校验/);
  await assert.rejects(savePreview(directory,Buffer.from('not PNG')),/PNG/);
  await assert.rejects(savePreview(directory,png,AbortSignal.abort(new Error('cancelled'))),/cancelled/);
});
test('DSH home uses absolute paths and host-style tilde/blank handling',()=>{
  assert.equal(resolveDataHome('  '),path.join(os.homedir(),'.dsh'));
  assert.equal(resolveDataHome('~/custom'),path.join(os.homedir(),'custom'));
  assert.equal(resolveDataHome('relative'),path.resolve('relative'));
});
test('packaged computer-use skill is discoverable and loads only its fixed directory',async()=>{
  const provider=createSkillProvider(),[candidate]=await provider.list();
  assert.equal(candidate.name,SKILL_NAME);assert.equal(candidate.resourceBase.kind,'directory');
  assert.equal((await provider.get(candidate)).content.includes('imagePreviews'),true);
  assert.equal(await provider.get({...candidate,locator:'../../secret'}),undefined);
});
