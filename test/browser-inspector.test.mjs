import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

async function inspector() {
  const h = await harness({width:1440,height:1000});
  const actions=[];
  const states={phone:{level:67,plugged:'usb',wifi:true,data:true,airplane:false},tv:{level:22,plugged:'ac',wifi:false,data:true,airplane:false}};
  let failure=null;
  await h.page.route('**/*/action',async route=>{
    const device=new URL(route.request().url()).pathname.split('/')[1];
    const {action,params}=route.request().postDataJSON();
    actions.push({device,action,params});
    if (failure && action===failure && Object.keys(params).length) {
      await route.fulfill({status:400,json:{ok:false,message:'Device refused the change'}}); return;
    }
    const state=states[device]; let result={};
    if(action==='network') { Object.assign(state,params); result={wifi:state.wifi,data:state.data,airplane:state.airplane,...params}; }
    if(action==='battery') { Object.assign(state,params.reset?{level:91,plugged:'wireless'}:params); result={level:state.level,plugged:state.plugged}; }
    if(action==='debug') result={flags:{overdraw:false,'gpu-profile':false,'layout-bounds':false,'show-taps':false,'pointer-location':false,'slow-animations':false},...params};
    if(action==='font-scale') result={scale:params.scale??1};
    if(action==='talkback'||action==='high-contrast') result={enabled:params.enabled??false};
    if(action==='snapshot') result={snapshots:[]};
    await route.fulfill({json:{ok:true,result}});
  });
  if (!await h.page.locator('.panes.inspector').isVisible()) await h.page.getByRole('button',{name:'Toggle inspector',exact:true}).click();
  await h.page.getByRole('button',{name:'Controls',exact:true}).click();
  await h.page.waitForFunction(()=>document.querySelector('[aria-label="High-contrast text"]')?.indeterminate===false);
  const group=title=>h.page.locator(`details[data-group="${title}"]`);
  const open=async title=>{const g=group(title);if(!await g.getAttribute('open') && await g.getAttribute('open')!== '') await g.locator('summary').click();return g;};
  return {...h,actions,states,group,open,fail(action){failure=action;}};
}

test('inspector has eight design groups plus snapshots/history, actual battery readback and summaries',async()=>{
  const h=await inspector();
  try {
    assert.deepEqual(await h.page.locator('.inspector-group').evaluateAll(groups=>groups.map(g=>g.dataset.group)),['Quick actions','Network','Battery','Location','Apps','Render debugging','Telephony & sensors','Accessibility','Snapshots','Recent actions']);
    assert.match(await h.group('Battery').locator('summary').textContent(),/67% · USB/);
    await h.open('Battery');
    assert.equal(await h.group('Battery').getByRole('slider',{name:'Battery level'}).inputValue(),'67');
    await h.group('Battery').getByRole('button',{name:'Reset',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('[aria-label="Battery level"]').value==='91');
    assert.match(await h.group('Battery').locator('[data-summary]').getAttribute('data-summary'),/91% · WIRELESS/);
    await h.group('Network').getByRole('button',{name:'200 ms',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('[title="Network latency: 200 ms"]').getAttribute('aria-pressed')==='true');
    assert.ok(h.actions.some(a=>a.action==='network'&&a.params.delay==='200'));
    await h.group('Network').getByRole('button',{name:'Off',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('[aria-label="Mobile data"]').checked===false);
    assert.ok(h.actions.some(a=>a.action==='network'&&a.params.data===false&&!('speed'in a.params)));
    assert.equal(h.states.phone.wifi,true);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('location presets require Send location and settings route only to selected device',async()=>{
  const h=await inspector();
  try {
    await h.page.getByRole('switch',{name:'Mirror input',exact:true}).click();
    await h.open('Location');
    await h.group('Location').getByRole('button',{name:'Tokyo',exact:true}).click();
    assert.equal(await h.group('Location').getByRole('spinbutton',{name:'Latitude',exact:true}).inputValue(),'35.6762');
    assert.equal(h.actions.filter(a=>a.action==='geo').length,0);
    await h.group('Location').getByRole('button',{name:'Send location',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('details[data-group="Location"] [data-summary]').dataset.summary.includes('139.6503'));
    assert.deepEqual(h.actions.filter(a=>a.action==='geo'),[{device:'phone',action:'geo',params:{lat:35.6762,lon:139.6503}}]);
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('[aria-label="High-contrast text"]')?.indeterminate===false);
    assert.equal(await h.group('Location').getByRole('spinbutton',{name:'Latitude',exact:true}).inputValue(),'');
    await h.open('Accessibility');
    await h.group('Accessibility').getByRole('switch',{name:'High-contrast text',exact:true}).click();
    await h.page.waitForFunction(()=>document.querySelector('[aria-label="High-contrast text"]').checked===true);
    assert.deepEqual(h.actions.filter(a=>a.action==='high-contrast'&&a.params.enabled!==undefined),[{device:'tv',action:'high-contrast',params:{enabled:true}}]);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('failed segmented changes retain last applied state and show error outside filtered groups',async()=>{
  const h=await inspector();
  try {
    const button=h.group('Network').getByRole('button',{name:'LTE',exact:true});
    await button.click();
    await h.page.waitForFunction(()=>document.querySelector('[title="Network speed: LTE"]').getAttribute('aria-pressed')==='true');
    h.fail('network');
    await h.page.getByRole('searchbox',{name:'Find a control',exact:true}).fill('latency');
    await h.group('Network').getByRole('button',{name:'3G',exact:true}).click();
    await h.page.getByRole('status').filter({hasText:'Device refused the change'}).waitFor({state:'visible'});
    assert.equal(await button.getAttribute('aria-pressed'),'true');
    assert.equal(await h.group('Snapshots').isVisible(),false);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});
