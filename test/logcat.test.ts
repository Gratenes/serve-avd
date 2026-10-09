import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogcat, LogBuffer, createLogcatState } from '../src/client/logcat.js';

test('Logcat parses server time format, threadtime and brief without guessing a PID', () => {
  for (const line of ['10-09 12:34:56.789 W/Render( 42): slow frame', '10-09 12:34:56.789 42 99 W Render: slow frame', 'W/Render(42): slow frame']) {
    const parsed = parseLogcat(line);
    assert.equal(parsed.pid, 42); assert.equal(parsed.level, 'W'); assert.equal(parsed.tag, 'Render'); assert.equal(parsed.message, 'slow frame');
  }
  assert.equal(parseLogcat('W/Render: no PID').pid, null);
  assert.equal(parseLogcat('--------- beginning of main').message, '--------- beginning of main');
});

test('Logcat deduplicates consecutive repeats while preserving processes, severity and bounded chronology', () => {
  const buffer = new LogBuffer(3);
  buffer.push('10-09 12:00:00.001 W/Render(42): repeated');
  buffer.push('10-09 12:00:01.002 W/Render(42): repeated');
  assert.equal(buffer.records.length, 1); assert.equal(buffer.records[0]!.count, 2); assert.equal(buffer.records[0]!.time, '12:00:01.002');
  buffer.push('W/Render(43): repeated'); buffer.push('E/Render(42): repeated');
  const state = createLogcatState(); state.appOnly = true;
  assert.equal(buffer.visible(state, null).length, 0);
  assert.deepEqual(buffer.visible(state, 42).map(r => r.count), [2, 1]);
  state.minimum = 5;
  assert.deepEqual(buffer.visible(state, 42).map(r => r.level), ['E']);
  state.filter = 'missing'; assert.equal(buffer.visible(state, 42).length, 0);
  buffer.push('I/New(42): new'); assert.equal(buffer.records.length, 3); assert.equal(buffer.records[0]!.pid, 43);
  buffer.clear(); assert.equal(buffer.records.length, 0);
});
