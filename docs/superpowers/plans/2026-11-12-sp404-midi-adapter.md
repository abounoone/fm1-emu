# SP-404 MK2 controller adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an SP-404 MK2 (or any class-compliant MIDI controller) drive the fm1-emu site correctly, by remapping incoming note/CC numbers and note-on velocity, per firmware, before they reach the emulated FM-1's MIDI UART.

**Architecture:** A pure, DOM-free mapping engine (`web/controller.js`, mirroring the existing `persistence.js`/`tryout.js` modules) holds the remap logic. `web/main.js` wires it to a new "Controller" profile select and an "Edit mapping" panel next to the existing MIDI-in controls, persists profiles to `localStorage`, and calls the engine inside `midiMessage()` right before the existing `send({type:"midi", bytes})` call — so every message that already works today keeps working, and only numbers with an explicit entry change.

**Tech Stack:** Vanilla JS (ES modules), `node --test` for unit/behavior tests (existing convention, no test framework dependency), plain HTML/CSS reusing the site's existing `.save-controls`/`.row` classes.

**Deviation from the approved spec, called out up front:** the spec's "built-in starting preset" (hardcoded SP-404 note/CC guesses as an editable template) is dropped. Those numbers were already flagged in the spec itself as unverified, and shipping guessed numbers as if they were a preset is worse than an empty table the user fills in with Learn — capability is unchanged, only a convenience seed is gone. Also dropped: the "curve" velocity mode — only "as sent" and "fixed" ship; a curve can be added later if fixed proves too coarse (YAGNI).

---

## Task 1: Controller mapping engine (`web/controller.js`)

**Files:**
- Create: `web/controller.js`
- Create: `web/controller.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `web/controller.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test web/controller.test.mjs`
Expected: FAIL — `Cannot find module '.../web/controller.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `web/controller.js`:

```js
// Controller profiles: remap incoming MIDI note and CC numbers (and note-on velocity) before
// they reach a firmware's MIDI IN. Every firmware reads MIDI its own way, and a real controller's
// note numbers and channels can be offset in its own settings, so a profile is calibrated per
// (profile, firmware) pair with Learn, rather than assumed from the controller's documentation.
export function emptyMap() {
  return { notes: {}, cc: {}, velocity: 'pass' };
}

// profiles: { [profileId]: { [firmwareId]: map } }. null means "nothing mapped yet", distinct
// from a map with no entries so callers can tell "no profile picked" from "an empty one".
export function mapFor(profiles, profileId, firmwareId) {
  if (!profileId) return null;
  return (profiles[profileId] && profiles[profileId][firmwareId]) || null;
}

export function withMap(profiles, profileId, firmwareId, map) {
  const forProfile = { ...profiles[profileId], [firmwareId]: map };
  return { ...profiles, [profileId]: forProfile };
}

// Adds an identity mapping (target = source) for the number just received, so a freshly learned
// row shows up editable instead of invisible. `status` is the raw MIDI status byte; a control
// change (0xb0-0xbf) is learned into cc, anything else (note on/off) into notes.
export function learn(map, status, number) {
  const kind = (status & 0xf0) === 0xb0 ? 'cc' : 'notes';
  return { ...map, [kind]: { ...map[kind], [number]: number } };
}

export function setTarget(map, kind, from, to) {
  return { ...map, [kind]: { ...map[kind], [from]: to } };
}

export function removeMapping(map, kind, from) {
  const rest = { ...map[kind] };
  delete rest[from];
  return { ...map, [kind]: rest };
}

export function setVelocity(map, velocity) {
  return { ...map, velocity };
}

// Rewrites one MIDI message's note/CC number and, for a note-on, its velocity, per `map`.
// A number with no entry passes through unchanged, so an incomplete mapping never blocks play.
export function applyMapping(map, bytes) {
  if (!map || bytes.length < 2) return bytes;
  const status = bytes[0] & 0xf0;
  const out = bytes.slice();
  if (status === 0x90 || status === 0x80) {
    if (map.notes[bytes[1]] !== undefined) out[1] = map.notes[bytes[1]];
    if (status === 0x90 && bytes.length > 2 && bytes[2] > 0 && map.velocity !== 'pass') out[2] = map.velocity;
  } else if (status === 0xb0) {
    if (map.cc[bytes[1]] !== undefined) out[1] = map.cc[bytes[1]];
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test web/controller.test.mjs`
Expected: `pass 8`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add web/controller.js web/controller.test.mjs
git commit -m "$(cat <<'EOF'
Add a pure per-firmware MIDI note/CC remapping engine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Controller UI markup

