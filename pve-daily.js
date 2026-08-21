/* ═══════════════════════════════════════════════════════════════
   MODES + SERVICES — everything around the duel proper.

   The delve (PvE) and its ascensions, the daily challenge, the
   discovery layer, build codes and ghost duels, the ascension
   screen, synthesized audio, persistence, and the post-battle
   result panels that read all of the above.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";
/* ═══════════════════════════════════════════════════════════════
   PvE RUN — 50 stages, a pack of monsters each, a boss every 10th.

   Two rules shape every number below.

   First: monsters are built from the SAME catalog the players draft
   from, so a monster's damage is the solved tier budget and nothing
   here re-prices a skill. Difficulty is expressed only as pack size,
   a health multiplier and `dmgMul` — three dials that sit strictly
   outside the fitted coefficients and therefore cannot corrupt them.

   Second: the curves are geometric, not linear. A linear ramp reads
   as "the same fight with bigger numbers"; the player's own power
   grows geometrically too (one skill becomes ten, and they level),
   so only a geometric threat curve keeps stage 50 feeling like a
   different game from stage 5.
   ═══════════════════════════════════════════════════════════════ */
/* PVE-BLOCK-START — everything between these markers is lifted verbatim by
   _balance/pvefit.js and run headless. Keep it free of DOM references so
   the tuner and the game can never disagree about the difficulty curve. */
const PVE_MAX_STAGE  = 100;
const PVE_MAX_SKILLS = 10;
const PVE_BOSS_EVERY = 10;

/* ---- ASCENSION ---------------------------------------------------------
   The delve's ratchet. Without this, `pveBest` is one integer and clearing
   stage 40 gives a player no reason to ever look at stages 1-20 again:
   the only way to progress is to go deeper, and the only way to go deeper
   is to be luckier. Ascension inverts that — you replay the SAME depths
   under modifiers you have earned the right to switch on.

   Every modifier is expressed strictly through the four dials that already
   sit outside the fitted coefficients (pack size, tier band, kit size,
   health/damage multipliers) plus the two structural cadences (boss
   frequency, between-stage healing). Nothing here re-prices a skill, so
   the swept numbers in MOB remain exactly as measured.

   `at` is the depth that unlocks the modifier — checked against pveBest,
   which is why restoring pveBest in Save.load() had to be fixed first.
   `w` is a rough difficulty weight, shown to the player only. */
const ASCENSIONS = [
  { id:'swarm', at:10, w:1, name:'Swarm', ac:'#ff9f6a',
    desc:'Every pack brings one more monster, and the ceiling rises from six to seven.' },
  { id:'armed', at:15, w:1, name:'Well-Armed', ac:'#5fd0ff',
    desc:'Monsters carry two skills from the very first stage instead of from stage 20.' },
  { id:'nosalve', at:20, w:2, name:'No Salve', ac:'#a97bff',
    desc:'Clearing trash no longer returns any health. Only a boss kill mends you.' },
  { id:'elite', at:30, w:2, name:'Elite Blood', ac:'#ff7ad9',
    desc:'Every monster is promoted one tier. At depth the commons and Epics run out entirely.' },
  { id:'relentless', at:40, w:3, name:'Relentless', ac:'#ffce5a',
    desc:'A boss waits every five stages rather than every ten.' },
  { id:'frail', at:50, w:3, name:'Frail', ac:'#ff5d7a',
    desc:'Your health pool stops growing with depth. Stage 90 gives you a stage-1 body.' },
];
const ASC_BY_ID = {};
for(const a of ASCENSIONS) ASC_BY_ID[a.id] = a;
/* Neutral mods object — every difficulty function below defaults to this, so
   an un-ascended delve (and the balance harness, which passes nothing)
   produces byte-identical numbers to before ascension existed. */
const ASC_NONE = {};
/* Turns a list of active ids into a flag object the dials can read. */
function ascMods(ids){
  const m = {};
  for(const id of (ids||[])) if(ASC_BY_ID[id]) m[id] = true;
  return m;
}
/* How many modifiers are live — the "ascension level" a record is filed under. */
function ascLevel(ids){ return (ids||[]).filter(id=>ASC_BY_ID[id]).length; }
/* Boss cadence. Every `stage % PVE_BOSS_EVERY` test in the mode goes through
   these two so Relentless cannot desync the reward screen from the pack. */
function bossEvery(m){ return (m||ASC_NONE).relentless ? 5 : PVE_BOSS_EVERY; }
function isBossStage(stage, m){ return stage % bossEvery(m) === 0; }

/* Swept by _balance/pvefit.js against a target survival curve — see the
   TARGET block there. These are measured, not chosen by feel. */
const MOB = {
  hpBase:  260,      // health of one stage-1 trash monster
  hpGrow:  1.0750,   // per stage, compounding
  dmgBase: 0.60,     // stage-1 damage multiplier — mobs start weak
  dmgGrow: 1.0280,   // per stage, compounding
  bossHp:  5.4,      // boss health vs a trash mob of the same stage
  bossDmg: 1.5,      // boss damage vs a trash mob of the same stage
  vit:     0.045,    // player max-hp gained per stage, as a fraction of base
};
/* The player's health pool grows with depth. Without this the mode is
   unwinnable by construction: the player is ONE fighter with a fixed
   4200 hp, and any pack big enough to be interesting at stage 40 out-damages
   that pool in seconds no matter how low the multiplier goes. Growing the
   pool is also what lets pack size stay a difficulty dial instead of a
   cliff. */
function playerMaxHp(stage, m){
  if((m||ASC_NONE).frail) return HP_BASE;
  return Math.round(HP_BASE * (1 + MOB.vit * (stage-1)));
}
function packSize(stage, m){
  m = m || ASC_NONE;
  const extra = m.swarm ? 1 : 0;
  if(isBossStage(stage, m)) return 1 + Math.min(3, 1 + Math.floor(stage/20)) + extra;
  return Math.min(6 + extra, 3 + Math.floor(stage/13) + extra);
}
/* Which tiers a monster may draw from. Deep stages stop rolling
   commons entirely, so late packs are qualitatively nastier and not
   merely fatter. */
function mobTiers(stage, m){
  const band = rawTiers(stage);
  if(!(m||ASC_NONE).elite) return band;
  /* Elite Blood promotes every tier in the band one step, capped at 5.
     Deriving it from the band rather than from a scaled input stage is
     what makes it work at depth: the band saturates at [3,4,5] by stage
     40, so scaling the stage number stopped changing anything in exactly
     the deep runs this modifier is unlocked for. Promoting instead turns
     the floor up forever — [3,4,5] becomes [4,5], so a stage-90 pack has
     no Epics left in it at all. */
  const up = [...new Set(band.map(t => Math.min(5, t + 1)))];
  return up;
}
function rawTiers(stage){
  if(stage < 6)  return [1];
  if(stage < 12) return [1,2];
  if(stage < 20) return [2,3];
  if(stage < 30) return [2,3,4];
  if(stage < 40) return [3,4];
  return [3,4,5];
}
/* Kit size is the only other structural dial, and it is deliberately
   shallow: monsters stay at level 1 forever and never carry more than two
   skills. Letting them fuse to level 3 the way a player does multiplied
   their damage by 2.95 on top of tier, count and pack growth, which made
   the curve impossible to fit — five compounding terms and only two of
   them sweepable. Measured: a third skill at stage 36, landing on the same
   stage as the sixth pack slot, killed 31 of 40 runs inside four stages.
   Structural steps must not coincide; 20 and 39 are deliberately apart. */
function mobSkillCount(stage, m){
  if((m||ASC_NONE).armed) return 2;
  return stage < 20 ? 1 : 2;
}
const MOB_NAMES = ['Husk','Cinder Imp','Glass Wretch','Bloom Tick','Ash Hound',
                   'Pale Stalker','Rust Golem','Mire Thing','Screech','Wisp-Eater',
                   'Bone Choir','Gloom Wolf','Salt Revenant','Dim Herald'];
const BOSS_NAMES = ['THE FIRST GATE','MARROW KING','THE LONG SILENCE',
                    'CHOIR OF ASH','WHAT WAITS BELOW'];

function mobBuild(stage, tiers, nSkills){
  /* Undying Will is off the table for every monster, bosses included. A
     pack already gets its staying power from stacked health pools and
     numbers; a second life on top of that reads to the player as a kill
     that did not count, and on a boss it silently doubles the only health
     bar that matters. Filtered out of the pool rather than blocked at cast
     time, so a mob spends its one or two slots on something it can
     actually use — the guard in Sim.saveUndying is the belt to this brace. */
  const pool = SKILLS.filter(s => tiers.includes(s.tier) && s.fx !== 'undying');
  const out = [], used = new Set();
  for(let i=0;i<nSkills && pool.length;i++){
    let sk, guard = 0;
    do { sk = pool[RNG.int(pool.length)]; } while(used.has(sk.id) && ++guard < 20);
    if(used.has(sk.id)) break;
    used.add(sk.id);
    out.push({id:sk.id, lvl:1});
  }
  return out;
}

function makePack(stage, m){
  m = m || ASC_NONE;
  const boss = isBossStage(stage, m);
  const n = packSize(stage, m);
  const tiers = mobTiers(stage, m);
  const hp1  = MOB.hpBase  * Math.pow(MOB.hpGrow,  stage-1);
  const dmg1 = MOB.dmgBase * Math.pow(MOB.dmgGrow, stage-1);
  const out = [];
  const cx = ARENA_W/2, cy = ARENA_H/2;
  for(let i=0;i<n;i++){
    const isBoss = boss && i===0;
    /* Spawn on a ring encircling the centered player so the pack surrounds
       from every side instead of lining up on one flank. An ellipse, not a
       circle: the arena is far wider than it is tall, so a true circle would
       clip top and bottom. The boss anchors directly ahead; trash fills the
       remaining arc evenly. */
    const ang = isBoss ? 0 : TAU * (i / Math.max(1, n)) + (boss ? 0.6 : 0);
    const rx = isBoss ? 300 : 300 + (i%2)*40;
    const ry = isBoss ? 0 : 150;
    const kit = mobSkillCount(stage, m);
    const f = new Fighter(1, mobBuild(stage, tiers, isBoss ? kit+2 : kit),
      isBoss ? BOSS_NAMES[Math.min(BOSS_NAMES.length-1,
                 Math.max(0, Math.round(stage/bossEvery(m)) - 1))]
             : MOB_NAMES[RNG.int(MOB_NAMES.length)], {
      team: 1,
      hp: Math.round(hp1 * (isBoss ? MOB.bossHp : 1)),
      dmgMul: dmg1 * (isBoss ? MOB.bossDmg : 1),
      x: clamp(cx + Math.cos(ang)*rx, 120, ARENA_W-120),
      y: clamp(cy + Math.sin(ang)*ry, 130, ARENA_H-90),
      R: isBoss ? 52 : 30,
      boss: isBoss,
      title: '',
      sway: RNG.r(TAU),        // drives vertical drift, so it affects the fight
    });
    /* mark as a Delve monster so the renderer draws it as a pixel-art
       creature instead of the abstract polygon champion */
    f.mob = true;
    out.push(f);
  }
  return out;
}
/* PVE-BLOCK-END */

