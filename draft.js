/* ═══════════════════════════════════════════════════════════════
   DRAFT — gold, the rolling shop, 3-copy fusion, the AI drafter,

   and the handoff into a fight.

   The whole pre-battle flow, ending at beginBattle().
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";
/* ═══════════════════════════════════════════════════════════════
   DRAFT — gold, rolling shop, 3-copy fusion
   ═══════════════════════════════════════════════════════════════ */
const COST   = {1:1, 2:2, 3:3, 4:4, 5:5};
const REROLL = 2;
const ROUNDS = 5;
/* ---- the series -------------------------------------------------------
   A duel is a best-of-five, and every draft round is followed immediately
   by a fight. That is the whole design change: the old flow spent all five
   rounds of gold blind and then fought once, so a player never once got to
   answer information. Now round 2 is drafted knowing exactly what round 1
   lost to, and the shared pool is contested across five decisions instead
   of one.

   Rounds are still indexed 1..5, so `goldFor` and `ODDS` are untouched and
   the fitted economy (60 gold total, tier odds ramping to legendary) means
   the same thing it always did. A 3-0 sweep simply ends the match before
   the top of that curve, which is what a sweep should do.

   NOT applied to the daily: its score band is fitted to one battle
   (hpFrac / foeLeftFrac / t), and re-basing it would break the comparability
   of every streak already banked in a save. The daily keeps the old
   draft-five-then-fight flow via `G.series === false`. */
const SERIES_TARGET = 3;
/* Fresh hp every round, but scaled to how much gold has actually been spent
   by then — otherwise round 1 is two fighters with one skill each chipping
   at 4200 hp, which cannot resolve before the sudden-death tithe and so gets
   decided by the tithe instead of by the builds.

   This is a scalar OUTSIDE the fitted coefficients, exactly like PvE's
   per-stage hp multiplier: both sides get the identical number, so no skill
   is re-priced and no matchup is skewed. Values are cumulative gold through
   round r as a fraction of the full 60. */
const ROUND_HP = [0, 0.14, 0.30, 0.50, 0.74, 1.00];
function roundHp(r){ return Math.max(1, Math.round(HP_BASE * ROUND_HP[clamp(r,1,ROUNDS)])); }
/* family chips for cards — color-coded badges */
function famChips(id){
  const tags = TAGS[id] || [];
  if(!tags.length) return '';
  return tags.map(t=>{
    const f = FAMILY[t];
    return `<span class="fam" style="background:${f.col}22;color:${f.col};border-color:${f.col}55">${f.name}</span>`;
  }).join('');
}
/* combo color for glowing borders — the primary family of the combo */
function comboCol(c){ return FAMILY[c.fam[0]].col; }
/* combo bar at the top of the draft screen, showing active combos */
function renderComboBar(combos){
  const el = $('#comboBar');
  if(!el) return;
  if(!combos.length){ el.innerHTML=''; el.style.display='none'; return; }
  el.style.display='flex';
  el.innerHTML = combos.map(c=>{
    const col = comboCol(c);
    return `<div class="cbar" style="border-color:${col}88;background:${col}11">
      <b style="color:${col}">${c.name}</b><span>${c.txt}</span></div>`;
  }).join('');
}
/* shop odds shift toward high tiers in later rounds */
const ODDS = [
  null,
  [0.62,0.28,0.10,0.00,0.00],
  [0.45,0.33,0.18,0.04,0.00],
  [0.32,0.32,0.25,0.09,0.02],
  [0.20,0.29,0.30,0.16,0.05],
  [0.12,0.23,0.31,0.23,0.11],
];

const G = {
  turn:0, round:1,
  p:[{gold:0, own:{}}, {gold:0, own:{}}],
  shop:[], builds:[null,null],
  pool:[],           // shared finite card pool
  vsAI:true,         // player 2 is drafted by the AI
  /* set only for the seeded daily challenge; suppresses the reseed in
     startDraft() and reroutes the result screen */
  daily:false,
  /* true for a best-of-five duel (draft a round, fight it, draft again).
     The daily sets it false and keeps the original single-battle flow. */
  series:true,
  /* round wins per side, and the builds each side actually fielded last
     round — the reveal the next draft is played against. */
  wins:[0,0],
  fielded:[null,null],
  lastRound:0,       // which round `fielded` came from; 0 = nothing fought yet
  roundLog:[],       // {r, w, t, sd} per round fought, for the match card
  /* champion ids, one per side. Kept OUT of `builds` on purpose: a champion
     has no tier, no gold cost, never enters the pool and cannot be fused, so
     folding it into the build array would mean special-casing it in every
     loop that walks a loadout. */
  champs:[null,null],
};

