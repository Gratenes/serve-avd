import test from 'node:test';
import assert from 'node:assert/strict';
import { MacroRunner, pause, recordedStep, resolveDeepLink } from '../src/client/macro-model';

test('deep links substitute and encode ids without sending cancelled prompts', () => {
  assert.equal(resolveDeepLink('demo://title/{id}?next={id}', 'a/b ?'), 'demo://title/a%2Fb%20%3F?next=a%2Fb%20%3F');
  assert.equal(resolveDeepLink('demo://title/{id}', null), null);
  assert.equal(resolveDeepLink('demo://home'), 'demo://home');
});
test('macro recorder records actual keys, text and normalized gestures, ignoring key releases', () => {
  assert.deepEqual(recordedStep(4, {button:'dpad-up'}, 123), {kind:'KEY',value:'dpad-up',waitMs:123});
  assert.equal(recordedStep(6,{code:'Enter',type:'up'},0), null);
  assert.equal(recordedStep(15,{},0), null);
  assert.equal(recordedStep(3,{type:'begin',x:0.5,y:0.4},0)?.kind,'INPUT');
});
test('stopping interrupts a pending wait immediately and runner rejects empty or offline targets', async () => {
  const abort = new AbortController(); const waiting = pause(10000,abort.signal); abort.abort(); await assert.rejects(waiting,/stopped/);
  const runner = new MacroRunner();
  await assert.rejects(runner.run([],[],1,false,()=>{}),/at least one step/);
  await assert.rejects(runner.run([{kind:'WAIT',value:'1',waitMs:0}],[],1,false,()=>{}),/connected devices/);
  assert.equal(runner.running,false);
});
test('macro validation rejects malformed steps before requests and stops on a crash during a long final wait', async () => {
  const device = { entry:{device:'tv',name:'TV',actionEndpoint:'/tv/action'}, connected:true,sendInput:()=>true } as never;
  const runner = new MacroRunner();
  await assert.rejects(runner.run([{kind:'KEY',value:'Bogus',waitMs:0}],[device],1,false,()=>{}),/Unknown key/);
  await assert.rejects(runner.run([{kind:'WAIT',value:'1',waitMs:NaN}],[device],1,false,()=>{}),/Step delay/);
  const original=globalThis.fetch;let checks=0;
  globalThis.fetch=async()=>new Response(JSON.stringify({crashes:checks++?[{id:'new'}]:[]}));
  try { const started=Date.now();await assert.rejects(runner.run([{kind:'WAIT',value:'10000',waitMs:0}],[device],1,true,()=>{}),/app crashed/);assert.ok(Date.now()-started<2000);assert.equal(runner.running,false); }
  finally { globalThis.fetch=original; }
});
