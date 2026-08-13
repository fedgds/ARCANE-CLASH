/* ═══════════════════════════════════════════════════════════════
   ARCANE CLASH — auto-battler. Architecture:
     · fixed-timestep sim (60Hz) decoupled from render → slow-mo is
       a timeScale on the sim, never a framerate drop
     · skills are DATA; 11 reusable behaviour renderers cover all 40
     · damage derived from a power budget, then verified by running
       thousands of headless matches (Balance Lab)

   CORE — this file: utilities, balance constants, the skill catalog,
   tag families and combos, and the formulas that turn a skill's power
   budget into concrete numbers.

   The page loads eight CLASSIC scripts (no ES modules), so every
   top-level const/let/class still lands in the one shared script scope
   this code was written for, and it still opens straight off disk over
   file://. Load order IS dependency order:

     1 core.js           this file — the static data everything reads
     2 arena-art.js      colosseum backdrop, cosmetic geometry, particle art
     3 codex.js          codex screens and the per-skill preview loop
     4 sim-engine.js     seeded RNG, Fighter, Sim — pure logic, no DOM
     5 battle-render.js  canvas renderer, main loop, HUD sync
     6 draft.js          gold, rolling shop, fusion, AI drafter
     7 pve-daily.js      delve, ascension, daily, ghosts, audio, save
     8 main.js           champion select, nav, event wiring, boot — LAST

   Only top-level EVALUATION is order-sensitive; functions call across
   files freely at runtime, so the groupings above follow subject matter
   rather than call order. main.js must stay last: it binds DOM handlers
   and boots.
   ══════════════════════════════════════════════════════════════ */

"use strict";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const TAU = Math.PI * 2;
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const lerp = (a,b,t) => a+(b-a)*t;
const rnd = (a=1,b=0) => b + Math.random()*(a-b);
const pick = a => a[(Math.random()*a.length)|0];
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

/* ---------- balance constants ---------- */
const HP_BASE   = 4200;
const BASIC_DMG = 26, BASIC_CD = 1.1;
const DPS_BUDGET = {1:9.5, 2:18, 3:26.5, 4:35, 5:44};   // ~linear in gold cost
const LVL_MUL    = [0, 1, 1.78, 2.95];                  // L1 / L2 / L3
const SUSTAIN_COEF = 1.35;   // hp of heal/shield per point of dps budget
const BURN_COEF  = 0.15, BLEED_COEF = 0.10, BLEED_MAX = 2;
const CHILL_CD   = 0.11;     // cooldown slow from chill (CDR is the strongest stat)
const SHRED_AMP  = 0.18;     // damage amplification from shred
/* Riders scale on a GENTLER curve than base damage. A rider multiplies the
   whole build, so its worth already grows as the rest of the build grows --
   giving it LVL_MUL on top double-counts and made chill/shred LV3 absurd in
   testing. sqrt(LVL_MUL) is the compromise: an upgrade visibly improves the
   rider without it outrunning the damage skills it multiplies.
   Before this existed, chill and shred stored magnitude 1 (a flag) and used a
   flat constant, so upgrading them bought nothing but a bigger number on a
   deliberately tiny base -- measured 78-92% upgrade value against 98.7% for
   everything else, and a LV1->LV3 win-rate inversion (Rust Bolt 71% -> 29%). */
const RIDER_MUL  = [0, 1, 1.334, 1.718];

/* ── CROWD CONTROL ──────────────────────────────────────────────
   Four hard statuses, each gating a DIFFERENT action, so they are not
   reskins of one another and a build wants specific ones:
     stun     no casting, no basic attack, no movement   (shortest)
     freeze   no casting, no movement — basics still land, and the
              target takes amplified damage while frozen
     silence  no casting — basics and movement continue  (longest)
     root     no movement — casting and basics continue

   DIMINISHING RETURNS is the whole reason this is safe to ship. Each
   application of the same category on the same target within the
   memory window lands at a fraction of its printed duration, and past
   the third it does nothing at all. Without it two CC skills chain
   into a permanent lock: the headless harness put an unbounded
   double-CC build at 96% before this existed, and 51% after.
   The window is generous (7s) on purpose, so the counterplay is
   "spread your CC out", not "press it twice and win".              */
const CC_KINDS   = ['stun','freeze','silence','root'];
const CC_DR      = [1, 0.5, 0.25, 0];   // 1st, 2nd, 3rd, 4th+ application
const CC_MEMORY  = 7.0;                 // seconds a DR stack is remembered
const FREEZE_AMP = 0.20;                // frozen targets take +20% damage
const isCC = fx => CC_KINDS.indexOf(fx) >= 0;

/* ── SUMMONS ────────────────────────────────────────────────────
   A pet's health is derived from the same solved `u` that sets its damage,
   so one fitted coefficient controls the whole archetype and there is no
   second hand-tuned number to drift. The ratio is a feel decision: high
   enough that a familiar survives long enough to matter, low enough that
   it cannot tank a boss. */
const PET_HP = 26;
/* `immune` is a duration, not a magnitude, so it has no coefficient to
   solve — the fitted `u` on an invulnerability skill buys its LENGTH via
   riderMul instead. Capped so no upgrade path reaches a degenerate window. */
const IMMUNE_MAX = 3.2;
const PURE_BONUS = 1.24;     // no-rider damage skills buy raw damage with the slack
const EXEC_SCALE = 0.9;      // execute bonus at 0 hp
const TIER_COL   = ['#000','#8b96b8','#5fd0ff','#a97bff','#ff7ad9','#ffce5a'];
const TIER_NAME  = ['','Common','Rare','Epic','Mythic','Legendary'];
const MAX_SKILLS = 6;
const ARENA_W = 1000, ARENA_H = 470;

