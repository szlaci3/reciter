const { test } = require('node:test');
const assert = require('node:assert/strict');
const { passages, segments, edgeSegments, Player } = require('./speech.js');

function fixture() {
  const spoken = [], pending = new Map(); let nextId = 0;
  const synth = { cancel() {}, pause() {}, resume() {}, speak(u) { spoken.push(u); } };
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
test('resume retains the interrupted utterance and errors allow retry', () => {
  const { player, spoken } = fixture();
  player.setText('Remember this.'); player.play(); player.pause(); player.play();
  assert.equal(spoken.length, 1);
  spoken[0].onerror({ error: 'network' }); assert.equal(player.state, 'error');
  player.play(); assert.equal(player.state, 'speaking');
});

test('Edge keeps a long sentence intact instead of cutting at 220 characters', () => {
  const sentence = 'Advocates of vibe coding say it allows amateur programmers to produce software ' +
    'by explaining what they want and examining the generated result '.repeat(7).trim() + '.';
  assert.ok(sentence.length > 220);
  assert.deepEqual(edgeSegments(sentence), [sentence]);
  assert.ok(segments(sentence).length > 1);
});

test('Edge groups full sentences and keeps citations and closing quotes with them', () => {
  const first = 'An explanation with enough detail to make the sentence quite long '.repeat(6).trim() + '.”[12][13]';
  const second = 'A separate explanation with more detail for the next sentence '.repeat(6).trim() + '.[14]';
  assert.deepEqual(edgeSegments(first + ' ' + second), [first, second]);
  assert.deepEqual(edgeSegments('One.[1] Two.[2] Three!'), ['One.[1] Two.[2] Three!']);
});

test('Edge avoids boundaries inside common abbreviations, initials and decimals', () => {
  const first = 'An introductory explanation '.repeat(21).trim() + '.';
  const second = 'Dr. A. Smith uses version 3.14, e.g. for U.S. projects.';
  assert.deepEqual(edgeSegments(first + ' ' + second), [first, second]);
});

test('Edge bounds oversized and unpunctuated text without dropping content', () => {
  for (const text of ['word '.repeat(1200).trim(), 'x'.repeat(5000), '😀'.repeat(2200),
    'A detailed clause, '.repeat(220).trim() + '.']) {
    const chunks = edgeSegments(text);
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 900));
    assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
    assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
  }
  assert.deepEqual(edgeSegments('   '), []);
});

test('Edge packs sentences up to 300 characters and splits long sentences at a clause after 450', () => {
  const first = 'a'.repeat(148) + '.';
  const second = 'b'.repeat(149) + '.';
  assert.deepEqual(edgeSegments(first + ' ' + second + ' Last.'), [first + ' ' + second, 'Last.']);
  const clause = 'word '.repeat(100).trim() + ',';
  const remainder = 'more '.repeat(100).trim() + '.';
  assert.deepEqual(edgeSegments(clause + ' ' + remainder), [clause, remainder]);
});
