import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

async function waitForMessages(h, count) {
  for (let tries = 0; tries < 40 && h.messages.length < count; tries++) await h.page.waitForTimeout(25);
  assert.ok(h.messages.length >= count, `Expected ${count} commands, got ${JSON.stringify(h.messages)}`);
}

test('mobile preview fits narrow viewports and panes remain reachable', async () => {
  for (const viewport of [{width:320,height:640}, {width:390,height:844}, {width:844,height:390}]) {
    const h = await harness(viewport);
    try {
      assert.equal(await h.page.locator('.device:visible').count(), 1);
      assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await h.page.locator('.device-selector').selectOption('tv');
      const bounds = await h.page.locator('.device.selected-device .screen-wrap').boundingBox();
      assert.ok(bounds.width > 100 && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds.y + bounds.height <= viewport.height, "Preview fits phone landscape height");
      await h.page.getByRole('button', {name:'Toggle device list', exact:true}).click();
      assert.equal(await h.page.locator('.device-rail:visible').count(), 1);
      await h.page.getByRole('button', {name:'Toggle device list', exact:true}).click();
      assert.equal(await h.page.locator('.device-rail:visible').count(), 0);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  }
});

test('mobile text, special keys and logs route to the selected device', async () => {
  const h = await harness();
  try {
    await h.page.locator('.device-selector').selectOption('tv');
    const selected = h.page.locator('.device.selected-device');
    await selected.locator('.text-entry summary').click();
    await selected.locator('textarea').fill('hello world');
    await selected.getByRole('button', {name:'Send', exact:true}).click();
    await selected.getByRole('button', {name:'Enter', exact:true}).click();
    await waitForMessages(h, 3);
    assert.deepEqual(h.messages.slice(0,3), [
      {device:'tv',tag:13,body:{text:'hello world'}},
      {device:'tv',tag:6,body:{type:'down',code:'Enter'}},
      {device:'tv',tag:6,body:{type:'up',code:'Enter'}},
    ]);
    assert.equal(await selected.locator('textarea').inputValue(), '');
    await h.page.getByRole('button', {name:'Toggle inspector', exact:true}).click();
    await h.page.getByRole('button', {name:'Logcat', exact:true}).click();
    await h.page.waitForTimeout(100);
    assert.ok(h.requests.includes('/tv/logs'));
    assert.ok(!h.requests.includes('/phone/logs'));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('second finger is ignored and cancellation ends the active gesture', async () => {
  const h = await harness();
  try {
    const surface = h.page.locator('.device.selected-device .screen-wrap');
    const box = await surface.boundingBox();
    const cdp = await h.page.context().newCDPSession(h.page);
    const p = {x:box.x + box.width / 2,y:box.y + box.height / 2,id:1};
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[p]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[p,{...p,x:p.x+15,id:2}]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchCancel',touchPoints:[]});
    await waitForMessages(h,2);
    const touches=h.messages.filter(m=>m.tag===3);
    assert.deepEqual(touches.map(m=>m.body.type),['begin','end']);
    assert.ok(touches.every(m=>m.device==='phone'));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('disconnected commands are not replayed and unsent text is retained', async () => {
  const h = await harness();
  try {
    const selected = h.page.locator('.device.selected-device');
    await selected.locator('.text-entry summary').click();
    await selected.locator('textarea').fill('retry me');
    for (const ws of h.wss.clients) ws.close();
    await h.page.waitForTimeout(100);
    await selected.getByRole('button', {name:'Send', exact:true}).click();
    await selected.getByText('Device controls', {exact:true}).click();
    await selected.locator('[title="Home"]').click();
    assert.equal(await selected.locator('textarea').inputValue(), 'retry me');
    await h.page.waitForTimeout(1200);
    assert.deepEqual(h.messages, []);
    await selected.getByRole('button', {name:'Send', exact:true}).click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages[0],{device:'phone',tag:13,body:{text:'retry me'}});
  } finally { await h.close(); }
});

test('device switching and page visibility pause and resume MJPEG previews', async () => {
  const h = await harness();
  try {
    const phone = h.page.locator('.device').nth(0).locator('img');
    const tv = h.page.locator('.device').nth(1).locator('img');
    assert.match(await phone.getAttribute('src'), /^\/phone\/streamMjpeg/);
    assert.equal(await tv.getAttribute('src'), null);
    await h.page.locator('.device-selector').selectOption('tv');
    assert.equal(await phone.getAttribute('src'), null);
    assert.match(await tv.getAttribute('src'), /^\/tv\/streamMjpeg/);
    const initialRequests = h.requests.filter(path => path.startsWith('/tv/streamMjpeg')).length;
    // Browsers deliberately keep automation tabs foregrounded. Dispatch the
    // document lifecycle transition while exercising the production listener.
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await tv.getAttribute('src'), null);
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await h.page.waitForTimeout(100);
    assert.match(await tv.getAttribute('src'), /^\/tv\/streamMjpeg/);
    assert.ok(h.requests.filter(path => path.startsWith('/tv/streamMjpeg')).length > initialRequests);
    assert.equal(await phone.getAttribute('src'), null);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('H264 fetch is aborted for inactive devices and restarts on resume', async () => {
  const h = await harness({width:390,height:844}, 'auto');
  try {
    await h.page.waitForTimeout(100);
    assert.ok(h.requests.includes('/phone/streamAvcc'));
    await h.page.locator('.device-selector').selectOption('tv');
    await h.page.waitForTimeout(350);
    assert.ok(h.streamClosures.includes('/phone/streamAvcc'));
    assert.ok(h.requests.includes('/tv/streamAvcc'));
    const requestsBeforeResume = h.requests.filter(path => path === '/phone/streamAvcc').length;
    await h.page.locator('.device-selector').selectOption('phone');
    await h.page.waitForTimeout(350);
    assert.ok(h.streamClosures.includes('/tv/streamAvcc'));
    assert.ok(h.requests.filter(path => path === '/phone/streamAvcc').length > requestsBeforeResume);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('desktop text buffered before focus changes is sent exactly once', async () => {
  const h = await harness({width:1280,height:900});
  try {
    const phone = h.page.locator('.device').nth(0);
    await phone.locator('.screen-wrap').focus();
    // Dispatch synchronously to make blur occur before the 120ms flush timer.
    await phone.locator('.screen-wrap').evaluate(surface => {
      surface.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',bubbles:true,cancelable:true}));
      surface.blur();
    });
    await waitForMessages(h,1);
    await h.page.waitForTimeout(150);
    assert.deepEqual(h.messages,[{device:'phone',tag:13,body:{text:'x'}}]);
  } finally { await h.close(); }
});

test('backgrounded mobile remote disables controls and resumes without replay', async () => {
  const h = await harness();
  try {
    await h.page.locator('.device-selector').selectOption('tv');
    const tv = h.page.locator('.workspace-remote');
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await tv.locator('.workspace-remote-dpad-center').isDisabled(), true);
    await tv.locator('.workspace-remote-panel').dispatchEvent('keydown',{code:'Enter',key:'Enter'});
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true,get:()=>false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await tv.locator('.workspace-remote-dpad-center').isEnabled(), true);
    assert.deepEqual(h.messages,[]);
    await tv.locator('.workspace-remote-dpad-center').click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'tv',tag:4,body:{button:'dpad-center'}}]);
  } finally { await h.close(); }
});

test('workspace layouts, hiding every device and recovery keep selection valid', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const devices = h.page.locator('.device:visible');
    assert.equal(await devices.count(),2);
    await h.page.getByRole('button',{name:'Focus',exact:true}).click();
    assert.equal(await h.page.getByRole('button',{name:'Focus',exact:true}).getAttribute('aria-pressed'),'true');
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    assert.equal(await h.page.locator('.device.selected-device').getAttribute('data-device'),'tv');
    await h.page.getByRole('button',{name:'Stack',exact:true}).click();
    assert.equal(await devices.count(),2);
    await h.page.getByRole('button',{name:'Split',exact:true}).click();
    assert.equal(await devices.count(),2);
    await h.page.getByRole('button',{name:'Hide Living Room TV',exact:true}).click();
    assert.equal(await h.page.locator('.device.selected-device').getAttribute('data-device'),'phone');
    await h.page.getByRole('button',{name:'Hide Pixel Phone',exact:true}).click();
    assert.equal(await devices.count(),0);
    assert.equal(await h.page.locator('.workspace-remote-dpad-center').isDisabled(),true);
    await h.page.getByRole('button',{name:'Show all devices',exact:true}).click();
    assert.equal(await devices.count(),2);
    assert.equal(await h.page.locator('.device.selected-device').count(),1);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('inspector search and log streams follow the selected device', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    await h.page.getByRole('searchbox',{name:'Find a control',exact:true}).fill('battery');
    const groups=h.page.locator('.inspector-group:visible');
    assert.equal(await groups.count(),1);
    assert.equal(await groups.first().getAttribute('data-group'),'Battery');
    await h.page.getByRole('button',{name:'Logcat',exact:true}).click();
    await h.page.waitForTimeout(50);
    assert.ok(h.requests.includes('/tv/logs'));
    await h.page.getByRole('button',{name:'Select Pixel Phone',exact:true}).click();
    await h.page.waitForTimeout(50);
    assert.ok(h.requests.includes('/phone/logs'));
    assert.match(await h.page.locator('.inspector-identity').innerText(),/Pixel Phone/);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});


test('X and eye hide previews only in this browser and discovery preserves visibility', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const tv = h.page.locator('.device[data-device="tv"]');
    await tv.getByRole('button', {name:'Hide from workspace',exact:true}).click();
    assert.equal(await tv.isVisible(), false);
    const show = h.page.getByRole('button', {name:'Show Living Room TV',exact:true});
    assert.equal(await show.getAttribute('aria-pressed'), 'false');
    assert.equal(await h.page.locator('.rail-row[data-device="tv"]').count(), 1);
    await Promise.all([h.page.waitForResponse(response => response.url().endsWith('/grid')),
      h.page.getByRole('button', {name:'Refresh devices',exact:true}).click()]);
    assert.equal(await tv.isVisible(), false);
    const second = await h.page.context().newPage();
    await second.goto(h.page.url());
    await second.locator('.device[data-device="tv"]').waitFor({state:'visible'});
    await second.close();
    await show.click();
    assert.equal(await tv.isVisible(), true);
    assert.equal(await h.page.getByRole('button', {name:'Hide Living Room TV',exact:true}).getAttribute('aria-pressed'), 'true');
    assert.ok(!h.requests.includes('/start'));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('device discovery adds connected devices and removes disconnected devices without reload', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const extra = {...h.devices[0], device:'new-phone', name:'New Phone'};
    for (const key of Object.keys(extra).filter(key => key.endsWith('Endpoint'))) extra[key] = extra[key].replace('/phone/', '/new-phone/');
    h.devices.push(extra);
    await h.page.getByRole('button', {name:'Refresh devices',exact:true}).click();
    await h.page.getByRole('button', {name:'Select New Phone',exact:true}).waitFor();
    assert.equal(await h.page.locator('.device:visible').count(), 3);
    await h.page.getByRole('button', {name:'Select New Phone',exact:true}).click();
    h.devices.pop();
    await h.page.getByRole('button', {name:'Refresh devices',exact:true}).click();
    await h.page.locator('.device[data-device="new-phone"]').waitFor({state:'detached'});
    assert.equal(await h.page.locator('.device:visible').count(), 2);
    assert.equal(await h.page.locator('.device.selected-device').count(), 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