/* Per-skill upgrade STEEPNESS, available but deliberately UNUSED (k=1
   for all 40 skills). The level curve becomes LVL_MUL^k, so k<1 flattens
   an over-rewarding upgrade and k>1 steepens a weak one.

   Why it is off: a uniform-LV3 measurement says utility upgrades
   over-deliver (+15.6pt LV1->LV3) and rider upgrades under-deliver
   (-10.3pt), and fitting k against that does flatten those curves. But
   that regime is an artefact of the test, not the game -- only 3% of
   drafted skills ever reach LV3, and a lone LV3 among LV1 fillers wins
   98-100% of the time for every skill, so the measurement is saturated
   and cannot discriminate. Applying the fitted k made the metric that
   matches real play WORSE: paired A/B outliers 0/40 -> 7/40, real-draft
   outliers 0/40 -> 3/40. So the numbers were fitted to noise and are
   discarded. The knob stays because the analysis is sound and a future
   change to the level mix may make it real; it just is not real now. */
function lvlMul(sk, lvl){
  const k = sk.k;
  return k === undefined || k === 1 ? LVL_MUL[lvl] : Math.pow(LVL_MUL[lvl], k);
}
function riderMul(sk, lvl){
  const k = sk.k;
  return k === undefined || k === 1 ? RIDER_MUL[lvl] : Math.pow(RIDER_MUL[lvl], k);
}
/* MEASURED, NOT FIXED — why upgrades are not equally good for everyone.
   LV3 fights run ~2.2x shorter than LV1 (27s -> 12s), and the LV1->LV3
   win-rate slope splits by category, not by mechanic:
       utility (pure % multipliers)   +15.6pt
       damage carrying a rider        -10.3pt
       damage with no rider           +0.2pt
   correlations: isUtility +0.52, hasRider -0.38 (among damage skills).
   A percentage multiplier compounds against a build that already tripled,
   so tripling it again over-delivers; a rider skill paid for its rider
   with a base-damage discount, so upgrading inflates exactly the part it
   underpaid.
   Left uncorrected on purpose: see `k` above. Correcting it optimises a
   regime real drafts barely produce (3% of skills reach LV3) and made
   both realistic metrics worse. Not fixed by touching the DoT mechanic
   either -- two attempts tried that and measurement refuted it: a DoT is
   2-7% of damage dealt and its share RISES with level. */
/* damage per hit, derived from budget — never hand-typed */
function dmgOf(sk, lvl){
  if(!sk.role) return 0;
  const pure = sk.fx ? 1 : PURE_BONUS;
  return Math.round(DPS_BUDGET[sk.tier] * sk.role * pure * lvlMul(sk,lvl) * sk.cd / sk.hits);
}
/* utility magnitude scales the same way */
function utilOf(sk, lvl){
  return (sk.u||0) * lvlMul(sk,lvl);
}
/* NOTE on cap overflow -- known, measured three times, still deliberate.
   Three skills request more than their pipeline clamp allows:
     Frenzy      crit  wants 0.69 at LV2 (+15%) and 1.14 at LV3 (+90%) vs 0.60
     Blood Pact  pact  wants 1.36 at LV2 (+13%) and 2.25 at LV3 (+88%) vs 1.20
     Stone Skin  dr    wants 0.61 at LV3 (+11%) vs 0.55
   so part of those upgrades is wasted. Two cures were tried and both cost
   more than the bug: flattening the utility curve nerfed all 15 utility
   skills and sank the defensives, and cap-deriving the base made LV1 25-40%
   weaker in 100% of draws to recover overflow that occurs in a few percent.

   It is also self-correcting in a way worth stating: because the balance
   fit measures what a skill DELIVERS, not what it requests, these three
   are priced as the clamped values they actually produce -- all three sit
   within noise of 50% in the paired A/B. The waste is real but it is
   already paid for, and only 3% of drafted skills ever reach LV3.        */

/* ---------- skill catalog ----------
   kind: proj multiproj beam nova cone rain dash orbit field self
   role: share of tier DPS budget spent on raw damage (0 = pure utility)
   fx:   status rider applied on hit / on cast

   The 4-decimal role/u values are SOLVED, not typed. They come from a
   paired A/B: both sides draft the same filler build, one contested slot
   differs by a same-tier peer, seats swapped so seat effects cancel. 50%
   is then correct by construction, and each coefficient is driven to it
   by coordinate descent (9 passes, ~24k battles per verification).

   This replaced an earlier fit made against per-skill win rates from real
   drafts, which was measuring the DRAFTER: holding a strong skill
   correlates with having drafted well, and the stronger build wins 81% of
   non-tied drafts. Under that biased target, damage skills sat at 53.1%
   and utility at 40.4% -- a 12.7pt gap that looked like ten separate
   balance bugs. Refitting against the unbiased target closed it to
   50.0/50.1 and took within-tier outliers from 18/40 to 1/40 (paired A/B)
   and 6/40 to 0/40 (real drafts). Blood Pact alone moved 28.1% -> 50.3%.
   Do not hand-edit these; re-solve them.                                */
const S = (id,name,tier,kind,cd,hits,role,o={}) =>
  Object.assign({id,name,tier,kind,cd,hits,role,col:o.col||TIER_COL[tier]}, o);