function rollTier(round){
  const o = ODDS[clamp(round,1,5)];
  let r = RNG.f(), acc = 0;
  for(let i=0;i<5;i++){ acc += o[i]; if(r<acc) return i+1; }
  return 1;
}
/* ---- shared card pool -------------------------------------------------
   Both players draw from ONE finite pool, so buying a card denies it to the
   opponent and contesting a rare skill is a real decision. Copies per tier
   fall as tier rises, which is what makes a tier-5 fuse genuinely scarce. */
const POOL_COPIES = {1:14, 2:11, 3:8, 4:5, 5:3};
function buildPool(){
  G.pool = [];
  for(const sk of SKILLS)
    for(let i=0;i<POOL_COPIES[sk.tier];i++) G.pool.push(sk.id);
}
function takeFromPool(tier){
  /* prefer the requested tier; fall back down if that tier is exhausted */
  for(let t=tier; t>=1; t--){
    const idx = [];
    for(let i=0;i<G.pool.length;i++) if(BY_ID[G.pool[i]].tier===t) idx.push(i);
    if(idx.length){
      const k = idx[RNG.int(idx.length)];
      return BY_ID[G.pool.splice(k,1)[0]];
    }
  }
  return null;
}
function returnToPool(sk){ if(sk) G.pool.push(sk.id); }

/* ---- affinity rolling -------------------------------------------------
   Fusing needs SIX copies of one skill (3 to reach LV2, 3 more for LV3).
   With 40 skills and ~25 cards seen per draft, a purely random shop offered
   a repeat so rarely that only 0.3% of measured builds ever reached LV3 --
   the upgrade system existed but never fired. So some slots deliberately
   offer something you already hold and can still fuse. Copies still come
   out of the shared pool, so a rival can starve your fuse by buying them. */
const AFFINITY = 0.34;
function takeOwned(side){
  const me = G.p[side];
  const avail = [];
  for(const id in me.own)
    if(me.own[id].lvl < 3 && G.pool.indexOf(id) >= 0) avail.push(id);
  if(!avail.length) return null;
  const id = avail[RNG.int(avail.length)];
  G.pool.splice(G.pool.indexOf(id), 1);
  return BY_ID[id];
}

/* side is explicit: affinity depends on WHOSE shop this is, and relying on
   G.turn made the roll silently wrong whenever it was called out of order */
function rollShop(side){
  if(side === undefined) side = G.turn;
  /* unbought cards go back so they can appear for either player later */
  for(const cell of G.shop) if(!cell.bought) returnToPool(cell.sk);
  G.shop = [];
  armed = null;                 // stale arm would point at a different card
  for(let i=0;i<5;i++){
    /* affinity slots offer a skill the drafter can still fuse */
    const sk = (RNG.f() < AFFINITY && takeOwned(side))
      || takeFromPool(rollTier(G.round));
    if(sk) G.shop.push({sk, bought:false});
  }
}
function goldFor(round){ return 6 + round*2; }   // 8,10,12,14,16 → 60 total

function startDraft(){
  /* Only the daily arrives here on a seeded stream. Every other draft must
     be unpredictable — including one started straight off the daily's
     result screen, which would otherwise inherit its seed. */
  if(!G.daily) RNG.scramble();
  /* A fresh draft is never a ghost fight; the flag survives on the result
     screen so its buttons work, and this is where it is cleared. */
  Ghost.active = false;
  /* the daily is scored as one battle; every other duel is a best-of-five */
  G.series = !G.daily;
  G.turn = 0; G.round = 1;
  G.p = [{gold:goldFor(1), own:{}}, {gold:goldFor(1), own:{}}];
  G.builds = [null,null];
  G.wins = [0,0];
  G.fielded = [null,null];
  G.lastRound = 0;
  G.roundLog = [];
  G.shop = [];
  /* per-match discovery accumulators, reported on the match card */
  G.freshSeen = []; G.roundFresh = [];
  buildPool();
  rollShop();
  restoreDuelButtons();
  show('draft'); renderDraft();
}