const Run = {
  stage: 1, build: [], hpFrac: 1, alive: false, best: 0,
  /* Active ascension flags for THIS run, snapshotted at start(). Read from
     the save once rather than per stage: toggling a modifier mid-run from
     another screen would otherwise change the difficulty under the player. */
  mods: {}, modIds: [], ascLvl: 0,
  /* Ledger for the WHOLE run, not the last stage. Each stage builds a
     fresh Fighter, so per-stage stats would answer "what worked against
     the pack that happened to kill me" — the useful question over a
     50-stage delve is what the kit did across all of it. */
  stats: {},

  start(){
    RNG.scramble();          // Delve is not a seeded mode
    this.stage = 1; this.build = []; this.hpFrac = 1; this.alive = true;
    this.stats = {};
    this.modIds = (Save.data.asc && Save.data.asc.on || [])
      .filter(id => ASC_BY_ID[id] && ASC_BY_ID[id].at <= (Save.data.pveBest||0));
    this.mods = ascMods(this.modIds);
    this.ascLvl = ascLevel(this.modIds);
    this.best = Save.data.pveBest || 0;
    /* The run opens on a choice rather than a fight: walking into stage
       one with an empty kit and only a basic attack is not a decision,
       it's a loading screen. */
    this.offer('Choose your first skill.');
  },

  begin(){
    show('battle');
    resetBattleFx();
    const nm = Save.data.names[0] || 'AZURE WARDEN';
    const player = new Fighter(0, this.build, nm,
      {team:0, hp: playerMaxHp(this.stage, this.mods), x: ARENA_W/2, y: ARENA_H/2});
    player.setChamp(G.champs[0]);
    player.hp = Math.max(1, Math.round(player.max * this.hpFrac));
    const pack = makePack(this.stage, this.mods);
    sim = new Sim({fighters:[player, ...pack]}, null, World);
    const boss = isBossStage(this.stage, this.mods);
    $('#n1').innerHTML = `${player.name} <i style="opacity:.7;font-weight:500">${player.title}</i>`;
    $('#n2').innerHTML = boss
      ? `<b style="color:#ffce5a">BOSS</b> · Stage ${this.stage}`
      : `Stage ${this.stage} / ${PVE_MAX_STAGE}`;
    syncHud();
    log(boss ? `<b style="color:#ffce5a">Stage ${this.stage} — something larger is here.</b>`
             : `Stage ${this.stage}. ${pack.length} enemies.`);
    if(this.stage === 1 && this.ascLvl)
      log(`<b style="color:#a97bff">Ascension ${this.ascLvl}</b> — ${
        this.modIds.map(id=>ASC_BY_ID[id].name).join(' · ')}.`);
    last = performance.now(); running = true;
  },

  /* Called by showResult() instead of the duel result card. */
  resolve(){
    running = false;
    const player = sim.f.find(x => x.team === 0 && !x.minion);
    const won = sim.over === 0;
    /* banked before the win/lose branch: the stage that ends the run is
       exactly the one whose numbers the player most wants to see */
    if(player) mergeStats(this.stats, player.stats);
    if(won){
      /* Every skill that survived to here has now been used in anger —
         mark the loadout as discovered before the run can end. */
      Discovery.markBuild(this.build);
      this.hpFrac = clamp(player.hp / player.max, 0.01, 1);
      /* Clearing a boss restores you completely. Trash stages give back
         a little — enough that a long run is survivable, not so much
         that damage taken stops mattering. No Salve removes the trickle
         but never the boss mend: without one guaranteed heal the deep
         stages are decided by attrition rather than by the kit. */
      if(isBossStage(this.stage, this.mods)) this.hpFrac = 1;
      else if(!this.mods.nosalve) this.hpFrac = Math.min(1, this.hpFrac + 0.12);
      if(this.stage > this.best){
        this.best = this.stage;
        Save.data.pveBest = this.best; Save.flush();
      }
      /* Per-ascension record, so a hard shallow run is still progress. */
      this.bankAsc(this.stage);
      if(this.stage >= PVE_MAX_STAGE){ this.finish(true); return; }
      this.stage++;
      if(this.stage % 2 === 1 || isBossStage(this.stage, this.mods)){
        this.offer(`Stage ${this.stage-1} cleared.`);
      } else {
        this.begin();
      }
    } else {
      this.finish(false);
    }
  },

  /* Files the depth reached under the CURRENT ascension level. Filed by
     level rather than by modifier set: the set is combinatorial (64 of
     them at six modifiers) and the number a player actually compares is
     "how deep, how many modifiers". */
  bankAsc(stage){
    const a = Save.data.asc || (Save.data.asc = {on:[], best:{}});
    const k = String(this.ascLvl);
    if((a.best[k]||0) < stage){ a.best[k] = stage; Save.flush(); }
  },

  finish(cleared){
    this.alive = false;
    /* A failed run still discovered whatever it drafted. */
    Discovery.markBuild(this.build);
    show('result');
    panelIdx = 0;
    renderSkillPanel([{label:`Run total — ${this.stage} stage${this.stage===1?'':'s'}`,
      stats:this.stats, build:this.build}]);
    $('#winTxt').textContent = cleared ? 'THE RUN IS DONE' : 'YOU FELL';
    $('#winTxt').style.color = cleared ? '#ffce5a' : '#ff5d7a';
    const asc = this.ascLvl
      ? ` Ascension <b style="color:#a97bff">${this.ascLvl}</b> — ${
          this.modIds.map(id=>ASC_BY_ID[id].name).join(', ')}.`
      : '';
    $('#winSub').innerHTML = (cleared
      ? `All ${PVE_MAX_STAGE} stages cleared with ${this.build.length} skills. Nothing below is left standing.`
      : `Stage ${this.stage} of ${PVE_MAX_STAGE}. Best run: ${this.best}.`) + asc;
    /* A delve build is worth sharing too — it is the one loadout the player
       assembled over a whole run rather than five draft rounds. */
    attachShare(this.build, cleared
      ? `cleared all ${PVE_MAX_STAGE} stages`
      : `fell on stage ${this.stage}`, {asc:this.ascLvl});
    $('#bAgain').textContent = 'New Run';
    $('#bAgain').onclick = ()=>Run.start();
    $('#bNew').textContent = 'Main Menu';
    $('#bNew').onclick = ()=>{ restoreDuelButtons(); show('title'); renderRecord(); };
    cleared ? sfx.win() : sfx.lose();
  },

  /* Three cards: new skills, or a level-up of something owned. At the
     10-skill cap the offer becomes upgrades only, so a full loadout is
     still a progression and not a dead end. */
  offer(headline){
    /* Each fresh offer grants exactly one refresh. */
    this.rerollLeft = 1;
    this._offerHead = headline;
    this.rollOffer();
  },

  /* Regenerates the three cards for the current offer. Called by offer()
     and again by the refresh button (which spends a reroll). */
  rollOffer(){
    const owned = new Map(this.build.map(b => [b.id, b]));
    const full = this.build.length >= PVE_MAX_SKILLS;
    /* Skill offers are drawn from the FULL catalogue regardless of depth —
       an early stage can roll a high-tier skill just as a late one can.
       (Monster difficulty still scales with mobTiers(); only the reward
       pool is unrestricted here.) */
    const band = [1,2,3,4,5];
    /* The FIRST pick must be able to kill something. Opening a run with a
       pure buff leaves you with only a basic attack against a pack, which
       does not lose so much as refuse to end — the stage grinds to the
       arena's tithe. Every later offer is unrestricted. */
    const opening = this.build.length === 0;
    const fresh = SKILLS.filter(s => !owned.has(s.id) && band.includes(s.tier)
                                  && (!opening || s.role > 0));
    /* Fused skills are excluded: their parents' levels are already baked into
       the grade, so there is no level 2 of a fusion to offer. */
    const ups = this.build.filter(b => b.lvl < 3 && !BY_ID[b.id].fused);
    const picks = [];
    /* One of the three slots can go to a fusion. Only ever ONE: two available
       fusions almost always name overlapping parents, so taking one would
       leave a stale card sitting on screen claiming skills you no longer own.
       Not offered every time either — a fusable pair exists in most late
       loadouts, and a permanent fuse card would quietly cut the new-skill
       draw rate by a third for the rest of the run. At the cap it IS every
       time, because there fusing is the only way to make room. */
    const fz = availableFusions(this.build);
    if(fz.length && (full || RNG.f() < 0.6)){
      /* Drawn from the strongest few rather than uniformly: availableFusions
         sorts best-first, and a flat draw over a long list would mostly offer
         the smallest two-parent recipe the loadout happens to allow. */
      const f = fz[RNG.int(Math.min(3, fz.length))];
      picks.push({kind:'fuse', id:f.sk.id, lvl:1, arch:f.rec.id,
                  grade:f.grade, parents:f.parents.map(p=>p.id)});
    }
    const wantUps = full ? 3 - picks.length : (ups.length ? 1 : 0);
    for(let i=0;i<wantUps && ups.length;i++){
      const b = ups.splice(RNG.int(ups.length),1)[0];
      picks.push({kind:'up', id:b.id, lvl:b.lvl+1});
    }
    const bag = [...fresh];
    while(picks.length < 3 && bag.length){
      const s = bag.splice(RNG.int(bag.length),1)[0];
      picks.push({kind:'new', id:s.id, lvl:1});
    }
    renderOffer(this._offerHead, picks);
  },

  /* The refresh button. One reroll per offer; regenerates all three cards. */
  reroll(){
    if(this.rerollLeft <= 0){ sfx.deny(); return; }
    this.rerollLeft--;
    sfx.tab();
    this.rollOffer();
  },

  take(pick){
    if(pick.kind === 'up'){
      const b = this.build.find(x => x.id === pick.id);
      if(b) b.lvl = pick.lvl;
    } else if(pick.kind === 'fuse'){
      /* The parents leave the loadout and the fusion takes their place. Filter
         rather than splice-in-place so the survivors keep their acquisition
         order, which is the order the battle rail reads left to right. The
         fusion lands at the end, where a newly taken skill always lands. */
      const eat = new Set(pick.parents);
      this.build = this.build.filter(b => !eat.has(b.id));
      this.build.push({id:pick.id, lvl:1});
    } else {
      this.build.push({id:pick.id, lvl:1});
    }
    /* Marked on pick rather than on stage clear: taking a card IS meeting the
       skill, and a run that dies on the very next stage should still have
       credited the discovery. */
    Discovery.markBuild(this.build);
    pick.kind === 'fuse' ? sfx.fuse() : sfx.buy();
    this.begin();
  },
};

/* The result screen is shared with the duel mode, so PvE rebinds its two
   buttons on the way in and this puts them back on the way out. */
function restoreDuelButtons(){
  $('#winTxt').style.color = '';
  /* The share row is opt-in per result card, so clear it on the way out —
     otherwise a delve code would linger on the next duel's card. */
  const sr = $('#shareRow');
  if(sr){ sr.style.display = 'none'; sr.innerHTML = ''; }
  $('#bAgain').textContent = 'Rematch (same builds)';
  $('#bAgain').onclick = ()=>beginBattle();
  $('#bNew').textContent = 'New Draft';
  $('#bNew').onclick = ()=>startDraft();
}

/* Reward cards reuse the draft's `.card-s` styling on purpose: a skill
   should look like the same object wherever the game shows it to you. */
function renderOffer(headline, picks){
  show('offer');
  const next = Run.stage;
  const m = Run.mods || ASC_NONE;
  const boss = isBossStage(next, m);
  $('#offHead').textContent = headline;
  $('#offSub').innerHTML = boss
    ? `Next: <b style="color:#ffce5a">stage ${next} — a boss.</b> ${packSize(next, m)} enemies.`
    : `Next: stage ${next} of ${PVE_MAX_STAGE} · ${packSize(next, m)} enemies.`;

  /* What the pick would do to your combos — the same "▲" tell the draft
     uses, because a reward that silently completes a combo is a reward
     the player never learns to look for. */
  const liveIds = new Set(activeCombos(Run.build).map(c=>c.id));
  const host = $('#offCards'); host.innerHTML = '';
  for(const p of picks){
    const sk = BY_ID[p.id];
    const ate = p.kind==='fuse' ? p.parents.map(id=>BY_ID[id].name) : null;
    const after = p.kind==='up'   ? Run.build
                : p.kind==='fuse' ? Run.build.filter(b=>p.parents.indexOf(b.id)<0)
                                            .concat([{id:p.id, lvl:1}])
                :                   [...Run.build, {id:p.id, lvl:1}];
    const keptIds = new Set(activeCombos(after).map(c=>c.id));
    const gained = activeCombos(after).filter(c=>!liveIds.has(c.id));
    /* Only a fusion can LOSE you a combo — it is the one pick that removes
       skills. Adding one never unseats an existing claim, so the other two
       kinds skip the diff entirely. */
    const lost = p.kind==='fuse'
      ? activeCombos(Run.build).filter(c=>!keptIds.has(c.id)) : [];
    const el = document.createElement('div');
    el.className = 'card-s' + (gained.length?' willcombo':'')
                            + (p.kind==='fuse'?' card-f':'');
    el.dataset.sfx = 'none';         // Run.take sounds the acquire
    if(p.kind==='fuse') el.style.setProperty('--fzc', sk.col);
    el.innerHTML = `
      <div class="tierbar" style="background:${sk.col}"></div>
      ${skillCardHead(sk, {size:40,
        nameExtra: p.kind==='up'?` <span class="lvl l2">→ LV ${p.lvl}</span>`:''})}
      <div class="fams">${famChips(sk.id)}</div>
      <div class="desc">${sk.txt||''}</div>
      ${ate?`<div class="fzeat">✦ eats ${ate.join(' + ')}</div>`:''}
      ${lost.length?`<div class="fzlose">▼ ${lost.map(c=>c.name).join(' · ')}</div>`:''}
      ${gained.length?`<div class="willc">▲ ${gained.map(c=>c.name).join(' · ')}</div>`:''}
      <div class="row"><span class="stats">${skillLine(sk, p.lvl)}</span>
        <span class="grow"></span>
        <span class="cost" style="color:${p.kind==='up'?'#ffce5a'
                                        :p.kind==='fuse'?'#c9a6ff':'#7fe0a0'}">${
          p.kind==='up' ? 'UPGRADE' : p.kind==='fuse' ? 'FUSE' : 'NEW'}</span></div>`;
    el.onclick = ()=>{ Preview.reset(); Run.take(p); };
    cardFocus(el, `${skillIconLabel(sk)}. ${p.kind==='up'?`Upgrade to level ${p.lvl}`
                    :p.kind==='fuse'?`Fusion. Consumes ${ate.join(', ')}`:'New skill'}.`
      + ` ${skillLine(sk, p.lvl)}.`
      + (gained.length?` Completes ${gained.map(c=>c.name).join(', ')}.`:'')
      + (lost.length?` Breaks ${lost.map(c=>c.name).join(', ')}.`:''));
    host.append(el);
  }

  /* Refresh button — one use per offer. */
  const rb = $('#offReroll');
  if(rb){
    const left = Run.rerollLeft || 0;
    rb.textContent = `↻ Refresh (${left} left)`;
    rb.disabled = left <= 0;
    rb.style.opacity = left <= 0 ? '0.4' : '1';
    rb.onclick = ()=>{ if(!rb.disabled) Run.reroll(); };
  }

  const kit = Run.build.length
    ? Run.build.map(b=>{
        const s = BY_ID[b.id];
        /* a fusion never levels, so its numeral slot carries the grade */
        return `<b style="color:${s.col}">${s.name}${
          s.fused ? ' ✦'+s.grade : (b.lvl>1?' '+'I'.repeat(b.lvl):'')}</b>`;
      }).join(' · ')
    : '<i>nothing but a basic attack</i>';
  $('#offKit').innerHTML =
    `Loadout ${Run.build.length}/${PVE_MAX_SKILLS} — ${kit}`;
}