const SKILLS = [
  /* ── Tier 1 ─────────────────────────────────────────── */
  S('arcbolt','Arc Bolt',1,'proj',1.6,1,1.5064,{col:'#7fd4ff',spd:520,txt:'A homing mote of raw mana.'}),
  S('emberdart','Ember Dart',1,'proj',2.0,1,0.5169,{col:'#ff9a4d',spd:470,fx:'burn',fxDur:3,txt:'Ignites the target for extra damage over time.'}),
  S('frostneedle','Frost Needle',1,'proj',2.2,1,0.5283,{col:'#a8e6ff',spd:600,fx:'chill',fxDur:2.2,txt:'Slows the target, delaying their attacks.'}),
  S('stonechip','Stone Chip',1,'proj',2.6,1,0.2092,{col:'#c9b48a',spd:420,fx:'shred',fxDur:4,txt:'Strips armour, amplifying all later hits.'}),
  S('windslash','Wind Slash',1,'cone',2.4,3,1.7513,{col:'#b8ffe0',spread:0.62,reach:310,txt:'Three quick cuts in a forward arc.'}),
  S('sparkring','Spark Ring',1,'nova',3.0,1,1.6098,{col:'#ffe98a',reach:275,txt:'A short pulse of static around the caster.'}),
  S('mendwound','Mend Wound',1,'self',5.0,1,0,{col:'#8dffa8',fx:'heal',u:117.5863,txt:'Restores health instantly.'}),
  S('wardplate','Ward Plate',1,'self',6.0,1,0,{col:'#9fc4ff',fx:'shield',u:133.6291,txt:'Absorbs incoming damage until broken.'}),
  S('quickstep','Quickstep',1,'self',7.0,1,0,{col:'#d0ffe8',fx:'haste',u:0.1227,fxDur:6,txt:'Reduces all cooldowns while active.'}),

  /* ── Tier 2 ─────────────────────────────────────────── */
  S('lightlance','Light Lance',2,'beam',4.0,4,1.1757,{col:'#fff4c2',dur:0.6,txt:'A sustained lance of light that pierces armour.'}),
  S('cinderrain','Cinder Rain',2,'rain',5.0,5,0.5308,{col:'#ff7a3d',area:150,fx:'burn',fxDur:3,txt:'Five embers fall across the target zone.'}),
  S('glaciallance','Glacial Lance',2,'proj',3.4,1,0.7332,{col:'#8fd8ff',spd:560,fx:'chill',fxDur:3,txt:'A heavy shard that badly slows the target.'}),
  S('rustbolt','Rust Bolt',2,'proj',3.6,1,0.3561,{col:'#d59a5a',spd:440,fx:'shred',fxDur:6,txt:'Deep armour corrosion, long duration.'}),
  S('bladedance','Blade Dance',2,'dash',4.5,4,0.8622,{col:'#dfe9ff',txt:'Dashes through the enemy, four strikes.'}),
  S('venomcoil','Venom Coil',2,'proj',3.2,1,0.2128,{col:'#9dff6b',spd:480,fx:'bleed',fxDur:6,txt:'Stacking poison that ignores shields.'}),
  S('siphonorb','Siphon Orb',2,'proj',3.8,1,0.8669,{col:'#ff7ad9',spd:430,fx:'vamp',u:0.35,txt:'Heals the caster for a share of damage dealt.'}),
  S('stoneskin','Stone Skin',2,'self',9.0,1,0,{col:'#cbbf9a',fx:'dr',u:0.2069,fxDur:7,txt:'Reduces all incoming damage while active.'}),
  S('battlehymn','Battle Hymn',2,'self',8.0,1,0,{col:'#ffd88a',fx:'dmgAmp',u:0.2480,fxDur:7,txt:'Increases all outgoing damage while active.'}),
  S('thornmail','Thorn Mail',2,'self',10.0,1,0,{col:'#ff9aa8',fx:'thorns',u:0.2332,fxDur:8,txt:'Returns a share of damage taken to the attacker.'}),

  /* ── Tier 3 ─────────────────────────────────────────── */
  S('voidlance','Void Lance',3,'beam',5.0,6,1.0110,{col:'#c39bff',dur:0.8,txt:'A channelled beam of collapsing void.'}),
  S('chainlightning','Chain Lightning',3,'multiproj',4.2,3,0.8402,{col:'#8ce0ff',spd:700,txt:'Three forking bolts, each seeking the target.'}),
  S('stormcall','Storm Call',3,'rain',6.0,7,0.9470,{col:'#a9d8ff',area:190,txt:'A lattice of lightning across the arena floor.'}),
  S('shadowstep','Shadow Step',3,'dash',5.5,6,0.6924,{col:'#b58cff',txt:'Blinks through the target six times.'}),
  S('gravitywell','Gravity Well',3,'field',6.5,8,1.1814,{col:'#8f7bff',area:170,dur:4,fx:'pull',txt:'A well that drags the enemy inward and grinds them.'}),
  S('plaguewell','Plague Well',3,'field',6.5,8,0.5840,{col:'#a6ff7a',area:160,dur:5,fx:'bleed',fxDur:4,txt:'Lingering contagion that stacks poison.'}),
  S('sunflare','Sun Flare',3,'nova',5.0,1,0.6955,{col:'#ffd45a',reach:290,fx:'burn',fxDur:4,txt:'A blinding detonation centred on the caster.'}),
  S('arcanetwins','Arcane Twins',3,'orbit',7.0,6,0.9472,{col:'#7fe9ff',count:2,dur:6,txt:'Two orbs circle you, striking anything close.'}),
  S('bulwark','Aegis Bulwark',3,'self',11.0,1,0,{col:'#bfe0ff',fx:'shield',u:383.3799,txt:'A large absorbing barrier.'}),
  /* Frenzy sits in tier 2, not tier 3: an amplifier multiplies the REST of
     the build rather than adding damage of its own, so at tier-3 pricing it
     contributed far less than the 26.5 dps a tier-3 damage skill delivers.
     Raising the crit % barely moved it -- it multiplies too small a base --
     so the fix was repricing it a tier down, not a bigger number. (The
     specific win rates once quoted here came from the old drafter-biased
     harness; the conclusion survived remeasurement, the numbers did not.) */
  S('frenzy','Frenzy',2,'self',10.0,1,0,{col:'#ff9c6b',fx:'crit',u:0.3863,fxDur:8,txt:'Greatly increases critical strike chance.'}),

  /* ── Tier 4 ─────────────────────────────────────────── */
  S('meteorfall','Meteor Fall',4,'rain',7.0,2,0.7004,{col:'#ff6a3d',area:170,fx:'burn',fxDur:4,txt:'Two catastrophic impacts.'}),
  S('abyssalgaze','Abyssal Gaze',4,'beam',8.0,10,0.7659,{col:'#d68cff',dur:1.4,txt:'A long channel that mounts in intensity.'}),
  S('bloodpact','Blood Pact',4,'self',12.0,1,0,{col:'#ff5d7a',fx:'pact',u:0.7631,fxDur:10,txt:'Spend health for a large damage bonus.'}),
  S('frostcathedral','Frost Cathedral',4,'field',9.0,10,0.6521,{col:'#9be4ff',area:200,dur:6,fx:'chill',fxDur:2,txt:'A cathedral of ice that slows and shears.'}),
  S('ragingtempest','Raging Tempest',4,'nova',7.5,3,0.6975,{col:'#8fe0d0',reach:300,txt:'Three expanding shockwaves in sequence.'}),
  S('executioner','Executioner\'s Mark',4,'proj',5.0,1,0.6272,{col:'#ffb03d',spd:620,fx:'exec',txt:'Deals sharply more damage to wounded targets.'}),
  S('mirrorguard','Mirror Guard',4,'self',14.0,1,0,{col:'#cfe8ff',fx:'reflect',u:0.3235,fxDur:8,txt:'Reflects a large share of damage taken.'}),

  /* ── Tier 5 ─────────────────────────────────────────── */
  S('singularity','Singularity',5,'field',11.0,12,0.9834,{col:'#b07bff',area:210,dur:5,fx:'pull',txt:'A collapsing point of gravity. Inescapable.'}),
  S('celestial','Celestial Judgment',5,'rain',10.0,8,0.7582,{col:'#fff0b0',area:230,txt:'Eight pillars of judgment fall from above.'}),
  S('dragonbreath','Dragon\'s Breath',5,'cone',9.0,6,0.6897,{col:'#ff7a2d',spread:0.62,reach:330,fx:'burn',fxDur:5,txt:'A torrent of dragonfire in a wide cone.'}),
  S('eternityedge','Eternity Edge',5,'dash',10.0,8,0.5344,{col:'#e8d0ff',txt:'Eight cuts delivered between heartbeats.'}),

  /* ── Crowd control ───────────────────────────────────────────
     CC is priced as a rider, not as damage: each of these carries a
     reduced `role` and buys the lockout with the difference. The
     coefficients below are SOLVED by the same paired-A/B coordinate
     descent as the original 40 — see the note above the catalog.
     Durations are hand-set (they are a feel decision, not a power
     one) and then the damage share is fitted around them.

     Every one of these is subject to CC_DR: repeat applications on the
     same target decay hard. Without it, two Rime Prisons at LV3 chain
     into a permanent lock, which the harness found immediately —
     an unbounded CC build won 96% before diminishing returns existed. */
  S('thunderclap','Thunder Clap',1,'nova',6.0,1,1.8940,
    {col:'#ffd76b',reach:250,fx:'stun',fxDur:0.7,
     txt:'A concussive crack that briefly stuns.'}),
  S('grasproots','Grasping Roots',2,'field',6.5,3,1.4005,
    {col:'#9ad06b',area:150,dur:3,fx:'root',fxDur:1.6,
     txt:'Roots pin the enemy in place — they can still cast.'}),
  S('silencesigil','Silence Sigil',2,'proj',7.0,1,1.0974,
    {col:'#c4a8ff',spd:520,fx:'silence',fxDur:2.0,
     txt:'Seals their skills. Basic attacks still land.'}),
  S('rimeprison','Rime Prison',3,'proj',8.0,1,0.9104,
    {col:'#a8f0ff',spd:480,fx:'freeze',fxDur:1.5,
     txt:'Encases the target — no movement, no casting.'}),
  S('gluttonshex','Glutton\'s Hex',4,'proj',9.0,1,0.5739,
    {col:'#c07bff',spd:500,fx:'silence',fxDur:3.0,
     txt:'A long silence that also feeds on what it stops.'}),
  S('oblivionchain','Oblivion Chain',5,'field',10.0,6,0.9827,
    {col:'#9d7bff',area:190,dur:5,fx:'stun',fxDur:0.9,
     txt:'Chains of nothing. Repeatedly locks them in place.'}),

  /* ── Sustain, immunity, summons ───────────────────────────────
     Seeded by interpolation from the nearest solved peer (noted per line).
     STATUS: seeded and spot-checked against tier peers, NOT yet put through
     the full joint fit the original 40 received. Treat these coefficients as
     provisional. Re-solve with:
       node _balance/solve.js <id>      per skill
       node _balance/tierfit.js <tier>  joint fit, needed because
                                        re-pricing several skills moves the
                                        peer pool every OTHER skill in that
                                        tier is measured against.

     Two of these archetypes are not scalar and so are fitted differently:
     `immune` stores a WINDOW (u is seconds, capped by IMMUNE_MAX) and a
     summon's `u` sets both pet damage and pet health, so one coefficient
     moves the whole archetype. */

  /* Lifesteal. Anchored on Siphon Orb (t2 proj, cd 3.8, role 0.8669,
     u 0.35 vamp) scaled to the t4 budget. Heals a large share of a big
     single hit, where Siphon Orb heals a small share often. */
  S('crimsonfeast','Crimson Feast',4,'proj',5.5,1,0.5800,
    {col:'#ff4d7a',spd:500,fx:'vamp',u:0.5000,est:true,
     txt:'A ravenous bolt. Returns half its damage as health.'}),
  /* Sustained lifesteal on a channel: the beam form spreads the same
     total heal across ticks, so it survives burst mitigation better.
     Anchored on Void Lance (t3 beam, cd 5.0, 6 hits, role 1.0110). */
  S('leechingcoil','Leeching Coil',3,'beam',5.5,5,0.6900,
    {col:'#e56bb0',dur:0.7,fx:'vamp',u:0.3000,est:true,
     txt:'A tether that drinks steadily while it holds.'}),

  /* Temporary invulnerability. `u` is SECONDS, not a magnitude — the
     archetype has no scalar to fit, so the fitted quantity is the window
     itself, lengthened by riderMul and hard-capped by IMMUNE_MAX.
     Anchored on Mirror Guard (t4 self, cd 14) as the nearest pure
     defensive with no healing component. */
  S('phaseveil','Phase Veil',4,'self',16.0,1,0,
    {col:'#d9f2ff',fx:'immune',u:1.5000,est:true,
     txt:'Slip briefly out of phase. Nothing at all can touch you.'}),
  /* Named 'Stillpoint', not 'Event Horizon' — that name is already taken by
     the void/void combo, and two unrelated things with one name is exactly
     the sort of collision the Codex would surface as a bug report. */
  S('stillpoint','Stillpoint',5,'self',18.0,1,0,
    {col:'#cfd8ff',fx:'immune',u:2.2000,est:true,
     txt:'Time bends around you. The blow simply never arrives.'}),

  /* Summons. A pet is a real combatant on your team — targetable and
     killable — so its whole budget lives in `u`, which sets BOTH its
     per-swing damage and (via PET_HP) its health. Estimated from
     uptime: a pet swings every BASIC_CD, so delivered dps ~= u/BASIC_CD
     for the fraction of the cooldown it is alive. */
  S('wraithcall','Wraith Call',3,'summon',7.0,1,0,
    {col:'#9ecfff',fx:'summon',u:26.0000,fxDur:8,count:1,petName:'Wraith',est:true,
     txt:'Binds a wraith to fight beside you for a time.'}),
  S('direwolves','Dire Wolves',5,'summon',9.0,1,0,
    {col:'#ffb98a',fx:'summon',u:23.0000,fxDur:9,count:2,petName:'Dire Wolf',est:true,
     txt:'Two wolves answer. They pick their own targets.'}),
  /* A summon that also blocks: high pet hp, low pet damage, so it reads as
     a wall rather than a damage pet. Same `u`, different split — the hp
     multiplier is what differentiates it. */
  S('bonebulwark','Bone Bulwark',4,'summon',8.0,1,0,
    {col:'#e8dcc0',fx:'summon',u:18.0000,fxDur:10,count:1,petName:'Bone Sentinel',
     petHpMul:2.1,est:true,
     txt:'Raises a sentinel that soaks blows meant for you.'}),

  /* ── New mechanics ────────────────────────────────────────────
     Seven skills that each add a NEW verb to the sim: shield-pierce,
     knockback, a repelling barrier, a position swap, an undying
     trigger, a timed reflect window, and a two-enemy link. Their
     role/u values are SEEDED from tier peers (est:true), not solved
     by the balance harness — the harness only knows the original 40.
     The handling for each lives in Sim.cast / Sim.rider / Sim.hit. */
  /* Shield-pierce: routes its hit through hit() with pierce:true, the
     same door bleed already uses, so wards soak nothing. */
  S('voidpierce','Void Piercer',3,'proj',4.5,1,0.9000,
    {col:'#c8a0ff',spd:560,pierce:true,est:true,
     txt:'A bolt that phases through wards — ignores shields entirely.'}),
  /* Knockback: a nova whose rider shoves every caught enemy outward.
     Damage is real, the shove is the point. */
  S('cyclonepush','Cyclone Push',2,'nova',5.0,1,0.9000,
    {col:'#b8ffe0',reach:260,fx:'knock',u:170,fxDur:0.3,est:true,
     txt:'A burst of wind that hurls nearby enemies away.'}),
  /* Barrier: a self ward that also raises a repulsion wall — enemies
     inside its radius are pushed back out for its duration. */
  S('bulwarkwall','Barrier Wall',3,'self',12.0,1,0,
    {col:'#bfe0ff',fx:'wall',u:300,fxDur:5,est:true,
     txt:'Raises a warded wall that repels enemies and shields you.'}),
  /* Swap: a bolt that trades the caster and the target's positions. */
  S('warpswap','Warp Swap',4,'proj',9.0,1,0.4000,
    {col:'#d68cff',spd:600,fx:'swap',est:true,
     txt:'Trades places with the target across the arena.'}),
  /* Undying: a long-recharge self buff that turns the next lethal blow
     into a partial heal instead of death. */
  S('undyingwill','Undying Will',5,'self',30.0,1,0,
    {col:'#ffce5a',fx:'undying',u:0.45,fxDur:999,est:true,
     txt:'The next lethal blow leaves you at 45% health. Long recharge.'}),
  /* Reflect window: a timed variant of Mirror Guard, one tier cheaper. */
  S('retribution','Retribution',3,'self',11.0,1,0,
    {col:'#cfe8ff',fx:'reflect',u:0.3000,fxDur:6,est:true,
     txt:'For a time, returns a share of all damage taken to attackers.'}),
  /* Link: binds the struck enemy to its nearest ally. While the link
     holds, damage or CC on one is echoed onto the other. */
  S('soulbind','Soul Bind',4,'proj',8.0,1,0.4000,
    {col:'#ff7ad9',spd:520,fx:'link',u:0.75,fxDur:6,est:true,
     txt:'Binds two enemies: harm or control one, and the other suffers too.'}),
];
/* ═══════════════════════════════════════════════════════════════
   TAG FAMILIES — the substrate the Codex combo system reads.
   Tags are declared OUT here rather than inline in the catalog so the
   40 solved coefficient lines above stay untouched and diff-clean.
   A skill may belong to several families; Sun Flare is both holy and
   fire, so it can complete either combo but never counts twice for one.
   ═══════════════════════════════════════════════════════════════ */