/* owned entry: {count, lvl}  — 3 copies fuse into next level */
function buy(i, silent){
  const cell = G.shop[i], me = G.p[G.turn];
  if(!cell || cell.bought) return;
  const c = COST[cell.sk.tier];
  if(me.gold < c) { if(!silent) flashMsg('Not enough gold'); return; }
  const distinct = Object.keys(me.own).length;
  if(!me.own[cell.sk.id] && distinct >= MAX_SKILLS){
    if(!silent) flashMsg(`Loadout full — ${MAX_SKILLS} skills max`); return;
  }
  me.gold -= c; cell.bought = true;
  const e = me.own[cell.sk.id] || (me.own[cell.sk.id] = {count:0, lvl:1, spent:0});
  e.count++; e.spent += c;
  /* fuse: every 3 copies past the first raises level, capped at 3 */
  while(e.count >= 3 && e.lvl < 3){ e.count -= 3; e.lvl++; if(!silent) fuseFx(cell.sk); }
  if(!silent){ sfx.buy(); renderDraft(); }
}
function fuseFx(sk){
  log(`Fused <b style="color:${sk.col}">${sk.name}</b>`);
  flashMsg(`${sk.name} → Level up`);
  sfx.fuse();
}
let msgTimer = 0;
function flashMsg(txt){
  let el = $('#toast');
  if(!el){
    el = document.createElement('div'); el.id='toast';
    el.style.cssText = `position:absolute;bottom:22px;left:50%;transform:translateX(-50%);
      background:#141a30;border:1px solid #32406e;padding:9px 16px;border-radius:9px;
      font-weight:650;font-size:12.5px;pointer-events:none;transition:opacity .25s;z-index:9`;
    $('#app').append(el);
  }
  el.textContent = txt; el.style.opacity='1';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(()=>{ el.style.opacity='0'; }, 1400);
}

/* ---- selling ----------------------------------------------------------
   Without this the draft is a trap: six slots fill with round-1 commons
   before Mythic and Legendary cards ever appear in the shop (they need
   round 3+ odds), so measured over 4000 real drafts the four tier-5 skills
   saw ZERO play. Selling gives back the slot and most of the gold, and
   returns every copy to the shared pool so the opponent can contest them.
   Refund is full cost minus 1 — enough to pivot, not free churn. */
function sellValue(id){
  const e = G.p[G.turn].own[id];
  if(!e) return 0;
  return Math.max(1, e.spent - 1);
}
function sell(id, silent){
  const me = G.p[G.turn], e = me.own[id];
  if(!e) return;
  me.gold += Math.max(1, e.spent - 1);
  /* every copy ever put into this skill goes back to the shared pool */
  const copies = e.count + 3*(e.lvl - 1);
  for(let i=0;i<copies;i++) returnToPool(BY_ID[id]);
  delete me.own[id];
  if(!silent){ sfx.click(); flashMsg(`Sold ${BY_ID[id].name}`); renderDraft(); }
}

function reroll(){
  const me = G.p[G.turn];
  if(me.gold < REROLL){ flashMsg('Not enough gold'); return; }
  me.gold -= REROLL; rollShop(); renderDraft();
}

function endTurn(){
  const me = G.p[G.turn];
  if(Object.keys(me.own).length === 0){ flashMsg('Buy at least one skill'); return; }
  /* A ghost never drafts — its build was fixed when its owner copied the
     code — so player 2's turn is skipped entirely and the pool is left
     uncontested. Mirroring the ghost card-for-card stays legal; it just
     tends to trade into a draw rather than beat it. */
  if(Ghost.active){ advanceRound(); return; }
  if(G.turn === 0){
    G.turn = 1;
    rollShop(1);
    if(G.vsAI){
      /* AI drafts from the same shared pool, then the round advances.
         Its picks are silent so the UI never flickers on player 2's turn. */
      aiTakeTurn(1);
      advanceRound();
    } else renderDraft();
  } else advanceRound();
}
/* Both sides have drafted. In a series that means "fight it now"; in the
   daily's single-battle flow it means "next draft round, or the one fight". */
function advanceRound(){
  if(G.series){
    G.builds = [toBuild(G.p[0]), toBuild(G.p[1])];
    beginBattle();
    return;
  }
  if(G.round < ROUNDS){
    openDraftRound(G.round + 1);
  } else if(Ghost.active){
    Ghost.fight();
  } else {
    G.builds = [toBuild(G.p[0]), toBuild(G.p[1])];
    beginBattle();
  }
}
/* Opens draft round `r`: grants that round's gold to both sides, hands the
   turn back to player 1 and refreshes their shop. Unspent gold and every
   owned card carry over — a series is one build growing, not five builds. */