/* ═══════════════════════════════════════════════════════════════
   AUDIO — fully synthesized, no asset files, so the single-file build
   stays single-file. The context can only start after a user gesture
   (browser autoplay policy), so init() is called from the first click.
   Every call is wrapped: audio failing must never break the fight.

   The graph, from a voice out to the speakers:

     source → [envelope] → [pan] ─┬───────── dry ──────────┐
                                  └→ [send] → [convolver] ─┤
                                                           ↓
        busSfx / busUi / busAmb → master(vol) → limiter → destination

   Three buses so the interface sits UNDER combat rather than competing
   with it, and a limiter last so a master loud enough to actually hear
   still survives eight impacts landing in the same frame.

   Randomness here uses rnd()/Math.random(), NEVER the seeded RNG in
   sim-engine.js: dailies, ghosts and build codes are reproducible from
   its exact draw sequence, so pulling one number for a sound would
   silently change the match that sound belongs to.
   ═══════════════════════════════════════════════════════════════ */
const sfx = {
  ac:null, master:null, limiter:null, ready:false, muted:false, vol:0.8,
  busSfx:null, busUi:null, busAmb:null, verb:null, verbSend:null,
  live:0,                  // voices currently sounding
  MAX_VOICES:28,
  _hits:{},                // event key -> recent fire times, for stack()

  init(){
    if(this.ready) return;
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      const ac = this.ac = new AC();

      /* Peaks, not tone: this exists so raising the master from the old 0.32
         to something audible does not clip the moment a volley lands. */
      const lim = this.limiter = ac.createDynamicsCompressor();
      lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 12;
      lim.attack.value = 0.003; lim.release.value = 0.15;
      lim.connect(ac.destination);

      const master = this.master = ac.createGain();
      master.gain.value = this.muted ? 0 : this.vol;
      master.connect(lim);

      const bus = g => { const n = ac.createGain(); n.gain.value = g; n.connect(master); return n; };
      this.busSfx = bus(0.85);
      this.busUi  = bus(0.50);
      this.busAmb = bus(0.30);

      /* Reverb from a generated impulse response rather than a file, for the
         same reason every other sound here is generated. Without it each
         voice arrives with no space around it, which is most of why the mix
         reads as thin. */
      try{
        const v = this.verb = ac.createConvolver();
        v.buffer = this.impulse(1.5, 2.6);
        const send = this.verbSend = ac.createGain();
        send.gain.value = 1;
        send.connect(v); v.connect(master);
      }catch(e){ this.verb = this.verbSend = null; }

      this.ready = true;
    }catch(e){ /* no audio available; game continues silently */ }
  },

  /* Stereo IR: noise under an exponential tail, lowpassed harder as the tail
     decays, so it reads as a stone arena and not a bright metal box. */
  impulse(dur, decay){
    const ac = this.ac, sr = ac.sampleRate, n = Math.floor(sr*dur);
    const buf = ac.createBuffer(2, n, sr);
    for(let c=0;c<2;c++){
      const d = buf.getChannelData(c);
      let lp = 0;
      for(let i=0;i<n;i++){
        const t = i/n;
        lp += ((Math.random()*2-1) - lp) * (0.35 - 0.25*t);
        d[i] = lp * Math.pow(1-t, decay);
      }
    }
    return buf;
  },

  resume(){
    try{
      if(this.ac && this.ac.state==='suspended') this.ac.resume();
      /* a context suspended mid-voice never fires onended, so the budget can
         drift upward across tab switches until nothing plays at all */
      this.live = 0;
    }catch(e){}
  },
  setMuted(m){ this.muted = m; this.apply(); },
  /* A junk value keeps the current level rather than falling to 0 — `+v || 0`
     would read a missing save field as silence, which is indistinguishable
     from a broken build. */
  setVol(v){ const n = +v; this.vol = clamp(isFinite(n) ? n : this.vol, 0, 1); this.apply(); },
  apply(){
    try{ if(this.master) this.master.gain.value = this.muted ? 0 : this.vol; }catch(e){}
  },

  /* arena x → stereo position. Fighter 1 holds the left of the mix and
     fighter 2 the right, so a fight has width instead of arriving from a
     single point in the middle of your head. */
  panOf(x){
    return typeof x === 'number' ? clamp((x/ARENA_W)*2 - 1, -1, 1) * 0.75 : 0;
  },

  /* A rain skill can land ten impacts inside one frame. Uncapped they stack
     into clipping mush, and the eleventh identical click carries no
     information anyway, so voices past the budget are simply dropped. */
  take(){ if(this.live >= this.MAX_VOICES) return false; this.live++; return true; },
  freeOn(node){ node.onended = ()=>{ this.live = Math.max(0, this.live-1); }; },

  /* How many times `key` already fired in the last 40ms. Callers roll gain
     off and widen detune by this, so a volley reads as one thickening swell
     rather than N copies of the same sound fighting each other. */
  stack(key){
    const now = this.ac ? this.ac.currentTime : 0;
    const a = this._hits[key] || (this._hits[key] = []);
    while(a.length && now - a[0] > 0.04) a.shift();
    a.push(now);
    return a.length - 1;
  },

  /* Shared voice tail: [pan] → bus, plus a parallel reverb send. Sources
     bring their own envelope and connect into the node returned, so layers
     of one voice can share its position without sharing its envelope. */
  sink(bus, pan, wet){
    const ac = this.ac;
    let head;
    if(pan && ac.createStereoPanner){
      head = ac.createStereoPanner();
      head.pan.value = clamp(pan, -1, 1);
    } else head = ac.createGain();
    head.connect(bus || this.busSfx);
    if(wet > 0 && this.verbSend){
      const s = ac.createGain(); s.gain.value = wet;
      head.connect(s); s.connect(this.verbSend);
    }
    return head;
  },
  /* percussive envelope: near-instant attack, exponential decay */
  env(t0, dur, gain, into){
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0+Math.min(0.02, dur*0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    g.connect(into);
    return g;
  },

  /* One-shot tone. The first six arguments are the original positional
     signature — battle-render.js calls this directly — and everything new
     lives in the trailing options object:
       pan     stereo position, -1..1 (use panOf for arena coordinates)
       cents   randomise pitch by ±cents, so repeats are not identical
       partial add a quiet harmonic at this multiple, for body
       wet     reverb send, 0..1
       bus     destination bus; defaults to busSfx                        */
  tone(freq, dur, type='sine', gain=0.5, slideTo=null, delay=0, opt){
    if(!this.ready || this.muted) return;
    const O = opt || {};
    try{
      if(!this.take()) return;
      const ac = this.ac, t0 = ac.currentTime + delay;
      const k = O.cents ? Math.pow(2, rnd(O.cents, -O.cents)/1200) : 1;
      const head = this.sink(O.bus, O.pan, O.wet === undefined ? 0.16 : O.wet);
      const mk = (mult, amp)=>{
        const o = ac.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq*k*mult, t0);
        if(slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo*k*mult), t0+dur);
        o.connect(this.env(t0, dur, gain*amp, head));
        o.start(t0); o.stop(t0+dur+0.02);
        return o;
      };
      this.freeOn(mk(1, 1));          // only the fundamental holds the budget slot
      if(O.partial) mk(O.partial, 0.34);
    }catch(e){}
  },

  /* Filtered noise burst — impacts, explosions. Same rule as tone(): the
     five positional arguments are the original ones, extras go in opt, and
     `sweepTo` additionally sweeps the filter for whooshes. */
  noise(dur, gain=0.4, freq=900, q=1, delay=0, opt){
    if(!this.ready || this.muted) return;
    const O = opt || {};
    try{
      if(!this.take()) return;
      const ac = this.ac, t0 = ac.currentTime + delay;
      const n = Math.max(1, Math.floor(ac.sampleRate*dur));
      const buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for(let i=0;i<n;i++) d[i] = (Math.random()*2-1) * (1 - i/n);
      const src = ac.createBufferSource(); src.buffer = buf;
      const bp = ac.createBiquadFilter();
      bp.type = O.filter || 'bandpass';
      bp.Q.value = q;
      const f = O.cents ? freq*Math.pow(2, rnd(O.cents, -O.cents)/1200) : freq;
      bp.frequency.setValueAtTime(f, t0);
      if(O.sweepTo) bp.frequency.exponentialRampToValueAtTime(Math.max(20, O.sweepTo), t0+dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
      src.connect(bp); bp.connect(g);
      g.connect(this.sink(O.bus, O.pan, O.wet === undefined ? 0.16 : O.wet));
      src.start(t0); src.stop(t0+dur+0.02);
      this.freeOn(src);
    }catch(e){}
  },

  /* Low-end body: a fast downward sine sweep with a click on the front. This
     is what "weight" is made of, and what impacts had none of. */
  thump(freq, dur, gain, opt){
    const O = opt || {};
    this.tone(freq, dur, 'sine', gain, freq*0.42, 0,
      {pan:O.pan, bus:O.bus, cents:O.cents === undefined ? 20 : O.cents,
       wet:O.wet === undefined ? 0.1 : O.wet});
    this.noise(0.02, gain*0.5, 2200, 0.8, 0, {pan:O.pan, bus:O.bus, wet:0});
  },
  /* ── interface ──
     One grammar so navigation has a direction you can hear: confirm rises,
     back falls, tab is dry and neutral, deny refuses to resolve at all.
     Everything here goes to busUi, which sits below combat, so a click
     during a fight never steps on the fight. */
  ui(freq, dur, type, gain, slideTo, delay, wet){
    this.tone(freq, dur, type, gain, slideTo, delay,
      {bus:this.busUi, wet:wet === undefined ? 0.12 : wet, cents:18});
  },
  /* two layers: a short pitched blip for the press, a noise tick for the
     contact. One bare oscillator is what made the old click read as a beep. */
  click(){
    this.ui(700, 0.045, 'triangle', 0.30, 620);
    this.noise(0.018, 0.10, 2700, 1.1, 0, {bus:this.busUi, wet:0.1, cents:150});
  },
  confirm(){
    this.ui(523, 0.09, 'triangle', 0.26);
    this.ui(784, 0.15, 'triangle', 0.20, null, 0.055, 0.2);
  },
  back(){
    this.ui(523, 0.08, 'triangle', 0.22);
    this.ui(349, 0.16, 'triangle', 0.18, null, 0.05, 0.2);
  },
  tab(){ this.ui(560, 0.035, 'square', 0.16); },
  pick(){
    this.ui(660, 0.06, 'triangle', 0.24);
    this.ui(990, 0.10, 'sine', 0.15, null, 0.045, 0.24);
  },
  toggle(on){
    if(on) this.ui(480, 0.07, 'triangle', 0.24, 720);
    else   this.ui(480, 0.09, 'triangle', 0.22, 300);
  },
  /* The refusal: unpitched, damped, going nowhere. An action that did NOT
     happen must not sound like one that did — every failed buy, empty
     reroll and locked modifier used to be completely silent. */
  deny(){
    this.noise(0.09, 0.22, 180, 1.6, 0, {bus:this.busUi, wet:0.06});
    this.tone(150, 0.13, 'square', 0.16, 118, 0, {bus:this.busUi, wet:0.05});
  },
  /* screen change — air moving, deliberately close to subliminal */
  whoosh(){
    this.noise(0.28, 0.08, 400, 0.7, 0,
      {bus:this.busUi, wet:0.3, sweepTo:1800, cents:120});
  },

  /* --- game events --- */
  buy(){   this.tone(660, 0.07, 'triangle', 0.22, null, 0, {bus:this.busUi, cents:20});
           this.tone(990, 0.09, 'sine', 0.13, null, 0.05, {bus:this.busUi, wet:0.22}); },
  fuse(){  [523,659,784,1047].forEach((f,i)=>
             this.tone(f, 0.16, 'triangle', 0.20, null, i*0.055,
               {bus:this.busUi, wet:0.28, partial:2})); },
  /* Every repeatable combat sound randomises pitch, length and timbre, and
     rolls off against stack() — a battle fires dozens of these, and identical
     repeats are exactly what made the mix monotonous. */
  basic(x){
    const p = this.panOf(x), n = this.stack('basic'), k = 1/(1+0.5*n);
    this.noise(rnd(0.06,0.035), 0.17*k, rnd(1900,1250), 1.2, 0, {pan:p, cents:90});
    this.tone(rnd(300,240), 0.05, 'square', 0.06*k, 170, 0, {pan:p, wet:0.08});
  },
  /* cast pitch tracks tier so the mix tells you what just fired */
  cast(sk, x){
    const tier = (sk && sk.tier) || 1;
    const p = this.panOf(x), n = this.stack('cast'), k = 1/(1+0.4*n);
    const base = 150 + tier*55;
    this.tone(base, rnd(0.20,0.14), 'sawtooth', 0.18*k, base*2.1, 0,
      {pan:p, cents:45, partial:1.5, wet:0.2});
    this.noise(rnd(0.11,0.07), 0.11*k, 700+tier*260, 0.9, 0, {pan:p, cents:110});
    /* a bright top on the big tiers, so scale is audible and not just numeric */
    if(tier >= 3) this.tone(base*4, 0.18, 'triangle', 0.06*k, base*6, 0.02,
      {pan:p, wet:0.3, cents:60});
  },
  /* transient + body + occasional ring, in three timbres, so consecutive
     hits are related without being the same sound twice */
  hit(x){
    const n = this.stack('hit');
    if(n > 6) return;                 // past this it is only mud
    const p = this.panOf(x), k = 1/(1+0.55*n), v = ~~rnd(3);
    this.noise(rnd(0.09,0.055), 0.26*k, [380,470,300][v], 0.8, 0, {pan:p, cents:120});
    this.thump(rnd(138,112), rnd(0.14,0.09), 0.24*k, {pan:p, cents:40+n*30});
    if(v === 1) this.tone(rnd(1900,1500), 0.05, 'triangle', 0.05*k, null, 0.005,
      {pan:p, wet:0.3, cents:200});
  },
  /* crit is the audio counterpart of the slow-mo: impact, then a downward
     sweep under the stretched time, so the sound matches what you see.
     It also sends hardest to the reverb — the big moment gets the room. */
  crit(x){
    const p = this.panOf(x);
    this.noise(rnd(0.19,0.13), 0.46, rnd(300,220), 0.6, 0, {pan:p, wet:0.4});
    this.thump(rnd(96,80), 0.55, 0.30, {pan:p, wet:0.3});
    this.tone(90, 0.5, 'square', 0.22, 42, 0, {pan:p, wet:0.35, partial:1.5});
    this.tone(rnd(1500,1300), 1.25, 'sine', 0.12, 180, 0.04, {pan:p, wet:0.5, cents:50});
    this.noise(1.0, 0.10, 200, 0.5, 0.10, {pan:p, wet:0.45});
  },
  heal(x){
    const p = this.panOf(x);
    this.tone(520, rnd(0.24,0.18), 'sine', 0.16, 880, 0, {pan:p, cents:35, partial:2, wet:0.3});
  },
  shield(x){
    const p = this.panOf(x);
    this.tone(300, 0.22, 'triangle', 0.17, 460, 0, {pan:p, cents:30, partial:1.5, wet:0.26});
  },
  /* CC shares one grammar — a hard transient then a tail — but each kind
     bends pitch differently so you can hear which lock landed without
     looking: stun slams down, freeze crystallises upward, silence closes
     to a dead stop, root drags low and stays. */
  cc(kind, x){
    const p = this.panOf(x);
    if(kind==='stun'){
      this.noise(rnd(0.14,0.10), 0.36, 1100, 0.7, 0, {pan:p, cents:80});
      this.tone(320, 0.28, 'square', 0.22, 90, 0, {pan:p, cents:40, partial:1.5, wet:0.28});
      this.thump(rnd(120,96), 0.22, 0.20, {pan:p});
    } else if(kind==='freeze'){
      this.noise(rnd(0.16,0.12), 0.24, 2600, 2.4, 0, {pan:p, cents:120});
      this.tone(760, 0.42, 'triangle', 0.18, 1500, 0, {pan:p, cents:40, partial:2, wet:0.4});
    } else if(kind==='silence'){
      this.tone(600, 0.30, 'sine', 0.20, 120, 0, {pan:p, cents:30, wet:0.24});
      this.noise(rnd(0.09,0.055), 0.15, 500, 1.4, 0, {pan:p, cents:70});
    } else {
      this.noise(rnd(0.22,0.17), 0.28, 240, 0.8, 0, {pan:p, cents:70});
      this.tone(140, 0.40, 'sawtooth', 0.20, 70, 0, {pan:p, cents:35, partial:2, wet:0.3});
    }
  },
  /* deliberately small and dry — a resist is an absence, not an event */
  resist(x){ this.tone(240, 0.10, 'sine', 0.10, 190, 0, {pan:this.panOf(x), cents:50, wet:0.06}); },
  death(x){
    const p = this.panOf(x);
    this.noise(0.7, 0.44, 180, 0.5, 0, {pan:p, wet:0.45});
    this.tone(180, 0.9, 'sawtooth', 0.28, 38, 0, {pan:p, cents:25, partial:1.5, wet:0.4});
    this.thump(rnd(70,54), 0.7, 0.26, {pan:p, wet:0.4});
  },
  sudden(){
    /* the ambience answers this too — see amb.urgent */
    this.amb.urgent = true;
    [330,247].forEach((f,i)=>this.tone(f, 0.5, 'square', 0.20, f*0.6, i*0.3,
      {wet:0.4, partial:1.5}));
  },
  win(){ [523,659,784,1047,1319].forEach((f,i)=>
           this.tone(f, 0.42, 'triangle', 0.24, null, i*0.1, {wet:0.34, partial:2})); },
  /* the win figure inverted — same rhythm walking down, and the last note
     sags instead of landing, so a loss reads as the fanfare not arriving */
  lose(){
    [523,440,330].forEach((f,i)=>this.tone(f, 0.40, 'triangle', 0.22, null, i*0.12,
      {wet:0.3, partial:1.5}));
    this.tone(247, 0.75, 'sawtooth', 0.20, 130, 0.36, {wet:0.4, partial:1.5});
  },

  /* ── champion ultimates ──
     One grammar, three readings. Every ult opens on the same rising
     two-tone stab so "an ultimate just fired" is one recognisable sound,
     then each id bends it: Reversal settles and holds (a door closing),
     Total Force climbs (something winding up), Suppression inverts —
     it falls, because the whole skill is a reversal of direction. */
  ult(id, x){
    const p = this.panOf(x);
    this.tone(180, 0.10, 'square', 0.18, 300, 0, {pan:p, wet:0.3, partial:1.5});
    if(id === 'reversal'){
      this.tone(330, 0.55, 'triangle', 0.22, 262, 0.05, {pan:p, wet:0.42, partial:2});
      this.noise(0.30, 0.17, 380, 0.7, 0.04, {pan:p, wet:0.4});
      this.thump(rnd(84,66), 0.5, 0.22, {pan:p, wet:0.35});
    } else if(id === 'totalforce'){
      [392,523,659,880].forEach((f,i)=>this.tone(f, 0.22, 'sawtooth', 0.16, null, 0.04+i*0.045,
        {pan:p, wet:0.36, partial:2}));
    } else {
      this.tone(880, 0.42, 'sine', 0.20, 330, 0.05, {pan:p, wet:0.44, partial:2});
      this.noise(0.18, 0.15, 2200, 1.8, 0.04, {pan:p, wet:0.38});
    }
  },
  /* small, dry and metallic — a blow landing on something that refuses it */
  absorb(x){
    const p = this.panOf(x), k = 1/(1+0.5*this.stack('absorb'));
    this.tone(520, 0.09, 'square', 0.11*k, 720, 0, {pan:p, cents:60, wet:0.08});
    this.noise(rnd(0.07,0.04), 0.11*k, 1800, 1.4, 0, {pan:p, cents:130});
  },
  /* the payout borrows the crit recipe deliberately: it IS the big moment */
  nova(x){
    const p = this.panOf(x);
    this.noise(0.22, 0.52, 220, 0.55, 0, {pan:p, wet:0.45});
    this.tone(110, 0.7, 'sawtooth', 0.28, 44, 0, {pan:p, wet:0.4, partial:1.5});
    this.thump(rnd(76,58), 0.6, 0.28, {pan:p, wet:0.4});
    [523,784,1047].forEach((f,i)=>this.tone(f, 0.6, 'triangle', 0.18, null, 0.05+i*0.05,
      {pan:p, wet:0.48, partial:2}));
  },
  /* a wasted window: a short descent that lands on nothing */
  fizzle(x){
    const p = this.panOf(x);
    this.tone(300, 0.26, 'sine', 0.12, 120, 0, {pan:p, cents:40, wet:0.14});
    this.noise(0.10, 0.09, 400, 0.9, 0.03, {pan:p, cents:80});
  },
  /* the catch: an upward whip, then the throw back down */
  steal(x){
    const p = this.panOf(x);
    this.noise(0.10, 0.27, 2600, 2.2, 0, {pan:p, cents:90});
    this.tone(300, 0.16, 'triangle', 0.19, 1200, 0, {pan:p, wet:0.28, partial:1.5});
    this.tone(1200, 0.34, 'sine', 0.16, 420, 0.09, {pan:p, wet:0.4});
  },
  force(x){
    const p = this.panOf(x);
    this.noise(0.14, 0.31, 900, 1.1, 0, {pan:p, wet:0.3});
    [262,392,523,784].forEach((f,i)=>this.tone(f, 0.30, 'square', 0.15, null, i*0.04,
      {pan:p, wet:0.34, partial:1.5}));
    this.tone(1319, 0.5, 'sine', 0.13, 1760, 0.12, {pan:p, wet:0.44});
  },

  /* ── a fused cast ──
     Layered ON TOP of the ordinary cast(), not instead of it: the cast is the
     mechanical "a skill fired" and this is the weight on top, so the two
     together read as the same event escalated rather than a different one.

     Shape mirrors what the eye is doing (see fuseCast in battle-render.js):
     a short rising sweep for the implosion, then a low thump and a long
     sub-tail for the detonation, then a rising fifth-and-octave chord for
     the rite — the same intervals as fuse() on the draft screen, so buying a
     fusion and firing it are audibly the same family of moment.

     Sends hard to the reverb. Along with crit() and nova() this is one of the
     few sounds allowed to own the room, which is most of why it feels big. */
  fuseCast(sk, x){
    const p = this.panOf(x);
    /* implosion: noise sweeping UP, the only rising sweep in the mix */
    this.noise(0.26, 0.20, 300, 0.8, 0, {pan:p, wet:0.34, sweepTo:3200, cents:60});
    /* detonation */
    this.thump(rnd(74,58), 0.62, 0.30, {pan:p, wet:0.38});
    this.noise(0.20, 0.42, 260, 0.55, 0.20, {pan:p, wet:0.44});
    this.tone(96, 0.72, 'sawtooth', 0.24, 40, 0.20, {pan:p, wet:0.4, partial:1.5});
    /* the rite: root, fifth, octave, tenth — pitched off GRADE so a ✦4 lands
       a whole tone above a ✦1 and the ladder is audible across a run */
    const base = 196 * Math.pow(1.06, (sk && sk.grade || 1) - 1);
    [1, 1.5, 2, 2.5].forEach((m,i) =>
      this.tone(base*m, 0.62, 'triangle', 0.17, null, 0.22 + i*0.05,
        {pan:p, wet:0.5, partial:2, cents:20}));
  },

  /* ═══ ambience ═══
     Battles used to be silent between events, which is the other half of why
     they read as monotonous — variation in the effects does nothing about
     dead air. A drone under the fight fills that space and doubles as a
     tension meter: as either side nears death the filter opens, the two
     oscillators pull apart and the pulse quickens.

     Deliberately NOT gated on `muted`: the master gain already silences it,
     so muting and unmuting mid-fight brings the bed straight back instead of
     leaving the rest of the round dry. */
  amb: {
    on:false, timer:0, tension:0, urgent:false, drone:null, gain:null, filt:null,

    start(){
      if(this.on || !sfx.ready) return;
      try{
        const ac = sfx.ac, t0 = ac.currentTime;
        const g = this.gain = ac.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.9, t0 + 1.4);   // fade in, never a hard start
        const f = this.filt = ac.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 200; f.Q.value = 3;
        f.connect(g); g.connect(sfx.busAmb);
        /* two near-unison lows plus a fifth: the beating between the first
           two is what keeps a held drone from sounding like a test tone */
        this.drone = [55, 55.4, 82.5].map((hz, i)=>{
          const o = ac.createOscillator();
          o.type = i === 2 ? 'sine' : 'sawtooth';
          o.frequency.value = hz;
          const vg = ac.createGain();
          vg.gain.value = i === 2 ? 0.05 : 0.09;
          o.connect(vg); vg.connect(f);
          o.start();
          return o;
        });
        this.on = true; this.urgent = false; this.tension = 0;
        this.beat();
      }catch(e){ this.on = false; }
    },

    /* self-rescheduling rather than setInterval, because the rate itself is
       what tension changes */
    beat(){
      if(!this.on) return;
      if(!sfx.muted && !document.hidden)
        sfx.thump(rnd(46,38), 0.3, 0.16 + this.tension*0.14, {bus:sfx.busAmb, wet:0.3});
      const rate = (1.7 - this.tension*0.95) / (this.urgent ? 2 : 1);
      this.timer = setTimeout(()=>this.beat(), Math.max(260, rate*1000));
    },

    /* 0..1, fed every frame from syncHud, which already has both HP fractions */
    set(t){
      if(!this.on) return;
      this.tension = clamp(t, 0, 1);
      try{
        this.filt.frequency.value = 200 + this.tension*520;
        this.drone[1].frequency.value = 55.4 + this.tension*1.9;
      }catch(e){}
    },

    /* Idempotent, and called from show() as well as the result screens: a
       drone that followed the player back to the title would never stop. */
    stop(){
      if(!this.on) return;
      this.on = false;
      clearTimeout(this.timer); this.timer = 0;
      try{
        const t0 = sfx.ac.currentTime, g = this.gain.gain;
        g.cancelScheduledValues(t0);
        g.setValueAtTime(Math.max(0.0001, g.value), t0);
        g.exponentialRampToValueAtTime(0.0001, t0 + 0.8);
        for(const o of this.drone) o.stop(t0 + 0.85);
      }catch(e){}
      this.drone = this.gain = this.filt = null;
      this.urgent = false; this.tension = 0;
    },
  },
};

