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
  if (!await h.page.getByRole('button', { name: 'Logcat', exact: true }).isVisible())
    await h.page.getByRole('button', { name: 'Toggle inspector', exact: true }).click();
  await h.page.getByRole('button', { name: 'Logcat', exact: true }).click();
  await h.page.waitForFunction(() => window.__logSources.some(s => s.url.includes('/phone/logs')));
}

async function emit(page, lines, device = 'phone') {
  await page.evaluate(async ({ lines, device }) => {
    const source = window.__logSources.filter(s => s.url.includes(`/${device}/logs`)).at(-1);
    for (const line of lines) source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ line }) }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { lines, device });
}

test('Unwrapped log entries share one horizontal scroll viewport', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await emit(h.page, [
      'I/Reader(42): ' + 'first long message '.repeat(60),
      'E/Reader(42): ' + 'second long message '.repeat(60),
    ]);
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    for (const expanded of [false, true]) {
      if (expanded) await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
      for (const raw of [false, true]) {
        if (raw) await h.page.getByRole('button', { name: 'Show raw log lines', exact: true }).click();
        const geometry = await h.page.locator('.log-lines').evaluate(viewport => {
          const scrolling = [...viewport.querySelectorAll('*')].filter(node =>
            ['auto', 'scroll'].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 2);
          return { viewportScrolls: viewport.scrollWidth > viewport.clientWidth + 2,
            scrolling: scrolling.map(node => node.className) };
        });
        assert.equal(geometry.scrolling.some(name => name.includes('log-message') || name.includes('cm-line')), false,
          'individual messages must never own scrollbars');
        assert.ok(geometry.viewportScrolls || geometry.scrolling.length === 1,
          'the entire document must have one shared horizontal scrollbar');
        const positions = await h.page.locator('.cm-scroller').evaluate(scroller => {
          scroller.scrollLeft = 0;
          const lines = [...scroller.querySelectorAll('.log-line')];
          const before = lines.map(line => line.getBoundingClientRect().x);
          scroller.scrollLeft = 180;
          return lines.map((line, index) => before[index] - line.getBoundingClientRect().x);
        });
        assert.deepEqual(positions, [180, 180], 'horizontal movement applies equally to every entry');
        if (raw) await h.page.getByRole('button', { name: 'Show raw log lines', exact: true }).click();
      }
      await h.page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollLeft = 0; });
      await h.page.screenshot({ path: expanded ? '/tmp/serve-avd-log-expanded-nowrap.png' : '/tmp/serve-avd-log-inspector-nowrap.png' });
    }
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    assert.equal(await h.page.locator('.cm-scroller').evaluate(scroller => scroller.scrollWidth <= scroller.clientWidth + 2), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Live logs preserve the reading position and selection and support find and follow', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    const lines = Array.from({ length: 180 }, (_, index) => `I/Reader(42): Reading entry ${index} ${'context '.repeat(25)}`);
    await emit(h.page, lines);
    await h.page.waitForFunction(() => {
      const node = document.querySelector('.cm-scroller'); return node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    });
    const scroller = h.page.locator('.cm-scroller');
    await scroller.evaluate(node => { node.scrollTop = 240; node.scrollLeft = 120; });
    await h.page.getByRole('button', { name: 'Jump to latest logs', exact: true }).filter({ hasText: 'Jump to latest' }).waitFor();
    const position = await scroller.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }));
    const selection = await h.page.locator('.log-line').nth(3).evaluate(line => {
      const range = document.createRange(); range.selectNodeContents(line);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    await emit(h.page, ['E/Reader(42): New error after the reader scrolled away']);
    assert.deepEqual(await scroller.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft })), position);
    assert.equal(await h.page.evaluate(() => window.getSelection().toString()), selection);
    await h.page.evaluate(() => window.getSelection().removeAllRanges());
    await h.page.getByRole('textbox', { name: 'Log text for Pixel Phone', exact: true }).focus();
    await h.page.keyboard.press('Control+f');
    await h.page.getByRole('textbox', { name: 'Find', exact: true }).fill('New error');
    await h.page.getByRole('textbox', { name: 'Find', exact: true }).dispatchEvent('change');
    await h.page.keyboard.press('Enter');
    await h.page.locator('.cm-searchMatch-selected').waitFor();
    await h.page.getByRole('button', { name: 'close', exact: true }).click();
    await h.page.getByRole('button', { name: 'Jump to latest logs', exact: true }).click();
    await h.page.waitForFunction(() => {
      const node = document.querySelector('.cm-scroller'); return node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    });
    await emit(h.page, ['I/Reader(42): Latest follow event']);
    assert.ok(await scroller.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 24));
    const messagesBefore = h.messages.length;
    await h.page.getByRole('textbox', { name: 'Log text for Pixel Phone', exact: true }).focus();
    await h.page.keyboard.press('ArrowUp');
    await h.page.keyboard.type('safe keyboard input');
    assert.equal(h.messages.length, messagesBefore, 'reader keys must not reach the device');
    assert.equal(await h.page.locator('.cm-content').getAttribute('contenteditable'), 'false');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('The log reader virtualizes the bounded buffer and copies the entire document', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    const lines = Array.from({ length: 1200 }, (_, index) => `I/Reader(42): bounded event ${index}`);
    await emit(h.page, lines);
    assert.match(await h.page.locator('.log-count').innerText(), /1000 of 1000 entries/);
    assert.ok(await h.page.locator('.log-line').count() < 200, 'only the viewport and overscan should render');
    await h.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await h.page.getByRole('textbox', { name: 'Log text for Pixel Phone', exact: true }).focus();
    await h.page.keyboard.press('Control+a');
    await h.page.keyboard.press('Control+c');
    assert.equal(await h.page.evaluate(() => navigator.clipboard.readText()), lines.slice(-1000).join('\n'));
    await h.page.getByRole('button', { name: 'Copy filtered logs', exact: true }).click();
    await h.page.getByText('Copied logs', { exact: true }).waitFor();
    assert.equal(await h.page.evaluate(() => navigator.clipboard.readText()), lines.join('\n'), 'export retains ungrouped chronology');
    const downloaded = h.page.waitForEvent('download');
    await h.page.getByRole('button', { name: 'Download filtered logs', exact: true }).click();
    assert.equal((await downloaded).suggestedFilename(), 'logcat.txt');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Evicting old buffered logs keeps the surviving entry at the same reading position', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    await emit(h.page, Array.from({ length: 1000 }, (_, index) => `I/Reader(42): anchored entry ${index}`));
    await h.page.locator('.cm-scroller').evaluate(node => { node.scrollTop = 5000; });
    await h.page.waitForFunction(() => document.querySelector('[aria-label="Jump to latest logs"]')?.getAttribute('aria-pressed') === 'false');
    const anchor = await h.page.locator('.cm-scroller').evaluate(scroller => {
      const line = [...scroller.querySelectorAll('.log-line')].find(line => line.getBoundingClientRect().top >= scroller.getBoundingClientRect().top);
      return { text: line.textContent.replace(/^↗/, ''), y: line.getBoundingClientRect().y };
    });
    await emit(h.page, Array.from({ length: 4 }, (_, index) => `I/Reader(42): new buffered entry ${index}`));
    const retained = h.page.locator('.log-line').filter({ hasText: anchor.text });
    assert.ok(Math.abs((await retained.boundingBox()).y - anchor.y) < 2, 'removing the oldest records must preserve the visible anchor');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('The expanded log reader fits a mobile viewport in both wrapping modes', async () => {
  const h = await harness({ width: 390, height: 844 });
  try {
    await prepare(h);
    await emit(h.page, [`W/Reader(42): ${'full mobile context '.repeat(70)}`, 'I/Reader(42): second entry']);
    await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
    const dialog = h.page.locator('.logcat-dialog');
    assert.ok((await dialog.boundingBox()).width <= 390);
    assert.ok((await h.page.locator('.cm-scroller').boundingBox()).height > 120);
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    assert.ok(await h.page.locator('.cm-scroller').evaluate(node => node.scrollWidth > node.clientWidth));
    assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await h.page.screenshot({ path: '/tmp/serve-avd-log-expanded-mobile-nowrap.png' });
    await h.page.getByRole('button', { name: 'Wrap log lines', exact: true }).click();
    assert.ok(await h.page.locator('.cm-scroller').evaluate(node => node.scrollWidth <= node.clientWidth + 2));
    await h.page.screenshot({ path: '/tmp/serve-avd-log-expanded-mobile-wrap.png' });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Attached logs use the same single scrollport with wrap and search on mobile', async () => {
  const h = await harness({ width: 390, height: 844 });
  try {
    await h.page.route('**/phone/workspace', route => route.fulfill({ json: {
      captures: [{ id: 'log-fixture', device: 'phone', name: 'Pixel Phone', createdAt: new Date().toISOString(), duration: 2,
        format: 'mp4', bytes: 12, hasLogs: true, hasKeys: false }], recording: null, crashes: [], builds: [], defaultSnapshot: null,
    } }));
    await h.page.route('**/phone/captures/log-fixture/logs', route => route.fulfill({ contentType: 'text/plain',
      body: `E/Reader(42): exception ${'complete context '.repeat(120)}\nI/Reader(42): playback resumed` }));
    await h.page.reload();
    await h.page.getByRole('button', { name: 'Captures 1', exact: true }).click();
    await h.page.getByRole('button', { name: 'View attached logs', exact: true }).click();
    const reader = h.page.locator('.saved-log-content .cm-scroller');
    await h.page.getByText(/2 of 2 lines/).waitFor();
    assert.equal(await reader.evaluate(node => node.scrollWidth <= node.clientWidth + 2), true);
    await h.page.getByRole('button', { name: 'Wrap attached log lines', exact: true }).click();
    assert.equal(await reader.evaluate(node => node.scrollWidth > node.clientWidth + 2), true);
    assert.equal(await h.page.locator('.saved-log-content .cm-scroller').count(), 1);
    await h.page.getByRole('searchbox', { name: 'Search attached logs', exact: true }).fill('exception');
    assert.match(await h.page.locator('.log-count').innerText(), /1 of 2 lines/);
    assert.doesNotMatch(await h.page.locator('.saved-log-content').innerText(), /playback resumed/);
    await h.page.screenshot({ path: '/tmp/serve-avd-attached-logs-mobile.png' });
    await h.page.keyboard.press('Escape');
    await h.page.locator('.saved-log-dialog').waitFor({ state: 'detached' });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

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

test('Full log messages remain readable and logs received while paused are retained', async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await prepare(h);
    const message = 'Actual exception details '.repeat(20) + 'ROOT_CAUSE_AT_END';
    await emit(h.page, ['E/Player(42): ' + message]);
    const text = h.page.locator('.cm-content');
    assert.ok(['pre-wrap', 'break-spaces'].includes(await text.evaluate(n => getComputedStyle(n).whiteSpace)));
    await h.page.getByRole('button', { name: 'Pause/resume the log stream', exact: true }).click();
    await emit(h.page, ['E/Player(42): retained while paused']);
    assert.equal(await h.page.locator('.log-line').count(), 1);
    await h.page.getByRole('button', { name: 'Pause/resume the log stream', exact: true }).click();
    await h.page.locator('.log-line').filter({ hasText: 'retained while paused' }).waitFor();
    await h.page.getByRole('button', { name: 'Expand log viewer', exact: true }).click();
    assert.ok((await h.page.locator('.log-lines').boundingBox()).width > 800);
    await h.page.getByRole('button', { name: 'View full log entry', exact: true }).first().click();
    assert.ok((await h.page.locator('.log-entry-detail').innerText()).includes('ROOT_CAUSE_AT_END'));
    await h.page.screenshot({ path:'/tmp/serve-avd-log-viewer.png' });
    await h.page.keyboard.press('Escape');
    await h.page.locator(".logcat-dialog").waitFor({ state: "detached" });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
