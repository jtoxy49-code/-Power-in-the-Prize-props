// NFL NORMALIZATION: resolving a player NAME to the canonical player_id.
//
// Inside PWR a player is his GSIS id (nflverse `gsis_id`). Names are display
// fields. The one place a name has to be resolved is the odds feed, whose rows
// carry `player_name` and nothing else.
//
// resolvePlayer() tries, in order, and stops at the first step that yields
// EXACTLY ONE candidate:
//   1. exact       the normalized name equals one of the player's roster names
//   2. alias       a reviewed entry in PLAYER_ALIASES (name -> player_id)
//   3. variant     same last name, and the first names are forms of one name
//                  (Kenneth / Kenny, Cameron / Cam, ...)
//   4. initial     same last name and the same first initial
// A step that yields two or more candidates ends the search: the name is
// ambiguous and is NOT matched. Anything unmatched goes to quarantine with its
// reason; it is never attached to the nearest name.

/** Accents, case, punctuation and generational suffixes do not distinguish players. */
export function nameKey(raw) {
  return String(raw ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,'’`]/g, "")
    .replace(/-/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Forms of one first name. Each group is a set of interchangeable spellings.
// This is a general table, not a list of the cases the probe happened to see;
// a pair belongs here only if the two forms are the same name in common use.
const FIRST_NAME_GROUPS = [
  ["kenneth", "kenny", "ken"], ["cameron", "cam"], ["joshua", "josh"], ["christopher", "chris"],
  ["michael", "mike"], ["matthew", "matt"], ["william", "will", "bill", "billy"], ["robert", "rob", "bob", "bobby", "robbie"],
  ["benjamin", "ben"], ["samuel", "sam"], ["nicholas", "nick", "nico"], ["zachary", "zach", "zack", "zac"],
  ["anthony", "tony"], ["joseph", "joe", "joey"], ["daniel", "dan", "danny"], ["thomas", "tom", "tommy"],
  ["james", "jim", "jimmy"], ["andrew", "drew", "andy"], ["andres", "andy"], ["gabriel", "gabe"],
  ["jacob", "jake"], ["jeffrey", "jeffery", "jeff"], ["nathaniel", "nathan", "nate"], ["patrick", "pat"],
  ["richard", "rich", "ricky", "rick"], ["steven", "stephen", "steve"], ["timothy", "tim"], ["alexander", "alex"],
  ["gregory", "greg"], ["jonathan", "jonathon", "jon"], ["david", "dave"], ["edward", "ed", "eddie"],
  ["ronald", "ron", "ronnie"], ["donald", "don", "donnie"], ["raymond", "ray"], ["lawrence", "larry"],
  ["charles", "charlie", "chuck"], ["frederick", "fred", "freddie"], ["phillip", "philip", "phil"], ["terrance", "terrence", "terry"],
  ["isaiah", "isiah"], ["deandre", "de andre"], ["marquise", "hollywood"], ["dwayne", "dewayne"],
  ["trenton", "trent"], ["tyrone", "ty"], ["tyler", "ty"], ["maxwell", "max"], ["jackson", "jack"],
  ["mitchell", "mitch"], ["dominic", "dom"], ["vincent", "vince", "vinny"], ["leonard", "leo", "lenny"],
  ["devonta", "de vonta"], ["demarcus", "de marcus"], ["jaylen", "jaylon", "jalen"],
];
const VARIANTS = new Map();
for (const group of FIRST_NAME_GROUPS) for (const n of group) VARIANTS.set(n, new Set([...(VARIANTS.get(n) || []), ...group]));
export const sameFirstName = (a, b) => a === b || !!VARIANTS.get(a)?.has(b);

/**
 * Reviewed overrides: normalized feed name -> player_id. Use this only for a
 * name no rule can resolve (a nickname unrelated to the legal name, a feed
 * typo). Each entry says where it came from. Empty until a quarantine review
 * adds one.
 */
export const PLAYER_ALIASES = {
  // "name key as the feed sends it": { player_id: "00-0000000", source: "sharpapi", reviewed: "YYYY-MM-DD" },
};

const split = (k) => { const p = k.split(" "); return { first: p[0] || "", last: p.slice(1).join(" ") }; };

/** Every normalized name a roster row can be known by. */
export function rosterNameKeys(player) {
  const keys = new Set();
  const add = (v) => { const k = nameKey(v); if (k) keys.add(k); };
  add(player.display_name);
  add(player.full_name);
  if (player.first_name && player.last_name) add(`${player.first_name} ${player.last_name}`);
  if (player.football_name && player.last_name) add(`${player.football_name} ${player.last_name}`);
  return [...keys];
}

/**
 * @param {string} rawName  the name exactly as the source sent it
 * @param {Array}  candidates  roster rows already narrowed by the caller to the
 *        two teams in the game (and to the positions the prop allows):
 *        { player_id, display_name, first_name?, last_name?, football_name?, position }
 * @param {object} [aliases]  reviewed overrides (defaults to PLAYER_ALIASES)
 * @returns {{player_id:string, method:string} | {player_id:null, reason:string, matches:number}}
 */
export function resolvePlayer(rawName, candidates, aliases = PLAYER_ALIASES) {
  const want = nameKey(rawName);
  if (!want) return { player_id: null, reason: "empty_name", matches: 0 };
  const byId = new Map();
  for (const c of candidates) if (c?.player_id && !byId.has(c.player_id)) byId.set(c.player_id, c);
  const pool = [...byId.values()];
  const decide = (hits, method) => {
    const ids = [...new Set(hits.map((h) => h.player_id))];
    if (ids.length === 1) return { player_id: ids[0], method };
    if (ids.length > 1) return { player_id: null, reason: `ambiguous_${method}`, matches: ids.length };
    return null;
  };

  // 1. exact
  let out = decide(pool.filter((c) => rosterNameKeys(c).includes(want)), "exact");
  if (out) return out;

  // 2. reviewed alias (only honored if that player is actually a candidate)
  const alias = aliases[want];
  if (alias) {
    if (byId.has(alias.player_id)) return { player_id: alias.player_id, method: "alias" };
    return { player_id: null, reason: "alias_not_in_game", matches: 0 };
  }

  // 3. first-name variant with the same last name
  const w = split(want);
  if (w.last) {
    out = decide(pool.filter((c) => rosterNameKeys(c).some((k) => { const r = split(k); return r.last === w.last && sameFirstName(r.first, w.first); })), "variant");
    if (out) return out;

    // 4. same last name and first initial ("J Luzardo"-style short names)
    out = decide(pool.filter((c) => rosterNameKeys(c).some((k) => { const r = split(k); return r.last === w.last && r.first[0] === w.first[0]; })), "initial");
    if (out) return out;
  }
  return { player_id: null, reason: "no_match", matches: 0 };
}