function openDraftRound(r){
  G.round = r; G.turn = 0;
  G.p[0].gold += goldFor(r);
  /* The ghost is not drafting, so granting it gold would only make the
     "foe gold" readout lie. */
  if(!Ghost.active) G.p[1].gold += goldFor(r);
  rollShop(0);
  show('draft'); renderDraft();
}
/* Has either side taken the series? Also true once the rounds run out, which
   only matters when draws have eaten rounds without awarding a win. */
function seriesDecided(){
  return G.wins[0] >= SERIES_TARGET || G.wins[1] >= SERIES_TARGET
      || G.round >= ROUNDS;
}
/* Winner of the whole series: -1 for a genuine tie on round wins. */
function seriesWinner(){
  if(G.wins[0] === G.wins[1]) return -1;
  return G.wins[0] > G.wins[1] ? 0 : 1;
}
/* "● ● ○ · 2–1" — the running series score, coloured per side. */
function seriesPips(){
  const dot = (n, col) => `<b style="color:${col}">${'●'.repeat(n)}${'○'.repeat(Math.max(0,SERIES_TARGET-n))}</b>`;
  return `${dot(G.wins[0],'#7fd4ff')} <span style="opacity:.5">·</span> ${dot(G.wins[1],'#ff8fae')}`;
}
function toBuild(p){
  return Object.entries(p.own).map(([id,e])=>({id, lvl:e.lvl}));
}

/* ═══════════════════════════════════════════════════════════════
   AI DRAFTER — so one person can play.
   Scores each shop card for the AI's current board rather than picking
   the "best" skill globally: finishing a fuse beats a slightly stronger
   card, because LVL_MUL[2]/[3] outruns a flat tier bump.
   ═══════════════════════════════════════════════════════════════ */
function aiScore(cell, me){
  const sk = cell.sk;
  const owned = me.own[sk.id];
  let s = DPS_BUDGET[sk.tier] * 1.0;          // baseline: gold buys power
  if(owned){
    if(owned.lvl < 3){
      /* 2 copies in hand -> this card completes a level: huge */
      s += owned.count === 2 ? 34 : 14;
    } else s -= 12;                            // already maxed, low value
  } else {
    const distinct = Object.keys(me.own).length;
    if(distinct >= MAX_SKILLS) return -1e6;    // no room, never pick
    if(distinct >= MAX_SKILLS-1) s -= 10;      // last slot: be a bit picky
  }
  /* a build that is all self-buffs and no damage loses; keep a damage core */
  const dmgCount = Object.keys(me.own).filter(id=>BY_ID[id].role).length;
  if(sk.role && dmgCount < 3) s += 16;
  if(!sk.role && dmgCount < 2) s -= 18;
  /* mild sustain preference — measured tier averages show it holds up */
  if(sk.fx==='heal' || sk.fx==='shield' || sk.fx==='dr') s += 4;
  s += counterScore(sk);
  return s + RNG.f()*5;                        // jitter so it isn't robotic
}
/* ---- counterdrafting --------------------------------------------------
   From round 2 the AI has seen a real build, so it should answer it. The
   read is on the opposing build's SHAPE rather than on skill ids, because
   the catalogue is data and any id list here would rot the moment a skill
   is renamed. Magnitudes sit near the ±5 jitter and well under the
   DPS_BUDGET baseline (9.5–44): enough to break a tie between comparable
   cards, never enough to make the AI draft a bad card for the read.
   Returns 0 before anything has been fought, so round 1 is unchanged. */
