// mulberry32, seeded from a string, so every caller gets its own repeatable sequence.
export function seededRandom(seedText) {
  let state = hashText(seedText);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashText(text) {
  let hash = 2_166_136_261;
  for (const character of text) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return hash >>> 0;
}
