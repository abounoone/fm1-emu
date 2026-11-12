import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMap, mapFor, withMap, learn, setTarget, removeMapping, setVelocity, applyMapping } from './controller.js';

test('mapFor is null for no profile, an unknown profile, and a profile with nothing mapped for this firmware', () => {
  assert.equal(mapFor({}, '', 'felucca'), null);
  assert.equal(mapFor({}, 'sp404mk2', 'felucca'), null);
  assert.equal(mapFor({ sp404mk2: { other: emptyMap() } }, 'sp404mk2', 'felucca'), null);
});

test('withMap adds a firmware entry to a profile without disturbing other firmwares or profiles', () => {
  const profiles = withMap({ keep: { x: emptyMap() } }, 'sp404mk2', 'felucca', emptyMap());
  assert.ok(profiles.keep.x);
  assert.deepEqual(profiles.sp404mk2.felucca, emptyMap());
});

test('learn adds an identity mapping, sorting a control change from a note by the status nibble', () => {
  let map = learn(emptyMap(), 0x90, 42);
  assert.deepEqual(map.notes, { 42: 42 });
  assert.deepEqual(map.cc, {});
  map = learn(map, 0xb3, 16);
  assert.deepEqual(map.cc, { 16: 16 });
});

test('setTarget edits a learned mapping; removeMapping deletes it', () => {
  let map = learn(emptyMap(), 0x80, 10);
  map = setTarget(map, 'notes', 10, 60);
  assert.equal(map.notes[10], 60);
  map = removeMapping(map, 'notes', 10);
  assert.equal(map.notes[10], undefined);
});

test('applyMapping passes unmapped notes and CCs through unchanged, and tolerates no map at all', () => {
  const map = emptyMap();
  assert.deepEqual(applyMapping(map, [0x90, 40, 100]), [0x90, 40, 100]);
  assert.deepEqual(applyMapping(null, [0x90, 40, 100]), [0x90, 40, 100]);
});

test('applyMapping rewrites a mapped note-on/off number and leaves velocity alone by default', () => {
  const map = setTarget(emptyMap(), 'notes', 40, 60);
  assert.deepEqual(applyMapping(map, [0x90, 40, 100]), [0x90, 60, 100]);
  assert.deepEqual(applyMapping(map, [0x80, 40, 0]), [0x80, 60, 0]);
});

test('applyMapping forces velocity only on a sounding note-on, never on note-off or a zero-velocity note-on', () => {
  const map = setVelocity(setTarget(emptyMap(), 'notes', 40, 40), 100);
  assert.deepEqual(applyMapping(map, [0x90, 40, 5]), [0x90, 40, 100]);
  assert.deepEqual(applyMapping(map, [0x90, 40, 0]), [0x90, 40, 0]);
  assert.deepEqual(applyMapping(map, [0x80, 40, 64]), [0x80, 40, 64]);
});

test('applyMapping rewrites a mapped control change and never touches its value', () => {
  const map = setTarget(emptyMap(), 'cc', 16, 74);
  assert.deepEqual(applyMapping(map, [0xb0, 16, 90]), [0xb0, 74, 90]);
});