const TAGS = {
  arcbolt:['arcane'],          emberdart:['fire'],
  frostneedle:['frost'],       stonechip:['earth'],
  windslash:['wind','blade'],  sparkring:['storm'],
  mendwound:['life'],          wardplate:['guard'],
  quickstep:['swift'],
  lightlance:['holy'],         cinderrain:['fire'],
  glaciallance:['frost'],      rustbolt:['earth'],
  bladedance:['blade'],        venomcoil:['blight'],
  siphonorb:['blood','life'],  stoneskin:['earth','guard'],
  battlehymn:['holy'],         thornmail:['guard'],
  frenzy:['blood'],
  voidlance:['void'],          chainlightning:['storm'],
  stormcall:['storm'],         shadowstep:['shadow','blade'],
  gravitywell:['void'],        plaguewell:['blight'],
  sunflare:['holy','fire'],    arcanetwins:['arcane'],
  bulwark:['guard'],
  meteorfall:['fire','earth'], abyssalgaze:['void','shadow'],
  bloodpact:['blood'],         frostcathedral:['frost'],
  ragingtempest:['wind','storm'], executioner:['blade'],
  mirrorguard:['guard','arcane'],
  singularity:['void'],        celestial:['holy'],
  dragonbreath:['fire'],       eternityedge:['blade','shadow'],
  /* crowd-control skills, defined further down */
  gluttonshex:['control','shadow'], rimeprison:['control','frost'],
  silencesigil:['control','arcane'], thunderclap:['control','storm'],
  grasproots:['control','earth'],   oblivionchain:['control','void'],
  /* sustain / immunity / summons. Two new families, `bind` and `veil`,
     because slotting summons into `blood` or immunity into `guard` would
     silently change which combos every EXISTING skill in those families
     can form — the tag set is load-bearing, not decorative. */
  crimsonfeast:['blood','life'],   leechingcoil:['blood','shadow'],
  phaseveil:['veil','arcane'],     stillpoint:['veil','void'],
  wraithcall:['bind','shadow'],    direwolves:['bind','wind'],
  bonebulwark:['bind','guard'],
  /* new-mechanic skills */
  voidpierce:['void','arcane'],    cyclonepush:['wind','storm'],
  bulwarkwall:['guard','earth'],   warpswap:['void','arcane'],
  undyingwill:['holy','life'],     retribution:['guard','arcane'],
  soulbind:['blood','void'],
};
const FAMILY = {
  fire:  {name:'Fire',    col:'#ff7a3d', lore:'Heat that does not ask permission.'},
  frost: {name:'Frost',   col:'#8fd8ff', lore:'Cold enough to slow a heartbeat.'},
  storm: {name:'Storm',   col:'#8ce0ff', lore:'Charge looking for a path to ground.'},
  arcane:{name:'Arcane',  col:'#7fe9ff', lore:'Raw mana, shaped by will alone.'},
  void:  {name:'Void',    col:'#b07bff', lore:'Absence with an appetite.'},
  blade: {name:'Blade',   col:'#dfe9ff', lore:'The oldest answer to any question.'},
  blood: {name:'Blood',   col:'#ff5d7a', lore:'Power billed to your own body.'},
  guard: {name:'Guard',   col:'#bfe0ff', lore:'The art of still being here.'},
  holy:  {name:'Holy',    col:'#fff0b0', lore:'Light that judges before it warms.'},
  shadow:{name:'Shadow',  col:'#b58cff', lore:'Everything the light refuses.'},
  blight:{name:'Blight',  col:'#9dff6b', lore:'Patience, weaponised.'},
  earth: {name:'Earth',   col:'#c9b48a', lore:'Weight, and the promise of it.'},
  wind:  {name:'Wind',    col:'#b8ffe0', lore:'Motion borrowed, never owned.'},
  life:  {name:'Life',    col:'#8dffa8', lore:'The wound closing faster than it opens.'},
  swift: {name:'Swift',   col:'#d0ffe8', lore:'Time, on favourable terms.'},
  control:{name:'Control',col:'#ffb347', lore:'A fight you are the only one fighting.'},
  veil:  {name:'Veil',    col:'#d9f2ff', lore:'For a moment, not strictly present.'},
  bind:  {name:'Bind',    col:'#c0a6ff', lore:'Something else does the dying.'},
};
/* ── COMBO BONUSES ──────────────────────────────────────────────
   Every bonus is a PERCENTAGE MULTIPLIER on something the build
   already does, never flat damage. That matters for balance: a
   multiplier scales with what you drafted, so a combo cannot make a
   weak build strong on its own, and it does not need its own solved
   coefficient the way a damage skill does.

   Magnitudes are deliberately small (5–18% for pairs). Two same-family
   skills is a cheap thing to stumble into; three is a real draft
   commitment and pays roughly double. They are also symmetric — both
   fighters can build them, and the A/B harness drafts the same filler
   on both sides, so combos largely cancel in the balance fit rather
   than invalidating it.
   `vfx` is the visual power multiplier: combo-active skills render
   bigger, which is the readable feedback that the combo is live.    */