**Files:**
- Modify: `web/index.html:101-106`
- Modify: `web/smk37/index.html:102-107`

No automated test for this step — it's inert markup with no JS behind it yet (Task 3 wires it up). Verify by eye in Step 2.

- [ ] **Step 1: Add the markup to the FM-1 page**

In `web/index.html`, the "Play from" box currently reads:

```html
      <section class="box" aria-labelledby="h-play-from">
        <h2 class="eyebrow" id="h-play-from">Play from</h2>
        <label id="midiin">MIDI in <span class="sel"><span id="midiact" aria-hidden="true"></span><select id="midi" aria-label="MIDI input"><option value="">off</option><option value="*">all inputs</option></select></span></label>
        <label id="midichl" title="Played notes and controllers go to this channel (M-VAVE's firmware listens on 2, Felucca's parts on 1–4)">Channel
          <select id="midich" aria-label="MIDI channel"><option value="0">as sent</option></select></label>
      </section>
```

Replace it with:

```html
      <section class="box" aria-labelledby="h-play-from">
        <h2 class="eyebrow" id="h-play-from">Play from</h2>
        <label id="midiin">MIDI in <span class="sel"><span id="midiact" aria-hidden="true"></span><select id="midi" aria-label="MIDI input"><option value="">off</option><option value="*">all inputs</option></select></span></label>
        <label id="midichl" title="Played notes and controllers go to this channel (M-VAVE's firmware listens on 2, Felucca's parts on 1–4)">Channel
          <select id="midich" aria-label="MIDI channel"><option value="0">as sent</option></select></label>
        <label id="ctrlprofilel" title="Remaps incoming note and CC numbers, and note-on velocity, before they reach the firmware">Controller
          <select id="ctrlprofile" aria-label="Controller profile"><option value="">none</option><option value="sp404mk2">SP-404 MK2</option></select></label>
        <details class="save-controls" id="ctrlmapbox">
          <summary>Edit mapping</summary>
          <div class="row">
            <button type="button" id="ctrl-learn" disabled>Learn</button>
            <span class="dim">Press Learn, then hit a pad or move a knob/fader on the controller</span>
          </div>
          <div id="ctrlmap-rows"></div>
          <div class="row">
            <label>Velocity <select id="ctrlvelocity" aria-label="Velocity mode"><option value="pass">as sent</option><option value="fixed">fixed</option></select></label>
            <input type="number" id="ctrlvelocity-fixed" min="1" max="127" value="100" hidden>
          </div>
        </details>
      </section>
```

- [ ] **Step 2: Add the same markup, hidden, to the SMK-37 page**

In `web/smk37/index.html`, the "Play from" box currently reads:

```html
      <section class="box" aria-labelledby="h-play-from">
        <h2 class="eyebrow" id="h-play-from">Play from</h2>
        <label id="midiin" title="A MIDI keyboard plays the SMK-37's keys (notes C3..C6, with velocity) and its wheels (pitch bend, mod wheel)">MIDI keyboard <span class="sel"><span id="midiact" aria-hidden="true"></span><select id="midi" aria-label="MIDI input"><option value="">off</option><option value="*">all inputs</option></select></span></label>
        <label id="midichl" hidden>Channel
          <select id="midich" aria-label="MIDI channel"><option value="0">as sent</option></select></label>
      </section>
```

