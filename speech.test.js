const { test } = require('node:test');
const assert = require('node:assert/strict');
const { passages, segments, Player } = require('./speech.js');

function fixture() {
  const spoken = [], pending = new Map(); let nextId = 0;
  const synth = { cancel() {}, speak(u) { spoken.push(u); } };
  const timers = { setTimeout(fn) { pending.set(++nextId, fn); return nextId; }, clearTimeout(id) { pending.delete(id); } };
  const player = new Player(synth, text => ({ text }), () => ({ voice: { name: 'Daniel', lang: 'en-GB' }, pitch: 1.4, rate: 1, gap: 2 }), () => {}, timers);
  return { player, spoken, pending };
}
test('passages handle blank lines and long segments preserve words', () => {
  assert.deepEqual(passages(' \n First\nline\n \n Second \n'), ['First\nline', 'Second']);
  assert.deepEqual(passages('  '), []);
  const text = 'A sentence to remember. '.repeat(80).trim();
  const chunks = segments(text);
  assert.ok(chunks.every(s => s.length <= 220));
  assert.equal(chunks.join(' '), text);
});
test('preferred settings apply to every segment and passages have a break', () => {
  const { player, spoken, pending } = fixture();
  player.setText('First.\n\nSecond.'); player.play();
  assert.equal(spoken[0].pitch, 1.4); assert.equal(spoken[0].lang, 'en-GB');
  spoken[0].onend(); assert.equal(player.state, 'waiting'); assert.equal(player.index, 1);
  [...pending.values()][0](); assert.equal(spoken[1].text, 'Second.'); assert.equal(spoken[1].pitch, 1.4);
  spoken[1].onend(); assert.equal(player.state, 'ended');
  player.play(); assert.equal(spoken[2].text, 'First.');
});
test('stop ignores late events from canceled speech', () => {
  const { player, spoken } = fixture();
  player.setText('One.\n\nTwo.'); player.play(); const old = spoken[0];
  player.stop(); old.onend(); old.onerror({ error: 'canceled' });
  assert.equal(player.state, 'idle'); assert.equal(player.index, 0); assert.equal(spoken.length, 1);
});
test('pause during a break cancels auto-play and resume speaks the next passage', () => {
  const { player, spoken, pending } = fixture();
  player.setText('One.\n\nTwo.'); player.play(); spoken[0].onend();
  const lateTimer = [...pending.values()][0]; player.pause(); lateTimer();
  assert.equal(pending.size, 0); assert.equal(spoken.length, 1);
  player.play(); assert.equal(spoken[1].text, 'Two.');
});
test('navigation cancels old playback; editing stops and resets', () => {
  const { player, spoken } = fixture();
  player.setText('One.\n\nTwo.'); player.play(); player.select(1);
  spoken[0].onend(); assert.equal(player.index, 1); assert.equal(spoken[1].text, 'Two.');
  player.setText('New.'); spoken[1].onend();
  assert.equal(player.state, 'idle'); assert.equal(player.index, 0); assert.deepEqual(player.items, ['New.']);
});
test('resume repeats the interrupted segment and errors allow retry', () => {
  const { player, spoken } = fixture();
  player.setText('Remember this.'); player.play(); player.pause(); player.play();
  assert.equal(spoken[0].text, spoken[1].text);
  spoken[1].onerror({ error: 'network' }); assert.equal(player.state, 'error');
  player.play(); assert.equal(player.state, 'speaking');
});