const COMBOS = [
  /* ── two of a family ── */
  {id:'rime2',   fam:['frost','frost'],   name:'Rime Accord',
   fx:{critDmg:0.10, chillPow:0.25}, vfx:1.25,
   txt:'+10% critical damage · chill bites 25% deeper'},
  {id:'pyre2',   fam:['fire','fire'],     name:'Kindled Pyre',
   fx:{burnPow:0.35, dmgAmp:0.06}, vfx:1.25,
   txt:'Burns tick 35% harder · +6% damage'},
  {id:'storm2',  fam:['storm','storm'],   name:'Static Cascade',
   fx:{critChance:0.08, cdr:0.06}, vfx:1.25,
   txt:'+8% crit chance · −6% cooldowns'},
  {id:'arc2',    fam:['arcane','arcane'], name:'Resonant Weave',
   fx:{cdr:0.10, dmgAmp:0.05}, vfx:1.25,
   txt:'−10% cooldowns · +5% damage'},
  {id:'void2',   fam:['void','void'],     name:'Event Horizon',
   fx:{dmgAmp:0.12, shredPow:0.30}, vfx:1.3,
   txt:'+12% damage · shred strips 30% more'},
  {id:'blade2',  fam:['blade','blade'],   name:'Twin Fangs',
   fx:{critChance:0.10, critDmg:0.08}, vfx:1.25,
   txt:'+10% crit chance · +8% critical damage'},
  {id:'blood2',  fam:['blood','blood'],   name:'Crimson Tithe',
   fx:{vampFlat:0.10, dmgAmp:0.08}, vfx:1.25,
   txt:'10% lifesteal on everything · +8% damage'},
  {id:'guard2',  fam:['guard','guard'],   name:'Sworn Wall',
   fx:{drFlat:0.08, sustain:0.15}, vfx:1.2,
   txt:'−8% damage taken · +15% heals and shields'},
  {id:'holy2',   fam:['holy','holy'],     name:'Choir of Two',
   fx:{dmgAmp:0.08, sustain:0.12}, vfx:1.25,
   txt:'+8% damage · +12% heals and shields'},
  {id:'shade2',  fam:['shadow','shadow'], name:'Umbral Pact',
   fx:{critDmg:0.14, execPow:0.20}, vfx:1.25,
   txt:'+14% critical damage · executes bite 20% harder'},
  {id:'blight2', fam:['blight','blight'], name:'Contagion',
   fx:{bleedPow:0.40, bleedCap:1}, vfx:1.25,
   txt:'Poison ticks 40% harder · one extra bleed stack'},
  {id:'earth2',  fam:['earth','earth'],   name:'Bedrock',
   fx:{drFlat:0.06, shredPow:0.30}, vfx:1.2,
   txt:'−6% damage taken · shred strips 30% more'},
  {id:'ctrl2',   fam:['control','control'],name:'Iron Grip',
   fx:{ccPow:0.25, dmgAmp:0.06}, vfx:1.3,
   txt:'Crowd control lasts 25% longer · +6% damage'},
  {id:'veil2',   fam:['veil','veil'],     name:'Twice Absent',
   fx:{immunePow:0.25, cdr:0.08}, vfx:1.3,
   txt:'Invulnerability lasts 25% longer · −8% cooldowns'},
  {id:'bind2',   fam:['bind','bind'],     name:'Full Kennel',
   fx:{petPow:0.30, dmgAmp:0.05}, vfx:1.3,
   txt:'Summons are 30% stronger · +5% damage'},

  /* ── named cross-family pairs: the reward for reading the Codex ── */
  {id:'thermal', fam:['frost','fire'],    name:'Thermal Shock',
   fx:{critDmg:0.18, shredPow:0.25}, vfx:1.35,
   txt:'+18% critical damage · shred strips 25% more'},
  {id:'stormforge',fam:['storm','earth'], name:'Storm Forge',
   fx:{critChance:0.09, shredPow:0.35}, vfx:1.3,
   txt:'+9% crit chance · shred strips 35% more'},
  {id:'bloodblade',fam:['blood','blade'], name:'Bloodletting',
   fx:{vampFlat:0.12, critDmg:0.12}, vfx:1.3,
   txt:'12% lifesteal · +12% critical damage'},
  {id:'voidshade',fam:['void','shadow'],  name:'Starless',
   fx:{dmgAmp:0.10, ccPow:0.20}, vfx:1.35,
   txt:'+10% damage · crowd control lasts 20% longer'},
  {id:'holyfire',fam:['holy','fire'],     name:'Pyre of Judgment',
   fx:{burnPow:0.45, critDmg:0.10}, vfx:1.3,
   txt:'Burns tick 45% harder · +10% critical damage'},
  {id:'frostctrl',fam:['frost','control'],name:'Absolute Zero',
   fx:{ccPow:0.30, chillPow:0.35}, vfx:1.4,
   txt:'Crowd control lasts 30% longer · chill bites 35% deeper'},
  {id:'windblade',fam:['wind','blade'],   name:'Cutting Gale',
   fx:{cdr:0.09, critChance:0.07}, vfx:1.25,
   txt:'−9% cooldowns · +7% crit chance'},
  {id:'lifeguard',fam:['life','guard'],   name:'Undying Vigil',
   fx:{sustain:0.25, drFlat:0.05}, vfx:1.25,
   txt:'+25% heals and shields · −5% damage taken'},
  {id:'swiftstorm',fam:['swift','storm'], name:'Chain Reaction',
   fx:{cdr:0.13, critChance:0.06}, vfx:1.3,
   txt:'−13% cooldowns · +6% crit chance'},
  {id:'blightblood',fam:['blight','blood'],name:'Sanguine Rot',
   fx:{bleedPow:0.45, vampFlat:0.08}, vfx:1.3,
   txt:'Poison ticks 45% harder · 8% lifesteal'},
  {id:'veilguard',fam:['veil','guard'],   name:'Nothing Lands',
   fx:{immunePow:0.35, drFlat:0.06}, vfx:1.3,
   txt:'Invulnerability lasts 35% longer · −6% damage taken'},
  {id:'veilswift',fam:['veil','swift'],   name:'Out of Phase',
   fx:{immunePow:0.20, cdr:0.12}, vfx:1.3,
   txt:'Invulnerability lasts 20% longer · −12% cooldowns'},
  {id:'bindblood',fam:['bind','blood'],   name:'Shared Hunger',
   fx:{petPow:0.25, vampFlat:0.10}, vfx:1.3,
   txt:'Summons are 25% stronger · 10% lifesteal'},
  {id:'bindholy',fam:['bind','holy'],     name:'Called Host',
   fx:{petPow:0.35, sustain:0.15}, vfx:1.35,
   txt:'Summons are 35% stronger · +15% heals and shields'},

  /* ── three of a family: the deep-commitment payoffs ── */
  {id:'rime3',   fam:['frost','frost','frost'], name:'Absolute Winter',
   fx:{critDmg:0.22, chillPow:0.55, ccPow:0.25}, vfx:1.6,
   txt:'+22% critical damage · chill 55% deeper · CC 25% longer'},
  {id:'pyre3',   fam:['fire','fire','fire'],    name:'Firestorm',
   fx:{burnPow:0.80, dmgAmp:0.14}, vfx:1.6,
   txt:'Burns tick 80% harder · +14% damage'},
  {id:'storm3',  fam:['storm','storm','storm'], name:'Tempest Crown',
   fx:{critChance:0.16, cdr:0.13, critDmg:0.10}, vfx:1.6,
   txt:'+16% crit chance · −13% cooldowns · +10% crit damage'},
  {id:'void3',   fam:['void','void','void'],    name:'Singular Truth',
   fx:{dmgAmp:0.24, shredPow:0.60, ccPow:0.20}, vfx:1.7,
   txt:'+24% damage · shred 60% more · CC 20% longer'},
  {id:'blade3',  fam:['blade','blade','blade'], name:'Thousand Cuts',
   fx:{critChance:0.18, critDmg:0.20}, vfx:1.6,
   txt:'+18% crit chance · +20% critical damage'},
  {id:'guard3',  fam:['guard','guard','guard'], name:'Unbroken Line',
   fx:{drFlat:0.14, sustain:0.35}, vfx:1.5,
   txt:'−14% damage taken · +35% heals and shields'},
  {id:'holy3',   fam:['holy','holy','holy'],    name:'Full Choir',
   fx:{dmgAmp:0.16, sustain:0.28, critDmg:0.10}, vfx:1.6,
   txt:'+16% damage · +28% sustain · +10% critical damage'},
  {id:'blood3',  fam:['blood','blood','blood'], name:'Exsanguination',
   fx:{vampFlat:0.18, dmgAmp:0.18}, vfx:1.6,
   txt:'18% lifesteal on everything · +18% damage'},
  {id:'ctrl3',   fam:['control','control','control'], name:'Absolute Authority',
   fx:{ccPow:0.50, dmgAmp:0.12, critDmg:0.10}, vfx:1.7,
   txt:'CC lasts 50% longer · +12% damage · +10% critical damage'},
  {id:'bind3',   fam:['bind','bind','bind'], name:'The Whole Menagerie',
   fx:{petPow:0.70, dmgAmp:0.10, sustain:0.15}, vfx:1.7,
   txt:'Summons are 70% stronger · +10% damage · +15% sustain'},
];