/* ═══════════════════════════════════════════════════════════════
   PERSISTENCE — names, record and match history survive a reload.
   Wrapped in try/catch: a file:// page in some browsers throws on
   localStorage access, and losing history must never break the game.
   ═══════════════════════════════════════════════════════════════ */
const SAVE_KEY = 'arcane-clash-v1';
const Save = {
  data: { names:['AZURE WARDEN','CRIMSON TYRANT'], wins:[0,0], draws:0, history:[], muted:false,
          vol:0.8, pveBest:0, speed:1, champs:[null,null], daily:null,
          /* Discovery ledger. `skills`/`combos` map id -> first-seen day key,
             so the codex can both gate content and say WHEN you found it.
             Kept as an object rather than an array because ids are the stable
             key here and a renamed skill should simply read as undiscovered
             rather than shifting every later index. `fusions` is keyed by
             archetype rather than by fused instance id — see sawFusion(). */
          seen: {skills:{}, combos:{}, fusions:{}},
          /* Delve ascension: which modifiers are switched on for the next
             run, and the best depth reached at each ascension LEVEL (number
             of active modifiers). Indexed by level so a 4-mod run to stage 20
             is not silently compared against a 0-mod run to stage 60. */
          asc: {on:[], best:{}} },
  load(){
    try{
      const raw = localStorage.getItem(SAVE_KEY);
      if(raw){
        const d = JSON.parse(raw);
        /* merge rather than replace, so an older save missing new fields still works */
        if(Array.isArray(d.names) && d.names.length===2) this.data.names = d.names.map(n=>String(n).slice(0,18));
        if(Array.isArray(d.wins)  && d.wins.length===2)  this.data.wins  = d.wins.map(n=>+n||0);
        this.data.draws = +d.draws || 0;
        if(Array.isArray(d.history)) this.data.history = d.history.slice(0,40);
        this.data.muted = !!d.muted;
        /* Volume is separate from mute on purpose: turning the sound down and
           turning it off are different intentions, and a player who set 0.3
           last session should not get 0.8 back just because they unmuted. */
        if(typeof d.vol === 'number' && isFinite(d.vol)) this.data.vol = clamp(d.vol, 0, 1);
        /* a player who set 4x last session almost certainly wants it again
           on stage 1 of the next run */
        if([1,2,4].includes(+d.speed)) this.data.speed = +d.speed;
        /* Deepest delve. This was written by Run.resolve() and serialized by
           flush(), but never read back here — so the record reset to 0 on
           every reload and `renderRecord`'s delve line never appeared for a
           returning player. Ascension unlocks are gated on this number, so
           restoring it is load-bearing now, not just cosmetic. */
        this.data.pveBest = clamp(+d.pveBest || 0, 0, PVE_MAX_STAGE);
        /* validated against the live catalogue, not trusted: a save from a
           build where a champion was named differently must not produce a
           fighter holding an ultimate that no longer exists */
        if(Array.isArray(d.champs) && d.champs.length===2)
          this.data.champs = d.champs.map(id => champOf(id) ? id : null);
        /* Discovery ledger, filtered through the live catalogue for the same
           reason champions are: an id that no longer exists must read as
           undiscovered rather than inflating the "14/39 found" counter with
           a skill nobody can ever see again. */
        if(d.seen && typeof d.seen === 'object'){
          const pick = (src, valid) => {
            const out = {};
            if(src && typeof src === 'object')
              for(const k of Object.keys(src)) if(valid(k)) out[k] = String(src[k]||'').slice(0,10);
            return out;
          };
          this.data.seen = {
            skills: pick(d.seen.skills, k => !!BY_ID[k]),
            combos: pick(d.seen.combos, k => COMBOS.some(c=>c.id===k)),
            /* Validated against FUSIONS, not BY_ID: this bucket is keyed by
               ARCHETYPE, so a fused instance id like `fz_thermallance_5` would
               sail through a BY_ID check and then never match anything
               fusionCount() asks about. Restoring it here is the whole reason
               the meter survives a reload — the bucket is written by flush()
               with everything else, and this object is rebuilt from scratch, so
               a key omitted here is a key silently dropped every session. */
            fusions: pick(d.seen.fusions, k => FUSIONS.some(f=>f.id===k)),
          };
        }
        /* Ascension. `on` is filtered to modifiers that still exist AND are
           actually unlocked at the restored depth — a save edited to switch on
           a stage-60 modifier at stage 3 gets it dropped rather than honoured. */
        if(d.asc && typeof d.asc === 'object'){
          const best = {};
          if(d.asc.best && typeof d.asc.best === 'object')
            for(const k of Object.keys(d.asc.best)){
              const lvl = +k;
              if(Number.isInteger(lvl) && lvl >= 0 && lvl <= ASCENSIONS.length)
                best[lvl] = clamp(+d.asc.best[k] || 0, 0, PVE_MAX_STAGE);
            }
          const on = Array.isArray(d.asc.on)
            ? d.asc.on.filter(id => ASC_BY_ID[id] && ASC_BY_ID[id].at <= this.data.pveBest)
            : [];
          this.data.asc = {on:[...new Set(on)], best};
        }
        /* Field-by-field rather than assigned wholesale: this object gates
           the one attempt per day, so a hand-edited or truncated save must
           not be able to smuggle in a shape the renderer then trips over. */
        if(d.daily && typeof d.daily === 'object'){
          const s = d.daily;
          this.data.daily = {
            day: String(s.day || ''), done: !!s.done,
            streak: +s.streak || 0, best: +s.best || 0,
            played: +s.played || 0, wins: +s.wins || 0,
            history: Array.isArray(s.history) ? s.history.slice(0,30) : [],
            last: (s.last && typeof s.last === 'object') ? s.last : null,
          };
        }
      }
    }catch(e){ /* private mode / file:// restrictions — run with defaults */ }
    return this.data;
  },
  flush(){
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); }
    catch(e){ /* quota or blocked; gameplay continues unaffected */ }
  },
};
Save.load();