function counterScore(sk){
  const foe = G.fielded[0];
  if(!G.series || !foe || !foe.length) return 0;
  /* tally the threat profile once per call — the build is at most 6 slots */
  let sustain = 0, dot = 0, cc = 0, pets = 0, burst = 0;
  for(const b of foe){
    const f = BY_ID[b.id];
    if(!f) continue;
    const w = LVL_MUL[b.lvl];
    if(f.fx==='heal' || f.fx==='vamp' || f.fx==='shield' || f.fx==='undying') sustain += w;
    if(f.fx==='burn' || f.fx==='bleed') dot += w;
    if(f.fx==='stun' || f.fx==='root' || f.fx==='freeze' || f.fx==='silence'
       || f.fx==='knock' || f.fx==='pull') cc += w;
    if(f.fx==='summon') pets += w;
    if(f.role && f.tier >= 3) burst += w;
  }
  let c = 0;
  /* they out-heal you: buy the things that punch through a health bar */
  if(sustain >= 1.5){
    if(sk.fx==='exec')  c += 11;
    if(sk.fx==='shred') c += 7;
    if(sk.fx==='crit')  c += 5;
  }
  /* they bleed and burn you: shields and flat mitigation beat raw heals,
     since a heal races the tick and mitigation removes it */
  if(dot >= 1.5){
    if(sk.fx==='dr')     c += 9;
    if(sk.fx==='shield') c += 6;
    if(sk.fx==='immune') c += 5;
  }
  /* they lock you down: a window of immunity is worth more than more damage */
  if(cc >= 1.5){
    if(sk.fx==='immune') c += 12;
    if(sk.fx==='haste')  c += 5;
  }
  /* they field a pack: sweepers hit every body, single-target does not */
  if(pets >= 1){
    if(sk.kind==='nova' || sk.kind==='rain' || sk.kind==='cone') c += 9;
    if(sk.fx==='thorns') c += 5;
  }
  /* they hit hard and rarely: returning damage and mitigating it both pay */
  if(burst >= 2){
    if(sk.fx==='thorns')  c += 7;
    if(sk.fx==='reflect') c += 8;
    if(sk.fx==='dr')      c += 5;
  }
  return c;
}
/* worth of a slot the AI already owns — what it gives up by selling */
function aiHoldValue(id, e){
  const sk = BY_ID[id];
  return DPS_BUDGET[sk.tier] * LVL_MUL[e.lvl] + e.count * 4;
}
function aiTakeTurn(side){
  const me = G.p[side];
  let guard = 0;
  while(guard++ < 60){
    const affordable = G.shop
      .map((c,i)=>({c,i}))
      .filter(o=>!o.c.bought && COST[o.c.sk.tier] <= me.gold);
    if(!affordable.length) break;
    let best = null, bestS = -Infinity;
    for(const o of affordable){
      const s = aiScore(o.c, me);
      if(s > bestS){ bestS = s; best = o; }
    }
    /* Board full and something much better is on offer: sell the weakest
       slot to make room. Without this the AI locks itself out of tier 4-5
       exactly the way a new player does, because the cheap commons it
       bought in round 1 occupy all six slots by the time Mythics appear. */
    if(!best || bestS <= -1e5){
      const entries = Object.entries(me.own);
      if(entries.length < MAX_SKILLS) break;
      const cand = G.shop
        .map((c,i)=>({c,i}))
        .filter(o=>!o.c.bought && !me.own[o.c.sk.id]);
      if(!cand.length) break;
      let want = null, wantV = -Infinity;
      for(const o of cand){
        const v = DPS_BUDGET[o.c.sk.tier];
        if(v > wantV){ wantV = v; want = o; }
      }
      let weak = null, weakV = Infinity;
      for(const [id,e] of entries){
        const v = aiHoldValue(id,e);
        if(v < weakV){ weakV = v; weak = id; }
      }
      /* only pivot for a clear gain, and only if the swap is affordable */
      const refund = Math.max(1, me.own[weak].spent - 1);
      if(weak && wantV > weakV * 1.45 && me.gold + refund >= COST[want.c.sk.tier]){
        const save = G.turn; G.turn = side; sell(weak, true); G.turn = save;
        continue;
      }
      break;
    }
    /* reroll instead if the board is weak and gold is plentiful */
    if(bestS < 12 && me.gold >= REROLL + 3 && guard < 6){
      me.gold -= REROLL; rollShop(side); continue;
    }
    buyFor(side, best.i);
  }
}
/* buy on behalf of a given side (AI needs this; buy() assumes G.turn) */
function buyFor(side, i){
  const save = G.turn;
  G.turn = side;
  buy(i, true);
  G.turn = save;
}

/* ---------- draft rendering ---------- */
/* Touch has no hover, so a single tap must not both inspect AND buy.
   Rule: tapping a card the first time inspects it and arms it; tapping the
   *armed* card buys. Mouse users keep hover-to-inspect and click-to-buy,
   so nothing gets slower for them. The ⓘ badge is an explicit inspect
   affordance that never buys, on either input type. */
const TOUCH = matchMedia('(hover:none)').matches || 'ontouchstart' in window;
let armed = null;                       // shop index currently armed on touch

/* ---- the reveal --------------------------------------------------------
   Everything here was public information the moment the round was fought:
   both loadouts are drawn on the rails during the battle. Restating it in
   the shop is what turns "I lost to that" into a decision, instead of a
   thing the player has to have memorised. */
