import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

const card = (page, id) => page.locator(`.device[data-device="${id}"]`);
const geometry = locator => locator.evaluate(n => ({ x: n.offsetLeft, y: n.offsetTop, width: n.offsetWidth, height: n.offsetHeight }));

test('Focus promotes the selected device, keeps thumbnails visible and follows visibility and discovery', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await h.page.getByRole('button', { name: 'Toggle remote', exact: true }).click();
    await h.page.getByRole('button', { name: 'Focus', exact: true }).click();
    const phone = card(h.page, 'phone'), tv = card(h.page, 'tv');
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-primary')), true);
    assert.equal(await tv.evaluate(n => n.classList.contains('focus-thumbnail')), true);
    assert.ok((await geometry(phone)).width > (await geometry(tv)).width);
    assert.ok((await geometry(tv)).x >= (await geometry(phone)).width);
    assert.equal(await tv.getByRole('button', { name: 'Fill screen with this device', exact: true }).isVisible(), false);
    await h.page.getByRole('button', { name: 'Select Living Room TV', exact: true }).click();
    assert.equal(await tv.evaluate(n => n.classList.contains('focus-primary')), true);
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-thumbnail')), true);
    const selectedGeometry = await geometry(tv);
    await h.page.getByRole('button', { name: 'Refresh devices', exact: true }).click();
    assert.deepEqual(await geometry(tv), selectedGeometry);
    h.devices.push({ ...h.devices[1], device: 'tv2', name: 'Second TV' });
    await h.page.getByRole('button', { name: 'Refresh devices', exact: true }).click();
    await card(h.page, 'tv2').waitFor();
    assert.equal(await card(h.page, 'tv2').evaluate(n => n.classList.contains('focus-thumbnail')), true);
    await h.page.getByRole('button', { name: 'Hide Living Room TV', exact: true }).click();
    assert.equal(await tv.isVisible(), false);
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-primary')), true);
    await h.page.getByRole('button', { name: 'Hide Pixel Phone', exact: true }).click();
    await h.page.getByRole('button', { name: 'Hide Second TV', exact: true }).click();
    await h.page.getByText('All devices are hidden', { exact: true }).waitFor();
    await h.page.getByRole('button', { name: 'Show all devices', exact: true }).click();
    assert.equal(await h.page.locator('.focus-primary').count(), 1);
    assert.equal(await h.page.locator('.focus-thumbnail').count(), 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Focus selection consumes thumbnail input, adapts to narrow workspaces and exits to full controls', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await h.page.getByRole('button', { name: 'Toggle remote', exact: true }).click();
    const tv = card(h.page, 'tv');
    await tv.getByRole('button', { name: 'Focus this device', exact: true }).click();
    assert.equal(await tv.evaluate(n => n.classList.contains('focus-primary')), true);
    const phone = card(h.page, 'phone');
    await phone.locator('.screen-wrap').click();
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-primary')), true);
    assert.equal(h.messages.filter(m => m.tag === 3).length, 0);
    await h.page.setViewportSize({ width: 900, height: 1000 });
    await h.page.waitForTimeout(100);
    const a = await geometry(phone), b = await geometry(tv);
    assert.ok(b.y >= a.height, 'Narrow workspaces place thumbnails beneath the primary');
    await phone.getByRole('button', { name: 'Back to split layout', exact: true }).click();
    assert.equal(await h.page.locator('.focus-primary, .focus-thumbnail').count(), 0);
    assert.equal(await tv.getByRole('button', { name: 'Fill screen with this device', exact: true }).isVisible(), true);
    assert.equal(await h.page.getByRole('button', { name: 'Split', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Focus preserves saved custom coordinates and keeps the primary through reorder and mobile transitions', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    const phone = card(h.page, 'phone'), tv = card(h.page, 'tv');
    await phone.locator('.device-head').focus();
    await h.page.keyboard.press('ArrowRight');
    const before = await geometry(phone);
    await h.page.waitForTimeout(250);
    await h.page.getByRole('button', { name: 'Focus', exact: true }).click();
    h.devices.push({ ...h.devices[1], device: 'tv2', name: 'Second TV' });
    await h.page.getByRole('button', { name: 'Refresh devices', exact: true }).click();
    await card(h.page, 'tv2').waitFor();
    const grip = h.page.getByRole('button', { name: 'Reorder Second TV; use up and down arrows', exact: true });
    await grip.focus(); await h.page.keyboard.press('ArrowUp');
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-primary')), true);
    assert.ok((await geometry(card(h.page, 'tv2'))).y < (await geometry(tv)).y);
    await h.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await phone.evaluate(n => n.classList.contains('focus-primary')), true);
    await h.page.setViewportSize({ width: 1440, height: 1000 });
    await h.page.locator('.canvas-workspace').waitFor();
    await h.page.waitForTimeout(100);
    assert.ok((await geometry(phone)).width > (await geometry(tv)).width);
    await h.page.reload(); await phone.waitFor();
    const after = await geometry(phone);
    assert.equal(after.x, before.x); assert.equal(after.y, before.y); assert.equal(after.width, before.width);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