function recordMatch(winner){
  const d = Save.data;
  if(winner === -1) d.draws++;
  else if(winner === 0 || winner === 1) d.wins[winner]++;
  d.history.unshift({
    w: winner,
    t: Math.round(elapsed),
    sd: !!sim.sdPhase,
    hp: sim.f.map(f=>Math.ceil(f.hp)),
    dmg: sim.f.map(f=>Math.round(f.dealt)),
    names: sim.f.map(f=>f.name),
    when: Date.now(),
  });
  d.history = d.history.slice(0, 40);
  Save.flush();
  renderRecord();
}
function renderRecord(){
  Daily.render();
  Discovery.render();
  const d = Save.data, el = $('#record');
  if(!el) return;
  const total = d.wins[0] + d.wins[1] + d.draws;
  /* The delve record is worth showing even with no duels fought — it is
     the only persistent thing a PvE-only player has. */
  const delve = d.pveBest
    ? `<div class="stats" style="margin-bottom:6px">Deepest delve —
        <b style="color:#ffce5a">stage ${d.pveBest}</b> of ${PVE_MAX_STAGE}</div>`
    : '';
  if(!total){ el.innerHTML = delve; return; }
  const rows = d.history.slice(0,6).map(h=>{
    const who = h.w === -1 ? '<span style="color:#cbb6ff">draw</span>'
      : `<span style="color:${h.w?'#ff8fae':'#7fd4ff'}">${h.names?h.names[h.w]:'P'+(h.w+1)}</span>`;
    return `<div class="hrow"><span>${who}</span><span class="mono">${h.t}s${h.sd?' ⚡':''}</span></div>`;
  }).join('');
  el.innerHTML = delve +
    `<div class="stats" style="margin-bottom:6px">Record — ${d.names[0]} <b>${d.wins[0]}</b>
      · ${d.names[1]} <b>${d.wins[1]}</b>${d.draws?` · draws <b>${d.draws}</b>`:''}
      <span style="opacity:.6">(${total} fought)</span></div>${rows}`;
}

/* ═══════════════════════════════════════════════════════════════
   DAILY CHALLENGE

   One seeded duel per calendar day. Everything the seed can reach is
   fixed — both champions, every shop roll, the AI's draft, every crit —
   so two players on the same date fight the same fight, and the only
   variable left is how you spend 60 gold.

   Deliberately ONE attempt: the score is only worth chasing if it cannot
   be re-rolled. `done` is written the moment the battle resolves, not
   when the player leaves the result screen, so a reload mid-fight cannot
   buy a second run either.

   The day key is LOCAL date, not UTC — "today's challenge" should mean
   today on the player's own calendar.
   ═══════════════════════════════════════════════════════════════ */
const Daily = {
  dayKey(d){
    d = d || new Date();
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  },
  /* Yesterday's key, used only to decide whether a streak survives. */
  prevKey(key){
    const [y,m,d] = key.split('-').map(Number);
    const t = new Date(y, m-1, d);
    t.setDate(t.getDate()-1);
    return this.dayKey(t);
  },
  seedFor(key){ return hashStr('arcane-clash/daily/' + key); },

  state(){
    const d = Save.data;
    if(!d.daily) d.daily = {day:'', done:false, streak:0, best:0, played:0, wins:0, history:[]};
    return d.daily;
  },
  doneToday(){ const s = this.state(); return s.done && s.day === this.dayKey(); },

  /* A win always outranks a loss, so the leaderboard question is "did you
     solve it", not "did you flail impressively". That ordering only holds if
     the loss score is BOUNDED — an early version scored losses by raw damage
     dealt, and a long fight against a healer broke six figures and beat a
     clean win. Everything here is a fraction, so a loss can never reach the
     win floor.

     Losses rank by how much of the enemy's health bar came off, not by damage
     dealt: overkill and enemy healing both inflate the latter without getting
     you any closer to actually winning. */
  scoreOf(r){
    if(!r.won) return Math.round(clamp(1 - r.foeLeftFrac, 0, 1) * 9999);
    return 100000
      + Math.round(clamp(r.hpFrac, 0, 1) * 10000)          //     0 .. 10000
      + Math.max(0, Math.round((150 - r.t) * 30));         //     0 ..  4500
  },

  begin(){
    if(this.doneToday()){ flashMsg('Today\'s challenge is already spent', 'deny'); return; }
    const key = this.dayKey();
    const seed = this.seedFor(key);
    RNG.seed(seed);
    G.daily = true;
    G.vsAI  = true;
    /* Champions are dealt by the seed rather than chosen: a fixed matchup is
       the whole point of a shared challenge, and it also skips a select
       screen that would otherwise imply a choice the daily does not offer. */
    G.champs[0] = CHAMPIONS[RNG.int(CHAMPIONS.length)].id;
    G.champs[1] = CHAMPIONS[RNG.int(CHAMPIONS.length)].id;
    startDraft();
    const c0 = champOf(G.champs[0]), c1 = champOf(G.champs[1]);
    flashMsg(`Daily ${key} — ${c0.name} vs ${c1.name}`);
  },

  /* Called from showResult once, for the seeded match only. Takes a record
     object rather than four positionals — they were all numbers, and a
     transposed pair would have silently mis-scored every run. */
  record(r){
    const s = this.state(), key = this.dayKey();
    if(s.done && s.day === key) return;          // belt: never score a day twice
    const score = this.scoreOf(r);
    const won = r.won;
    /* A streak counts consecutive days ATTEMPTED, not won. Rewarding the
       return visit is the point; a streak you can only keep by winning is
       one bad seed away from never mattering again. */
    s.streak = (s.day && s.day === this.prevKey(key)) ? (s.streak||0) + 1 : 1;
    s.day = key; s.done = true;
    s.played = (s.played||0) + 1;
    if(won) s.wins = (s.wins||0) + 1;
    s.best = Math.max(s.best||0, score);
    const row = {day:key, won, score, t:Math.round(r.t), hp:Math.ceil(r.hpAbs||0)};
    s.history = [row, ...(s.history||[])].slice(0,30);
    s.last = row;
    Save.flush();
    this.render();
  },

  render(){
    const el = $('#daily');
    if(!el) return;
    const s = this.state(), key = this.dayKey(), done = this.doneToday();
    const streak = done ? (s.streak||0) : (s.day === this.prevKey(key) ? (s.streak||0) : 0);
    const body = done
      ? `<div class="dstat">${s.last && s.last.won
            ? `<b style="color:#7fe0a0">Cleared</b> in ${s.last.t}s with ${s.last.hp} hp left.`
            : `<b style="color:#ff8fae">Fell</b>${s.last?` after ${s.last.t}s.`:'.'}`}
           Score <b style="color:#e8ecf8">${s.last ? s.last.score.toLocaleString() : 0}</b>.
           <span style="opacity:.7">Next challenge tomorrow.</span></div>`
      : `<div class="dstat">One seeded duel. Same champions, same cards, same
           rolls for everyone today — <b style="color:#e8ecf8">one attempt</b>.</div>`;
    el.className = done ? 'done' : '';
    el.innerHTML =
      `<div class="dtop"><span class="dlabel">${done?'Daily · spent':'Daily challenge'}</span>
         <span class="dday mono">${key}</span></div>
       ${body}
       <div class="dstreak"><span>Streak <b>${streak}</b></span>
         <span>Best <b>${(s.best||0).toLocaleString()}</b></span>
         <span>Won <b>${s.wins||0}</b>/<b>${s.played||0}</b></span></div>`;
  },

  /* The result screen is shared with the duel, and a daily must not offer a
     rematch: the fight is only reproducible from the seed's starting state,
     and a second run of it would not be the same fight anyway. */
  bindResultButtons(){
    $('#bAgain').textContent = 'Main Menu';
    $('#bAgain').onclick = ()=>{
      G.daily = false; RNG.scramble();
      restoreDuelButtons(); show('title'); renderRecord();
    };
    $('#bNew').textContent = 'Free Draft';
    $('#bNew').onclick = ()=>{
      G.daily = false; RNG.scramble();
      restoreDuelButtons(); startDraft();
    };
  },
};