function renderFoePanel(){
  const panel = $('#foePanel');
  if(!panel) return;
  const foe = G.fielded[1 - G.turn];
  /* A ghost is visible from round 1 — its build is already fixed, so hiding
     it would only make the fight a guess. In a series the panel is the
     previous round's reveal instead, and outside both it stays closed. */
  if((!G.series && !Ghost.active) || !foe || !foe.length){
    panel.style.display = 'none'; return;
  }
  panel.style.display = '';
  if(Ghost.active){
    const ch = champOf(G.champs[1]);
    $('#foeHead').textContent = `${GHOST_NAME}'s build`
      + (ch ? ` · ${ch.name}` : '');
  } else {
    $('#foeHead').textContent =
      `${Save.data.names[1 - G.turn]}, round ${G.lastRound}`;
  }
  const bench = $('#foeBench');
  bench.innerHTML = '';
  for(const b of foe){
    const sk = BY_ID[b.id];
    if(!sk) continue;
    const el = document.createElement('div');
    el.className = 'card-s foe';
    el.innerHTML = `
      <div class="tierbar" style="background:${sk.col}"></div>
      <div class="tag" style="color:${sk.col}">${TIER_NAME[sk.tier]}${b.lvl>1?` · LV${b.lvl}`:''}</div>
      <div class="nm">${sk.name}</div>
      <div class="fams">${famChips(sk.id)}</div>`;
    /* inspect only — this is the opponent's card, it can never be bought */
    el.onclick = ()=>{ sfx.click(); showDetail(sk, b.lvl, true); };
    el.onmouseenter = ()=>{ if(!TOUCH) showDetail(sk, b.lvl); };
    bench.append(el);
  }
  const combos = activeCombos(foe);
  $('#foeCombo').innerHTML = combos.length
    ? `Their combos — ${combos.map(c=>`<b style="color:${comboCol(c)}">${c.name}</b>`).join(' · ')}`
    : 'No combos active in their build.';
}

