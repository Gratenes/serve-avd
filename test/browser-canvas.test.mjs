import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

const position = locator => locator.evaluate(n => ({x: n.offsetLeft, y: n.offsetTop}));
const camera = page => page.locator('.stage').evaluate(n => {
  const m = new DOMMatrix(getComputedStyle(n).transform);
  return {x: m.e, y: m.f, zoom: m.a};
});

test('canvas dragging snaps in world coordinates and survives selection, discovery and reload', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    await h.page.getByRole('button',{name:'Toggle remote',exact:true}).click();
    const phone = h.page.locator('.device[data-device="phone"]');
    const before = await position(phone);
    const head = await phone.locator('.device-head').boundingBox();
    const zoom = (await camera(h.page)).zoom;
    await h.page.mouse.move(head.x + 25, head.y + 10);
    await h.page.mouse.down();
    await h.page.mouse.move(head.x + 25 + 72 * zoom, head.y + 10 + 48 * zoom, {steps:5});
    await h.page.mouse.up();
    const moved = await position(phone);
    assert.deepEqual(moved, {x: before.x + 72, y: before.y + 48});
    assert.equal(h.messages.filter(m => m.tag === 3).length, 0);
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    await h.page.getByRole('button',{name:'Refresh devices',exact:true}).click();
    assert.deepEqual(await position(phone), moved);
    await h.page.waitForTimeout(250);
    const savedCamera = await camera(h.page);
    await h.page.reload();
    await phone.waitFor();
    assert.deepEqual(await position(phone), moved);
    assert.deepEqual(await camera(h.page), savedCamera);
    await phone.locator('.device-head').focus();
    await h.page.keyboard.press('ArrowRight');
    assert.deepEqual(await position(phone), {x: moved.x + 24, y: moved.y});
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('zoom is pointer anchored, Android coordinates remain correct and pan consumes input', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    await h.page.getByRole('button',{name:'Toggle remote',exact:true}).click();
    const surface = h.page.locator('.device[data-device="phone"] .screen-wrap');
    let box = await surface.boundingBox();
    const host = await h.page.locator('.workspace-stage').boundingBox();
    const anchor = {x:Math.round(box.x + box.width / 2), y:Math.round(box.y + box.height / 2)};
    const old = await camera(h.page);
    await h.page.mouse.move(anchor.x, anchor.y);
    await h.page.keyboard.down('Control');
    await h.page.mouse.wheel(0, 100);
    await h.page.keyboard.up('Control');
    await h.page.waitForTimeout(60);
    const next = await camera(h.page);
    assert.ok(next.zoom < old.zoom);
    assert.ok(next.zoom / old.zoom >= .85, `One Ctrl-scroll should change zoom gently, got ${Math.round((1 - next.zoom / old.zoom) * 100)}%`);
    assert.ok(Math.abs((anchor.x-host.x-old.x)/old.zoom - (anchor.x-host.x-next.x)/next.zoom) < .01);
    assert.equal(h.messages.filter(m=>m.tag===4).length, 0);
    box = await surface.boundingBox();
    await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await h.page.waitForTimeout(50);
    const touches = h.messages.filter(m=>m.tag===3);
    assert.deepEqual(touches.map(m=>m.body.type), ['begin','end']);
    assert.ok(touches.every(m=>Math.abs(m.body.x-.5)<.01 && Math.abs(m.body.y-.5)<.01));
    await h.page.getByRole('button',{name:'Pan canvas (drag anywhere)',exact:true}).click();
    const start = await camera(h.page);
    await h.page.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await h.page.mouse.down();
    await h.page.mouse.move(box.x + box.width/2+90, box.y+box.height/2+60, {steps:4});
    await h.page.mouse.up();
    const end = await camera(h.page);
    assert.ok(Math.abs(end.x-start.x-90)<.01 && Math.abs(end.y-start.y-60)<.01);
    assert.equal(h.messages.filter(m=>m.tag===3).length, 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('layout presets place cards once, fit all recovers a panned canvas, and hidden cards keep positions', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const phone = h.page.locator('.device[data-device="phone"]');
    const tv = h.page.locator('.device[data-device="tv"]');
    await h.page.getByRole('button',{name:'Stack',exact:true}).click();
    const stacked = await position(tv);
    assert.equal(stacked.x, (await position(phone)).x);
    assert.ok(stacked.y >= await phone.evaluate(n=>n.offsetHeight));
    await h.page.getByRole('button',{name:'Hide Living Room TV',exact:true}).click();
    await h.page.getByRole('button',{name:'Show Living Room TV',exact:true}).click();
    assert.deepEqual(await position(tv), stacked);
    await h.page.getByRole('button',{name:'Grid',exact:true}).click();
    assert.equal((await position(tv)).y, (await position(phone)).y);
    const workspace = h.page.locator('.workspace-stage');
    await workspace.focus();
    const host = await workspace.boundingBox();
    await h.page.keyboard.down('Space');
    await h.page.mouse.move(host.x+10,host.y+10);
    await h.page.mouse.down();
    await h.page.mouse.move(host.x+300,host.y+200);
    await h.page.mouse.up();
    await h.page.keyboard.up('Space');
    await h.page.getByRole('button',{name:'Fit all devices',exact:true}).click();
    for (const card of [phone,tv]) {
      const b = await card.boundingBox();
      assert.ok(b.x >= host.x && b.y >= host.y && b.x+b.width <= host.x+host.width+1 && b.y+b.height <= host.y+host.height-60);
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('entering desktop from mobile and adding mixed-size devices creates aligned grid columns', async () => {
  const h = await harness();
  try {
    await h.page.setViewportSize({width:1440,height:1000});
    const phone = h.page.locator('.device[data-device="phone"]');
    const tv = h.page.locator('.device[data-device="tv"]');
    await h.page.locator('.canvas-workspace').waitFor();
    assert.ok((await position(tv)).x >= (await position(phone)).x + await phone.evaluate(n=>n.offsetWidth));
    h.devices.push({...h.devices[1],device:'tv2',name:'Second TV'}, {...h.devices[0],device:'phone2',name:'Second phone'});
    await h.page.getByRole('button',{name:'Refresh devices',exact:true}).click();
    const tv2 = h.page.locator('.device[data-device="tv2"]');
    const phone2 = h.page.locator('.device[data-device="phone2"]');
    await phone2.waitFor();
    await h.page.getByRole('button',{name:'Grid',exact:true}).click();
    const [a,b,c,d] = await Promise.all([phone,tv,tv2,phone2].map(position));
    assert.equal(a.x,c.x);
    assert.equal(b.x,d.x);
    assert.equal(a.y,b.y);
    assert.equal(c.y,d.y);
    assert.ok(c.y>a.y);
    assert.ok(b.x >= c.x + await tv2.evaluate(n=>n.offsetWidth));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('large Ctrl/Meta scroll events stay gentle across pixel, line and page wheels', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const workspace = h.page.locator('.workspace-stage');
    for (const modifier of ['ctrlKey','metaKey']) {
      for (const deltaMode of [0,1,2]) {
        for (const direction of [-1,1]) {
          const before = await camera(h.page);
          await workspace.dispatchEvent('wheel', {[modifier]:true, deltaY:direction*1000, deltaMode, clientX:600, clientY:300});
          const after = await camera(h.page);
          const ratio = after.zoom / before.zoom;
          assert.ok(direction === 1 ? ratio < 1 && ratio >= .85 : ratio > 1 && ratio <= 1.15,
            `Large scroll must not jump: ${JSON.stringify({modifier,deltaMode,direction,ratio})}`);
        }
      }
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('sidebar selection focuses the device without rearranging cards and refocuses on repeated clicks', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const phone = h.page.locator('.device[data-device="phone"]');
    const tv = h.page.locator('.device[data-device="tv"]');
    const positions = await Promise.all([phone,tv].map(position));
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    const focused = await camera(h.page);
    const screen = tv.locator('.screen-wrap');
    assert.equal(await screen.evaluate(n=>document.activeElement===n),true);
    const host = await h.page.locator('.workspace-stage').boundingBox();
    const box = await tv.boundingBox();
    assert.ok(Math.abs(box.x+box.width/2-host.x-host.width/2)<1, 'Sidebar selection centers the card');
    await h.page.getByRole('button',{name:'Zoom out',exact:true}).click();
    assert.ok((await camera(h.page)).zoom < focused.zoom);
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    assert.deepEqual(await camera(h.page),focused);
    assert.deepEqual(await Promise.all([phone,tv].map(position)),positions);
    await h.page.getByRole('button',{name:'Hide Living Room TV',exact:true}).click();
    await h.page.getByRole('button',{name:'Select Living Room TV',exact:true}).click();
    assert.equal(await tv.isVisible(),true);
    assert.deepEqual(await camera(h.page),focused);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('each device expand button fills the workspace with that device and Layout only arranges cards', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    await h.page.getByRole('button',{name:'Toggle remote',exact:true}).click();
    const cards = [h.page.locator('.device[data-device="phone"]'), h.page.locator('.device[data-device="tv"]')];
    const positions = await Promise.all(cards.map(position));
    assert.deepEqual(await h.page.locator('.layout-picker button').allTextContents(),['Focus','Grid','Split','Stack']);
    const host = await h.page.locator('.workspace-stage').boundingBox();
    for (const [index, card] of cards.entries()) {
      await h.page.getByRole('button',{name:'Fit all devices',exact:true}).click();
      for (let i=0; i<4; i++) await h.page.getByRole('button',{name:'Zoom out',exact:true}).click();
      const before = await camera(h.page);
      await card.getByRole('button',{name:'Fill screen with this device',exact:true}).click();
      assert.ok((await camera(h.page)).zoom > before.zoom);
      assert.equal(await h.page.evaluate(()=>document.fullscreenElement),null);
      assert.equal(await card.locator('.screen-wrap').evaluate(n=>n===document.activeElement),true);
      const box = await card.boundingBox();
      assert.ok(box.x>=host.x && box.y>=host.y && box.x+box.width<=host.x+host.width && box.y+box.height<=host.y+host.height);
      assert.ok(Math.abs(box.x+box.width/2-host.x-host.width/2)<2, 'Requested device is centered');
      assert.ok(Math.abs(box.width-(host.width-48))<2 || Math.abs(box.height-(host.height-104))<2,
        'Requested device fills the limiting dimension');
      assert.equal(await cards[1-index].isVisible(),true, 'Other devices remain on the canvas');
      assert.deepEqual(await Promise.all(cards.map(position)),positions);
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