/* ═══════════════════════════════════════════════════════════════
   DISCOVERY — the collection layer.

   The game already shipped 60 skills and 39 combos and then forgot every
   one of them the moment a match ended. Nothing accrued: a player on day
   thirty could do exactly what a player on day one could, so the only
   thing bringing anyone back was mood.

   This records what a player has actually FIELDED — not what they have
   read about in the codex. Reading is free; assembling three specific
   families in one build under a gold cap is the accomplishment, and a
   ledger is only motivating if it is honest about the difference.

   Deliberately additive and never gating: the draft pool, the offers and
   the shop are all untouched. Restricting variety on day one would attack
   the one system that makes this game interesting.
   ═══════════════════════════════════════════════════════════════ */
const Discovery = {
  ledger(){
    const d = Save.data;
    if(!d.seen || typeof d.seen !== 'object') d.seen = {skills:{}, combos:{}};
    if(!d.seen.skills) d.seen.skills = {};
    if(!d.seen.combos) d.seen.combos = {};
    /* Added with fusions; a save written before them simply has no bucket, so
       it grows one on first read and every earlier save migrates for free. */
    if(!d.seen.fusions) d.seen.fusions = {};
    return d.seen;
  },
  sawSkill(id){ return !!this.ledger().skills[id]; },
  sawCombo(id){ return !!this.ledger().combos[id]; },
  /* Keyed by ARCHETYPE, not instance. Thermal Lance is one discovery whether
     you forged it at grade 2 or grade 9 — recording all nine would make the
     meter a measure of how many times you fused, not of what you have met. */
  sawFusion(arch){ return !!this.ledger().fusions[arch]; },
  skillCount(){ return SKILLS.filter(s=>this.sawSkill(s.id)).length; },
  comboCount(){ return COMBOS.filter(c=>this.sawCombo(c.id)).length; },
  fusionCount(){ return FUSIONS.filter(f=>this.sawFusion(f.id)).length; },

  /* Marks a whole loadout and every combo it forms. Returns the names of
     things discovered for the FIRST time, so the result screen can make a
     moment of it — a checklist nobody is told about does not motivate.
     One flush for the batch rather than one per id. */
  markBuild(build){
    if(!build || !build.length) return [];
    const L = this.ledger(), day = Daily.dayKey(), fresh = [];
    for(const b of build){
      const sk = BY_ID[b.id];
      if(!sk) continue;
      /* A fusion goes in its own bucket under its archetype and never into
         skills: the skills meter counts the 60 draftable cards, and dropping
         198 instance ids in there would only bloat the save. */
      if(sk.fused){
        if(L.fusions[sk.fuseOf]) continue;
        L.fusions[sk.fuseOf] = day;
        fresh.push({kind:'fusion', name:sk.name, col:sk.col});
        continue;
      }
      if(L.skills[b.id]) continue;
      L.skills[b.id] = day;
      fresh.push({kind:'skill', name:sk.name, col:sk.col});
    }
    for(const c of activeCombos(build)){
      if(L.combos[c.id]) continue;
      L.combos[c.id] = day;
      fresh.push({kind:'combo', name:c.name, col:comboCol(c)});
    }
    if(fresh.length) Save.flush();
    return fresh;
  },

  /* Both sides of a duel count. Losing to a combo is how most players meet
     one, and refusing to credit it would mean the codex stayed emptier the
     more the player was beaten by interesting builds. */
  markMatch(builds){
    const fresh = [];
    for(const b of builds) fresh.push(...this.markBuild(b));
    return fresh;
  },

  /* Appended to a result card. Silent when nothing is new. */
  banner(fresh){
    if(!fresh || !fresh.length) return '';
    const list = fresh.slice(0,6).map(f=>
      `<b style="color:${f.col}">${f.name}</b>`).join(' · ');
    const more = fresh.length > 6 ? ` +${fresh.length-6} more` : '';
    return `<br><span style="color:#a97bff">New to the Codex — ${list}${more}.</span>`;
  },

  /* The title-screen panel: three meters and the delve ratchet. This is the
     "you are getting somewhere" surface, and it is the reason to reopen. */
  render(){
    const el = $('#progress');
    if(!el) return;
    const sk = this.skillCount(), cb = this.comboCount(), fz = this.fusionCount();
    const d = Save.data;
    const asc = d.asc || {on:[], best:{}};
    const lvl = ascLevel(asc.on);
    const deep = d.pveBest || 0;
    const meter = (label, have, total, cls) =>
      `<div class="meter${cls?' '+cls:''}">
         <div class="mlab"><span>${label}</span><b>${have} / ${total}</b></div>
         <div class="bar"><i style="width:${total? (have/total*100).toFixed(1):0}%"></i></div>
       </div>`;
    /* Deepest run at the CURRENT ascension level — the number that moves
       when a player replays ground they have already covered. */
    const atLvl = +(asc.best && asc.best[String(lvl)]) || 0;
    const ascLine = lvl
      ? `Ascension <b>${lvl}</b> — deepest <b>${atLvl || '—'}</b>`
      : (deep ? `Delve <b>${deep}</b> / ${PVE_MAX_STAGE}` : 'Delve unplayed');
    el.innerHTML =
      `<div class="ptop"><span class="plabel">Discovery</span>
         <span class="pasc">${ascLine}</span></div>
       ${meter('Skills fielded', sk, SKILLS.length)}
       ${meter('Combos triggered', cb, COMBOS.length, 'gold')}
       ${meter('Fusions forged', fz, FUSIONS.length, 'fz')}`;
  },
};

/* ═══════════════════════════════════════════════════════════════
   BUILD CODES — asynchronous PvP with no server.

   A code IS the opponent. There is no matchmaking, no account and no
   network call: a player copies a string, sends it however they already
   talk to their friends, and the recipient fights that exact loadout
   against a real Sim. The sim is deterministic given a build, so the
   fight the sender watched is the fight the receiver gets.

   Format: `AC1-<champ><payload>-<check>`, base36 throughout.
     champ    one char, index into CHAMPIONS ('z' = none)
     payload  two chars per slot — skill index in a STABLE sorted order,
              then level 1-3
     check    one char, sum of payload codes mod 36

   Skill index comes from ids sorted lexicographically rather than from
   catalogue order, so adding a skill to the middle of SKILLS does not
   silently reinterpret every code ever shared. A code referencing an
   unknown index is rejected whole rather than partially decoded — a
   half-decoded build would be a different opponent than the sender saw.
   ═══════════════════════════════════════════════════════════════ */
const CODE_VER = 'AC1';
/* Stable id order. Computed once; SKILLS is frozen at load.
   Fusion ids are APPENDED after the sorted base list rather than sorted in
   with it. That is the whole reason CODE_VER stays AC1: every index a
   previously shared code refers to still points at the same skill, so every
   code anyone has ever posted still decodes byte-identically. Sorting the
   fusions in would have shifted every alphabetically-later id and silently
   reinterpreted the entire history of shared codes.
   FUSION_IDS is itself deterministic (archetype-sorted, grade ascending),
   so codes stay valid as new recipes are added — a new archetype only ever
   appends. Indices past 36 already use the two-char form below.

   Regression anchor, minted with the id table as it stood BEFORE fusions
   existed. If a change ever reorders the base list, this is the one-line
   check that catches it — decodeBuild('AC1-00220g111k3-8') must return
   arcbolt LV2 + Ember Dart LV1 + Ward Plate LV3, champion `reversal`. */
const CODE_IDS = [...SKILLS.map(s=>s.id).sort(), ...FUSION_IDS];
const CODE_IX = {};
CODE_IDS.forEach((id,i)=>{ CODE_IX[id] = i; });
const B36 = n => n.toString(36);

function encodeBuild(build, champId){
  const slots = (build||[]).filter(b => BY_ID[b.id] && CODE_IX[b.id] !== undefined);
  if(!slots.length) return '';
  /* Sorted by index so the same build always yields the same code
     regardless of the order it happened to be drafted in. */
  slots.sort((a,b)=>CODE_IX[a.id]-CODE_IX[b.id]);
  let body = '', sum = 0;
  for(const b of slots){
    const ix = CODE_IX[b.id], lvl = clamp(b.lvl|0, 1, 3);
    /* One base36 char covers 36 ids; a two-char index keeps the format
       valid past that without a version bump. */
    const ic = ix < 36 ? B36(ix) : B36(Math.floor(ix/36)) + B36(ix%36);
    body += (ix < 36 ? '0' : '1') + ic + B36(lvl);
    sum += ix + lvl;
  }
  const ci = CHAMPIONS.findIndex(c=>c.id===champId);
  const champ = ci >= 0 ? B36(ci) : 'z';
  return `${CODE_VER}-${champ}${body}-${B36(sum%36)}`;
}

/* Returns {build, champ} or null. Never throws and never returns a
   partial build: a malformed code is a stranger's typo, not a game state.

   Accepts the code ANYWHERE inside pasted text, because the realistic
   flow is "select the whole message, paste" — and the message we put on
   the clipboard has a human-readable line above the code. Requiring a
   bare code would fail on our own share format. */
function decodeBuild(str){
  if(typeof str !== 'string') return null;
  /* Whitespace only: a long code can pick up a soft wrap in an email or a
     line break in a chat quote, and those must not break it. Everything
     else is left in place so it can act as a boundary. */
  const norm = str.toUpperCase().replace(/\s+/g, '');
  const re = new RegExp(CODE_VER + '-([0-9A-Z]+)-([0-9A-Z])', 'g');
  let m, found = null;
  /* Every candidate is tried and the LAST valid one wins. Two codes in one
     paste means a quoted chat thread, where the quote sits above the new
     message — so the trailing code is the one being challenged with. The
     checksum is what makes "valid" mean something here. */
  while((m = re.exec(norm))){
    const got = decodeCode(m[1], m[2]);
    if(got) found = got;
  }
  return found;
}

/* The strict half: one payload, one check char, all-or-nothing. */
function decodeCode(payload, check){
  const p = payload.toLowerCase();
  if(p.length < 4) return null;
  const champCh = p[0];
  const champ = champCh === 'z'
    ? null
    : ((CHAMPIONS[parseInt(champCh,36)] || {}).id || null);
  const build = [], used = new Set();
  let i = 1, sum = 0;
  while(i < p.length){
    const wide = p[i];
    if(wide !== '0' && wide !== '1') return null;
    const n = wide === '1' ? 2 : 1;
    const idxStr = p.slice(i+1, i+1+n);
    const lvlStr = p[i+1+n];
    /* Truncated tail: a chat client that clipped the message must fail the
       whole decode rather than yield a shorter build than the sender had. */
    if(idxStr.length !== n || lvlStr === undefined) return null;
    const ix = parseInt(idxStr, 36);
    const lvl = parseInt(lvlStr, 36);
    if(!Number.isInteger(ix) || !Number.isInteger(lvl)) return null;
    if(lvl < 1 || lvl > 3) return null;
    const id = CODE_IDS[ix];
    /* Unknown index: the sender is on a build with a skill this copy of the
       game does not have. Reject rather than skip. */
    if(!id || !BY_ID[id]) return null;
    if(!used.has(id)){ used.add(id); build.push({id, lvl}); }
    sum += ix + lvl;
    i += n + 2;
  }
  if(!build.length || build.length > MAX_SKILLS) return null;
  if(B36(sum%36) !== check.toLowerCase()) return null;
  return {build, champ};
}

/* Adds a copyable code + share blurb to the result card. Uses the async
   clipboard when available and falls back to selecting the text, because
   file:// pages and older Safari both refuse writeText. */
