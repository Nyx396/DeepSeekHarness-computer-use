import assert from 'node:assert/strict';
import { createHarness } from './ui-runtime.mjs';

// Boot through DSH's actual concurrent module loader, not sequential ctx.plugin().
const browser = await createHarness(`
import '/assets/seeds.js';
import '/renderer.js';
import '/modules.js';
import '/hub.js';
import '/client.js';
try {
  const seeds=globalThis.__hubSeeds, React=seeds.react, h=React.createElement;
  const ctx=new seeds['@deepseek-ai/cordis'].Context();globalThis.__ctx=ctx;
  const renderer=__hubFactories.get('@deepseek-ai/dsh-client-ui-renderer')(id=>seeds[id]);
  renderer.apply(ctx);
  ctx.slots.installScope('session',{current:{getSnapshot:()=>undefined,subscribe:()=>()=>{}}});
  function App(){return h('div');}
  const registerRoot=()=>globalThis.__unmountRoot=ctx.slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'},'conversation.input.left':{kind:'list',scope:'root'}}},App);
  globalThis.__registerRoot=registerRoot;
  if(${process.env.DSH_TEST_LATE_SLOTS === '1'})setTimeout(registerRoot,100);else registerRoot();
  const moduleExports=__hubFactories.get('@deepseek-ai/dsh-client-modules')(id=>seeds[id]);
  const ids=['dsh-plugin-hub','dsh-desktop-control'];
  const manifest={rev:'test',modules:ids.map(id=>({id,url:'/'+id+'.js',initialUrl:'/'+id+'.js',rev:'test',external:['react'],inject:id==='dsh-desktop-control'?['dsh-plugin-hub']:[]})),plugins:ids.map(id=>({id,inject:[],immediately:false}))};
  const target={mode:'queue',pendingQueue:ids.map(id=>({id,factory:__hubFactories.get(id)}))};
  const modules=new moduleExports.ClientModuleSystem({manifest,staticModules:seeds,bootstrapModule:{id:'@deepseek-ai/dsh-client-modules',exports:moduleExports},registrationTarget:target});
  try {await __hubBoot({ctx,modules,manifest});}
  catch(error) {
    const details=[];
    for(const entry of ctx.loader.entries()) {
      try {await entry.fiber?.await();}catch(cause){details.push(entry.options.name+': '+cause.stack);}
    }
    throw Error(error.message+'\\n'+details.join('\\n'));
  }
  await new Promise(resolve=>setTimeout(resolve,150));
  globalThis.__states=[...ctx.loader.entries()].map(e=>({id:e.options.name,state:e.fiber?.state}));
  globalThis.__hubFixtureReady=true;
}catch(error){globalThis.__hubFixtureError=error.stack||String(error);}
`);
try {
  const states=await browser.evaluate('__states');
  assert.ok(states.every(row=>row.state===2),JSON.stringify(states));
  const settingsCount=()=>browser.evaluate('__ctx.slots.entriesOfSlot("plugin-hub.settings").filter(e=>e.options.id==="desktop-control").length');
  assert.equal(await settingsCount(),1);
  await browser.evaluate('__unmountRoot();__registerRoot()');
  assert.equal(await settingsCount(),1);
  assert.deepEqual(browser.errors,[]);
  console.log(JSON.stringify({ok:true,concurrentBoot:states}));
  await browser.evaluate('__ctx.fiber.dispose()');
} finally {await browser.close();}
