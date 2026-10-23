import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskAuthorization } from '../lib/authorization.js';

const who = (id='a',turn=1) => ({id,turn,key:JSON.stringify([id,turn])});
const exec = () => ({agent:{session:{id:'a'}},callId:'test-approval',signal:new AbortController().signal});
const args = {task:'Enter fixture code',windowTitles:['Fixture'],benefit:'necessary',reason:'Only the drawn pixels contain the code'};
test('approval is fail-closed for absent, rejected, cancelled and unknown answers',async()=>{
  for (const outcome of ['rejected','cancelled','unavailable','forged-allow']) {
    let requests=0;const auth=new TaskAuthorization({approver:()=>({request:async()=>{requests++;return outcome;}})});
    await assert.rejects(auth.begin(exec(),who(),args),/未获批准/);
    assert.throws(()=>auth.require(who(),'invented'),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(auth.begin(exec(),who(),args),/不得反复申请/);
    assert.equal(requests,1);
  }
  const missing=new TaskAuthorization({approver:()=>undefined});
  await assert.rejects(missing.begin(exec(),who(),args),/没有可用/);
});
test('one native approval covers same-task turns, binds target HWND/PID, and cannot cross sessions or scopes',async()=>{
  let requests=0;const auth=new TaskAuthorization({approver:()=>({request:async req=>{requests++;assert.ok(req.reason.includes('Fixture'));return 'allowed-once';}})});
  const grant=await auth.begin(exec(),who(),args);
  const current=auth.require(who('a',2),grant.authorizationId);
  assert.equal(requests,1);assert.throws(()=>auth.require(who('b'),grant.authorizationId),/AUTHORIZATION_REQUIRED/);
  auth.window(who(),{nativeWindowHandle:1,processId:2,name:'Fixture'});
  auth.window(who(),{nativeWindowHandle:1,processId:2,title:'Fixture - changed'});
  assert.throws(()=>auth.window(who(),{nativeWindowHandle:1,processId:3,title:'Fixture'}),/超出/);
  assert.throws(()=>auth.window(who(),{nativeWindowHandle:9,processId:2,title:'Other'}),/超出/);
  assert.equal(auth.allows(current,{nativeWindowHandle:9,processId:4,title:'Other'}),false);
  auth.revoke('a');assert.throws(()=>auth.require(who(),grant.authorizationId),/AUTHORIZATION_REQUIRED/);
});
test('enumeration-only grants cannot observe/input, idle grants expire and new tasks replace tokens',async()=>{
  let now=0;const auth=new TaskAuthorization({now:()=>now,approver:()=>({request:async()=> 'allowed-once'})});
  const first=await auth.begin(exec(),who(),{...args,windowTitles:[]});
  assert.throws(()=>auth.window(who(),{nativeWindowHandle:1,processId:2,title:'Fixture'}),/超出/);
  const second=await auth.begin(exec(),who(),args);
  assert.throws(()=>auth.require(who(),first.authorizationId),/AUTHORIZATION_REQUIRED/);
  now=30*60*1000+1;assert.throws(()=>auth.require(who(),second.authorizationId),/AUTHORIZATION_REQUIRED/);
});
test('pause/revocation and caller abort discard even a late positive approval; malformed scopes never ask',async()=>{
  let resolve;const auth=new TaskAuthorization({approver:()=>({request:()=>new Promise(r=>{resolve=r;})})});
  const pending=auth.begin(exec(),who(),args);auth.clear();resolve('allowed-once');await assert.rejects(pending,/撤销/);
  assert.equal(auth.grants.size,0);
  let requests=0;const invalid=new TaskAuthorization({approver:()=>({request:async()=>{requests++;return 'allowed-once';}})});
  await assert.rejects(invalid.begin(exec(),who(),{...args,benefit:'convenient'}),/benefit/);
  await assert.rejects(invalid.begin(exec(),who(),{...args,windowTitles:['Fixture','Fixture']}),/不重复/);
  assert.equal(requests,0);
});