function attachShare(build, blurb, opt){
  const host = $('#shareRow');
  if(!host) return;
  const code = encodeBuild(build, G.champs[0]);
  if(!code){ host.style.display = 'none'; return; }
  host.style.display = 'flex';
  const asc = opt && opt.asc ? ` · ascension ${opt.asc}` : '';
  host.innerHTML =
    `<input id="shareCode" class="codein" readonly value="${code}">
     <button class="btn" id="bCopy" data-sfx="none">Copy build code</button>`;
  $('#bCopy').onclick = ()=>{
    const txt = `Arcane Clash — ${blurb}${asc}\n${code}`;
    /* data-sfx="none" above: a copy that only left the code selected has not
       copied anything, and must not sound as though it had */
    const done = ()=>{ sfx.confirm(); flashMsg('Build code copied — send it to a rival'); };
    try{
      if(navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(done, ()=>fallback());
      else fallback();
    }catch(e){ fallback(); }
    function fallback(){
      const el = $('#shareCode');
      el.removeAttribute('readonly'); el.select();
      /* execCommand is deprecated but remains the only synchronous copy
         available on a file:// page; the selection is the real fallback. */
      try{ document.execCommand('copy'); done(); }
      catch(e2){ flashMsg('Press Ctrl+C to copy the selected code', 'deny'); }
      el.setAttribute('readonly','');
    }
  };
}

/* ═══════════════════════════════════════════════════════════════
   GHOST DUEL — draft an answer to a pasted build.

   Not a series: the opponent is fixed, so there is nothing for them to
   answer back with and no reason to fight five times. It borrows the
   daily's shape instead — five draft rounds of gold spent in one sitting,
   then one battle — with two differences that matter:

     · the ghost's loadout is visible in the foe panel from round 1, so
       this is a PUZZLE ("beat this") rather than a guess. That visibility
       is the whole appeal of an asynchronous challenge.
     · the ghost does not draft, so it never contests the shared pool.
       Its build was fixed when its owner copied the code.

   Deliberately not scored, ranked or persisted beyond the ordinary
   win/loss record: there is no server to verify a code came from a real
   run, so anything competitive built on it would only reward editing
   the string.
   ═══════════════════════════════════════════════════════════════ */
const GHOST_NAME = 'CHALLENGER';
const Ghost = {
  active: false,
  build: null,
  champ: null,

  /* Reads the title-screen field, then hands off to champion select so the
     player still chooses their own ultimate against the ghost. */
  fromInput(){
    const el = $('#ghostCode');
    const parsed = decodeBuild(el ? el.value : '');
    if(!parsed){
      flashMsg('That build code is not valid', 'deny');
      if(el){ el.focus(); el.select(); }
      return;
    }
    this.build = parsed.build;
    this.champ = parsed.champ;
    commitNames();
    /* #bGhost is data-sfx="none": a rejected code already denied above, and a
       good one is a commit, so it rises */
    sfx.confirm();
    Sel.open({both:false, after: ()=>Ghost.start()});
  },

  /* Opens the draft against the ghost. Sel.confirm() has already picked a
     random champion for side 1, so the ghost's own champion overrides it
     here — after the select screen, never before. */
  start(){
    G.daily = false;
    startDraft();                    // clears Ghost.active, resets G
    this.active = true;              // ...so re-arm it immediately after
    G.series = false;                // one battle, like the daily
    G.vsAI = true;
    if(this.champ) G.champs[1] = this.champ;
    /* Shown in the foe panel for every draft round. `fielded` is what that
       panel reads, and `lastRound` labels it. */
    G.fielded = [null, this.build];
    G.lastRound = 0;
    renderDraft();
    const n = this.build.length;
    flashMsg(`Ghost drafted — ${n} skill${n===1?'':'s'}. Build an answer.`);
  },

  /* Called by advanceRound() once the draft rounds are spent. */
  fight(){
    G.builds = [toBuild(G.p[0]), this.build];
    beginBattle();
  },

  /* Result card for a ghost fight: the interesting axis is "bring a
     different build to the same wall", so the primary action re-drafts
     against the same ghost rather than replaying the identical fight. */
  bindResultButtons(){
    $('#bAgain').textContent = 'New answer, same ghost';
    $('#bAgain').onclick = ()=>Ghost.start();
    $('#bNew').textContent = 'Main Menu';
    $('#bNew').onclick = ()=>{
      Ghost.active = false;
      restoreDuelButtons(); show('title'); renderRecord();
    };
  },
};

/* ═══════════════════════════════════════════════════════════════
   ASCENSION SCREEN — the delve's modifier picker.
   ═══════════════════════════════════════════════════════════════ */
const Asc = {
  open(){
    show('asc');
    this.render();
  },
  state(){
    const d = Save.data;
    if(!d.asc || typeof d.asc !== 'object') d.asc = {on:[], best:{}};
    if(!Array.isArray(d.asc.on)) d.asc.on = [];
    if(!d.asc.best || typeof d.asc.best !== 'object') d.asc.best = {};
    return d.asc;
  },
  unlocked(a){ return (Save.data.pveBest||0) >= a.at; },
  toggle(id){
    const a = this.state(), mod = ASC_BY_ID[id];
    if(!mod || !this.unlocked(mod)){
      flashMsg(`Reach stage ${mod ? mod.at : '?'} to unlock this`, 'deny');
      return;
    }
    const i = a.on.indexOf(id);
    if(i >= 0) a.on.splice(i,1); else a.on.push(id);
    /* rises when switching a modifier on, falls when switching it off, so the
       row tells you which way it went without reading it */
    sfx.toggle(i < 0);
    Save.flush();
    this.render();
  },
  render(){
    const a = this.state(), deep = Save.data.pveBest || 0;
    const lvl = ascLevel(a.on);
    const weight = a.on.reduce((s,id)=>s + (ASC_BY_ID[id] ? ASC_BY_ID[id].w : 0), 0);
    const atLvl = +(a.best[String(lvl)]) || 0;
    $('#ascStat').innerHTML = deep
      ? `Deepest <b style="color:#ffce5a">${deep}</b> · ascension ${lvl}
         (weight ${weight})${atLvl?` · best at this level <b>${atLvl}</b>`:''}`
      : 'Clear stage 10 to unlock your first modifier';
    const host = $('#ascGrid');
    host.innerHTML = '';
    for(const mod of ASCENSIONS){
      const open = this.unlocked(mod);
      const on = a.on.includes(mod.id);
      const el = document.createElement('div');
      el.className = 'asc' + (on?' on':'') + (open?'':' locked');
      el.style.setProperty('--ac', mod.ac);
      el.innerHTML = `
        <div class="am"><span class="tick"></span>
          <span class="an">${mod.name}</span>
          <span class="grow"></span>
          <span>${'◆'.repeat(mod.w)}</span></div>
        <div class="ad">${mod.desc}</div>
        ${open ? '' : `<div class="req">Locked — reach stage ${mod.at}</div>`}`;
      /* Locked rows are bound too: toggle() refuses and says so. Previously
         they had no handler at all, so pressing one was completely silent and
         read as a dead element rather than a locked one. The delegate skips
         .locked, and toggle() owns the sound either way — hence data-sfx. */
      el.dataset.sfx = 'none';
      el.onclick = ()=>this.toggle(mod.id);
      host.append(el);
    }
    /* The button states the commitment, so "Descend" is never ambiguous
       about whether the ticks took effect. */
    $('#ascGo').textContent = lvl ? `Descend · ascension ${lvl}` : 'Descend';
  },
};

/* ═══════════════════════════════════════════════════════════════
   PER-SKILL CONTRIBUTION PANEL

   An auto-battler's only real decision is the draft, so the result
   screen has to answer "which of my picks did the work?". The sim
   credits every point of damage, healing and shielding to a skill id
   (Fighter.credit); this turns that ledger into a ranked chart.

   Two deliberate choices:

   · Skills that were drafted and did NOTHING are still listed, at
     zero. A missing row reads as an oversight; a row sitting empty at
     the bottom of the chart is the single most useful thing the screen
     can tell a player about their draft.

   · Damage, healing and shielding share one bar rather than getting
     three charts. A defensive slot and an offensive slot compete for
     the same draft pick, so they have to be comparable at a glance —
     the segment colour says which kind of work it was.
   ═══════════════════════════════════════════════════════════════ */
const HEAL_COL = '#8dffa8', SHIELD_COL = '#9fc4ff';
const SYNTH = {
  _basic:  {name:'Basic Strike',    col:'#8b96b8'},
  _thorns: {name:'Thorns · Reflect', col:'#ff9f6a'},
  /* The ultimate has no draft slot, so it needs a synthetic row exactly as
     the basic attack does. Reversal's nova and heal, and every point of
     damage Suppression steals, are booked here — otherwise a stolen Meteor
     Fall would credit the enemy's skill on the player's own chart. */
  _ult:    {name:'Champion Ultimate', col:'#ffce5a'},
};

/* An "enabler" is a self-buff whose entire contribution is expressed
   through OTHER skills: haste, dmgAmp, crit, dr, pact, immune and the
   reflect/thorns pair produce no ledger entry of their own, because the
   damage they cause is credited to the skill that landed it.

   They must not be reported as dead slots. A player told that Battle
   Hymn "contributed nothing" would drop it, when it may have been the
   reason the top row is as large as it is. So they are listed, marked
   as buffs, and excluded from the dead-slot count — an honest "we can't
   attribute this" rather than a confident wrong number. */
const ENABLER_FX = new Set(['haste','dmgAmp','crit','dr','pact','immune',
                            'reflect','thorns','vamp','shred','chill']);
const isEnabler = sk => !!sk && sk.role === 0 && sk.kind === 'self'
                        && ENABLER_FX.has(sk.fx);

/* Delve builds one Fighter per stage, so a run's ledger is the sum of
   its stages. Merging by id keeps the run total meaningful across the
   50 fighters a full clear creates. */
function mergeStats(dst, src){
  for(const id in src){
    const s = src[id];
    const r = dst[id] || (dst[id] = {dmg:0, heal:0, shield:0, casts:0});
    r.dmg += s.dmg; r.heal += s.heal; r.shield += s.shield; r.casts += s.casts;
  }
  return dst;
}

function ledgerRows(stats, build){
  const lvl = {};
  for(const b of (build||[])) lvl[b.id] = b.lvl;
  /* union of "what was drafted" and "what produced output" — the first
     set catches dead slots, the second catches basics and thorns */
  const ids = new Set([...Object.keys(stats||{}), ...(build||[]).map(b=>b.id)]);
  const rows = [];
  for(const id of ids){
    const s = (stats && stats[id]) || {dmg:0, heal:0, shield:0, casts:0};
    const sk = BY_ID[id], syn = SYNTH[id];
    if(!sk && !syn) continue;                       // unknown id, ignore
    const total = s.dmg + s.heal + s.shield;
    if(syn && total <= 0) continue;                 // don't list an unused synthetic
    rows.push({
      id, total, dmg:s.dmg, heal:s.heal, shield:s.shield, casts:s.casts,
      name: sk ? sk.name : syn.name,
      col:  sk ? sk.col  : syn.col,
      lvl:  lvl[id] || 0,
      enabler: isEnabler(sk),
    });
  }
  /* rank by contribution; among the unattributable, buffs sit above
     genuinely dead slots so the bottom of the chart is the actual
     "reconsider these" list */
  rows.sort((a,b) => b.total - a.total
    || (b.enabler?1:0) - (a.enabler?1:0)
    || b.casts - a.casts
    || a.name.localeCompare(b.name));
  const sum = rows.reduce((a,r)=>a+r.total, 0);
  for(const r of rows) r.pct = sum > 0 ? r.total/sum*100 : 0;
  return rows;
}

const fmtN = n => Math.round(n).toLocaleString('en-US');

function skillChartHTML(rows){
  if(!rows.length) return '<div class="dmg-foot">No contribution recorded.</div>';
  const max = rows[0].total || 1;
  const body = rows.map(r => {
    const w = r.total > 0 ? Math.max(1.5, r.total/max*100) : 0;
    /* segments are shares of this row's own total, so the bar reads as a
       composition regardless of how long it is */
    const seg = (v, col) => v > 0
      ? `<span style="width:${v/r.total*100}%;background:${col}"></span>` : '';
    const parts = r.total > 0
      ? seg(r.dmg, r.col) + seg(r.heal, HEAL_COL) + seg(r.shield, SHIELD_COL) : '';
    const bits = [];
    if(r.dmg    > 0) bits.push(`${fmtN(r.dmg)} dmg`);
    if(r.heal   > 0) bits.push(`${fmtN(r.heal)} healed`);
    if(r.shield > 0) bits.push(`${fmtN(r.shield)} shielded`);
    const none = r.enabler
      ? 'buff — its value is counted inside the skills it boosted'
      : 'no contribution';
    const tip = `${r.name}${r.lvl?` LV${r.lvl}`:''} — ${bits.join(' · ') || none} · ${r.casts} cast${r.casts===1?'':'s'}`;
    /* an enabler shows its cast count and a dash, not a 0% bar: the
       number we would print is not "it did nothing", it is "not
       separable", and those must not look the same */
    const pct = r.total > 0 ? (r.pct >= 0.05 ? r.pct.toFixed(1)+'%' : '—')
                            : (r.enabler ? '<span title="counted inside other skills">buff</span>' : '—');
    return `<div class="skrow${r.total>0?'':(r.enabler?' buff':' zero')}" title="${tip}">
      <div class="skname">${BY_ID[r.id] ? skillIcon(BY_ID[r.id], {size:16})
        : `<i style="background:${r.col}"></i>`}<b>${r.name}</b>${
        r.lvl > 1 ? `<span class="sklvl">LV${r.lvl}</span>` : ''}</div>
      <div class="skbar"><div class="skfill" style="width:${w}%">${parts}</div></div>
      <div class="skpct">${pct}</div>
      <div class="skval">${r.total > 0 ? fmtN(r.total) : '—'}</div>
      <div class="skcast">${r.casts}×</div>
    </div>`;
  }).join('');
  const sum = rows.reduce((a,r)=>a+r.total,0);
  /* only real, attributable slots can be called dead */
  const dead = rows.filter(r => r.total<=0 && BY_ID[r.id] && !r.enabler).length;
  return `<div class="dmg-legend">
      <span><i style="background:#8b96b8"></i>damage</span>
      <span><i style="background:${HEAL_COL}"></i>healing</span>
      <span><i style="background:${SHIELD_COL}"></i>shielding</span>
      <span style="margin-left:auto">% of own output</span>
    </div>
    <div class="dmg-rows">${body}</div>
    <div class="dmg-foot">${fmtN(sum)} total output${
      dead ? ` · <b style="color:#ff8fae">${dead}</b> slot${dead===1?'':'s'} contributed nothing` : ''}</div>`;
}

/* entries: [{label, stats, build}] — one per champion worth showing. */
let panelEntries = [], panelIdx = 0;
function renderSkillPanel(entries){
  panelEntries = entries.filter(Boolean);
  panelIdx = Math.min(panelIdx, panelEntries.length - 1);
  if(panelIdx < 0) panelIdx = 0;
  paintSkillPanel();
}
function paintSkillPanel(){
  const el = $('#dmgPanel');
  if(!el) return;
  if(!panelEntries.length){ el.innerHTML = ''; return; }
  const e = panelEntries[panelIdx];
  const tabs = panelEntries.length > 1
    ? `<div class="dmg-tabs">${panelEntries.map((p,i) =>
        `<button class="btn seg${i===panelIdx?' on':''}" data-pi="${i}" data-sfx="tab">${p.label}</button>`).join('')}</div>`
    : '';
  el.innerHTML = `<div class="dmg-head">
      <span class="dmg-title">${panelEntries.length > 1 ? 'Skill breakdown' : e.label}</span>${tabs}
    </div>${skillChartHTML(ledgerRows(e.stats, e.build))}`;
  el.querySelectorAll('[data-pi]').forEach(b => {
    b.onclick = () => { panelIdx = +b.dataset.pi; paintSkillPanel(); };
  });
}

/* ═══════════════════════════════════════════════════════════════
   SERIES RESOLUTION — one round ends, the match may not have.
   ═══════════════════════════════════════════════════════════════ */
/* Bank the round just fought, then route: back to the draft, or to the
   match card. A draw awards nobody and still consumes the round. */
function scoreRound(){
  const w = sim.over;
  if(w === 0 || w === 1) G.wins[w]++;
  /* what each side actually fielded, for the next draft to be played
     against — captured before any further buying mutates `own` */
  G.fielded = [G.builds[0], G.builds[1]];
  G.lastRound = G.round;
  G.roundLog.push({r:G.round, w, t:elapsed, sd:!!sim.sdPhase});
  /* Every round is a discovery opportunity — both sides' kits count. The
     round card reports only what THIS round turned up; the accumulator is
     for the match card, so a series does not re-announce round 1's finds
     on every subsequent screen. */
  const fresh = Discovery.markMatch(G.builds.filter(Boolean));
  G.roundFresh = fresh;
  G.freshSeen = [...(G.freshSeen||[]), ...fresh];
  /* both sides' ledgers, same panel the match card uses */
  panelIdx = 0;
  renderSkillPanel(sim.f.filter(x=>!x.minion).map(f =>
    ({label:f.name, stats:f.stats, build:f.build})));
  if(seriesDecided()) showSeriesResult();
  else showRoundResult(w);
}
function clockOf(t){
  const m = Math.floor(t/60), s = Math.floor(t%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
/* Round card: a scoreline and a door back to the shop. Deliberately does
   NOT call recordMatch — the persisted win/loss record counts matches. */
function showRoundResult(w){
  const nm = Save.data.names;
  const lead = G.wins[0] === G.wins[1] ? 'All square'
    : `${nm[G.wins[0] > G.wins[1] ? 0 : 1]} leads`;
  if(w === -1){
    $('#winTxt').textContent = `ROUND ${G.round} — DRAW`;
    $('#winTxt').style.color = '#cbb6ff';
  } else {
    const win = sim.f.find(x => x.team === w) || sim.f[w];
    $('#winTxt').textContent = `ROUND ${G.round} — ${win.name}`;
    $('#winTxt').style.color = w ? '#ff8fae' : '#7fd4ff';
  }
  const dmg = sim.f.filter(x=>!x.minion)
    .map(f=>`${f.name}: <b>${Math.round(f.dealt)}</b>`).join(' · ');
  $('#winSub').innerHTML =
    `${seriesPips()} &nbsp; <b>${G.wins[0]}–${G.wins[1]}</b> · ${lead}, first to ${SERIES_TARGET}.<br>
     Settled in ${clockOf(elapsed)}${sim.sdPhase ? ' <i style="color:#ffb37a">(sudden death)</i>' : ''}.<br>
     Damage dealt — ${dmg}<br>
     <span style="color:#7f8bb0">Gold and every card you own carry into the next
     round. You now know what they brought.</span>${Discovery.banner(G.roundFresh)}`;
  w === 0 ? sfx.win() : sfx.lose();
  $('#bAgain').textContent = `Draft round ${G.round + 1} →`;
  $('#bAgain').onclick = ()=>openDraftRound(G.round + 1);
  $('#bNew').textContent = 'Abandon match';
  $('#bNew').onclick = ()=>{
    restoreDuelButtons(); show('title'); renderRecord();
  };
  show('result');
}
/* Match card: the series is over. This is the one that touches the record. */
function showSeriesResult(){
  const w = seriesWinner();
  const nm = Save.data.names;
  const tally = G.roundLog.map(e =>
    `R${e.r} ${e.w === -1 ? '<span style="color:#cbb6ff">draw</span>'
      : `<span style="color:${e.w ? '#ff8fae' : '#7fd4ff'}">${nm[e.w]}</span>`}`
  ).join(' · ');
  if(w === -1){
    $('#winTxt').textContent = 'MATCH DRAWN';
    $('#winTxt').style.color = '#cbb6ff';
    $('#winSub').innerHTML =
      `Five rounds, nothing between them — <b>${G.wins[0]}–${G.wins[1]}</b>.<br>${tally}`
      + Discovery.banner(G.freshSeen);
  } else {
    $('#winTxt').textContent = `${nm[w]} TAKES THE MATCH`;
    $('#winTxt').style.color = w ? '#ff8fae' : '#7fd4ff';
    const sweep = G.wins[1-w] === 0 ? ' A clean sweep.' : '';
    $('#winSub').innerHTML =
      `<b style="color:${w ? '#ff8fae' : '#7fd4ff'}">${nm[w]}</b> wins the series
       <b>${G.wins[0]}–${G.wins[1]}</b>.${sweep}<br>${tally}`
      + Discovery.banner(G.freshSeen);
    sfx.win();
  }
  recordMatch(w);
  /* The final loadout is the thing worth sending to a rival — five rounds of
     drafting produced it, and a code makes it a challenge rather than a
     screenshot. Player 1's build, since that is whose champion the code
     carries. */
  attachShare(G.builds[0], w === 0
    ? `won a series ${G.wins[0]}–${G.wins[1]}`
    : `lost a series ${G.wins[0]}–${G.wins[1]}`);
  $('#bAgain').textContent = 'New Match';
  $('#bAgain').onclick = ()=>startDraft();
  $('#bNew').textContent = 'Main Menu';
  $('#bNew').onclick = ()=>{
    restoreDuelButtons(); show('title'); renderRecord();
  };
  show('result');
}

function showResult(){
  /* PvE resolves through the run controller instead: a cleared stage is
     not the end of anything, it is a reward screen and the next stage. */
  if(sim.pve){ Run.resolve(); return; }
  /* A best-of-five scores the round and then either hands back to the draft
     or shows the match card. The card below is the single-battle one, which
     the daily and a ghost duel both reach. */
  if(G.series){ scoreRound(); return; }
  const w = sim.over;                    // index of winner, or -1 for a draw
  /* captured before either exit path: both of them return, and the daily has
     to be banked on a draw exactly as it is on a loss */
  const daily = G.daily;
  const ghost = Ghost.active;
  const m=Math.floor(elapsed/60), s=Math.floor(elapsed%60);
  const clock = `${m}:${String(s).padStart(2,'0')}`;
  /* Both kits count toward the codex — meeting a combo by losing to it is
     still meeting it. Computed before either branch writes #winSub. */
  const fresh = Discovery.markMatch(
    sim.f.filter(x=>!x.minion).map(f=>f.build).filter(Boolean));
  /* both champions get a tab: reading what BEAT you is at least as
     instructive as reading what you brought */
  panelIdx = 0;
  renderSkillPanel(sim.f.filter(x=>!x.minion).map(f =>
    ({label:f.name, stats:f.stats, build:f.build})));
  if(w === -1){                          // the last tithe emptied every side at once
    /* A draw is now always a mutual wipe, so both bars read 0. Naming the
       fighters beats "both champions" — in a PvE stage there were never
       two of them. */
    const names = sim.f.filter(x=>!x.minion).map(f=>f.name).join(' · ');
    $('#winTxt').textContent = 'DRAW';
    $('#winTxt').style.color = '#cbb6ff';
    $('#winSub').innerHTML =
      `The arena took its due from everyone still standing after ${clock}.<br>
       <span style="color:#cbb6ff">${names}</span> — all fell on the same tithe.<br>
       Damage dealt — ${sim.f.filter(x=>!x.minion)
         .map(f=>`${f.name}: <b>${Math.round(f.dealt)}</b>`).join(' · ')}`
      + Discovery.banner(fresh);
    recordMatch(-1);
    /* A draw is a mutual wipe, so nobody cleared it — scored as a loss, with
       the damage the player did manage as the tie-break. */
    if(daily){
      /* Mutual wipe: nobody is left, so the enemy bar is empty — a draw earns
         the top of the losing band without ever crossing into a win. */
      Daily.record({won:false, hpFrac:0, hpAbs:0, t:elapsed, foeLeftFrac:0});
      Daily.bindResultButtons();
    }
    if(ghost){ attachShare(G.builds[0], 'drew against a ghost'); Ghost.bindResultButtons(); }
    show('result');
    return;
  }
  const win = sim.f.find(x => x.team === w) || sim.f[w];
  const lose = sim.f.find(x => x.team !== w) || sim.f[1-w];
  $('#winTxt').textContent = `${win.name} WINS`;
  $('#winTxt').style.color = w ? '#ff8fae' : '#7fd4ff';
  $('#winSub').innerHTML =
    `<b style="color:${win.accent}">${win.name}, ${win.title}</b> survives with
     <b>${Math.ceil(win.hp)}</b> hp after ${clock}${
      sim.sdPhase ? ' <i style="color:#ffb37a">(sudden death)</i>' : ''}.<br>
     <span style="color:${lose.accent}">${lose.name}, ${lose.title}</span> falls.<br>
     Damage dealt — ${win.name}: <b>${Math.round(win.dealt)}</b> ·
     ${lose.name}: <b>${Math.round(lose.dealt)}</b>`
    + Discovery.banner(fresh);
  sfx.win();
  recordMatch(w);
  if(ghost){
    $('#winSub').innerHTML +=
      `<br><span style="color:#7fd4ff">Ghost duel — you fought a pasted build.
       Send yours back.</span>`;
    attachShare(G.builds[0], w === 0 ? 'beat a ghost build' : 'lost to a ghost build');
    Ghost.bindResultButtons();
  }
  if(daily){
    const me  = sim.f.find(x => x.team === 0 && !x.minion) || sim.f[0];
    const foe = sim.f.find(x => x.team === 1 && !x.minion) || sim.f[1];
    Daily.record({
      won: w === 0,
      hpFrac: me.max ? Math.max(0, me.hp) / me.max : 0,
      hpAbs:  Math.max(0, me.hp),
      t: elapsed,
      /* On a loss the foe is the one still standing, so this is what "how
         close was it" actually means. */
      foeLeftFrac: (foe && foe.max) ? Math.max(0, foe.hp) / foe.max : 0,
    });
    $('#winSub').innerHTML +=
      `<br><span style="color:#7fe0a0">Daily ${Daily.dayKey()} — score
       <b>${(Daily.state().last ? Daily.state().last.score : 0).toLocaleString()}</b>,
       streak <b>${Daily.state().streak}</b>.</span>`;
    Daily.bindResultButtons();
  }
  show('result');
}


/* ═══════════════════════════════════════════════════════════════
   HEADLESS SIM — retained for balance verification. Reachable from
   the console (runLab()) but no longer surfaced in the UI, since raw
   win rates are a developer concern.
   ═══════════════════════════════════════════════════════════════ */
function randomBuild(){
  const n = 4 + (Math.random()*3|0);
  const pool = [...SKILLS];
  const out = [];
  for(let i=0;i<n && pool.length;i++){
    const k = (Math.random()*pool.length)|0;
    out.push({id: pool.splice(k,1)[0].id, lvl: 1 + (Math.random()*3|0)});
  }
  return out;
}
/* cap sits past the ~75s a duel now needs to tithe a full pool to zero;
   at 90 it was cutting off fights the new rule was still resolving. */
function runHeadless(b1,b2,cap=130){
  const s = new Sim(b1,b2,null);
  const dt = 1/30;                        // coarser tick is fine headless
  let t = 0;
  while(s.over===null && t<cap){ s.step(dt); t+=dt; }
  if(s.over===null) return s.f[0].hp >= s.f[1].hp ? 0 : 1;   // timeout → higher hp
  return s.over;
}
function runLab(N=3000){
  const stat = {};
  for(const sk of SKILLS) stat[sk.id] = {w:0, n:0};
  const t0 = performance.now();
  for(let i=0;i<N;i++){
    const b1 = randomBuild(), b2 = randomBuild();
    const w = runHeadless(b1,b2);
    for(const b of b1){ stat[b.id].n++; if(w===0) stat[b.id].w++; }
    for(const b of b2){ stat[b.id].n++; if(w===1) stat[b.id].w++; }
  }
  const ms = Math.round(performance.now()-t0);
  const rows = SKILLS.map(sk=>{
    const st = stat[sk.id];
    return {Skill:sk.name, Tier:TIER_NAME[sk.tier], Cost:COST[sk.tier],
            Picks:st.n, Win:+(st.n? st.w/st.n*100 : 50).toFixed(1)};
  }).sort((a,b)=>b.Win-a.Win);
  const off = rows.filter(r=>r.Win>55||r.Win<45).length;
  console.table(rows);
  console.log(`${N} battles in ${ms}ms · ${SKILLS.length-off}/${SKILLS.length} inside 45–55%`);
  return rows;
}

