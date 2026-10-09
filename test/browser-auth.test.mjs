import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { emuMiddleware } from '../dist/middleware.js';

const adminPassword = 'browser admin password';
const temporaryPassword = 'temporary user password';
const newPassword = 'a new browser password';
async function fixture(basePath = '', mockDevice = false) {
  const directory = await mkdtemp(join(tmpdir(), 'serve-avd-auth-browser-'));
  let middleware;
  const messages = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (mockDevice && (path === basePath + '/api' || path.startsWith(basePath + '/helper/mock/'))) {
      if (await middleware.auth.handle(req, res)) return;
      if (path === basePath + '/api') {
        const prefix = basePath + '/helper/mock';
        const device = { device: 'mock', name: 'Mock device', videoAvailable: false,
          config: { width: 1080, height: 1920, orientation: 'portrait', rotation: 0 },
          ...Object.fromEntries(['streamMjpeg', 'streamAvcc', 'ws', 'config', 'logs', 'screenshot', 'ax', 'foreground', 'action'].map(key => [key + 'Endpoint', prefix + '/' + key])) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: 'test', codec: 'mjpeg', basePath, initialState: {}, devices: [device], gridApiEndpoint: basePath + '/grid/api', gridStartEndpoint: basePath + '/grid/api/start', eventLogEndpoint: basePath + '/events', eventLogEventsEndpoint: basePath + '/events/stream' }));
      } else { res.statusCode = 204; res.end(); }
      return;
    }
    middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  if (mockDevice) server.on('upgrade', (req, socket, head) => {
    const identity = middleware.auth.authorizeUpgrade(req);
    if (!identity) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const untrack = middleware.auth.track(identity, () => ws.close(4401, 'Session expired'));
      ws.on('close', untrack);
      ws.on('message', bytes => { if (middleware.auth.valid(identity)) messages.push({ tag: bytes[0], body: JSON.parse(bytes.subarray(1).toString() || '{}') }); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  middleware = emuMiddleware({ basePath, allowedDevices: [], auth: { databasePath: join(directory, 'auth.sqlite'), origin }, initialState: { panes: ['none'] } });
  await middleware.auth.bootstrap('admin', adminPassword);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, context, origin, basePath, errors, messages, async close() { await browser.close(); middleware.auth.close(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}
async function signIn(h, username, password, returnTo = '') {
  await h.page.goto(h.origin + h.basePath + '/login?returnTo=' + encodeURIComponent(returnTo || h.basePath + '/account'));
  await h.page.locator('#login-form input[name="username"]').fill(username);
  await h.page.locator('#login-form input[name="password"]').fill(password);
  await h.page.locator('#login-form button[type="submit"]').click();
}
async function changePassword(h, current, next) {
  await h.page.locator('#password-form input[name="currentPassword"]').fill(current);
  await h.page.locator('#password-form input[name="newPassword"]').fill(next);
  await h.page.locator('#password-form input[name="confirmPassword"]').fill(next);
  await h.page.locator('#password-form button[type="submit"]').click();
}

test('mobile login, account administration and forced password change work on a base path', async () => {
  const h = await fixture('/emu');
  try {
    await h.page.goto(h.origin + '/emu/login');
    await h.page.locator('#login-form input[name="username"]').fill('unknown');
    await h.page.locator('#login-form input[name="password"]').fill('invalid password');
    await h.page.locator('#login-form .reveal').click();
    assert.equal(await h.page.locator('#login-form input[name="password"]').getAttribute('type'), 'text');
    await h.page.locator('#login-form button[type="submit"]').click();
    await h.page.waitForFunction(() => document.getElementById('status').textContent.includes('Invalid username or password'));
    assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await signIn(h, 'admin', adminPassword);
    await h.page.locator('#admin:visible').waitFor();
    assert.match(await h.page.locator('#identity').textContent(), /admin · Administrator/);
    await h.page.locator('#create-form input[name="username"]').fill('operator');
    await h.page.locator('#create-form input[name="password"]').fill(temporaryPassword);
    await h.page.locator('#create-form button[type="submit"]').click();
    await h.page.locator('.user').filter({ hasText: 'operator' }).waitFor();
    const operator = h.page.locator('.user').filter({ has: h.page.locator('strong', { hasText: /^operator$/ }) });
    await operator.locator('select[name="action"]').selectOption('enabled');
    await operator.getByRole('button', { name: 'Disable account', exact: true }).click();
    await h.page.waitForFunction(() => [...document.querySelectorAll('.user')].some(row => row.textContent.includes('operator') && row.textContent.includes('Disabled')));
    await operator.locator('select[name="action"]').selectOption('enabled');
    await operator.getByRole('button', { name: 'Enable account', exact: true }).click();
    await h.page.waitForFunction(() => [...document.querySelectorAll('.user')].some(row => row.textContent.includes('operator') && row.textContent.includes('Enabled')));
    await operator.locator('select[name="action"]').selectOption('role');
    await operator.locator('label').nth(1).locator('select').selectOption('admin');
    await operator.getByRole('button', { name: 'Change role', exact: true }).click();
    await h.page.waitForFunction(() => [...document.querySelectorAll('.user')].some(row => row.querySelector('strong')?.textContent === 'operator' && row.querySelector('.user-title span')?.textContent.startsWith('admin')));
    await operator.locator('select[name="action"]').selectOption('role');
    await operator.locator('label').nth(1).locator('select').selectOption('operator');
    await operator.getByRole('button', { name: 'Change role', exact: true }).click();
    await h.page.waitForFunction(() => [...document.querySelectorAll('.user')].some(row => row.querySelector('strong')?.textContent === 'operator' && row.querySelector('.user-title span')?.textContent.startsWith('operator')));
    await operator.locator('input[type="password"]').fill(temporaryPassword);
    await operator.getByRole('button', { name: 'Reset password', exact: true }).click();
    await h.page.waitForFunction(() => document.getElementById('status').textContent === 'Account updated.');
    await operator.locator('select[name="action"]').selectOption('revoke');
    await operator.getByRole('button', { name: 'Revoke all sessions', exact: true }).click();
    await h.page.waitForFunction(() => document.getElementById('status').textContent === 'Account updated.');
    const admin = h.page.locator('.user').filter({ has: h.page.locator('strong', { hasText: /^admin$/ }) });
    await admin.locator('select[name="action"]').selectOption('enabled');
    await admin.getByRole('button', { name: 'Disable account', exact: true }).click();
    await h.page.waitForFunction(() => document.getElementById('status').textContent.includes('last enabled administrator'));
    await h.page.locator('#logout').click();
    await h.page.locator('#login:visible').waitFor();
    await signIn(h, 'operator', temporaryPassword, '/emu/');
    await h.page.locator('#forced:visible').waitFor();
    assert.equal(await h.page.locator('#admin:visible').count(), 0);
    assert.equal(await h.page.locator('#workspace:visible').count(), 0);
    await changePassword(h, temporaryPassword, newPassword);
    await h.page.locator('.account-menu').waitFor();
    assert.equal(new URL(h.page.url()).pathname, '/emu/');
    assert.equal(await h.page.getByRole('button', { name: 'Boot', exact: true }).count(), 0);
    await h.page.locator('.account-menu summary').click();
    await h.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await h.page.locator('#login:visible').waitFor();
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('hostile return URLs stay on origin and a revoked workspace session prompts a fresh login', async () => {
  const h = await fixture();
  try {
    await signIn(h, 'admin', adminPassword, '//evil.example/steal');
    await h.page.locator('.account-menu').waitFor();
    assert.equal(new URL(h.page.url()).origin, h.origin);
    assert.equal(new URL(h.page.url()).pathname, '/');
    // Revoke the live browser session externally, then make a protected request.
    await h.page.evaluate(async () => {
      const me = await fetch('/auth/me').then(r => r.json());
      await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken }, body: '{}' });
      await fetch('/api');
    });
    await h.page.getByRole('link', { name: 'Sign in again' }).waitFor();
    assert.equal(await h.page.locator('.device').count(), 0);
    await h.page.getByRole('link', { name: 'Sign in again' }).click();
    await h.page.locator('#login:visible').waitFor();
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});


test('revocation closes device input and fresh login never replays unsent text or keys', async () => {
  const h = await fixture('', true);
  try {
    await signIn(h, 'admin', adminPassword, '/');
    const selected = h.page.locator('.device.selected-device');
    await selected.waitFor();
    await h.page.waitForFunction(() => document.querySelector('.rail-row')?.classList.contains('connected'));
    await selected.locator('.text-entry summary').click();
    await selected.locator('textarea').fill('unsent secret');
    await h.page.evaluate(async () => {
      const me = await fetch('/auth/me').then(r => r.json());
      await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken }, body: '{}' });
    });
    await h.page.getByRole('link', { name: 'Sign in again' }).waitFor();
    assert.equal(await h.page.locator('textarea').count(), 0);
    assert.deepEqual(h.messages, []);
    await signIn(h, 'admin', adminPassword, '/');
    await h.page.locator('.device.selected-device').waitFor();
    await h.page.waitForTimeout(1200);
    assert.deepEqual(h.messages, []);
    await h.page.locator('.device.selected-device .text-entry summary').click();
    assert.equal(await h.page.locator('.device.selected-device textarea').inputValue(), '');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('login design validates fields, supports keyboard reveal and session-only sign-in', async () => {
  const h = await fixture('/emu');
  try {
    await h.page.goto(h.origin + '/emu/login');
    await h.page.locator('#login-form button[type="submit"]').click();
    await h.page.locator('#user-error:visible').waitFor();
    assert.equal(await h.page.locator('#login-user').getAttribute('aria-invalid'), 'true');
    await h.page.locator('#login-form').getByLabel('Username', {exact:true}).fill('admin');
    await h.page.getByLabel('Password', {exact:true}).fill(adminPassword);
    await h.page.getByRole('button', {name:'Show password',exact:true}).focus();
    await h.page.keyboard.press('Enter');
    assert.equal(await h.page.locator('#login-pass').getAttribute('type'),'text');
    await h.page.getByLabel('Keep me signed in on this browser').uncheck();
    await h.page.locator('#login-form button[type="submit"]').click();
    await h.page.locator('.account-menu').waitFor();
    const cookie = (await h.context.cookies()).find(c=>c.name.startsWith('serve_avd_'));
    assert.equal(cookie.expires,-1);
    await h.page.goto(h.origin + '/emu/login');
    await h.page.getByRole('heading', {name:'Signed in as admin'}).waitFor();
    await h.page.getByRole('button',{name:'Use a different account'}).click();
    await h.page.locator('#login:visible').waitFor();
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});
