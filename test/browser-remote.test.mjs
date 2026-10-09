import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

async function waitForMessages(h, count) {
  for (let tries = 0; tries < 40 && h.messages.length < count; tries++) await h.page.waitForTimeout(25);
  assert.equal(h.messages.length, count);
}

test('remote buttons and keyboard shortcuts route once to their owning device', async () => {
  const h = await harness({width:1280,height:900});
  try {
    await h.page.getByRole('button', {name:'Select Living Room TV', exact:true}).click();
    const tv = h.page.locator('.workspace-remote');
    assert.equal(await tv.locator('.workspace-remote-panel').isVisible(), true);
    await tv.locator('.workspace-remote-dpad-up').click();
    await tv.locator('.workspace-remote-dpad-center').click();
    await tv.locator('.workspace-remote-panel').focus();
    await h.page.keyboard.press('ArrowLeft');
    await h.page.keyboard.press('Enter');
    await h.page.keyboard.press('Escape');
    await waitForMessages(h,5);
    assert.deepEqual(h.messages, ['dpad-up','dpad-center','dpad-left','dpad-center','back']
      .map(button=>({device:'tv',tag:4,body:{button}})));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('remote native button activation does not duplicate commands or repeat held power', async () => {
  const h = await harness({width:1280,height:900});
  try {
    await h.page.getByRole('button', {name:'Select Living Room TV', exact:true}).click();
    const tv = h.page.locator('.workspace-remote');
    await tv.locator('.workspace-remote-power').focus();
    await h.page.keyboard.down('Enter');
    await h.page.keyboard.down('Enter');
    await h.page.keyboard.up('Enter');
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'tv',tag:4,body:{button:'power'}}]);
    await tv.locator('.workspace-remote-dpad-center').focus();
    await h.page.keyboard.press('Space');
    await waitForMessages(h,2);
    assert.deepEqual(h.messages[1],{device:'tv',tag:4,body:{button:'dpad-center'}});
    await h.page.getByRole('button', {name:'Toggle remote', exact:true}).click();
    await h.page.keyboard.press('ArrowRight');
    await h.page.waitForTimeout(50);
    assert.equal(h.messages.length,2);
  } finally { await h.close(); }
});

test('offline remote disables commands and reconnect never replays input', async () => {
  const h = await harness({width:1280,height:900});
  try {
    await h.page.getByRole('button', {name:'Select Living Room TV', exact:true}).click();
    const tv = h.page.locator('.workspace-remote');
    for (const ws of h.wss.clients) ws.close();
    await h.page.waitForTimeout(100);
    assert.equal(await tv.locator('.workspace-remote-dpad-center').isDisabled(), true);
    await tv.locator('.workspace-remote-panel').focus();
    await h.page.keyboard.press('Enter');
    await h.page.keyboard.press('ArrowDown');
    await h.page.waitForTimeout(1200);
    assert.deepEqual(h.messages,[]);
    assert.equal(await tv.locator('.workspace-remote-dpad-center').isEnabled(), true);
    await tv.locator('.workspace-remote-dpad-center').click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages[0],{device:'tv',tag:4,body:{button:'dpad-center'}});
  } finally { await h.close(); }
});

