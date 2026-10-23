import assert from 'node:assert/strict';
import {createHarness} from './ui-runtime.mjs';
import fs from 'node:fs/promises';
import {savePreview} from '../lib/preview.js';
import {artifactsDir} from './paths.mjs';
import path from 'node:path';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=','base64');
const directory=path.join(artifactsDir, 'preview 中文 #1 100%');
const preview=await savePreview(directory,png);
const image=(type)=>(_req,res)=>{res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});res.end(png);};
const browser=await createHarness(`
import '/assets/seeds.js';
try {
  const seeds=__hubSeeds,h=seeds.react.createElement,p=seeds['@deepseek-ai/dsh-client-ui-primitives'];
  globalThis.__resolved=[];
  const fileImages={resolve:path=>{__resolved.push(path);return location.origin+'/api/file?path='+encodeURIComponent(path)},labels:{open:'打开',loading:'加载中',failed:'图片无法预览',dialog:'图片',close:'关闭'}};
  const texts=['![内部附件](C:\\\\Users\\\\Test\\\\objects\\\\abcdef)','![明确文件](<C:/Users/Test/capture.png>)',${JSON.stringify(preview.markdown)}];
  const root=seeds['react-dom/client'].createRoot(document.getElementById('root'));
  root.render(h(p.MarkdownDelegateProvider,{fileImages},texts.map((text,index)=>h('section',{key:index,id:'case-'+index},h(p.MarkdownText,{text,labels:{}})))));
  await new Promise(resolve=>setTimeout(resolve,200));globalThis.__hubFixtureReady=true;
}catch(error){globalThis.__hubFixtureError=error.stack||String(error);}
`,{routes:{'/api/file':(req,res)=>{
  const requested=new URL(req.url,'http://localhost').searchParams.get('path');
  if (requested===preview.path || requested==='C:/Users/Test/capture.png') return image('image/png')(req,res);
  if (requested==='C:\\Users\\Test\\objects\\abcdef') return image('application/octet-stream')(req,res);
  res.writeHead(404);res.end();
}}});
try {
  await browser.sleep(300);
  const result=await browser.evaluate('({paths:__resolved,images:[...document.images].map(i=>({alt:i.alt,src:i.src,complete:i.complete,width:i.naturalWidth})),text:document.body.innerText})');
  console.log(JSON.stringify(result));
  assert.equal(result.images.find(i=>i.alt==='明确文件')?.width,1,'valid PNG fixture must load');
  assert.equal(result.images.find(i=>i.alt==='桌面操作结果')?.width,1,'exported preview must load through real DSH Markdown with #, %, spaces and Unicode');
  assert.ok(result.paths.includes(preview.path));
  assert.deepEqual(browser.errors,[]);
}finally{await browser.close();await fs.rm(directory,{recursive:true,force:true});}
