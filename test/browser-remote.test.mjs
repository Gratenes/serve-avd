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
    const tv = h.page.locator('.device').nth(1);
    assert.equal(await tv.locator('.tv-remote-panel').isVisible(), false);
    await tv.locator('.tv-remote-toggle').click();
    await tv.locator('.tv-remote-dpad-up').click();
    await tv.locator('.tv-remote-dpad-center').click();
    await tv.locator('.tv-remote-panel').focus();
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
    const tv = h.page.locator('.device').nth(1);
    await tv.locator('.tv-remote-toggle').click();
    await tv.locator('.tv-remote-power').focus();
    await h.page.keyboard.down('Enter');
    await h.page.keyboard.down('Enter');
    await h.page.keyboard.up('Enter');
    await waitForMessages(h,1);
    assert.deepEqual(h.messages,[{device:'tv',tag:4,body:{button:'power'}}]);
    await tv.locator('.tv-remote-dpad-center').focus();
    await h.page.keyboard.press('Space');
    await waitForMessages(h,2);
    assert.deepEqual(h.messages[1],{device:'tv',tag:4,body:{button:'dpad-center'}});
    await tv.locator('.tv-remote-toggle').click();
    await h.page.keyboard.press('ArrowRight');
    await h.page.waitForTimeout(50);
    assert.equal(h.messages.length,2);
  } finally { await h.close(); }
});

test('offline remote disables commands and reconnect never replays input', async () => {
  const h = await harness({width:1280,height:900});
  try {
    const tv = h.page.locator('.device').nth(1);
    await tv.locator('.tv-remote-toggle').click();
    for (const ws of h.wss.clients) ws.close();
    await h.page.waitForTimeout(100);
    assert.equal(await tv.locator('.tv-remote-dpad-center').isDisabled(), true);
    await tv.locator('.tv-remote-panel').focus();
    await h.page.keyboard.press('Enter');
    await h.page.keyboard.press('ArrowDown');
    await h.page.waitForTimeout(1200);
    assert.deepEqual(h.messages,[]);
    assert.equal(await tv.locator('.tv-remote-dpad-center').isEnabled(), true);
    await tv.locator('.tv-remote-dpad-center').click();
    await waitForMessages(h,1);
    assert.deepEqual(h.messages[0],{device:'tv',tag:4,body:{button:'dpad-center'}});
  } finally { await h.close(); }
});