function renderDraft(){
  const me = G.p[G.turn];
  /* combos the bench currently forms, plus what each shop card WOULD
     complete if bought — the preview is the whole point of the system,
     since a combo you cannot see coming is just a hidden stat */
  const myBuild = toBuild(me);
  const liveCombos = activeCombos(myBuild);
  const liveMembers = new Set(liveCombos.flatMap(c=>c.members));
  const liveIds = new Set(liveCombos.map(c=>c.id));

  $('#whoTurn').textContent = `${Save.data.names[G.turn]} · DRAFTING`;
  $('#whoTurn').className = 'turnpill ' + (G.turn?'p2':'p1');
  /* the shared pool is the competitive hook — show what is left to fight over */
  $('#roundTxt').title = `${G.pool.length} cards left in the shared pool`;
  $('#goldTxt').textContent = `⬤ ${me.gold}`;
  $('#roundTxt').textContent = `Round ${G.round} / ${ROUNDS}`;
  /* the series scoreline sits next to the round, so the stakes of this
     particular draft are always on screen while you spend */
  const st = $('#seriesTxt');
  if(st){
    if(G.series){
      st.style.display = '';
      st.innerHTML = `${seriesPips()} &nbsp;<span style="opacity:.75">first to ${SERIES_TARGET}</span>`;
      st.title = `Series ${G.wins[0]}–${G.wins[1]}`;
    } else st.style.display = 'none';
  }
  renderFoePanel();
  $('#bReroll').textContent = `Reroll · ${REROLL}`;
  $('#bReroll').disabled = me.gold < REROLL;
  /* in a series every round ends in a fight, so the last turn of every
     round is the one that opens the gate */
  $('#bDone').textContent = G.turn === 1 || (G.vsAI && G.turn === 0)
    ? (G.series || G.round === ROUNDS ? 'Enter the Arena' : 'End Turn')
    : 'End Turn';
  renderComboBar(liveCombos);

  /* shop */
  const shop = $('#shop'); shop.innerHTML='';
  G.shop.forEach((cell,i)=>{
    const sk = cell.sk, c = COST[sk.tier];
    const owned = me.own[sk.id];
    const lvl = owned ? owned.lvl : 1;
    /* would buying this card open a combo the bench does not already have? */
    const after = owned ? myBuild : [...myBuild, {id:sk.id, lvl:1}];
    const gained = owned ? [] : activeCombos(after).filter(c=>!liveIds.has(c.id));
    const el = document.createElement('div');
    el.className = 'card-s' + (cell.bought?' dead':'') + (armed===i?' armed':'')
      + (gained.length?' willcombo':'');
    el.innerHTML = `
      <div class="tierbar" style="background:${sk.col}"></div>
      <button class="info" aria-label="Inspect ${sk.name}">i</button>
      <div class="tag" style="color:${sk.col}">${TIER_NAME[sk.tier]} · ${sk.kind}</div>
      <div class="nm">${sk.name}</div>
      <div class="fams">${famChips(sk.id)}</div>
      <div class="desc">${sk.txt||''}</div>
      ${gained.length?`<div class="willc">▲ ${gained.map(c=>c.name).join(' · ')}</div>`:''}
      <div class="row"><span class="stats">${skillLine(sk,lvl)}</span>
        <span class="grow"></span>${armed===i
          ? `<span class="confirm">Tap to buy</span>`
          : `<span class="cost gold">⬤${c}</span>`}</div>`;
    el.querySelector('.info').onclick = ev=>{
      ev.stopPropagation();            /* inspect only, never buys */
      showDetail(sk, lvl, true);
    };
    el.onclick = ()=>{
      if(TOUCH && armed !== i){
        /* first tap: inspect + arm, so nothing is ever bought blind */
        armed = i; sfx.click(); showDetail(sk, lvl, true); renderDraft(); return;
      }
      armed = null; buy(i);
    };
    el.onmouseenter = ()=>{ if(!TOUCH) showDetail(sk, lvl); };
    shop.append(el);
  });

  /* bench */
  const bench = $('#bench'); bench.innerHTML='';
  const entries = Object.entries(me.own);
  $('#benchCount').textContent = `${entries.length}/${MAX_SKILLS}`;
  for(const [id,e] of entries){
    const sk = BY_ID[id];
    const el = document.createElement('div');
    /* the glowing border the brief asked for: a skill currently forming
       a combo is lit, and names which combo it feeds */
    const inCombo = liveMembers.has(id);
    const mine = liveCombos.filter(c=>c.members.includes(id));
    el.className = 'own' + (inCombo?' combo':'');
    if(inCombo) el.style.setProperty('--cg', comboCol(mine[0]));
    const pips = e.lvl<3
      ? [0,1,2].map(i=>`<div class="pip ${i<e.count?'f':''}"></div>`).join('')
      : `<div class="pip f"></div>`;
    el.innerHTML = `
      <div class="top"><span class="nm" style="color:${sk.col}">${sk.name}</span>
        <span class="lvl ${e.lvl===2?'l2':e.lvl===3?'l3':''}">LV ${e.lvl}</span></div>
      <div class="fams">${famChips(id)}</div>
      <div class="pips">${pips}</div>
      <div class="stats">${skillLine(sk,e.lvl)}</div>
      ${mine.length?`<div class="inc">◈ ${mine.map(c=>c.name).join(' · ')}</div>`:''}
      <div class="row"><span class="stats" style="color:#6a769c">${e.lvl<3?`${e.count}/3 to next`:'max level'}</span>
        <span class="grow"></span>
        <button class="sellb">Sell ⬤${sellValue(id)}</button></div>`;
    el.querySelector('.sellb').onclick = ev=>{ ev.stopPropagation(); sell(id); };
    el.onmouseenter = ()=>{ if(!TOUCH) showDetail(sk, e.lvl); };
    el.onclick = ()=>showDetail(sk, e.lvl, true);
    bench.append(el);
  }
  if(!entries.length) bench.innerHTML = `<div class="stats">Nothing drafted yet.</div>`;
}

function showDetail(sk, lvl, open){
  const rows = [1,2,3].map(L=>{
    const d = dmgOf(sk,L);
    return `<tr${L===lvl?' style="color:#fff"':''}><td>LV ${L}</td>
      <td>${d?d+(sk.hits>1?'×'+sk.hits:''):'—'}</td>
      <td>${d?effDps(sk,L):'—'}</td>
      <td>${skillLine(sk,L).split(' · ').slice(d?1:0,-1).join(', ')||'—'}</td></tr>`;
  }).join('');
  $('#detail').innerHTML = `
    <span class="dclose" role="button" aria-label="Close">✕</span>
    <div style="font-weight:750;font-size:14px;color:${sk.col}">${sk.name}</div>
    <div class="stats" style="margin-bottom:6px">${TIER_NAME[sk.tier]} · ${sk.kind} · ${sk.cd}s cooldown</div>
    <p style="color:#98a3c6;font-size:11.5px;margin:0 0 10px">${sk.txt||''}</p>
    <table><thead><tr><th>Lvl</th><th>Hit</th><th>DPS</th><th>Effect</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="stats" style="margin-top:10px;color:#6a769c">
      ${KIND_LORE[sk.kind]||''}${sk.fx&&FX_LORE[sk.fx]?' '+FX_LORE[sk.fx]:''}</p>`;
  const sheet = $('#detail').closest('.panel');
  $('#detail').querySelector('.dclose').onclick = ()=>sheet.classList.remove('open');
  /* on narrow screens the detail panel is a bottom sheet — raise it on demand */
  if(open) sheet.classList.add('open');
}
/* ═══════════════════════════════════════════════════════════════
   BATTLE + RESULT
   ═══════════════════════════════════════════════════════════════ */
