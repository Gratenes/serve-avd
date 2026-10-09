import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './browser-harness.mjs';

async function prepare(h) {
  await h.page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.__logSources = [];
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); if (this.url.includes('/logs')) window.__logSources.push(this); }
    };
  });
  await h.page.route('**/phone/foreground', route => route.fulfill({ json: { packageName: 'com.example.phone', pid: 42 } }));
  await h.page.route('**/tv/foreground', route => route.fulfill({ json: { packageName: 'com.example.tv', pid: 99 } }));
  await h.page.reload();
  await h.page.getByRole('button', { name: 'Logcat', exact: true }).click();
  await h.page.waitForFunction(() => window.__logSources.some(s => s.url.includes('/phone/logs')));
}

async function emit(page, lines, device = 'phone') {
  await page.evaluate(({ lines, device }) => {
    const source = window.__logSources.filter(s => s.url.includes(`/${device}/logs`)).at(-1);
    for (const line of lines) source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ line }) }));
  }, { lines, device });
  await page.waitForTimeout(50);
}

test('Logcat shows repeat counts, severity, minimum levels, filters, pause and clear', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await emit(h.page, [
      '10-09 12:00:00.001 W/Render(42): slow frame',
      '10-09 12:00:01.002 W/Render(42): slow frame',
      '10-09 12:00:02.003 42 44 E App: crash reported',
      'D/Other(77): ordinary debug',
    ]);
    assert.equal(await h.page.locator('.log-line').count(), 3);
    assert.equal(await h.page.locator('.log-repeat').innerText(), '×2');
    assert.equal(await h.page.locator('.logcat-badge').innerText(), '3');
    assert.equal(await h.page.locator('.logcat-badge').evaluate(n => n.classList.contains('log-severity-e')), true);
    await h.page.getByRole('button', { name: 'Minimum log level E', exact: true }).click();
    await h.page.waitForTimeout(50);
    assert.equal(await h.page.locator('.log-line').count(), 1);
    await h.page.getByRole('searchbox', { name: 'Filter Logcat', exact: true }).fill('missing');
    await h.page.waitForTimeout(50);
    assert.equal(await h.page.locator('.log-line').count(), 0);
    await h.page.getByRole('searchbox', { name: 'Filter Logcat', exact: true }).fill('');
    await h.page.getByRole('button', { name: 'Pause/resume the log stream', exact: true }).click();
    await emit(h.page, ['E/App(42): should not appear']);
    assert.equal(await h.page.locator('.log-line').count(), 1);
    await h.page.getByRole('button', { name: 'Pause/resume the log stream', exact: true }).click();
    await h.page.getByRole('button', { name: 'Clear displayed logs', exact: true }).click();
    await h.page.waitForTimeout(50);
    assert.equal(await h.page.locator('.log-line').count(), 0);
    assert.equal(await h.page.locator('.logcat-badge').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('App only matches foreground PID exactly and target changes close the previous stream', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await emit(h.page, ['I/App(42): phone process', 'I/App(420): unrelated process', 'I/App: process unknown']);
    await h.page.getByRole('switch', { name: 'App only', exact: true }).click();
    await h.page.getByText(/Showing com.example.phone \(PID 42\)/).waitFor();
    assert.equal(await h.page.locator('.log-line').count(), 1);
    assert.match(await h.page.locator('.log-line').innerText(), /phone process/);
    await h.page.getByRole('button', { name: 'Select Living Room TV', exact: true }).click();
    await h.page.waitForFunction(() => window.__logSources.some(s => s.url.includes('/tv/logs')));
    assert.equal(await h.page.evaluate(() => window.__logSources.find(s => s.url.includes('/phone/logs')).readyState), 2);
    await emit(h.page, ['E/App(42): stale device message'], 'phone');
    await emit(h.page, ['I/App(99): tv process', 'I/App(42): unrelated phone process'], 'tv');
    await h.page.getByText(/Showing com.example.tv \(PID 99\)/).waitFor();
    assert.equal(await h.page.locator('.log-line').count(), 1);
    assert.match(await h.page.locator('.log-line').innerText(), /tv process/);
    assert.equal(await h.page.locator('.logcat-badge').isVisible(), false);
    await h.page.getByRole('button', { name: 'Toggle inspector', exact: true }).click();
    assert.equal(await h.page.evaluate(() => window.__logSources.at(-1).readyState), 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('A pending foreground lookup cannot update Logcat after switching devices', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let requested = false;
  try {
    await prepare(h);
    await h.page.route('**/phone/foreground', async route => {
      requested = true; await pending;
      try { await route.fulfill({ json: { packageName: 'stale.phone', pid: 42 } }); } catch { /* The old request was canceled on target change. */ }
    });
    await h.page.getByRole('switch', { name: 'App only', exact: true }).click();
    for (let attempt = 0; attempt < 50 && !requested; attempt++) await h.page.waitForTimeout(10);
    assert.equal(requested, true);
    await h.page.getByRole('button', { name: 'Select Living Room TV', exact: true }).click();
    await h.page.getByText(/Showing com.example.tv \(PID 99\)/).waitFor();
    release(); await h.page.waitForTimeout(50);
    assert.doesNotMatch(await h.page.locator('.log-count').innerText(), /stale.phone|PID 42/);
    await emit(h.page, ['I/App(99): current device'], 'tv');
    assert.equal(await h.page.locator('.log-line').count(), 1);
    assert.deepEqual(h.errors, []);
  } finally { release(); await h.close(); }
});

test('App only waits for a real foreground PID and displays stream reconnect state', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await h.page.route('**/phone/foreground', route => route.fulfill({ json: { packageName: 'com.example.phone' } }));
    await emit(h.page, ['E/com.example.phone(42): package text is insufficient', 'E/App: PID unavailable']);
    await h.page.getByRole('switch', { name: 'App only', exact: true }).click();
    await h.page.getByText(/Foreground app PID unavailable/).waitFor();
    assert.equal(await h.page.locator('.log-line').count(), 0);
    assert.equal(await h.page.locator('.logcat-badge').isVisible(), false);
    await h.page.evaluate(() => window.__logSources.at(-1).dispatchEvent(new Event('error')));
    await h.page.getByText(/Reconnecting…/).waitFor();
    await h.page.evaluate(() => window.__logSources.at(-1).dispatchEvent(new Event('open')));
    await h.page.getByText(/Live ·/).waitFor();
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
