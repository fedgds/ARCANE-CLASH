/* ═══════════════════════════════════════════════════════════════
   SIM ENGINE — seeded gameplay RNG, Fighter, and Sim.

   The combat core: pure logic that never touches the DOM or a
   canvas, which is what lets the Balance Lab run it headless. It
   emits events, and battle-render.js decides what they look like.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ═══════════════════════════════════════════════════════════════
   SEEDED GAMEPLAY RNG

   Two random streams, deliberately separate:

   · `RNG` below drives everything that changes an OUTCOME — shop rolls,
     tier rolls, pool draws, crit rolls, PvE offers, monster kits, the AI's
     tie-break jitter. It is a seedable xorshift, so a seed reproduces a
     run exactly.
   · Plain `Math.random()` / `rnd()` stay on every COSMETIC draw (particles,
     sparks, screen-shake, mob name flavour). Those must NOT come from this
     stream: `World.headless` suppresses particle spawns, so routing them
     through RNG would make a skipped battle consume a different number of
     draws than a watched one and silently diverge from it.

   Keeping the split is what makes `skipBattle()` provably identical to
   watching the fight, and what makes a daily seed mean the same thing on
   every machine.
   ═══════════════════════════════════════════════════════════════ */
const RNG = {
  s: 1,
  /* xorshift32. Any seed works except 0, which is a fixed point. */
  seed(n){
    n = (n >>> 0) || 0x9e3779b9;
    this.s = n === 0 ? 0x9e3779b9 : n;
    /* burn a few draws: low-entropy seeds (a date hash) otherwise produce a
       visibly correlated first value across consecutive days */
    for(let i=0;i<8;i++) this.next();
    return this;
  },
  /* reseed from wall-clock entropy — used for ordinary, unseeded play so
     nothing about normal games becomes repeatable by accident */
  scramble(){ return this.seed((Date.now() ^ (Math.random()*0xffffffff)) >>> 0); },
  next(){
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x;
  },
  /* 0 <= f() < 1 */
  f(){ return this.next() / 4294967296; },
  /* same signature as the shared `rnd(hi, lo)` helper so call sites read
     the same after conversion */
  r(hi, lo){ lo = lo || 0; return lo + this.f()*(hi-lo); },
  int(n){ return (this.f()*n) | 0; },
  pick(a){ return a[(this.f()*a.length)|0]; },
};
/* Ordinary play must stay unpredictable; a seed is opted into, never the
   default. Daily.begin() overwrites this. */
RNG.scramble();

