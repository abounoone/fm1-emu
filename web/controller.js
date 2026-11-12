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