/* Everything a fight needs zeroed, with no opinion about who is fighting.
   PvE and the duel share it so a fix to one can't drift out of the other. */
function resetBattleFx(){
  fitCanvas();
  sdBanner = 0;
  floats=[]; rings=[]; ghosts=[]; slashes=[]; shards=[]; glyphs=[];
  for(const p of parts) p.live=false;
  shake=0; flashScr=0; elapsed=0; acc=0; endHold=0;
  Time.scale=1; Time.target=1; Time.slowLeft=0; Time.cooldown=0;
  Time.zoom=1; Time.zTarget=1; Time.aberr=0;
  $('#log').innerHTML=''; $('#slowtag').style.opacity='0';
  /* force both rails to rebuild: they cache by fighter identity, and a
     rematch makes new Fighters with the same names */
  railState[0].f = railState[1].f = null;
  $('#sk1').innerHTML=''; $('#sk2').innerHTML='';
  $('#sk2')._sig = null;
  /* and drop the slot bookkeeping, or a rebuilt rail would think it is
     already padded to the right height */
  for(const h of [$('#sk1'), $('#sk2')]){ h._slots = null; h._real = null; }
  $('#cc1').textContent=''; $('#cc2').textContent='';
  /* the bar caches by fighter identity too, and a rematch makes new
     Fighters — without this the buttons would still point at the corpses
     of the last fight */
  ultState.sig = null; ultState.btns = []; $('#ultbar').innerHTML = '';
  $('#rail1').classList.remove('gag'); $('#rail2').classList.remove('gag');
  World.headless = false;
}

function beginBattle(){
  show('battle');
  resetBattleFx();
  const [n1,n2] = Save.data.names;
  $('#n1').textContent = n1; $('#n2').textContent = n2;
  sim = new Sim(G.builds[0], G.builds[1], World);
  /* Build codes deliberately carry no name: they are pasted between
     strangers, so a name field in them would be someone else's free text
     rendered on your screen. Renaming the fighter rather than just the
     header means the ledger and the battle log agree with it. */
  if(Ghost.active) sim.f[1].name = GHOST_NAME;
  /* Round-scaled health, identical on both sides. A round-1 build is one or
     two skills; against a full 4200 pool it cannot close the fight before
     the tithe, so the sudden-death rule would decide the round instead of
     the drafts. Scaling the pool to the gold spent keeps every round a real
     fight. Set before setChamp, since a champion may read `max`. */
  if(G.series){
    const hp = roundHp(G.round);
    for(const f of sim.f){ f.max = hp; f.hp = hp; }
  }
  /* assigned after construction rather than through the constructor: the
     balance harness builds Sims with no champions at all and must keep
     producing the same numbers it always did */
  sim.f[0].setChamp(G.champs[0]);
  sim.f[1].setChamp(G.champs[1]);
  /* in hotseat BOTH sides are human, so nothing is auto-fired; in 1P the
     rival needs a hand on its own button */
  sim.f[1].autoUlt = G.vsAI;
  /* epithet is derived from the drafted kit, so it changes run to run */
  $('#n1').innerHTML = `${sim.f[0].name} <i style="opacity:.7;font-weight:500">${sim.f[0].title}</i>`;
  $('#n2').innerHTML = `<i style="opacity:.7;font-weight:500">${sim.f[1].title}</i> ${sim.f[1].name}`;
  syncHud();
  if(G.series){
    const need = SERIES_TARGET;
    log(`<b>Round ${G.round} of ${ROUNDS}</b> — series ${G.wins[0]}–${G.wins[1]}, first to ${need}.`);
  } else if(Ghost.active){
    log(`A <b style="color:#a97bff">ghost</b> stands in the arena — someone else's build, fought on your terms.`);
  } else log('The gate opens.');
  last = performance.now(); running = true;
}