/* Stable 32-bit hash of a string — turns '2026-08-11' into a seed. */
function hashStr(str){
  let h = 0x811c9dc5;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ═══════════════════════════════════════════════════════════════
   SIMULATION — pure logic, no drawing. Runs headless in the Lab.
   ═══════════════════════════════════════════════════════════════ */

/* shortest reach among a build's damaging skills → how close it wants to be */
function idealRange(build){
  let wsum = 0, rsum = 0;
  for(const b of build){
    const sk = BY_ID[b.id];
    if(!sk.role) continue;
    const w = dmgOf(sk,b.lvl)*sk.hits/sk.cd;          // weight by dps share
    let want = 300;
    if(sk.kind==='cone' || sk.kind==='nova') want = (sk.reach||220)*0.55;
    else if(sk.kind==='orbit') want = 140;
    else if(sk.kind==='dash')  want = 200;
    wsum += w; rsum += want*w;
  }
  return wsum ? clamp(rsum/wsum, 110, 320) : 300;
}

/* ---------------------------------------------------------------
   BUILD IDENTITY — a champion should look like what they drafted.
   The dominant skill (by share of the build's dps, or by tier for a
   pure-utility kit) gives an accent colour and an epithet, so two
   fights with the same names still read as different fighters.      */
const EPITHET = {
  burn:'the Ember', bleed:'the Plaguebearer', chill:'the Rimebound',
  shred:'the Render', heal:'the Unfaltering', shield:'the Bulwark',
  haste:'the Swift', dr:'the Stonebound', dmgAmp:'the Zealot',
  thorns:'the Bramble', crit:'the Frenzied', pact:'the Blood-Sworn',
  reflect:'the Mirror', vamp:'the Siphon', exec:'the Headsman', pull:'the Devourer',
  immune:'the Untouched', summon:'the Summoner',
};
const KIND_EPITHET = {
  proj:'the Marksman', multiproj:'the Scattershot', beam:'the Lancer',
  nova:'the Detonator', cone:'the Stormfront', rain:'the Skyfallen',
  dash:'the Duellist', orbit:'the Encircled', field:'the Warden', self:'the Ascetic',
  summon:'the Shepherd',
};
function identity(build){
  let best = null, bestW = -1;
  for(const b of build){
    const sk = BY_ID[b.id];
    /* weight damage kits by dps; a utility skill still counts, at its tier */
    const w = sk.role ? dmgOf(sk,b.lvl)*sk.hits/sk.cd : DPS_BUDGET[sk.tier]*0.55*LVL_MUL[b.lvl];
    if(w > bestW){ bestW = w; best = sk; }
  }
  if(!best) return {accent:null, title:'the Unarmed'};
  return {
    accent: best.col,
    title: (best.fx && EPITHET[best.fx]) || KIND_EPITHET[best.kind] || 'the Nameless',
  };
}

/* ═════════════════════════════════════════════════════════════
   CHAMPIONS — the body you wear and the one button you press.

   A champion is deliberately NOT a skill. Drafted skills fire themselves
   on cooldown, which is the premise of the game: you build the machine,
   then you watch it run. The ultimate is the single place that premise is
   suspended, so it is kept structurally separate from `build` — no tier,
   no gold cost, it never enters the pool, it cannot be fused.

   One charge per match, and that is load-bearing. A cooldown would turn
   every ultimate into "hold it for the next window"; a single charge makes
   the press itself the decision, which is what all three are about.

   `art` is read by drawFighter, `col` tints the body, the rest is combat
   data. Shapes follow the reference sheet: hex / star / rings. */
const CHAMPIONS = [
  { id:'reversal', name:'REVERSAL', art:'hex', col:'#2e2a6e', acc:'#ffce5a',
    tag:'Defensive counter',
    kicker:'Reads danger.',
    desc:'Opens a 1.8s window. Damage taken is stored instead of spent. When it '
       + 'closes, half returns to you as healing and half detonates outward as a nova.',
    note:'Worth exactly as much as the blow it eats — a shield absorbs a fixed '
       + 'number, this grows with the hit. Mistime it and it is wasted.',
    dur:1.8 },
  { id:'totalforce', name:'TOTAL FORCE', art:'star', col:'#ffce5a', acc:'#ff9f6a',
    tag:'Burst tempo',
    kicker:'Reads opportunity.',
    desc:'Every drafted skill comes off cooldown at once, and for 2.5s you cast '
       + 'at triple speed.',
    note:'Your build is the ammunition; this is only the trigger. Refresh four '
       + 'skills now, or wait three seconds for six?',
    dur:2.5, castMul:3 },
  { id:'suppress', name:'SUPPRESSION', art:'rings', col:'#4ec3f5', acc:'#9fe6ff',
    tag:'Control · theft',
    kicker:'Reads the opponent.',
    desc:'A 1.2s parry. Any attack that arrives is taken — ownership, team and '
       + 'heading all flip, and it flies back at whoever threw it.',
    note:'Not a reflect: the attack becomes yours, and so does the damage on '
       + 'the end-of-match chart.',
    dur:1.2 },
];
const CHAMP_BY_ID = {};
for(const c of CHAMPIONS) CHAMP_BY_ID[c.id] = c;
/* Unknown or missing id must still produce a playable fighter — a save
   written before champions existed, and every monster, has none. */
function champOf(id){ return CHAMP_BY_ID[id] || null; }

class Fighter {
  constructor(side, build, name, opt={}){
    this.side = side; this.name = name;
    /* stable per-instance tag. The PvE roster rebuilds its rows only when
       the set of combatants changes, and identity has to survive a monster
       dying (it stays listed, struck through) — so an index won't do. */
    this.uidTag = 'f' + (++Fighter._n);
    /* `side` used to be three things at once: team id, index into sim.f,
       and colour/spawn selector. PvE needs 1 player vs N monsters, so
       team is now its own field. Duels pass nothing and get team===side,
       which is exactly the old behaviour. */
    this.team = opt.team !== undefined ? opt.team : side;
    this.build = build;                    // [{id, lvl}]
    const id = identity(build);
    this.accent = opt.accent || id.accent || (this.team ? '#ff5d7a' : '#5fd0ff');
    this.title = opt.title !== undefined ? opt.title : id.title;
    this.hp = this.max = opt.hp || HP_BASE;
    this.shield = 0;
    this.x = opt.x !== undefined ? opt.x : (this.team===0 ? 250 : ARENA_W-250);
    this.y = opt.y !== undefined ? opt.y : ARENA_H/2;
    this.vx = 0; this.vy = 0;
    this.facing = this.team===0 ? 1 : -1;
    this.basicCd = BASIC_CD;
    /* Stagger the openers so a build doesn't dump its whole kit on frame one.
       SEEDED, not cosmetic: this sets the firing order for the entire match,
       so an unseeded draw here made a given day's seed play a different fight
       every time. */
    this.cds = build.map(b => BY_ID[b.id].cd * RNG.r(0.55,0.15));
    /* Positioning is derived from the kit: a build full of cones and novas
       has to close, a projectile build is happy to kite. Without this,
       short-range skills whiff all fight and test as underpowered. */
    this.range = idealRange(build);
    /* PvE monsters scale damage and size without touching solved
       coefficients: dmgMul multiplies outgoing, R scales the drawn body. */
    this.dmgMul = opt.dmgMul || 1;
    this.R = opt.R || 34;
    this.boss = !!opt.boss;
    this.minion = !!opt.minion;
    /* vertical bob phase. Keyed off side for duels (unchanged) but
       overridable, so a spawned pack drifts out of phase instead of
       sliding around as one rigid block. */
    this.sway = opt.sway !== undefined ? opt.sway : side*2.2;
    this.st = {};                          // status: name -> {t, v}
    /* active Codex combos, folded into one bonus object read by the
       damage pipeline. Computed once at construction: the loadout
       cannot change mid-fight, so recomputing per hit would be waste. */
    this.combo = comboBonus(build);
    /* CC diminishing-returns ledger: kind -> {n, t}. n counts recent
       applications, t counts down the memory window. */
    this.ccDR = {};
    this.dealt = 0; this.healed = 0;
    /* Per-skill contribution ledger, keyed by skill id (plus the two
       synthetic sources '_basic' and '_thorns' that have no draft slot).
       This is the same damage the pipeline already computes — it is only
       being credited to a source as well as a total, so the result screen
       can tell the player WHICH of their picks carried the fight. */
    this.stats = {};
    this.flash = 0; this.hitLag = 0; this.scaleP = 0;
    this.dead = false;
    /* ---- champion ----
       `champ` is the catalogue entry, or null: monsters and familiars have
       none. `ultLeft` is charges, not a cooldown (see CHAMPIONS). `ultT`
       counts the open window down; `ultStore` is Reversal's bank, held in
       already-mitigated damage. */
    this.champ = opt.champ ? champOf(opt.champ) : null;
    this.ultLeft = this.champ ? 1 : 0;
    this.ultT = 0;
    this.ultStore = 0;
    this.ultHits = 0;      // hits the window has eaten, for the VFX and the log
    this.ultFlash = 0;     // renderer pulse, decays in step()
    /* Who actually fed the bank. The nova is a counterattack, so it has to
       reach them wherever they were standing when they threw it. */
    this.ultSrc = new Set();
  }
  /* Is this champion's window open? Checked by name rather than a shared
     flag so two different windows can never be mistaken for each other. */
  /* One assignment path for every caller (duel, hotseat, PvE, the AI).
     Resets the whole ult block, so a rematch cannot inherit a spent charge
     or a half-open window from the fight before it. */
  setChamp(id){
    this.champ = champOf(id);
    this.ultLeft = this.champ ? 1 : 0;
    this.ultT = 0; this.ultStore = 0; this.ultHits = 0; this.ultFlash = 0;
    this.ultSrc.clear();
    return this.champ;
  }
  ultActive(id){ return !!this.champ && this.champ.id === id && this.ultT > 0; }
  get ultReady(){ return !!this.champ && this.ultLeft > 0 && !this.dead; }
  has(k){ return this.st[k] && this.st[k].t > 0; }
  val(k){ return this.has(k) ? this.st[k].v : 0; }
  /* Credit one skill with one contribution. `key` is a skill id, or a
     synthetic source for output that no drafted slot owns. A minion's
     work is credited to its summoner's summon skill via creditTo, set
     when the pet is spawned — otherwise a summon build would read as
     six dead slots and one enormous basic attack. */
  credit(key, field, amt){
    if(!key || !(amt > 0)) return;
    const r = this.stats[key] || (this.stats[key] = {dmg:0, heal:0, shield:0, casts:0});
    r[field] += amt;
  }
  bumpCast(key){
    if(!key) return;
    const r = this.stats[key] || (this.stats[key] = {dmg:0, heal:0, shield:0, casts:0});
    r.casts++;
  }
  /* --- action gates. Every one is checked in Sim.step. --- */
  get stunned(){ return this.has('stun') || this.has('freeze'); }
  get canCast(){ return !this.has('stun') && !this.has('freeze') && !this.has('silence'); }
  get canBasic(){ return !this.has('stun'); }
  get canMove(){ return !this.has('stun') && !this.has('freeze') && !this.has('root'); }
  /* any CC currently on this fighter, for the HUD and the renderer */
  get ccActive(){
    for(const k of CC_KINDS) if(this.has(k)) return k;
    return null;
  }
  /* `src` is who applied it. Only the damaging DoTs need it, but storing it
     on every status keeps one shape. In a duel the applier was inferable
     from the side index; with a pack of monsters it is not, and crediting
     the wrong one would hand a monster someone else's damage total. */
  add(k, v, dur, capBonus, src, srcKey){
    const cur = this.st[k];
    /* bleed stacks, but only to a cap — uncapped stacking made every
       DoT skill a runaway winner in the lab. The Contagion combo buys
       exactly one extra stack, which is why capBonus exists. */
    if(k==='bleed' && cur && cur.t>0){
      const cap = BLEED_MAX + (capBonus||0);
      const st = Math.min((cur.stacks||1)+1, cap);
      this.st[k] = {t:dur, v:Math.min(cur.v+v, v*cap), stacks:st, src:src||cur.src,
        srcKey:srcKey||cur.srcKey};
    } else {
      this.st[k] = {t:dur, v, stacks:1, src, srcKey};
    }
  }
  /* Apply a CC status through diminishing returns. Returns the seconds
     that actually landed (0 if fully resisted), so the caller can tell
     the player it was resisted rather than silently dropping it. */
  applyCC(kind, dur){
    const rec = this.ccDR[kind] || (this.ccDR[kind] = {n:0, t:0});
    const scale = CC_DR[Math.min(rec.n, CC_DR.length-1)];
    rec.n++; rec.t = CC_MEMORY;
    const eff = dur * scale;
    if(eff <= 0.01) return 0;
    /* CC does not stack — the longer remaining duration wins */
    const cur = this.st[kind];
    if(cur && cur.t > eff) return 0;
    this.st[kind] = {t:eff, v:1, stacks:1, max:eff};
    return eff;
  }
  /* cooldowns tick at dt*cdScale, so >1 is FASTER. Haste must add.
     Combo CDR is a straight multiplier on top, applied last. */
  get cdScale(){
    const base = Math.max(0.25, 1 + this.val('haste') - this.val('chill'));
    /* Total Force multiplies the finished figure rather than adding a haste
       term, so it is worth exactly 3x whatever chill and haste are doing at
       the time. Applied outside the 0.25 floor deliberately: that floor
       exists to stop chill stacking into a lock, not to cap a burst the
       player spent their one charge on. */
    const ult = this.ultActive('totalforce') ? (this.champ.castMul || 3) : 1;
    return base * (1 + (this.combo ? this.combo.cdr : 0)) * ult;
  }
}
Fighter._n = 0;

/* Sudden death bills every survivor a flat share of their OWN max hp on a
   fixed heartbeat: SD_FRAC of max, every SD_PERIOD seconds. Ten tithes
   empty a full pool, so the clock is identical for a 300 hp trash mob and
   a 4000 hp boss — which is the whole point of a stalemate breaker. */
const SD_PERIOD = 5, SD_FRAC = 0.10;

class Sim {
  /* Duel:  new Sim(buildA, buildB, world)
     PvE:   new Sim({fighters:[...Fighter], pve:true}, null, world)
     The two-build form is kept because the balance harness, the Lab and
     the draft all call it that way; teams are what the sim reasons about
     internally, and a duel is just teams 0 and 1 with one member each. */
  constructor(b1, b2, world){
    if(b1 && b1.fighters){
      this.f = b1.fighters;
      this.pve = true;
    } else {
      /* names come from the title screen (persisted); fall back if absent */
      const nm = (typeof Save!=='undefined' && Save.data.names) || ['AZURE WARDEN','CRIMSON TYRANT'];
      this.f = [new Fighter(0,b1,nm[0]||'AZURE WARDEN'), new Fighter(1,b2,nm[1]||'CRIMSON TYRANT')];
      this.pve = false;
    }
    this.t = 0; this.over = null; this.world = world || null;  // world = renderer hooks
    this.sdPhase = 0;         // 0 none, 1 sudden death open
    this.sudden = 0;          // sudden-death intensity 0..1
    this.sdTicks = 0;         // tithes already charged (see suddenDeath)
    this.acts = [];        // in-flight abilities (projectiles, beams, fields…)
    this.uid = 0;
    this.spawnQ = [];      // summons waiting to enter (see addFighter)
  }
  emit(type, data){ if(this.world) this.world.on(type, data); }

  /* ---- attribution ----
     Resolve "who really did this, and with what" for the ledger. A
     familiar has no draft slot of its own, so everything it does is
     folded back into the summon that called it; `creditTo` is stamped
     on the pet at spawn. Returns null when nobody should be credited
     (an orphaned DoT whose applier is already dead). */
  credit(src, key, field, amt){
    if(!src || !(amt > 0)) return;
    if(src.minion && src.owner){ key = src.creditTo || key; src = src.owner; }
    src.credit(key, field, amt);
  }
  /* the ledger key for a skill object: real skills carry an id, the
     basic attack and thorns return do not */
  keyOf(sk){ return sk ? (sk.id || (sk.basicKey || null)) : null; }

  /* ---- team queries: the only places that know how sides map to teams ----
     Every former `this.f[1-f.side]` goes through one of these. Returning
     null from foeOf is meaningful — it means a team has been wiped, which
     is how PvE stages end. */
  living(team){ return this.f.filter(x => !x.dead && x.team === team); }
  /* Win conditions count CHAMPIONS, not bodies. A surviving pet must not
     keep a fight alive after its summoner has fallen — that would let a
     summon build win posthumously, which reads as a bug however you
     rationalise it. Monsters are champions; familiars are not. */
  champions(team){ return this.f.filter(x => !x.dead && x.team === team && !x.minion); }
  enemiesOf(f){ return this.f.filter(x => !x.dead && x.team !== f.team); }
  /* nearest living enemy; ties broken by array order so it stays
     deterministic for the headless harness */
  foeOf(f){
    let best = null, bd = Infinity;
    for(const x of this.f){
      if(x.dead || x.team === f.team) continue;
      const d = dist(f, x);
      if(d < bd){ bd = d; best = x; }
    }
    return best;
  }
  /* add a combatant mid-fight (summons). Returns the fighter so the
     caller can position it. */
  addFighter(fr){ this.f.push(fr); this.emit('spawn',{f:fr}); return fr; }

  /* ---- damage pipeline: every hit in the game funnels here ---- */
  hit(src, tgt, raw, opt={}){
    if(tgt.dead || raw<=0) return 0;
    /* Invulnerability is absolute and sits ahead of everything: no crit
       roll, no shield spend, no thorns return. A percentage would just be
       damage reduction under another name; the point of the archetype is
       a window where a burst window simply does not land. */
    if(tgt.has('immune')){
      this.emit('immune',{tgt, x:opt.x??tgt.x, y:opt.y??tgt.y});
      return 0;
    }
    const cb = src.combo, tb = tgt.combo;
    let d = raw * (src.dmgMul || 1);
    /* combo dmgAmp rides inside the same cap as Battle Hymn and Blood
       Pact, so a combo cannot be used to punch through that ceiling */
    d *= 1 + Math.min(1.2, src.val('dmgAmp') + src.val('pact') + cb.dmgAmp);
    d *= 1 + tgt.val('shred');
    /* a frozen target is a bigger target — this is what makes freeze
       worth a slot over silence, which locks more but adds nothing */
    if(tgt.has('freeze')) d *= 1 + FREEZE_AMP;
    if(opt.exec){
      const missing = 1 - tgt.hp/tgt.max;
      d *= 1 + missing*EXEC_SCALE*(1 + cb.execPow);
    }
    /* crit — combo adds chance under the same hard cap, and damage
       above the 1.9x base so crit-combo builds feel different */
    const chance = Math.min(0.75, 0.15 + src.val('crit') + cb.critChance);
    const crit = !opt.noCrit && RNG.f() < chance;
    if(crit) d *= 1.9 * (1 + cb.critDmg);
    /* mitigation — combo DR shares the 55% floor with Stone Skin */
    d *= 1 - Math.min(0.55, tgt.val('dr') + tgt.val('reflect')*0.4 + tb.drFlat);
    d = Math.max(1, Math.round(d));

    /* ---- Reversal: bank the hit instead of paying it ----
       Sits AFTER mitigation and the crit roll but BEFORE shields, so what
       is stored is the damage that would really have reached hp. That is
       the identity of the skill: a shield absorbs a fixed number, this is
       worth exactly as much as the blow it ate, so a crit Meteor Fall into
       an open window is the best thing that can happen to you. Shields
       underneath are left untouched and are still there afterwards.

       Returns 0 early: no shield spend, no thorns return, no lifesteal for
       the attacker, no hp change. Nothing landed, so nothing is credited. */
    if(tgt.ultActive('reversal')){
      tgt.ultStore += d;
      tgt.ultHits++;
      if(src && src !== tgt) tgt.ultSrc.add(src);
      tgt.flash = 1;
      this.emit('ultAbsorb', {f:tgt, src, amt:d, x:opt.x??tgt.x, y:opt.y??tgt.y, col:opt.col});
      return 0;
    }

    /* shields soak first (bleed pierces) */
    if(tgt.shield > 0 && !opt.pierce){
      const soak = Math.min(tgt.shield, d);
      tgt.shield -= soak; d -= soak;
      if(soak>0) this.emit('shieldHit',{t:tgt, amt:soak});
    }
    tgt.hp = Math.max(0, tgt.hp - d);
    src.dealt += d;
    /* opt.key names the skill that landed this hit; the act carries it
       down from cast(). Basic attacks pass '_basic'. */
    this.credit(src, opt.key, 'dmg', d);

    /* riders */
    /* Crimson Tithe / Bloodletting grant lifesteal on EVERY hit, not
       just Siphon Orb's. Applied before thorns so a reflected kill
       still credits the heal that the killing blow earned. */
    if(cb.vampFlat > 0 && !opt.noVamp){
      const h = Math.min(d*cb.vampFlat*this.sustainMul, src.max - src.hp);
      if(h > 0.5){
        src.hp += h; src.healed += h;
        /* combo lifesteal belongs to the hit that earned it, not to a
           skill the player never picked */
        this.credit(src, opt.key, 'heal', h);
        this.emit('heal',{f:src, amt:h});
      }
    }
    /* thorns + reflect don't stack multiplicatively into a death spiral;
       one combined return capped at 60% of the hit */
    const back = Math.min(0.6, tgt.val('thorns') + tgt.val('reflect'));
    if(back > 0) this.raw(tgt, src, d*back, '_thorns');

    /* Soul Bind echo: a linked partner takes a fraction of the same hit.
       Routed through raw() (unmitigated, no further riders) so it cannot
       re-trigger the link and spiral. */
    if(tgt.link && tgt.link.t>0 && tgt.link.partner && !tgt.link.partner.dead && !opt.echo){
      this.raw(src, tgt.link.partner, d*tgt.link.frac, opt.key);
    }

    tgt.flash = 1; tgt.hitLag = crit ? 0.18 : 0.06;
    this.emit('hit', {src, tgt, dmg:d, crit, col:opt.col||'#fff', x:opt.x??tgt.x, y:opt.y??tgt.y, kind:opt.kind});
    if(crit) this.emit('crit', {src, tgt, dmg:d, x:opt.x??tgt.x, y:opt.y??tgt.y});
    if(tgt.hp<=0 && !this.saveUndying(tgt)) this.kill(tgt);
    return d;
  }
  /* Undying Will: intercept a lethal blow once. Returns true if the
     fighter was pulled back from 0 hp, consuming the buff. */
  saveUndying(f){
    if(f.dead || f.hp>0 || !f.has('undying')) return false;
    /* No PvE monster gets a second life. mobBuild already keeps the skill
       out of their pool, but the rule belongs on the death path too: any
       future aura, inherited kit or copied loadout that hands an enemy the
       buff must not quietly reintroduce it. Team 0 is the player's, so this
       covers bosses, trash and their familiars alike. The status is dropped
       rather than left armed, so the HUD never shows a save that cannot
       fire. */
    if(this.pve && f.team !== 0){ delete f.st.undying; return false; }
    const frac = f.st.undying.v || 0.45;
    f.hp = Math.max(1, Math.round(f.max * frac));
    delete f.st.undying;
    f.add('immune', 1, 0.6);   // a brief grace window so the same volley can't re-kill
    this.emit('immuneOn',{f, sk:{col:'#ffce5a',name:'Undying Will'}, dur:0.6});
    this.emit('heal',{f, amt:f.hp});
    return true;
  }
  /* ---- champion ultimate: the one manual input in the whole game ----
     Returns true only if it actually fired, so the UI can refuse a click
     (and skip the sound) rather than silently eating it. Every gate lives
     here rather than in the button handler, because the AI calls this too
     and both paths must obey the same rules.

     Silence stops it. Stun and freeze do not: the two defensive ultimates
     exist precisely to answer a burst window, and a burst window that opens
     with a stun would make them unusable exactly when they matter. Silence
     is the one CC whose stated identity is "no abilities", so it keeps it. */
  fireUlt(f){
    if(!f || f.dead || !f.champ || f.ultLeft <= 0) return false;
    if(this.over !== null) return false;
    if(f.has('silence')) return false;
    if(f.ultT > 0) return false;                 // already running
    f.ultLeft--;
    f.scaleP = 1;
    f.ultFlash = 1;
    const c = f.champ;
    this.emit('ultCast', {f, champ:c});

    switch(c.id){
      /* Reversal and Suppression are both windows: arm the timer and let
         hit() and stepAct() do the work while it is open. */
      case 'reversal':
        f.ultT = c.dur; f.ultStore = 0; f.ultHits = 0;
        f.ultSrc.clear();
        break;
      case 'suppress':
        f.ultT = c.dur; f.ultHits = 0;
        break;
      /* Total Force resolves instantly; only the cast-speed buff has a
         duration, and cdScale reads that straight off ultT. */
      case 'totalforce': {
        f.ultT = c.dur;
        let n = 0;
        for(let i=0;i<f.cds.length;i++){ if(f.cds[i] > 0) n++; f.cds[i] = 0; }
        /* the basic attack rides the same clock; leaving it out made the
           opening of the burst feel oddly gappy */
        f.basicCd = 0;
        this.emit('ultForce', {f, refreshed:n});
        break;
      }
    }
    return true;
  }

  /* ── AI ultimate ──
     Only fighters flagged `autoUlt` are driven from here, so a human's
     charge is never spent for them. One charge and no cooldown means the
     interesting failure mode is hoarding: an AI that waits for a perfect
     read never presses at all, so each heuristic has a floor that makes it
     fire on a merely GOOD read, and a deadline that makes it fire on any
     read at all once the fight is nearly over.

     Deliberately unaware of the enemy's champion. Reading the opponent's
     pick and countering it would be strictly stronger than anything a
     player can do — they cannot see the AI's intent either. */
  ultAI(f, dt){
    if(!f.autoUlt || !f.ultReady || f.ultT > 0) return;
    if(f.has('silence')) return;
    f.ultWait = (f.ultWait || 0) + dt;
    /* never in the first breath: an ult fired at t=0.2s reads as a scripted
       opener rather than as a decision */
    if(this.t < 2) return;
    const foes = this.enemiesOf(f);
    if(!foes.length) return;
    const c = f.champ.id;

    /* the deadline. Sudden death means the fight is ending one way or
       another, and an unspent charge is worth nothing at all. */
    const desperate = this.sdPhase > 0 || f.hp < f.max*0.22;

    if(c === 'reversal'){
      /* Bank what is already in the air. Only acts that will ARRIVE inside
         the window count — a rain volley two seconds out is not this
         window's problem. */
      let inbound = 0;
      for(const a of this.acts){
        if(a.foe !== f || a.f.team === f.team) continue;
        if(a.k === 'proj'){
          const eta = Math.hypot(f.x-a.x, f.y-a.y) / Math.max(1, a.spd);
          if(eta < f.champ.dur*0.8) inbound += a.dmg;
        } else if(a.k === 'nova' || a.k === 'rain' || a.k === 'beam' || a.k === 'cone'){
          inbound += a.dmg * (a.left || 1);
        }
      }
      /* DoTs already burning are guaranteed income for the window */
      for(const k of ['burn','bleed']){
        const s = f.st[k];
        if(s && s.t > 0) inbound += s.v * Math.min(s.t, f.champ.dur);
      }
      if(inbound > f.max*0.09 || (desperate && this.t > 8)) this.fireUlt(f);
      return;
    }

    if(c === 'suppress'){
      /* the window is short, so it only opens for something actually
         arriving — and only for something worth taking */
      for(const a of this.acts){
        if(a.k !== 'proj' || a.basic || a.stolen) continue;
        if(a.foe !== f || a.f.team === f.team) continue;
        const eta = Math.hypot(f.x-a.x, f.y-a.y) / Math.max(1, a.spd);
        if(eta < f.champ.dur*0.7 && a.dmg > f.max*0.025){ this.fireUlt(f); return; }
      }
      if(desperate && this.t > 12) this.fireUlt(f);
      return;
    }

    if(c === 'totalforce'){
      /* value is measured in cooldown actually erased, not in slots: three
         skills a half-second from ready is a worse press than two that just
         fired, and counting slots cannot tell those apart */
      let owed = 0, worst = 0;
      for(let i=0;i<f.build.length;i++){
        const cd = f.cds[i];
        if(cd > 0){ owed += cd; worst = Math.max(worst, cd); }
      }
      const total = f.build.reduce((s,b)=>s + BY_ID[b.id].cd, 0) || 1;
      if((owed > total*0.55 && worst > 2.5) || (desperate && owed > total*0.3)) this.fireUlt(f);
      return;
    }
  }

  /* Called when a champion window closes. Reversal is the only one with a
     payload; the others simply stop being open. */
  endUlt(f){
    const c = f.champ;
    f.ultT = 0;
    if(!c) return;
    if(c.id === 'reversal'){
      const stored = f.ultStore;
      const fed = [...f.ultSrc];
      f.ultStore = 0;
      f.ultSrc.clear();
      if(stored <= 0){ this.emit('ultFizzle', {f, champ:c}); return; }
      /* Half back as healing, half outward as a nova. The split is what
         stops it being strictly better than a shield in every matchup: a
         whiffed window heals nothing AND detonates nothing.

         The heal obeys sustainMul like every other heal, so sudden death
         degrades it. The nova deliberately does not decay — the damage half
         is a counterattack, not sustain, and letting the arena defuse it
         would remove the comeback the skill exists for. */
      const heal = Math.min(stored * 0.5 * this.sustainMul, f.max - f.hp);
      if(heal > 0.5){
        f.hp += heal; f.healed += heal;
        f.credit('_ult', 'heal', heal);
        this.emit('heal', {f, amt:heal});
      }
      const blast = stored * 0.5;
      const hurt = [];
      if(blast >= 1){
        /* Routed through raw(), not hit(): the payload was already mitigated
           on the way in, so running it through the pipeline again would tax
           the same damage twice. It also must not crit — it is a return,
           not a strike. */
        /* Anyone who fed the bank is hit wherever they stand. A ranged
           attacker walking away untouched from the damage it dealt you is
           the one outcome this skill must never produce, and duellists open
           at 500 apart, so a pure radius check whiffed every time.

           The radius only adds bystanders on top of that. It stays finite
           because each enemy in range takes the FULL blast rather than a
           share of it, so removing the bound would quietly make a packed
           PvE stage the ultimate's best matchup. */
        const NOVA_R = 420;
        for(const tg of this.enemiesOf(f)){
          if(!fed.includes(tg) && dist(f, tg) > NOVA_R) continue;
          this.raw(f, tg, blast, '_ult');
          hurt.push(tg);
        }
      }
      this.emit('ultNova', {f, stored, heal, blast, hit:hurt.length, fed:fed.length, champ:c});
    }
  }

  /* unmitigated chip damage (thorns, reflect, dots). src may be null for
     an orphaned DoT whose applier is already dead.

     Invulnerability gates here too. `hit` already refuses immune targets,
     but burn, bleed, thorns and reflect all arrive through this path, so
     without the same check the "absolute" promise made above hit() was one
     the code did not keep.

     Note the interaction with the status loop that calls this: it decrements
     s.t BEFORE calling raw(), and unconditionally. So a DoT's timer keeps
     running while its damage is suppressed — an immunity window eats the
     DoT's remaining duration rather than deferring it, and a long enough
     window can absorb a short DoT outright. That falls out of the existing
     loop order rather than being arranged here. */
  raw(src, tgt, amt, key){
    if(tgt.dead) return;
    if(tgt.has('immune')){
      this.emit('immune',{tgt, x:tgt.x, y:tgt.y});
      return;
    }
    const d = Math.max(1, Math.round(amt));
    /* Reversal eats chip damage too. A burn ticking into an open window is
       small, but excluding it would mean a DoT-heavy opponent quietly
       ignored the ultimate, which reads as a bug rather than a rule.
       tithe() does not arrive here — see the comment there. */
    if(tgt.ultActive('reversal')){
      tgt.ultStore += d;
      if(src && src !== tgt) tgt.ultSrc.add(src);
      this.emit('ultAbsorb', {f:tgt, src, amt:d, x:tgt.x, y:tgt.y, col:null});
      return;
    }
    tgt.hp = Math.max(0, tgt.hp-d);
    if(src){ src.dealt += d; this.credit(src, key, 'dmg', d); }
    this.emit('tick',{tgt, dmg:d});
    if(tgt.hp<=0 && !this.saveUndying(tgt)) this.kill(tgt);
  }
  /* A death ends the battle only when it empties a team. In a duel that is
     the same thing as before (one member per team), but PvE stages have
     several monsters and must survive the first corpse. */
  kill(f){
    if(f.dead) return;
    f.dead = true;
    this.emit('death',{f});
    if(this.champions(f.team).length === 0 && this.over === null){
      /* winner = any team that still has a champion standing. With two
         teams this is 1-f.team; written as a search so a future 3-way
         works. Guarded on `over === null` so a mutual wipe in one tick
         resolves to the first team emptied rather than flipping to a draw. */
      const alive = this.f.find(x => !x.dead && !x.minion);
      this.over = alive ? alive.team : -1;
      /* pets outlive nothing: dismiss them so the victory tableau isn't
         cluttered with familiars milling around a corpse */
      for(const x of this.f) if(x.minion && !x.dead){ x.dead = true; this.emit('death',{f:x, quiet:true}); }
    }
  }

  /* ---- ability launch ---- */
  cast(f, idx){
    const b = f.build[idx], sk = BY_ID[b.id], lvl = b.lvl;
    /* every act stores this object reference, so acts already survive the
       target dying mid-flight; what they cannot survive is having no
       target at all, which happens on the frame a team is wiped. */
    const foe = this.foeOf(f);
    if(!foe){ f.cds[idx] = sk.cd; return; }
    const dmg = dmgOf(sk,lvl), u = utilOf(sk,lvl);
    f.cds[idx] = sk.cd;
    f.scaleP = 1;
    f.bumpCast(sk.id);
    this.emit('cast',{f, sk, lvl, idx});

    switch(sk.kind){
      case 'self': {
        const sm = this.sustainMul * (1 + f.combo.sustain);
        if(sk.fx==='heal'){
          const h=Math.min(u*sm, f.max-f.hp);
          f.hp+=h; f.healed+=h; f.credit(sk.id,'heal',h); this.emit('heal',{f,amt:h});
        }
        /* Shielding is credited in full at cast, not by how much was
           later spent. A ward that goes untouched still did its job by
           existing; measuring absorption instead would rank a defensive
           slot by how badly the fight went. */
        else if(sk.fx==='shield'){ f.shield += u*sm; f.credit(sk.id,'shield',u*sm); this.emit('buff',{f,sk}); }
        /* Barrier Wall: a shield PLUS a repulsion field (read in step()).
           The wall radius is stored on the status value so movement can
           read it; the ward is credited like any other shield. */
        else if(sk.fx==='wall'){
          f.shield += u*sm; f.credit(sk.id,'shield',u*sm);
          f.add('wall', 200, sk.fxDur);   // 200 = repulsion radius
          this.emit('buff',{f,sk});
        }
        /* Undying: arm a one-shot lethal-blow save. Stored magnitude is
           the fraction of max hp restored when it triggers (see hit/raw). */
        else if(sk.fx==='undying'){ f.add('undying', u, sk.fxDur); this.emit('buff',{f,sk}); }
        else if(sk.fx==='pact'){ f.hp=Math.max(1,f.hp-f.max*0.08); f.add('pact',u,sk.fxDur); this.emit('buff',{f,sk}); }
        /* Invulnerability stores no magnitude — the value IS the window.
           Duration rides riderMul so an upgrade lengthens it, and sustainMul
           shortens it in sudden death for the same reason healing falters:
           otherwise two immunity builds stall the arena's tithe forever. */
        else if(sk.fx==='immune'){
          const dur = Math.min(IMMUNE_MAX,
            u * riderMul(sk,lvl) * (1 + (f.combo.immunePow||0)) * this.sustainMul);
          f.add('immune', 1, dur);
          this.emit('immuneOn',{f, sk, dur});
        }
        else { f.add(sk.fx, u, sk.fxDur); this.emit('buff',{f,sk}); }
        break;
      }
      case 'proj':
        this.acts.push({k:'proj',id:++this.uid,f,foe,sk,lvl,dmg,x:f.x+f.facing*44,y:f.y-8,
          spd:sk.spd||500, life:3, trail:[]});
        break;
      case 'multiproj':
        for(let i=0;i<sk.hits;i++)
          this.acts.push({k:'proj',id:++this.uid,f,foe,sk,lvl,dmg,x:f.x+f.facing*44,y:f.y-8,
            spd:(sk.spd||500)*RNG.r(1.15,.85), life:3, delay:i*0.11, wob:(i-1)*38, trail:[]});
        break;
      case 'beam':
        this.acts.push({k:'beam',id:++this.uid,f,foe,sk,lvl,dmg,t:0,dur:sk.dur,
          next:0, per:sk.dur/sk.hits, left:sk.hits});
        break;
      case 'nova':
        for(let i=0;i<sk.hits;i++)
          this.acts.push({k:'nova',id:++this.uid,f,foe,sk,lvl,dmg,t:-i*0.28,r:0,hit:false});
        break;
      case 'cone':
        this.acts.push({k:'cone',id:++this.uid,f,foe,sk,lvl,dmg,t:0,dur:0.5,
          next:0, per:0.5/sk.hits, left:sk.hits});
        break;
      case 'rain':
        for(let i=0;i<sk.hits;i++){
          const a = RNG.r(TAU);
          /* scatter shrinks with hit count so a big barrage still connects */
          const rr = RNG.r(sk.area*0.30/Math.sqrt(sk.hits));
          this.acts.push({k:'rain',id:++this.uid,f,foe,sk,lvl,dmg,
            tx:foe.x+Math.cos(a)*rr+foe.vx*0.35, ty:foe.y+Math.sin(a)*rr+foe.vy*0.35,
            t:-i*0.18, fall:0.55, done:false});
        }
        break;
      case 'dash':
        this.acts.push({k:'dash',id:++this.uid,f,foe,sk,lvl,dmg,t:0,
          next:0, per:0.13, left:sk.hits});
        break;
      case 'field':
        this.acts.push({k:'field',id:++this.uid,f,foe,sk,lvl,dmg,t:0,dur:sk.dur,
          x:foe.x,y:foe.y, next:0, per:sk.dur/sk.hits, left:sk.hits});
        break;
      case 'orbit':
        this.acts.push({k:'orbit',id:++this.uid,f,foe,sk,lvl,dmg,t:0,dur:sk.dur,
          next:0, per:sk.dur/sk.hits, left:sk.hits, a:RNG.r(TAU)});
        break;
      /* ---- summon ----
         A pet is a real Fighter on the caster's team, not an act: it has
         to be targetable, killable, and it has to soak hits, which is
         most of what a summon is FOR. Its damage rides `u` (the solved
         utility magnitude) rather than `dmg`, because the summon skill
         itself never touches the enemy — everything it contributes is
         delegated to the pet, so all of its budget lives in `u`. */
      case 'summon': {
        /* Re-casting replaces the oldest pet rather than stacking a
           private army: without a cap, a 10-slot PvE loadout with two
           summon skills fills the arena and the framerate dies. */
        const mine = this.f.filter(x => x.owner === f && !x.dead);
        const cap = sk.count || 1;
        while(mine.length >= cap){ const old = mine.shift(); this.kill(old); }
        /* The bind combos scale the whole pet — damage and health together —
           because `u` is the archetype's single budget and splitting the
           bonus across two numbers would just be the same buff, quieter. */
        const pw = u * (1 + (f.combo.petPow || 0));
        for(let i=0;i<cap;i++){
          const pet = new Fighter(f.side, [], sk.petName || 'Familiar', {
            team: f.team,
            hp: Math.max(1, Math.round(pw * PET_HP * (sk.petHpMul || 1))),
            x: f.x + f.facing*RNG.r(70,20), y: clamp(f.y + RNG.r(60,-60), 130, ARENA_H-90),
            accent: sk.col, title:'', R: 20, minion: true,
            /* Seeded: sway is not just decoration — it drives f.vy in the
               movement step, so it moves the pet and changes what it's in
               range of. */
            sway: RNG.r(TAU),
          });
          pet.owner = f;
          pet.creditTo = sk.id;        // its output belongs to the summon slot
          pet.petDmg = pw;             // per basic attack
          pet.life = sk.fxDur || 8;    // pets are temporary
          pet.lifeMax = pet.life;      // the renderer fades a pet as it expires
          pet.range = 190;
          /* Which sprite drawPet uses. Keyed by the summon skill so every
             summon reads as its own creature, and so an unknown skill still
             lands on a valid sprite instead of a blank. */
          pet.petArt = sk.id;
          pet.petIdx = i;              // de-syncs the two wolves' gaits
          pet.scaleP = 1;              // spawn pop; step() decays it
          this.addFighter(pet);
        }
        this.emit('buff',{f, sk});
        break;
      }
    }
  }

  /* apply a skill's status rider on hit. `dealt` = damage actually landed,
     so lifesteal can heal from the very hit that triggered it. */
  rider(sk, lvl, src, tgt, dealt){
    if(!sk.fx) return;
    const u = utilOf(sk,lvl);
    const cb = src.combo;   // rider magnitudes scale with the caster's combos
    switch(sk.fx){
      /* Total DoT damage is unchanged by level scaling; the tick value
         and duration both come from the skill's own curve. An earlier
         attempt compressed duration at higher levels on the theory that
         short LV3 fights cut DoTs off -- measured false: a DoT's share of
         damage RISES with level (Ember Dart 1.6% -> 3.4%) and is only
         2-7% of output, far too small to explain a 40pt swing. The real
         cause was rider skills trading base damage for a rider, which is
         a slope problem, handled by `k`. */
      case 'burn':  tgt.add('burn',  dmgOf(sk,lvl)*BURN_COEF*(1+cb.burnPow),  sk.fxDur, 0, src, sk.id); break;
      case 'bleed': tgt.add('bleed', dmgOf(sk,lvl)*BLEED_COEF*(1+cb.bleedPow), sk.fxDur, cb.bleedCap, src, sk.id); break;
      /* magnitude, not a flag — so LV2/LV3 actually deepen the debuff.
         riderMul follows the skill's own steepness k, so a flattened
         upgrade flattens its debuff too rather than drifting apart. */
      case 'chill': tgt.add('chill', CHILL_CD  * riderMul(sk,lvl)*(1+cb.chillPow), sk.fxDur); break;
      case 'shred': tgt.add('shred', SHRED_AMP * riderMul(sk,lvl)*(1+cb.shredPow), sk.fxDur); break;
      case 'vamp': {
        const h = Math.min((dealt||0)*u*this.sustainMul*(1+cb.sustain), src.max - src.hp);
        if(h>0){
          src.hp += h; src.healed += h;
          this.credit(src, sk.id, 'heal', h);
          this.emit('heal',{f:src, amt:h});
        }
        break;
      }
      /* ── crowd control ──
         Duration rides the rider curve (so upgrades lengthen the lock)
         and the combo ccPow multiplier, then goes through diminishing
         returns. applyCC returns what actually landed so the log can
         say "resisted" instead of the effect vanishing silently. */
      case 'stun': case 'freeze': case 'silence': case 'root': {
        const want = sk.fxDur * riderMul(sk,lvl) * (1 + cb.ccPow);
        const got = tgt.applyCC(sk.fx, want);
        this.emit('cc', {src, tgt, kind:sk.fx, dur:got, want, sk});
        /* a linked partner shares the lockout at the link's fraction */
        if(tgt.link && tgt.link.t>0 && tgt.link.partner && !tgt.link.partner.dead){
          const p = tgt.link.partner;
          const shared = p.applyCC(sk.fx, want*tgt.link.frac);
          if(shared>0) this.emit('cc', {src, tgt:p, kind:sk.fx, dur:shared, want:want*tgt.link.frac, sk});
        }
        break;
      }
      /* Knockback: shove the target directly away from the caster. The
         nudge to vx keeps it sliding a moment after the teleport so the
         shove reads as momentum, not a snap. */
      case 'knock': {
        const dir = tgt.x >= src.x ? 1 : -1;
        tgt.x = clamp(tgt.x + dir*(sk.u||150), 120, ARENA_W-120);
        tgt.vx += dir*300;
        this.emit('burst',{x:tgt.x,y:tgt.y-8,col:sk.col,n:14,pow:1.4,el:elemOf(sk)});
        break;
      }
      /* Swap: trade the caster's and target's positions outright. */
      case 'swap': {
        const tx = tgt.x, ty = tgt.y;
        tgt.x = clamp(src.x, 120, ARENA_W-120); tgt.y = clamp(src.y, 130, ARENA_H-90);
        src.x = clamp(tx, 120, ARENA_W-120);    src.y = clamp(ty, 130, ARENA_H-90);
        this.emit('ghost',{x:tgt.x,y:tgt.y,col:sk.col,side:src.side,el:elemOf(sk)});
        this.emit('ghost',{x:src.x,y:src.y,col:sk.col,side:tgt.side,el:elemOf(sk)});
        break;
      }
      /* Link: bind the struck enemy to its nearest ally so harm on one
         echoes onto the other (echo itself lives in hit() and the CC
         case above). No-op with only one enemy, e.g. a duel. */
      case 'link': {
        const others = this.enemiesOf(src).filter(x => x !== tgt);
        if(others.length){
          let best = null, bd = Infinity;
          for(const o of others){ const dd = dist(tgt,o); if(dd<bd){ bd=dd; best=o; } }
          const dur = sk.fxDur * riderMul(sk,lvl);
          const frac = sk.u || 0.75;
          tgt.link  = {partner:best, t:dur, frac};
          best.link = {partner:tgt,  t:dur, frac};
          this.emit('cc', {src, tgt, kind:'link', dur, want:dur, sk});
        }
        break;
      }
    }
  }

  /* ---- sudden death ----------------------------------------------------
     Death was the ONLY exit condition, so two sustain builds could heal
     past each other forever: measured 40/40 battles still running after
     10 simulated minutes. The arena now bills everyone a tithe — once
     sudden death opens, every SD_PERIOD seconds each survivor loses
     SD_FRAC of their own max hp. Ten tithes empty a full pool, so a duel
     that reaches 30s is settled by roughly 75s and a stage by roughly
     100s even if nobody lands another blow.

     A tithe, not a verdict: the previous rule simply killed whoever held
     the smaller health bar at a hard cap, which ended fights the player
     was mid-comeback in and made the last ten seconds unwatchable. The
     drain is a percentage of each fighter's OWN max, so a boss with a 10x
     pool is on exactly the same clock as the player and neither side can
     wait the other out. Sustain decays alongside it (see sustainMul), or
     a heal build would just top the tithe back off. */
  suddenDeath(dt){
    /* PvE stages legitimately run longer than a duel — six monsters is
       simply more health to chew through — so the fuse is longer there.
       It still exists: a stalled stage must not hang the run forever. */
    const SD_START = this.pve ? 55 : 30,
          SD_FULL  = this.pve ? 85 : 55;
    if(this.t < SD_START){ this.sudden = 0; this.sdPhase = 0; this.sdTicks = 0; return; }
    this.sudden = Math.min(1, (this.t - SD_START) / (SD_FULL - SD_START));
    if(this.sdPhase === 0){ this.sdPhase = 1; this.sdTicks = 0; this.emit('sudden',{}); }

    /* One tithe the moment sudden death opens, then one every SD_PERIOD.
       Derived from elapsed time rather than an accumulator, so a coarse
       headless dt or a skip-to-end can never drop or double a tick. */
    const due = Math.floor((this.t - SD_START) / SD_PERIOD) + 1;
    while(this.sdTicks < due && this.over === null) this.tithe();
  }
  /* Charge every living fighter one sudden-death tithe.

     Deliberately NOT gated on `immune`, unlike every other damage path,
     and it ignores shields. This is the anti-stall mechanism; if either
     could hold it off, a build with enough uptime would turn "the arena is
     closing" into "the arena is closing for my opponent". Writes hp
     directly for the same reason — routing it through raw() would pick up
     the immunity gate. */
  tithe(){
    this.sdTicks++;
    const hurt = this.f.filter(f => !f.dead);
    /* emitted before the damage lands, so the renderer can read each
       fighter's pre-tithe hp and show what it actually took off */
    this.emit('suddenTick', {n:this.sdTicks, frac:SD_FRAC, fighters:hurt});
    /* Written straight to hp, which is what keeps it out of Reversal's
       absorption as well as out of immunity and shields. Not an oversight to
       tidy up later: if the tithe could be banked, the correct play would be
       to hold the window for the heartbeat every five seconds and convert
       the anti-stalemate mechanic into a heal plus a free nova. The arena
       closing is not an attack, so there is nothing there to reverse. */
    for(const f of hurt) f.hp = Math.max(0, f.hp - f.max * SD_FRAC);
    const doomed = hurt.filter(f => f.hp <= 0);
    if(!doomed.length) return;
    /* A tithe can empty both teams on the same tick — everyone drains at
       the same relative rate, so it is a real outcome rather than a
       curiosity. kill() would award the win to whichever team happened to
       be emptied second, which is array order deciding a coin flip, so a
       mutual wipe is called a draw instead. */
    const wipe = !this.f.some(x => !x.dead && !x.minion && !doomed.includes(x));
    for(const f of doomed) this.kill(f);
    if(wipe && this.over !== -1){ this.over = -1; this.emit('draw',{}); }
  }
  /* sustain loses potency as sudden death ramps, or healing just cancels it */
  get sustainMul(){ return 1 - 0.85*this.sudden; }

  /* ---- one fixed tick ---- */
  step(dt){
    if(this.over!==null) return;
    this.t += dt;
    this.suddenDeath(dt);

    for(const f of this.f){
      if(f.dead) continue;
      /* summons are on a timer, and they leave when their summoner dies */
      if(f.minion){
        f.life -= dt;
        if(f.life <= 0 || (f.owner && f.owner.dead)){
          f.dead = true; this.emit('unsummon',{f});
          continue;
        }
      }
      /* statuses. DoT damage is credited to whoever applied it (s.src);
         falling back to the victim would inflate its own `dealt`, so an
         orphaned DoT — applier already dead — credits nobody. */
      for(const k in f.st){
        const s = f.st[k]; if(s.t<=0) continue;
        s.t -= dt;
        if(k==='burn' || k==='bleed') this.raw(s.src || null, f, s.v*dt, s.srcKey);
      }
      /* CC diminishing-returns memory decays independently of the CC
         itself, so spacing applications out restores full duration */
      for(const k in f.ccDR){
        const r = f.ccDR[k];
        if(r.t > 0){ r.t -= dt; if(r.t <= 0) r.n = 0; }
      }
      f.flash = Math.max(0, f.flash - dt*4.5);
      f.hitLag = Math.max(0, f.hitLag - dt);
      f.scaleP = Math.max(0, f.scaleP - dt*3);
      f.ultFlash = Math.max(0, f.ultFlash - dt*2);
      /* champion window. endUlt runs exactly once, on the tick the timer
         crosses zero — Reversal's payout must not be able to fire twice, so
         ultT is zeroed inside endUlt rather than here. */
      if(f.ultT > 0){
        f.ultT -= dt;
        if(f.ultT <= 0) this.endUlt(f);
      }
      if(f.autoUlt) this.ultAI(f, dt);
      /* Soul Bind lives on .link (not .st), so tick it down here. When it
         lapses, clear both ends so a stale partner can't keep echoing. */
      if(f.link){
        f.link.t -= dt;
        if(f.link.t <= 0){
          if(f.link.partner && f.link.partner.link && f.link.partner.link.partner === f)
            f.link.partner.link = null;
          f.link = null;
        }
      }

      /* movement — drift toward ideal range, with orbiting sway.
         Rooted, stunned and frozen fighters do not move at all; the
         pull field still drags them, which is what makes root+pull a
         genuinely nasty pairing rather than two redundant slots. */
      const foe = this.foeOf(f);
      if(foe) f.facing = foe.x > f.x ? 1 : -1;
      if(f.canMove && foe){
        const want = f.range, d = Math.abs(foe.x - f.x);
        const push = clamp((d-want)/200, -1, 1);
        const spd = f.has('chill') ? 46 : 78;
        /* the sway phase keys off a per-fighter offset rather than the side
           index, so a pack of six monsters doesn't bob in lockstep */
        f.vx = lerp(f.vx, push*f.facing*spd, 0.05);
        f.vy = lerp(f.vy, Math.sin(this.t*0.9 + f.sway)*34, 0.05);
      } else {
        /* held in place: bleed off momentum rather than snapping */
        f.vx = lerp(f.vx, 0, 0.25); f.vy = lerp(f.vy, 0, 0.25);
      }
      if(f.has('pull')){
        const pf = f.st.pull;
        f.vx += (pf.px - f.x)*0.9*dt*10; f.vy += (pf.py - f.y)*0.9*dt*10;
      }
      /* Barrier Wall repulsion: any enemy that carries a wall shoves THIS
         fighter back if it strays inside the ward radius. Cheap O(n) scan —
         packs are small, and it only does work while a wall is live. */
      for(const w of this.f){
        if(w===f || w.dead || w.team===f.team || !w.has('wall')) continue;
        const rad = w.val('wall') || 200;
        const dx = f.x - w.x, dy = f.y - w.y;
        const dd = Math.hypot(dx, dy);
        if(dd > 0 && dd < rad){
          const force = (1 - dd/rad) * 520;
          f.vx += (dx/dd)*force*dt; f.vy += (dy/dd)*force*dt;
        }
      }
      f.x = clamp(f.x + f.vx*dt, 120, ARENA_W-120);
      f.y = clamp(f.y + f.vy*dt, 130, ARENA_H-90);

      /* basic attack — stun stops it, silence and root do not.
         A familiar's whole contribution is its basic, so it swings its own
         petDmg and in its summoner's colour. */
      f.basicCd -= dt * f.cdScale;
      if(f.basicCd<=0 && f.canBasic && foe){
        f.basicCd = BASIC_CD;
        /* A familiar's swings are credited to the summon skill for DAMAGE
           (see Sim.credit) but deliberately not for CASTS: the player cast
           the summon twice, they did not cast it thirty times. */
        if(!f.minion) f.bumpCast('_basic');
        const col = f.minion ? f.accent : '#ffffff';
        this.acts.push({k:'proj',id:++this.uid,f,foe,sk:{id:'_basic',col,name:'Strike',spd:640,kind:'proj'},
          lvl:1,dmg:f.minion?f.petDmg:BASIC_DMG,x:f.x+f.facing*40,y:f.y-8,spd:640,life:3,
          basic:true,noVamp:true,trail:[]});
        this.emit('cast',{f,sk:{name:'Strike',col},basic:true});
      }
      /* skills — cooldowns keep ticking under CC (so a silence delays
         the cast rather than deleting the skill's whole rotation), but
         nothing may actually fire while cast is gated. */
      for(let i=0;i<f.build.length;i++){
        f.cds[i] -= dt * f.cdScale;
        if(f.cds[i]<=0){
          if(f.canCast) this.cast(f,i);
          else f.cds[i] = 0;    // hold at ready, fire the moment CC ends
        }
      }
    }
    this.updateActs(dt);
  }

  /* ---- Suppression: take the attack off them ----
     Called from stepAct the moment a hostile act reaches a fighter whose
     parry window is open. Everything deciding "whose attack is this" lives
     on the act, so the theft rewrites those fields rather than spawning a
     replacement — a replacement would lose the projectile's element, level
     and rider, which is most of what makes stealing a Meteor Fall feel like
     anything.

     Four things flip:
       a.f        ownership. credit() reads this, so the stolen damage lands
                  in the parrier's ledger and the end-of-match chart does not
                  hand it to the thrower.
       a.foe      the new target: whoever threw it.
       heading    trail and velocity reverse, so it visibly turns around.
       a.stolen   marks it, so two Suppression champions cannot volley the
                  same projectile between them forever.

     `a.dmg` is deliberately unchanged. The attack is worth what its owner
     paid for it; scaling it here would be a second balance number to
     maintain for no gain. */
  stealAct(a, by){
    const from = a.f;
    a.f = by;
    a.foe = from;
    a.stolen = true;
    a.noVamp = true;              // their lifesteal rider must not heal you
    /* the ledger key follows ownership: the damage is now the parrier's,
       booked to the champion rather than to a skill they never drafted */
    a.stolenKey = '_ult';
    /* Reverse the flight so it reads as a rebound rather than a teleport.
       drawActs derives a projectile's heading from the last two trail
       samples, so mirroring the whole ribbon about the impact point turns
       the drawn body around as well as the motion. */
    if(a.trail && a.trail.length >= 2){
      const hx = a.x, hy = a.y;
      for(let i=0;i<a.trail.length;i+=2){
        a.trail[i]   = hx*2 - a.trail[i];
        a.trail[i+1] = hy*2 - a.trail[i+1];
      }
    }
    if(a.life !== undefined) a.life = Math.max(a.life, 2.2);   // room to fly back
    by.ultHits++;
    this.emit('ultSteal', {f:by, from, a, x:a.x, y:a.y});
    return true;
  }

  updateActs(dt){
    for(let i=this.acts.length-1;i>=0;i--){
      const a = this.acts[i];
      if(this.stepAct(a,dt) === false) this.acts.splice(i,1);
    }
  }

  stepAct(a, dt){
    if(a.f.dead && a.k!=='rain' && a.k!=='field') return false;
    /* In a duel a target could only die at the end of the fight, so acts
       never outlived their foe. A monster pack dies piecemeal, so an
       in-flight act must re-acquire or it chases a corpse. Ground effects
       (rain, field) keep their anchor point and simply miss if the new
       target isn't standing in them — that's correct, not a bug. */
    if(a.foe.dead){
      const nf = this.foeOf(a.f);
      if(!nf) return false;
      a.foe = nf;
    }
    const {f, foe, sk, lvl} = a;

    switch(a.k){
      case 'proj': {
        if(a.delay>0){ a.delay-=dt; return true; }
        a.life -= dt; if(a.life<=0) return false;
        const dx = foe.x-a.x, dy = (foe.y-8)-a.y, L = Math.hypot(dx,dy)||1;
        const wob = a.wob ? Math.sin(a.life*14)*a.wob*dt : 0;
        a.x += (dx/L)*a.spd*dt; a.y += (dy/L)*a.spd*dt + wob;
        a.trail.push(a.x,a.y); if(a.trail.length>26) a.trail.splice(0,2);
        if(Math.hypot(foe.x-a.x,(foe.y-8)-a.y) < 34){
          /* The parry runs before the hit resolves, so a stolen projectile
             never damages the parrier at all. Basics are excluded: letting a
             1.2s window steal a stray punch would waste the charge on noise. */
          if(foe.ultActive('suppress') && !a.stolen && !a.basic){
            this.stealAct(a, foe);
            return true;
          }
          const dl = this.hit(f,foe,a.dmg,{col:sk.col,x:a.x,y:a.y,kind:'impact',
            exec:sk.fx==='exec', pierce:sk.pierce, noVamp:a.noVamp,
            key:a.stolen ? a.stolenKey : sk.id});
          this.rider(sk,lvl,f,foe,dl);
          this.emit('burst',{x:a.x,y:a.y,col:sk.col,n:a.basic?9:22,pow:a.basic?1:1.7,el:elemOf(sk)});
          return false;
        }
        return true;
      }
      case 'beam': {
        a.t += dt; a.next -= dt;
        if(a.next<=0 && a.left>0){
          a.next = a.per; a.left--;
          const dl = this.hit(f,foe,a.dmg,{col:sk.col,kind:'beam',key:sk.id});
          this.rider(sk,lvl,f,foe,dl);
          this.emit('burst',{x:foe.x,y:foe.y-8,col:sk.col,n:14,pow:1.2,el:elemOf(sk)});
        }
        return a.t < a.dur;
      }
      case 'nova': {
        a.t += dt; if(a.t<0) return true;
        a.r = (a.t/0.45)*sk.reach;
        /* An expanding ring hits each enemy as the wavefront reaches it.
           a.struck remembers who has already been caught so the ring does
           not re-hit on every tick. Against one enemy this is exactly the
           old single `a.hit` flag, which is why the solved coefficients
           still hold — the balance harness never has a second target. */
        a.struck = a.struck || new Set();
        for(const tg of this.enemiesOf(f)){
          if(a.struck.has(tg)) continue;
          if(a.r >= dist(f,tg)-30){
            a.struck.add(tg);
            const dl = this.hit(f,tg,a.dmg,{col:sk.col,kind:'nova',key:sk.id});
            this.rider(sk,lvl,f,tg,dl);
            this.emit('burst',{x:tg.x,y:tg.y-8,col:sk.col,n:26,pow:2,el:elemOf(sk)});
          }
        }
        return a.t < 0.5;
      }
      case 'cone': {
        a.t += dt; a.next -= dt;
        if(a.next<=0 && a.left>0){
          a.next = a.per; a.left--;
          for(const tg of this.enemiesOf(f)){
            const dx = tg.x-f.x, dy = tg.y-f.y;
            const ang = Math.abs(Math.atan2(dy, dx*f.facing));
            if(Math.hypot(dx,dy) < sk.reach && ang < sk.spread){
              const dl = this.hit(f,tg,a.dmg,{col:sk.col,kind:'cone',key:sk.id});
              this.rider(sk,lvl,f,tg,dl);
              this.emit('burst',{x:tg.x,y:tg.y-8,col:sk.col,n:12,pow:1.3,el:elemOf(sk)});
            }
          }
        }
        return a.t < a.dur;
      }
      case 'rain': {
        a.t += dt; if(a.t<0) return true;
        if(!a.done && a.t >= a.fall){
          a.done = true;
          for(const tg of this.enemiesOf(f)){
            if(dist({x:a.tx,y:a.ty}, tg) < 108){
              const dl = this.hit(f,tg,a.dmg,{col:sk.col,x:a.tx,y:a.ty,kind:'rain',key:sk.id});
              this.rider(sk,lvl,f,tg,dl);
            }
          }
          this.emit('shock',{x:a.tx,y:a.ty,col:sk.col,r:96,el:elemOf(sk)});
          this.emit('burst',{x:a.tx,y:a.ty,col:sk.col,n:30,pow:2.2,el:elemOf(sk)});
        }
        return a.t < a.fall + 0.5;
      }
      case 'field': {
        a.t += dt; a.next -= dt;
        const inside = this.enemiesOf(f).filter(tg => dist(a, tg) < sk.area+40);
        if(sk.fx==='pull') for(const tg of inside) tg.st.pull = {t:0.1, v:1, px:a.x, py:a.y};
        if(a.next<=0 && a.left>0){
          a.next = a.per; a.left--;
          for(const tg of inside){
            const dl = this.hit(f,tg,a.dmg,{col:sk.col,x:tg.x,y:tg.y,kind:'field',noCrit:a.left%2===1,key:sk.id});
            this.rider(sk,lvl,f,tg,dl);
            this.emit('burst',{x:tg.x,y:tg.y-8,col:sk.col,n:10,pow:1.1,el:elemOf(sk)});
          }
        }
        return a.t < a.dur;
      }
      case 'orbit': {
        a.t += dt; a.a += dt*3.4; a.next -= dt;
        if(a.next<=0 && a.left>0){
          a.next = a.per; a.left--;
          if(dist(f,foe) < 340){
            this.hit(f,foe,a.dmg,{col:sk.col,kind:'orbit',key:sk.id});
            this.emit('burst',{x:foe.x,y:foe.y-8,col:sk.col,n:12,pow:1.2,el:elemOf(sk)});
          }
        }
        return a.t < a.dur;
      }
      case 'dash': {
        a.t += dt; a.next -= dt;
        if(a.next<=0 && a.left>0){
          a.next = a.per; a.left--;
          const side = a.left%2 ? 1 : -1;
          this.emit('ghost',{x:f.x,y:f.y,col:sk.col,side:f.side,el:elemOf(sk)});
          f.x = clamp(foe.x + side*62, 120, ARENA_W-120);
          f.y = clamp(foe.y + RNG.r(30,-30), 130, ARENA_H-90);
          const dl = this.hit(f,foe,a.dmg,{col:sk.col,kind:'slash',key:sk.id});
          this.rider(sk,lvl,f,foe,dl);
          this.emit('slash',{x:foe.x,y:foe.y-8,col:sk.col,ang:rnd(TAU),el:elemOf(sk)});
        }
        return a.left>0 || a.t < 0.4;
      }
    }
    return false;
  }
}