/* Which combos a loadout satisfies. Greedy and non-reusing: a skill
   spent on one combo cannot also anchor another, so stacking six
   overlapping bonuses off two multi-tag skills is impossible.
   Sorted longest-first so a 3-family combo wins the skills over the
   2-family version of the same family it contains. */
function activeCombos(build){
  const items = build.map(b => ({id:b.id, tags:TAGS[b.id]||[]}));
  const out = [], used = new Set();
  const ordered = [...COMBOS].sort((a,b)=>b.fam.length-a.fam.length);
  for(const c of ordered){
    const claim = [];
    let ok = true;
    for(const need of c.fam){
      const hit = items.find(it =>
        !used.has(it.id) && !claim.includes(it.id) && it.tags.includes(need));
      if(!hit){ ok = false; break; }
      claim.push(hit.id);
    }
    if(ok){
      out.push({...c, members:claim});
      for(const id of claim) used.add(id);
    }
  }
  return out;
}
/* Fold every active combo into one bonus object the sim reads. */
function comboBonus(build){
  const b = {critDmg:0, critChance:0, dmgAmp:0, cdr:0, drFlat:0, sustain:0,
             vampFlat:0, burnPow:0, bleedPow:0, chillPow:0, shredPow:0,
             execPow:0, ccPow:0, bleedCap:0, immunePow:0, petPow:0};
  const list = activeCombos(build);
  for(const c of list) for(const k in c.fx) b[k] = (b[k]||0) + c.fx[k];
  b.list = list;
  /* per-skill visual multiplier: the biggest combo a skill anchors */
  b.vfxOf = {};
  for(const c of list)
    for(const id of c.members) b.vfxOf[id] = Math.max(b.vfxOf[id]||1, c.vfx);
  return b;
}

