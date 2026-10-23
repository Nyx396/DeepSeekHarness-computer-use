import assert from 'node:assert/strict';
import { createHarness } from './ui-runtime.mjs';

const fixture = `
import '/assets/seeds.js';
import '/renderer.js';
import '/hub.js';
import '/client.js';
try {
  const seeds=globalThis.__hubSeeds, React=seeds.react, h=React.createElement;
  const ctx=new seeds['@deepseek-ai/cordis'].Context();
  const renderer=__hubFactories.get('@deepseek-ai/dsh-client-ui-renderer')(id=>seeds[id]);
  const hub=__hubFactories.get('dsh-plugin-hub')(id=>seeds[id]);
  const desktop=__hubFactories.get('dsh-desktop-control')(id=>seeds[id]);
  renderer.apply(ctx);
  ctx.slots.installScope('session',{current:{getSnapshot:()=>undefined,subscribe:()=>()=>{}}});
  globalThis.__settings={enabled:true,screenshotWidth:1280};globalThis.__posts=[];
  globalThis.fetch=async(url,options={})=>{
    if(options.method==='POST'){__settings=JSON.parse(options.body);__posts.push(__settings);}
    return new Response(JSON.stringify({settings:__settings,version:'0.1.0',busy:false,stopped:false,platform:'win32'}),{status:200});
  };
  function App({renderSlot}) {
    return h('main',null,h('div',{id:'fixture-composer'},renderSlot('conversation.input.left',{sessionId:'test',inputActions:{}})),renderSlot('settings.section',{close:()=>{}},{only:'plugin-hub'}));
  }
  ctx.slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'},'conversation.input.left':{kind:'list',scope:'root'}}},App);
  globalThis.__hubFiber=ctx.plugin(hub);await __hubFiber.await();
  globalThis.__desktopFiber=ctx.plugin(desktop);await __desktopFiber.await();
  if(__desktopFiber.state!==2)throw Error('Desktop plugin did not activate: '+__desktopFiber.state);
  globalThis.__ctx=ctx;
  ctx.uiRenderer.mount(document.getElementById('root'));
  globalThis.__hubFixtureReady=true;
}catch(error){globalThis.__hubFixtureError=error.stack||String(error);}
`;
const browser = await createHarness(fixture);
try {
  const ev = browser.evaluate;
  await browser.sleep(150);
  const text = await ev('document.body.innerText');
  assert.ok(text.includes('桌面操作'), text);
  // Hub uses its own settings tabs and renderer, exactly as the installed app.
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('桌面操作'));if(!b)throw Error('desktop settings missing');b.click()})()`);
  await browser.sleep(150);
  assert.ok((await ev('document.body.innerText')).includes('暂停所有桌面工具'));
  await ev(`([...document.querySelectorAll('button')].find(b=>b.textContent==='暂停所有桌面工具')).click()`);
  await browser.sleep(150);
  assert.equal(await ev('__settings.enabled'), false);
  await ev(`([...document.querySelectorAll('button')].find(b=>b.textContent==='启用桌面工具')).click()`);
  await browser.sleep(150);
  assert.equal(await ev('__settings.enabled'), true);
  await browser.screenshot('desktop-settings-light');
  await ev(`document.documentElement.style.cssText='--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-border-l2:#444;--dsw-alias-bg-layer-2:#222';document.body.style.background='#222'`);
  await browser.screenshot('desktop-settings-dark');
  await ev('__desktopFiber.dispose()');
  assert.equal(await ev('!!document.querySelector("style[data-plugin=dsh-desktop-control]")'), false);
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ ok: true, nativeHub: true, settings: true, pause: true, resume: true, disposal: true }));
} finally { await browser.close(); }
