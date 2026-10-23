import fs from 'node:fs/promises';
import path from 'node:path';
import {artifactsDir} from './paths.mjs';
import assert from 'node:assert/strict';
import {WindowsEngine,resultData} from '../lib/engine.js';

await fs.mkdir(artifactsDir,{recursive:true});
const directory=await fs.mkdtemp(path.join(artifactsDir,'visual-engine-'));
const engine=new WindowsEngine({runtimeDirectory:directory,env:{TEMP:directory,TMP:directory}});
try {
  const result=resultData(await engine.call('health'));
  assert.equal(result.ok,true);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'windows-engine/package.json'),'utf8')).version,'0.5.0');
  const source=await fs.readFile(path.join(directory,'windows-engine/scripts/windows-takeover.cs'),'utf8');
  assert.ok(source.includes('class AuroraField'));
  console.log(JSON.stringify({ok:true,preparedRuntime:true,health:true,noInput:true}));
}finally{await engine.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
