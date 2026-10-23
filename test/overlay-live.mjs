import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {artifactsDir} from './paths.mjs';

// Exercise only this package's own presentation windows. No desktop input,
// target-app automation, screenshot capture or model call is performed.
const fixture=JSON.parse(await fs.readFile(path.join(artifactsDir,'current-visual-preview.json'),'utf8'));
const {TakeoverControl}=await import(pathToFileURL(path.join(path.dirname(fixture.script),'takeover.mjs')).href);
const helper=new TakeoverControl({testMode:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const before=await helper.command('status');
  const showing=await helper.command('begin',{indicatorText:'DSH visual preview',indicatorIdleMs:200,remoteIndicatorVisible:false,stopShortcut:'Ctrl+Alt+F12'});
  assert.equal(showing.foreground,before.foreground,'presentation must not steal focus');
  for(const name of ['overlayClickThrough','overlayCaptureExcluded','pointerClickThrough','pointerCaptureExcluded'])assert.equal(showing[name],true,name);
  const rtts=[];
  for(let i=0;i<15;i++){await pause(45);const start=performance.now();await helper.command('status');rtts.push(performance.now()-start);}
  await helper.command('end');await pause(500);
  const hidden=await helper.command('status');assert.equal(hidden.windows,0);assert.equal(hidden.pointerVisible,false);
  await helper.command('begin',{indicatorText:'DSH visual preview',remoteIndicatorVisible:false});
  const injected=await helper.command('test_key',{vk:27,injected:true,down:true});assert.equal(injected.paused,false);
  const stopped=await helper.command('test_key',{vk:27,injected:false,down:true});
  assert.equal(stopped.paused,true);assert.equal(stopped.windows,0);assert.equal(stopped.pointerVisible,false);
  const result={ok:true,clickThrough:true,captureExcluded:true,noFocusChange:true,automaticHide:true,stopSeam:true,physicalKeysSent:false,maxStatusRoundtripMs:Math.round(Math.max(...rtts))};
  await fs.writeFile(path.join(fixture.directory,'live-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await helper.close();}
