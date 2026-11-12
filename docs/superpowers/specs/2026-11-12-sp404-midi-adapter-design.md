# SP-404 MK2 controller adapter for fm1-emu

## Problem

The site (`web/main.js`) forwards raw Web MIDI bytes straight into the emulated
FM-1's MIDI UART (`midiMessage()` → `send({type:"midi", bytes})`). No note or
CC remapping happens. Playing from an SP-404 MK2 (USB class-compliant MIDI)
already produces sound, but:

- pad notes land on the wrong keys for the firmware in use
- SP-404 knobs/faders (CC) don't move the emulator's on-screen encoders
- pad velocity doesn't behave as expected

## Constraint that shapes the design

The FM-1's knobs are physical rotary encoders read by firmware over GPIO, not
MIDI parameters. A firmware only responds to incoming CC if its own code
explicitly reads CC for that purpose — most of the 156 community firmwares
don't. No amount of MIDI translation on the site can make a firmware react to
a CC it never reads; that would require patching that firmware's own source,
which is out of scope here.

Roland's own SP-404 MK2 MIDI implementation chart is not a safe source to
hardcode from: the note-number ranges differ between mode A/B and firmware
versions, and Roland explicitly allows note numbers and channels to be
offset in the Utility menu — so a real unit's output may not match the
printed chart anyway.

## Approach: profile-based remapper with a Learn mode

Insert one translation step inside `midiMessage()`, before the existing
channel-forcing logic, that rewrites incoming note/CC numbers and velocity
according to an active **controller profile**. Unmapped notes/CCs pass
through unchanged, so nothing that already works regresses.

### Data model

```js
// one profile = one named mapping, keyed by firmware id
{
  name: "SP-404 MK2",
  perFirmware: {
    "<firmware id>": {
      noteMap: { "<incoming note>": "<outgoing note>" },
      ccMap:   { "<incoming cc>":   "<outgoing cc>" },
      velocity: "pass" | { fixed: 0-127 } | { curve: gamma }
    }
  }
}
```

Stored in `localStorage` the same way existing settings are (`stored()` /
`store()` helpers already in `web/main.js`), under a new key such as
`fm1.controllerProfiles`.

### UI

Next to the existing MIDI device/channel selects:

- a "Controller" select: `None` / `SP-404 MK2`
- an "Edit mapping" button opening a small panel listing the active
  firmware's current note/CC rows, each with:
  - a **Learn** button: arms a one-shot capture; the next MIDI message
    received is taken as the mapping's input side
  - a target field (note number or CC number) the user types or picks
- a velocity mode control (pass-through / fixed / curve) per profile

### Calibration workflow

1. Load the **MIDIMON** firmware (`?fw=midimon`) in the emulator — it's a
   MIDI monitor that shows raw incoming bytes on the emulated screen.
2. Hit every SP-404 pad and move every knob/fader once; read the real note
   and CC numbers your unit actually sends (mode, offsets, and all).
3. Switch to the target firmware, open "Edit mapping", use Learn to tie each
   real pad/knob to the note/CC that firmware expects, verifying by sound.
4. Save; the mapping is recalled automatically next time that firmware is
   selected with the SP-404 MK2 profile active.

A built-in starting preset ships with a best-effort default (notes 36–47 for
bank A's 12 pads, CC16/17/18 → Ctrl1-3) purely as a template to edit via
Learn — not presented as a verified-correct table.

### Non-goals

- No changes to any firmware's own code or to the Rust/wasm emulator core.
- No virtual MIDI loopback or external process; everything happens inside
  this browser tab's existing Web MIDI handling.
- No guarantee that CC will drive a given firmware's on-screen knobs — only
  verified to work on firmwares that document MIDI control of parameters
  (e.g. SID's KNOB1-4, CTL-1, B1), and skipped/left in "pass" for the rest.

## Testing

- Manual: MIDIMON firmware to verify what the SP-404 actually sends, then
  the target firmware by ear/sight for each mapped pad and knob.
- `web/main.test.mjs` already exercises `midiMessage`-adjacent logic; add
  unit coverage for `applyControllerProfile()` (note/CC/velocity rewrite,
  pass-through of unmapped values, profile switch on firmware switch).