const BY_ID = Object.fromEntries(SKILLS.map(s=>[s.id,s]));

/* human-readable line for a card at a given level */
function skillLine(sk, lvl){
  const d = dmgOf(sk,lvl), u = utilOf(sk,lvl);
  const bits = [];
  if(d) bits.push(sk.hits>1 ? `${d}×${sk.hits} dmg` : `${d} dmg`);
  if(sk.fx==='heal')   bits.push(`heal ${Math.round(u)}`);
  if(sk.fx==='shield') bits.push(`shield ${Math.round(u)}`);
  if(sk.fx==='haste')  bits.push(`−${Math.round(u*100)}% cooldowns`);
  /* Three of these can request more than the damage pipeline allows (see
     the cap-overflow note). Showing the raw request would lie to the
     player -- Frenzy LV3 asks for +114% crit and can only ever apply
     +60% -- so the card states the value that actually lands, and says
     when the cap is what is limiting it. */
  if(sk.fx==='dr')     bits.push(`−${Math.round(Math.min(u,0.55)*100)}% damage taken`
                                 + (u>0.55?' (capped)':''));
  if(sk.fx==='dmgAmp') bits.push(`+${Math.round(Math.min(u,1.2)*100)}% damage`
                                 + (u>1.2?' (capped)':''));
  if(sk.fx==='thorns') bits.push(`${Math.round(u*100)}% thorns`);
  if(sk.fx==='crit')   bits.push(`+${Math.round(Math.min(u,0.60)*100)}% crit`
                                 + (u>0.60?' (capped)':''));
  if(sk.fx==='pact')   bits.push(`+${Math.round(Math.min(u,1.2)*100)}% dmg, −12% hp`
                                 + (u>1.2?' (capped)':''));
  if(sk.fx==='reflect')bits.push(`${Math.round(u*100)}% reflect${sk.fxDur?` for ${sk.fxDur}s`:''}`);
  if(sk.fx==='vamp')   bits.push(`${Math.round(u*100)}% lifesteal`);
  /* New utility riders — shown so their cards aren't blank of effect text. */
  if(sk.fx==='knock')  bits.push(`knockback ${Math.round(u)}${sk.fxDur?` · ${sk.fxDur}s stagger`:''}`);
  if(sk.fx==='wall')   bits.push(`ward wall ${sk.fxDur}s · shield ${Math.round(u)}`);
  if(sk.fx==='swap')   bits.push(`swap places`);
  if(sk.fx==='undying')bits.push(`survive at ${Math.round(u*100)}% hp`);
  if(sk.fx==='link')   bits.push(`bind foes ${sk.fxDur}s · ${Math.round(u*100)}% echo`);
  /* chill/shred scale on RIDER_MUL, not utilOf — and were previously
     invisible on the card, so their upgrades looked like pure damage */
  if(sk.fx==='chill')  bits.push(`−${Math.round(CHILL_CD*riderMul(sk,lvl)*100)}% enemy speed`);
  if(sk.fx==='shred')  bits.push(`+${Math.round(SHRED_AMP*riderMul(sk,lvl)*100)}% damage taken`);
  if(sk.fx==='burn')   bits.push(`burn ${Math.round(dmgOf(sk,lvl)*BURN_COEF)}/s for ${sk.fxDur}s`);
  if(sk.fx==='bleed')  bits.push(`bleed ${Math.round(dmgOf(sk,lvl)*BLEED_COEF)}/s for ${sk.fxDur}s`);
  /* CC duration scales on the rider curve like chill/shred, so an
     upgrade lengthens the lockout instead of only adding damage */
  if(isCC(sk.fx))      bits.push(`${sk.fx} ${(sk.fxDur*riderMul(sk,lvl)).toFixed(1)}s`);
  bits.push(`${sk.cd}s cd`);
  return bits.join(' · ');
}
function effDps(sk, lvl){
  return +(dmgOf(sk,lvl)*sk.hits/sk.cd).toFixed(1);
}