test('mirror affects remote commands only and excludes hidden devices', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const remote = h.page.locator('.workspace-remote');
    await h.page.getByRole('switch', {name:'Mirror input', exact:true}).click();
    await remote.locator('.workspace-remote-dpad-up').click();
    await waitForMessages(h,2);
    assert.deepEqual(h.messages.map(message=>message.device).sort(),['phone','tv']);
    assert.ok(h.messages.every(message=>message.tag===4 && message.body.button==='dpad-up'));
    h.messages.length=0;
    const phone = h.page.locator('.device[data-device="phone"] .screen-wrap');
    await phone.click();
    await waitForMessages(h,2);
    assert.deepEqual(h.messages.map(message=>message.body.type),['begin','end']);
    assert.ok(h.messages.every(message=>message.device==='phone'));
    h.messages.length=0;
    await phone.evaluate(surface => {
      surface.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',bubbles:true,cancelable:true}));
      surface.blur();
    });
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'phone',tag:13,body:{text:'x'}}]);
    h.messages.length=0;
    await h.page.getByRole('button', {name:'Hide Living Room TV', exact:true}).click();
    await remote.locator('.workspace-remote-dpad-down').click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'phone',tag:4,body:{button:'dpad-down'}}]);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('remote header keys never send Android navigation', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const remote = h.page.locator('.workspace-remote');
    await remote.locator('.workspace-remote-grip').focus();
    await h.page.keyboard.press('ArrowLeft');
    await h.page.keyboard.press('ArrowUp');
    await h.page.keyboard.press('Enter');
    await remote.locator('.workspace-remote-target').focus();
    await h.page.keyboard.press('ArrowRight');
    await h.page.waitForTimeout(50);
    assert.deepEqual(h.messages,[]);
  } finally { await h.close(); }
});

test('floating remote stays within the viewport when dragged and resized', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const remote = h.page.locator('.workspace-remote');
    const grip = await remote.locator('.workspace-remote-grip').boundingBox();
    await h.page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);
    await h.page.mouse.down();
    await h.page.mouse.move(0,0,{steps:4});
    await h.page.mouse.up();
    let bounds=await remote.boundingBox();
    assert.ok(bounds.x>=0 && bounds.y>=0);
    await h.page.setViewportSize({width:1024,height:768});
    await h.page.waitForTimeout(100);
    bounds=await remote.boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=1024);
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=768);
    assert.deepEqual(h.messages,[]);
  } finally { await h.close(); }
});

test('mobile target cycling and mirrored remote input affect only the displayed device', async () => {
  const h = await harness();
  try {
    const remote=h.page.locator('.workspace-remote');
    await h.page.getByRole('switch',{name:'Mirror input',exact:true}).click();
    await remote.locator('.workspace-remote-target').click();
    assert.equal(await h.page.locator('.device.selected-device').getAttribute('data-device'),'tv');
    await remote.locator('.workspace-remote-dpad-center').click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'tv',tag:4,body:{button:'dpad-center'}}]);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('remote movement clamps to the visible portion of a scrolled stage', async () => {
  const h = await harness({width:1440,height:1000});
  try {
    const remote=h.page.locator('.workspace-remote');
    await remote.evaluate(root => {
      const host=root.offsetParent;
      const height=root.offsetHeight+160;
      host.style.height=`${height}px`;
      host.style.maxHeight=`${height}px`;
      host.style.overflow='auto';
      const spacer=document.createElement('div');
      spacer.style.cssText='position:absolute;top:2400px;width:1px;height:1px';
      host.append(spacer);
      root.style.top='340px';
      root.style.bottom='auto';
      host.scrollTop=300;
    });
    await remote.locator('.workspace-remote-grip').focus();
    await h.page.keyboard.press('ArrowDown');
    await h.page.keyboard.press('ArrowLeft');
    const bounds=await remote.evaluate(root => {
      const host=root.offsetParent;
      const r=root.getBoundingClientRect(), parent=host.getBoundingClientRect();
      return {scroll:host.scrollTop,left:r.left,top:r.top,right:r.right,bottom:r.bottom,
        minX:parent.left+host.clientLeft,minY:parent.top+host.clientTop,
        maxX:parent.left+host.clientLeft+host.clientWidth,maxY:parent.top+host.clientTop+host.clientHeight};
    });
    assert.ok(bounds.scroll>0,'Fixture must exercise a scrolled stage');
    assert.ok(bounds.left>=bounds.minX && bounds.top>=bounds.minY,JSON.stringify(bounds));
    assert.ok(bounds.right<=bounds.maxX && bounds.bottom<=bounds.maxY,JSON.stringify(bounds));
    assert.deepEqual(h.messages,[]);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});