Replace it with (the SMK-37 has no MIDI-IN jack, so the controls exist only so `main.js`'s shared code finds the elements — they stay hidden, same as `midichl` above):

```html
      <section class="box" aria-labelledby="h-play-from">
        <h2 class="eyebrow" id="h-play-from">Play from</h2>
        <label id="midiin" title="A MIDI keyboard plays the SMK-37's keys (notes C3..C6, with velocity) and its wheels (pitch bend, mod wheel)">MIDI keyboard <span class="sel"><span id="midiact" aria-hidden="true"></span><select id="midi" aria-label="MIDI input"><option value="">off</option><option value="*">all inputs</option></select></span></label>
        <label id="midichl" hidden>Channel
          <select id="midich" aria-label="MIDI channel"><option value="0">as sent</option></select></label>
        <label id="ctrlprofilel" hidden>Controller
          <select id="ctrlprofile" aria-label="Controller profile"><option value="">none</option><option value="sp404mk2">SP-404 MK2</option></select></label>
        <details class="save-controls" id="ctrlmapbox" hidden>
          <summary>Edit mapping</summary>
          <div class="row">
            <button type="button" id="ctrl-learn" disabled>Learn</button>
          </div>
          <div id="ctrlmap-rows"></div>
          <div class="row">
            <label>Velocity <select id="ctrlvelocity" aria-label="Velocity mode"><option value="pass">as sent</option><option value="fixed">fixed</option></select></label>
            <input type="number" id="ctrlvelocity-fixed" min="1" max="127" value="100" hidden>
          </div>
        </details>
      </section>
```

- [ ] **Step 3: Verify by eye**

Run: `python3 -m http.server 8000 --directory web`
Open `http://localhost:8000/` and `http://localhost:8000/smk37/` in a browser. Expected: on the FM-1 page, a disabled "Learn" button and a "Controller: none" select appear under "MIDI in"/"Channel"; on the SMK-37 page, nothing new is visible (no layout shift). No console errors (the new ids aren't read by any script yet, so none are expected).

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/smk37/index.html
git commit -m "$(cat <<'EOF'
Add controller profile and mapping-editor markup (inert until wired)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the engine into `web/main.js`

**Files:**
- Modify: `web/main.js:6-8` (imports)
- Modify: `web/main.js:335-343` (`fwSel` change handler)
- Modify: `web/main.js:581-657` (MIDI-in section)
- Modify: `web/main.test.mjs` (test harness + new tests)

- [ ] **Step 1: Write the failing tests**

In `web/main.test.mjs`, add the import next to the existing ones at the top:

```js
import * as persistence from './persistence.js';
import * as tryout from './tryout.js';
import * as controller from './controller.js';
```

(only the `import * as controller from './controller.js';` line is new — it sits right after the existing `tryout` import.)

Then find this line inside the `environment` object (currently):

```js
    ...persistence, ...tryout, SaveStore: class { constructor() { return disk; } }, ...extra };
```

and change it to (named, not spread: `controller.js`'s `setVelocity` is bound as `setMapVelocity`, because `main.js` already has its own unrelated top-level `function setVelocity(f)` for key press velocity — spreading the raw export would collide with it):

```js
    ...persistence, ...tryout,
    emptyMap: controller.emptyMap, mapFor: controller.mapFor, withMap: controller.withMap,
    learn: controller.learn, setTarget: controller.setTarget, removeMapping: controller.removeMapping,
    setMapVelocity: controller.setVelocity, applyMapping: controller.applyMapping,
    SaveStore: class { constructor() { return disk; } }, ...extra };
```

Then find the returned API object inside `page()`'s `run` template literal (currently):

```js
  const run = new Function(...Object.keys(environment), `return (async () => { ${source}\nreturn {
    startAudio, boot, flushRunning, setLatency, get running() { return running; },
    setFirmware(id) { fw = byId.get(id); fwSel.value = id; }, setBank(bytes) { bank = bytes; },
    get fw() { return fw; }, perf, setMhz(c) { mhz = c; }, get bootSeq() { return bootSeq; }
  }; })()`);
```

and change it to:

```js
  const run = new Function(...Object.keys(environment), `return (async () => { ${source}\nreturn {
    startAudio, boot, flushRunning, setLatency, get running() { return running; },
    setFirmware(id) { fw = byId.get(id); fwSel.value = id; }, setBank(bytes) { bank = bytes; },
    get fw() { return fw; }, perf, setMhz(c) { mhz = c; }, get bootSeq() { return bootSeq; },
    midiMessage, armLearn() { ctrlLearnArmed = true; },
    setCtrlProfile(id) { ctrlProfile = id; ctrlProfileSel.value = id; ctrlLearnBtn.disabled = !id; renderCtrlMap(); },
    setMappingTarget, setMappingVelocity, get ctrlMaps() { return ctrlMaps; }
  }; })()`);
```

Finally, add these tests at the end of `web/main.test.mjs` (after the last existing `test(...)` call):

```js
test('no controller profile leaves every MIDI message untouched', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.api.midiMessage({ data: Uint8Array.from([0x90, 40, 100]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 40, 100] });
});
test('setting a mapped note target changes what reaches the firmware; unmapped notes still pass through', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.api.setCtrlProfile('sp404mk2');
  p.api.setMappingTarget('notes', 40, 60);
  p.api.midiMessage({ data: Uint8Array.from([0x90, 40, 100]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 60, 100] });
  p.api.midiMessage({ data: Uint8Array.from([0x90, 41, 100]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 41, 100] });
});
test('Learn captures the next incoming note identity-mapped, and consumes that one message instead of playing it', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.api.setCtrlProfile('sp404mk2');
  const before = p.audio.messages.length;
  p.api.armLearn();
  p.api.midiMessage({ data: Uint8Array.from([0x90, 36, 100]) });
  assert.equal(p.audio.messages.length, before);
  assert.deepEqual(p.api.ctrlMaps.sp404mk2[p.api.fw.id].notes, { 36: 36 });
  p.api.midiMessage({ data: Uint8Array.from([0x90, 36, 100]) });
  assert.equal(p.audio.messages.length, before + 1);
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 36, 100] });
});
test('a mapping is kept per firmware: switching firmware does not leak one firmware\'s map into another\'s', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.api.setCtrlProfile('sp404mk2');
  p.api.setMappingTarget('notes', 40, 60);
  p.api.setFirmware('b');
  p.api.midiMessage({ data: Uint8Array.from([0x90, 40, 100]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 40, 100] });
  p.api.setFirmware('a');
  p.api.midiMessage({ data: Uint8Array.from([0x90, 40, 100]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 60, 100] });
});
test('a fixed velocity override applies only to a sounding note-on', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.api.setCtrlProfile('sp404mk2');
  p.api.setMappingVelocity(100);
  p.api.midiMessage({ data: Uint8Array.from([0x90, 40, 5]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x90, 40, 100] });
  p.api.midiMessage({ data: Uint8Array.from([0x80, 40, 5]) });
  assert.deepEqual(p.audio.messages.at(-1), { type: 'midi', bytes: [0x80, 40, 5] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test web/main.test.mjs`
Expected: FAIL on the new tests — `setCtrlProfile is not a function` (none of the new behavior exists in `main.js` yet).

- [ ] **Step 3: Implement the `main.js` changes**

Add the import. Currently:

```js
import { fetchPackage, hubNewcomers, hubCardUrl } from "./fwsc.js";
import { SaveStore, packageHash, changedSectors, packSectors, exportSave, importSave } from "./persistence.js";
import { tryOutOf, loadTryOut } from "./tryout.js";
```

Change to:

```js
import { fetchPackage, hubNewcomers, hubCardUrl } from "./fwsc.js";
import { SaveStore, packageHash, changedSectors, packSectors, exportSave, importSave } from "./persistence.js";
import { tryOutOf, loadTryOut } from "./tryout.js";
import { emptyMap, mapFor, withMap, learn, setTarget, removeMapping, setVelocity as setMapVelocity, applyMapping } from "./controller.js";
```

(`setVelocity` is aliased to `setMapVelocity`: `main.js` already has its own top-level `function setVelocity(f)` at line 455, for SMK-37 key-press velocity — importing the name bare would collide with that existing declaration and throw at load.)

Re-render the mapping panel on firmware switch. Currently:

```js
fwSel.addEventListener("change", () => {
  fw = byId.get(fwSel.value) || localFw;
  endTryOut();
  loadedUrl = null;
```

Change to:

```js
fwSel.addEventListener("change", () => {
  fw = byId.get(fwSel.value) || localFw;
  renderCtrlMap();
  endTryOut();
  loadedUrl = null;
```

Replace the whole MIDI-in section. Currently (`web/main.js:576-657`):

```js
// ---------------------------------------------------------------- MIDI in (Web MIDI)
// The chosen input(s) play the synth through its MIDI IN jack (UART1 at 31250 baud in the
// emulator). Access is asked for only once an input is picked (Chrome asks the visitor), and on
// Start when one was picked on an earlier visit. Channel: channel messages rewritten to one
// channel (0 = as sent).
const midiSel = document.getElementById("midi");
const midiChSel = document.getElementById("midich");
const midiAct = document.getElementById("midiact");
let midi = null, midiAsked = null, midiActOff = 0;
let midiCh = Number(stored("fm1.midich") || 0);
for (let c = 1; c <= 16; c++) midiChSel.add(new Option(String(c), c));
midiChSel.value = midiCh;
const midiWant = () => stored("fm1.midi") || "";
if (!navigator.requestMIDIAccess) {
  midiSel.disabled = midiChSel.disabled = true;
  document.getElementById("midiin").title = "this browser has no Web MIDI (Chrome, Edge and Firefox do)";
}
function midiMessage(e) {
  const d = e.data;
  if (!d.length || !node) return;
  const bytes = Array.from(d);
  if (midiCh && bytes[0] >= 0x80 && bytes[0] < 0xf0) bytes[0] = (bytes[0] & 0xf0) | (midiCh - 1);
  if (board === 1) {
    // the SMK-37 has no MIDI in jack: notes C3..C6 play its keys (the velocity as the time between
    // the contacts), the pitch bend and the mod wheel its wheels
    const st = bytes[0] & 0xf0, k = bytes[1] - 48;
    if ((st === 0x90 || st === 0x80) && k >= 0 && k < NKEY) {
      const on = st === 0x90 && bytes[2] > 0;
      if (on) setVelocity((bytes[2] - 1) / 126);
      setKey(k, on);
    } else if (st === 0xe0) {
      const bend = ((bytes[2] << 7) | bytes[1]) - 8192;
      setAnalog(20, PITCH_REST + (bend >= 0 ? bend / 8191 * (640 - PITCH_REST) : bend / 8192 * (PITCH_REST - 445)));
    } else if (st === 0xb0 && bytes[1] === 1) {
      setAnalog(21, MOD_REST - bytes[2] / 127 * (MOD_REST - 474));
    }
  } else {
    send({ type: "midi", bytes });
  }
  if (bytes[0] < 0xf8) {
    midiAct.classList.add("on");
    clearTimeout(midiActOff);
    midiActOff = setTimeout(() => midiAct.classList.remove("on"), 120);
  }
}
// listen to the wanted inputs only; the list follows devices coming and going
function midiConnect() {
  if (!midi) return;
  const want = midiSel.value;
  const names = [...midi.inputs.values()].map((i) => i.name);
  for (const o of [...midiSel.options]) if (o.value !== "" && o.value !== "*" && !names.includes(o.value)) o.remove();
  for (const n of names) if (![...midiSel.options].some((o) => o.value === n)) midiSel.add(new Option(n, n));
  if ([...midiSel.options].some((o) => o.value === want)) midiSel.value = want;
  for (const input of midi.inputs.values())
    input.onmidimessage = want === "*" || want === input.name ? midiMessage : null;
}
async function midiOpen() {
  if (midi || !navigator.requestMIDIAccess) return midiConnect();
  midiAsked ||= navigator.requestMIDIAccess().then((m) => {
    midi = m;
    midi.onstatechange = midiConnect;
  }, () => {
    midiAsked = null;
    midiSel.value = "";
    status.textContent = "MIDI: access was not given";
  });
  await midiAsked;
  midiConnect();
}
{
  const want = midiWant();
  if (want && want !== "*") midiSel.add(new Option(want, want));
  midiSel.value = want;
}
midiSel.addEventListener("change", () => {
  store("fm1.midi", midiSel.value);
  if (midiSel.value) midiOpen(); else midiConnect();
});
midiChSel.addEventListener("change", () => {
  midiCh = Number(midiChSel.value);
  store("fm1.midich", midiCh);
});
```

Replace it with (the SMK-37 branch's own `setVelocity(...)` calls are untouched — that's the pre-existing top-level function for key-press velocity; the controller's velocity setter is only ever called as `setMapVelocity(...)`, inside `setMappingVelocity` below):

```js
// ---------------------------------------------------------------- MIDI in (Web MIDI)
// The chosen input(s) play the synth through its MIDI IN jack (UART1 at 31250 baud in the
// emulator). Access is asked for only once an input is picked (Chrome asks the visitor), and on
// Start when one was picked on an earlier visit. Channel: channel messages rewritten to one
// channel (0 = as sent). Controller: an optional per-firmware note/CC/velocity remap, calibrated
// with Learn (see controller.js) — unmapped numbers always pass through untouched.
const midiSel = document.getElementById("midi");
const midiChSel = document.getElementById("midich");
const midiAct = document.getElementById("midiact");
const ctrlProfileSel = document.getElementById("ctrlprofile");
const ctrlLearnBtn = document.getElementById("ctrl-learn");
const ctrlRows = document.getElementById("ctrlmap-rows");
const ctrlVelocitySel = document.getElementById("ctrlvelocity");
const ctrlVelocityFixed = document.getElementById("ctrlvelocity-fixed");
let midi = null, midiAsked = null, midiActOff = 0;
let midiCh = Number(stored("fm1.midich") || 0);
let ctrlProfile = stored("fm1.ctrlprofile") || "";
let ctrlMaps = {};
try { ctrlMaps = JSON.parse(stored("fm1.ctrlmaps") || "{}"); } catch { /* corrupt: start fresh */ }
let ctrlLearnArmed = false;
for (let c = 1; c <= 16; c++) midiChSel.add(new Option(String(c), c));
midiChSel.value = midiCh;
ctrlProfileSel.value = ctrlProfile;
ctrlLearnBtn.disabled = !ctrlProfile;
const midiWant = () => stored("fm1.midi") || "";
if (!navigator.requestMIDIAccess) {
  midiSel.disabled = midiChSel.disabled = true;
  document.getElementById("midiin").title = "this browser has no Web MIDI (Chrome, Edge and Firefox do)";
}
function saveCtrlMaps() { store("fm1.ctrlmaps", JSON.stringify(ctrlMaps)); }
function activeMap() { return mapFor(ctrlMaps, ctrlProfile, fw.id); }
function applyControllerProfile(bytes) { return applyMapping(activeMap(), bytes); }
function setMappingTarget(kind, from, to) {
  ctrlMaps = withMap(ctrlMaps, ctrlProfile, fw.id, setTarget(activeMap() || emptyMap(), kind, from, to));
  saveCtrlMaps();
}
function setMappingVelocity(v) {
  ctrlMaps = withMap(ctrlMaps, ctrlProfile, fw.id, setMapVelocity(activeMap() || emptyMap(), v));
  saveCtrlMaps();
  renderCtrlMap();
}
function captureLearn(bytes) {
  const status = bytes[0] & 0xf0;
  if (status !== 0x90 && status !== 0x80 && status !== 0xb0) return false;
  ctrlMaps = withMap(ctrlMaps, ctrlProfile, fw.id, learn(activeMap() || emptyMap(), bytes[0], bytes[1]));
  saveCtrlMaps();
  renderCtrlMap();
  return true;
}
function renderCtrlMap() {
  ctrlRows.replaceChildren();
  const map = activeMap() || emptyMap();
  for (const kind of ["notes", "cc"]) {
    for (const from of Object.keys(map[kind])) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = `${kind === "cc" ? "CC" : "note"} ${from} →`;
      const target = document.createElement("input");
      target.type = "number"; target.min = "0"; target.max = "127"; target.value = String(map[kind][from]);
      target.addEventListener("change", () => setMappingTarget(kind, Number(from), Number(target.value)));
      const removeBtn = document.createElement("button");
      removeBtn.type = "button"; removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        ctrlMaps = withMap(ctrlMaps, ctrlProfile, fw.id, removeMapping(activeMap() || emptyMap(), kind, Number(from)));
        saveCtrlMaps();
        renderCtrlMap();
      });
      row.append(label, target, removeBtn);
      ctrlRows.append(row);
    }
  }
  ctrlVelocitySel.value = map.velocity === "pass" ? "pass" : "fixed";
  ctrlVelocityFixed.hidden = map.velocity === "pass";
  if (map.velocity !== "pass") ctrlVelocityFixed.value = String(map.velocity);
}
function midiMessage(e) {
  const d = e.data;
  if (!d.length || !node) return;
  const bytes = Array.from(d);
  if (ctrlLearnArmed) { if (captureLearn(bytes)) ctrlLearnArmed = false; return; }
  if (midiCh && bytes[0] >= 0x80 && bytes[0] < 0xf0) bytes[0] = (bytes[0] & 0xf0) | (midiCh - 1);
  if (board === 1) {
    // the SMK-37 has no MIDI in jack: notes C3..C6 play its keys (the velocity as the time between
    // the contacts), the pitch bend and the mod wheel its wheels
    const st = bytes[0] & 0xf0, k = bytes[1] - 48;
    if ((st === 0x90 || st === 0x80) && k >= 0 && k < NKEY) {
      const on = st === 0x90 && bytes[2] > 0;
      if (on) setVelocity((bytes[2] - 1) / 126);
      setKey(k, on);
    } else if (st === 0xe0) {
      const bend = ((bytes[2] << 7) | bytes[1]) - 8192;
      setAnalog(20, PITCH_REST + (bend >= 0 ? bend / 8191 * (640 - PITCH_REST) : bend / 8192 * (PITCH_REST - 445)));
    } else if (st === 0xb0 && bytes[1] === 1) {
      setAnalog(21, MOD_REST - bytes[2] / 127 * (MOD_REST - 474));
    }
  } else {
    send({ type: "midi", bytes: applyControllerProfile(bytes) });
  }
  if (bytes[0] < 0xf8) {
    midiAct.classList.add("on");
    clearTimeout(midiActOff);
    midiActOff = setTimeout(() => midiAct.classList.remove("on"), 120);
  }
}
// listen to the wanted inputs only; the list follows devices coming and going
function midiConnect() {
  if (!midi) return;
  const want = midiSel.value;
  const names = [...midi.inputs.values()].map((i) => i.name);
  for (const o of [...midiSel.options]) if (o.value !== "" && o.value !== "*" && !names.includes(o.value)) o.remove();
  for (const n of names) if (![...midiSel.options].some((o) => o.value === n)) midiSel.add(new Option(n, n));
  if ([...midiSel.options].some((o) => o.value === want)) midiSel.value = want;
  for (const input of midi.inputs.values())
    input.onmidimessage = want === "*" || want === input.name ? midiMessage : null;
}
async function midiOpen() {
  if (midi || !navigator.requestMIDIAccess) return midiConnect();
  midiAsked ||= navigator.requestMIDIAccess().then((m) => {
    midi = m;
    midi.onstatechange = midiConnect;
  }, () => {
    midiAsked = null;
    midiSel.value = "";
    status.textContent = "MIDI: access was not given";
  });
  await midiAsked;
  midiConnect();
}
{
  const want = midiWant();
  if (want && want !== "*") midiSel.add(new Option(want, want));
  midiSel.value = want;
}
midiSel.addEventListener("change", () => {
  store("fm1.midi", midiSel.value);
  if (midiSel.value) midiOpen(); else midiConnect();
});
midiChSel.addEventListener("change", () => {
  midiCh = Number(midiChSel.value);
  store("fm1.midich", midiCh);
});
ctrlProfileSel.addEventListener("change", () => {
  ctrlProfile = ctrlProfileSel.value;
  store("fm1.ctrlprofile", ctrlProfile);
  ctrlLearnBtn.disabled = !ctrlProfile;
  renderCtrlMap();
});
ctrlLearnBtn.addEventListener("click", () => { ctrlLearnArmed = true; });
ctrlVelocitySel.addEventListener("change", () => {
  setMappingVelocity(ctrlVelocitySel.value === "fixed" ? Number(ctrlVelocityFixed.value) : "pass");
});
ctrlVelocityFixed.addEventListener("change", () => {
  if (ctrlVelocitySel.value === "fixed") setMappingVelocity(Number(ctrlVelocityFixed.value));
});
renderCtrlMap();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test web/main.test.mjs`
Expected: `pass 19`, `fail 0` (14 pre-existing + 5 new).

- [ ] **Step 5: Run the full browser test suite**

Run: `node --test web/*.test.mjs`
Expected: all suites pass, none fail.

- [ ] **Step 6: Commit**

```bash
git add web/main.js web/main.test.mjs
git commit -m "$(cat <<'EOF'
Wire the controller mapping engine into MIDI in: Learn, per-firmware
note/CC remap and a fixed-velocity override

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual validation with the real SP-404 MK2

No code changes. This is the step nothing above can automate: confirming the mapping against the actual hardware, since Roland's own documentation disagrees with itself across firmware versions and the unit's Utility settings can shift note numbers and channels further.

- [ ] **Step 1: Ground-truth the SP-404's real output**

Run: `python3 -m http.server 8000 --directory web`, open `http://localhost:8000/?fw=midimon`, press Start. Connect the SP-404 MK2 by USB, pick it in "MIDI in". Hit every pad you plan to use and move every knob/fader once. Read MIDIMON's screen (or its USB/serial text output, per its own docs) and write down the exact note numbers (pads) and CC numbers (knobs/faders) — this is your real device's output, independent of what any PDF chart claims.

- [ ] **Step 2: Build the mapping for your target firmware**

Switch "Firmware" to the one you actually play. Set "Controller" to "SP-404 MK2". For each pad/knob from Step 1: click "Learn", hit that pad or move that knob — a row appears with the real incoming number as both source and target. Edit the target number to whatever note/CC that firmware expects for the sound/parameter you want (check that firmware's own README/manual for its note layout; MIDI-aware ones are listed in the project's main `README.md`, e.g. CTL-1, Dinghy, FM-1 SID, B1).

- [ ] **Step 3: Verify by ear**

Play each mapped pad; confirm it sounds the note you intended. For a firmware that documents MIDI-controllable knobs (e.g. FM-1 SID's KNOB1-4 as CC), move the mapped SP-404 knob and confirm the on-screen encoder/parameter moves. For firmwares with no documented CC support, do not expect the knobs to do anything — that is the stated, out-of-scope limitation (the firmware's own code never reads CC for it), not a mapping bug.

- [ ] **Step 4: If velocity feels wrong**

Open "Edit mapping", set "Velocity" to "fixed" and pick a value (e.g. 100); every sounding pad hit now reports that same velocity regardless of how hard it was hit. Set it back to "as sent" to restore pass-through.

No commit for this task — it is a one-time calibration per firmware, already persisted to `localStorage` by Task 3's code as you go.
