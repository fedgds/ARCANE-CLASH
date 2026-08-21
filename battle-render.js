/* ═══════════════════════════════════════════════════════════════
   BATTLE RENDER — canvas 2D renderer, fixed-timestep main loop,

   and HUD/rail synchronisation.

   Owns cv/ctx, the particle pool, and frame(). The sim never knows
   this exists. The rAF loop starts on load, but frame() returns
   immediately until running=true, so it costs nothing before boot.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";
/* ═══════════════════════════════════════════════════════════════
   RENDERER — canvas 2D, pooled particles, additive glow.
   The sim never knows this exists; it only emits events.
   ═══════════════════════════════════════════════════════════════ */

const cv = $('#cv'), ctx = cv.getContext('2d', {alpha:false});
let VIEW = {s:1, ox:0, oy:0, w:0, h:0};

function fitCanvas(){
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio||1, 2);
  cv.width = Math.round(r.width*dpr); cv.height = Math.round(r.height*dpr);
  const s = Math.min(r.width/ARENA_W, r.height/ARENA_H);
  VIEW = {s:s*dpr, ox:(r.width-ARENA_W*s)/2*dpr, oy:(r.height-ARENA_H*s)/2*dpr,
          w:r.width*dpr, h:r.height*dpr};
}
addEventListener('resize', fitCanvas);

/* ---------- pools ---------- */
const P_MAX = 2600;
const parts = new Array(P_MAX);
for(let i=0;i<P_MAX;i++) parts[i] = {live:false};
let pHead = 0;
function spawn(o){
  for(let i=0;i<P_MAX;i++){
    const p = parts[(pHead+i)%P_MAX];
    if(!p.live){
      pHead = (pHead+i+1)%P_MAX;
      p.live=true; p.x=o.x; p.y=o.y; p.vx=o.vx||0; p.vy=o.vy||0;
      p.life=p.max=o.life||0.6; p.col=o.col||'#fff'; p.r=o.r||3;
      p.drag=o.drag??0.92; p.grav=o.grav||0; p.sh=o.sh||'dot'; p.rot=o.rot||0;
      p.spin=o.spin||0; p.add=o.add!==false;
      return p;
    }
  }
  return null;
}
function burst(x,y,col,n,pow){
  for(let i=0;i<n;i++){
    const a=rnd(TAU), sp=rnd(260,60)*pow;
    spawn({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-40,col,
      life:rnd(.62,.26),r:rnd(3.4,1.1)*pow,grav:220,drag:0.9,
      sh: Math.random()<.35?'streak':'dot', rot:a, spin:rnd(6,-6)});
  }
}
function smoke(x,y,col,n){
  for(let i=0;i<n;i++){
    const a=rnd(TAU), sp=rnd(60,10);
    spawn({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-30,col,
      life:rnd(1.4,.7),r:rnd(20,9),drag:0.96,sh:'soft',add:false});
  }
}
/* ---------- transient visual layers ---------- */
let floats=[], rings=[], ghosts=[], slashes=[], beams=[];
let shake=0, flashScr=0, flashCol='#fff';
let sdBanner=0;         // sudden-death announcement timer
/* ── the fused cast: a whole cinematic, not a bigger cast flare ──
   A fusion cost two or three draft slots and cannot be bought, rolled or
   levelled. It fires maybe five times in a battle. So it does not share the
   ordinary cast vocabulary at all — it gets its own staged sequence, and
   every stage is doing a different job:

     IMPLOSION  motes rip INWARD off a wide ring. Nothing else in the game
                converges on the caster, so this alone says "something is
                being gathered" before a single pixel of damage lands. It
                also buys the wind-up read without delaying the sim, which
                already resolved the cast the frame this fires.
     DETONATION white core, three staggered shockwaves, a spoke star, and a
                time punch. The punch is the single biggest lever: the world
                briefly stops, which is how the player FEELS tier rather
                than reading it.
     THE RITE   a dual counter-rotating sigil on the floor with one arc per
                parent family and one pip per grade. This is the part that
                is unmistakably a fusion: the recipe is drawn, at size, in
                the arena.
     COLUMN     a light shaft up through the caster. Vertical is the one
                axis the arena never uses, so it cuts through everything.
     BANNER     the name, wiped in over a slab, split into its two family
                colours, with the recipe spelled out underneath.

   Everything is throttled by fzBanner so a low-cooldown fusion cannot
   strobe, and the whole rite is suppressed while headless. */
const FZ_BANNER = 1.9;
let fzBanner=0, fzName='', fzCol='#fff', fzGrade=0;
let fzColA='#fff', fzColB='#fff', fzRecipe='', fzKind='';
let shards=[], glyphs=[], rites=[];
/* Floor seals a fused EFFECT stamps down (wards, orbit apparatus). Separate
   from `rites`, which is the cast cinematic and carries a whole staged
   timeline — a stamp is just a sigil on the ground with a lifetime. */
let stamps=[];

/* Easings the rite leans on. Local and prefixed so they cannot collide with
   anything the art files export. */
const fzOut  = p => 1 - Math.pow(1-p, 3);
const fzIn   = p => p*p;
/* overshoot: the sigil snaps past its radius then settles, which is what
   makes it land like a stamp instead of growing like a bubble */
const fzBack = p => { const c=2.2, q=p-1; return 1 + q*q*((c+1)*q + c); };

/* ── CC visual vocabulary ──
   Each kind needs to be legible in a half-second glance, so they differ on
   SHAPE, not just colour: stun orbits discrete stars, freeze encases in
   angular crystal, silence clamps a rune over the caster, root grows spikes
   from the floor. Colour reinforces but never carries the read alone —
   which also keeps it working for colour-blind players. */
const CC_VIS = {
  stun:    {col:'#ffd76b', ico:'✦', name:'STUNNED'},
  freeze:  {col:'#a8f0ff', ico:'❄', name:'FROZEN'},
  silence: {col:'#c4a8ff', ico:'⊘', name:'SILENCED'},
  root:    {col:'#9ad06b', ico:'❦', name:'ROOTED'}
};

/* ---------- time controller: the slow-motion system ----------
   timeScale only affects the SIM. The render loop keeps running
   at full rate, so slow-mo reads as cinematic, never as lag.     */
const Time = {
  scale:1, target:1, slowLeft:0, cooldown:0,
  zoom:1, zTarget:1, focus:{x:ARENA_W/2,y:ARENA_H/2}, aberr:0, lines:0,
  slowmo(x,y){
    if(this.cooldown>0) return false;
    this.cooldown = 2.6;          // gate it, or the fight stutters constantly
    this.slowLeft = 1.5;          // ← the requested 1.5s
    this.scale = 0.06; this.target = 0.12;
    this.zTarget = 1.55; this.focus.x=x; this.focus.y=y;
    this.aberr = 1; this.lines = 1;
    shake = Math.max(shake, 15);
    $('#slowtag').style.opacity = '1';
    return true;
  },
  /* A fused cast's time hitch. Deliberately NOT slowmo():
       · ungated — slowmo() is rate-limited against the crit stream, and a
         fusion that landed inside a crit's 2.6s shadow would silently lose
         the one beat that sells it;
       · shorter and shallower — 0.3s at 0.18 scale reads as a PUNCH, where
         slowmo's 1.5s at 0.06 reads as an action replay. The fusion should
         hit like a downbeat, not stop the fight;
       · no #slowtag — the banner is already naming what happened, and two
         labels at once is noise.
     It still nudges slowmo's cooldown so a crit landing in the same frame
     cannot stack a second, deeper stretch on top of this one. */
  punch(x,y){
    this.slowLeft = Math.max(this.slowLeft, 0.72);   // 0.3s hold, then ease
    this.scale = Math.min(this.scale, 0.05); this.target = 0.18;
    this.zTarget = 1.3; this.focus.x = x; this.focus.y = y;
    this.aberr = 1; this.lines = 1;
    this.cooldown = Math.max(this.cooldown, 1.1);
  },
  update(rdt){                    // rdt = REAL delta, unscaled
    this.cooldown = Math.max(0, this.cooldown-rdt);
    if(this.slowLeft>0){
      this.slowLeft -= rdt;
      this.scale = lerp(this.scale, this.target, 1-Math.pow(0.001,rdt));
      if(this.slowLeft < 0.42){    // ease back out
        this.target = 1; this.zTarget = 1;
        $('#slowtag').style.opacity = '0';
      }
    } else {
      this.scale = lerp(this.scale, 1, 1-Math.pow(0.0001,rdt));
      this.target = 1; this.zTarget = 1;
    }
    this.zoom  = lerp(this.zoom, this.zTarget, 1-Math.pow(0.004,rdt));
    this.aberr = lerp(this.aberr, this.slowLeft>0.42?1:0, 1-Math.pow(0.01,rdt));
    this.lines = Math.max(0, this.lines - rdt*1.5);
  }
};

/* ---------- world: bridges sim events into visuals ---------- */
const World = {
  headless:false,
  on(type, d){
    if(this.headless) return;
    switch(type){
      case 'hit': {
        floats.push({x:d.x+rnd(16,-16), y:d.y-26, vy:-52, life:d.crit?1.15:0.8,
          max:d.crit?1.15:0.8, txt:(d.crit?'':'')+Math.round(d.dmg), crit:d.crit,
          col:d.crit?'#fff':d.col});
        shake = Math.min(26, shake + (d.crit?9:2.2));
        if(d.crit){
          flashScr = 0.85; flashCol = d.col;
          rings.push({x:d.x,y:d.y,r:12,vr:900,life:.5,max:.5,col:'#fff',w:5});
          rings.push({x:d.x,y:d.y,r:6,vr:420,life:.75,max:.75,col:d.col,w:12});
          burst(d.x,d.y,'#ffffff',26,2.4); burst(d.x,d.y,d.col,34,2.1);
          smoke(d.x,d.y,'#2a2038',8);
          /* a crisp spike-star: eight fast streaks fired on the cardinals and
             diagonals, so a crit punctuates with a readable STAR, not just a
             fuzzy cloud of sparks */
          for(let s=0;s<8;s++){ const aa=s*TAU/8;
            spawn({x:d.x, y:d.y, vx:Math.cos(aa)*rnd(560,360), vy:Math.sin(aa)*rnd(560,360),
              col:'#fff', life:.24, r:2.6, drag:0.8, sh:'streak', add:true}); }
          /* Only a *meaningful* crit stops the world. Rain/field skills land
             many small ticks; without this floor the fight would spend most
             of its life in slow motion.
             Floor chosen from the measured crit distribution (2545 crits over
             140 battles): median crit is 1.62% of max HP, so a 3.5% floor left
             11% of battles with NO slow-mo at all. 1.5% passes ~53% of crits
             and yields ~3.2 slow-mos per 13.6s battle, zero empty battles. */
          if(d.dmg >= d.tgt.max*0.015){ Time.slowmo(d.x,d.y); sfx.crit(d.x); }
          else sfx.hit(d.x);
          log(`<b style="color:#fff">CRITICAL</b> — ${d.src.name} hits for ${Math.round(d.dmg)}`);
        } else if(d.dmg > d.tgt.max*0.004) sfx.hit(d.x);   /* skip DoT ticks */
        break;
      }
      case 'crit': break;
      /* ── crowd control landing ──
         Two very different messages share this event: the lock LANDED, or it
         was eaten by diminishing returns. A resist that looked identical to a
         hit would make DR feel like a bug, so the resist path gets its own
         muted grey treatment and says so in words. */
      case 'cc': {
        const v = CC_VIS[d.kind]; if(!v) break;
        const tx = d.tgt.x, ty = d.tgt.y - 8;
        if(d.dur <= 0.01){
          floats.push({x:tx, y:ty-46, vy:-40, life:.85, max:.85,
            txt:'RESIST', col:'#8b93a8'});
          rings.push({x:tx,y:ty,r:30,vr:120,life:.3,max:.3,col:'#8b93a8',w:2});
          sfx.resist(tx);
          log(`${d.tgt.name} <b style="color:#8b93a8">resists</b> ${v.name.toLowerCase()}`);
          break;
        }
        /* impact: a hard ring plus a converging cage of shards */
        rings.push({x:tx,y:ty,r:16,vr:520,life:.42,max:.42,col:v.col,w:6});
        rings.push({x:tx,y:ty,r:8,vr:260,life:.6,max:.6,col:'#fff',w:2.5});
        for(let i=0;i<14;i++){
          const a = rnd(TAU), rr = rnd(96,58);
          shards.push({x:tx+Math.cos(a)*rr, y:ty+Math.sin(a)*rr,
            tx, ty, life:.34, max:.34, col:v.col, ang:a, r:rnd(13,6)});
        }
        burst(tx,ty,v.col,20,1.5);
        glyphs.push({x:tx, y:ty-52, life:.9, max:.9, txt:v.ico, col:v.col});
        floats.push({x:tx, y:ty-70, vy:-34, life:.9, max:.9,
          txt:v.name, col:v.col});
        shake = Math.min(26, shake + 7);
        flashScr = Math.max(flashScr, 0.3); flashCol = v.col;
        sfx.cc(d.kind, tx);
        log(`${d.src.name} — <b style="color:${v.col}">${v.name}</b> ${d.tgt.name} (${d.dur.toFixed(1)}s)`);
        break;
      }
      case 'burst': {
        /* An impact carries the element of whatever landed it. `el` is a
           cosmetic hint from the sim (never read back); when present the
           debris flies with that element's shape and motion, so a fire hit
           throws rising embers and a frost hit sheds falling shards. */
        const e = d.el ? (EFX[d.el] || EFX_DEFAULT) : null;
        if(!e) burst(d.x,d.y,d.col,d.n,d.pow);
        else {
          glow(d.x,d.y,(10+d.n*0.6)*e.glow,d.col,0.6);
          for(let i=0;i<d.n;i++){ const aa=rnd(TAU), sp=rnd(220,40)*d.pow;
            spawn({x:d.x, y:d.y, vx:Math.cos(aa)*sp, vy:Math.sin(aa)*sp+e.rise*0.4,
              col:i%4? d.col : e.core, life:rnd(.55,.2), r:rnd(3.6,1.2)*d.pow,
              grav:e.grav, drag:e.drag, sh:e.sh, rot:aa, spin:rnd(6,-6)}); }
        }
        /* A fusion's contact reads as a fusion. Damped to 0.62 because a
           multi-target nova or an 8-tick field fires this once per victim per
           tick — at full strength the pool would thin out mid-battle. */
        if(d.sk && d.sk.fused) fzImpact(d.x, d.y, d.sk, d.pow*0.62);
        break;
      }
      case 'shock': {
        rings.push({x:d.x,y:d.y,r:8,vr:d.r*3.4,life:.42,max:.42,col:d.col,w:7});
        /* ground scorch/frost-bloom under a landed rain strike, tinted by the
           element's smoke colour when it has one */
        smoke(d.x,d.y,(d.el && (EFX[d.el]||{}).smoke) || d.col,5);
        /* A fused strike cracks the floor in both parent colours. Rings only,
           no particles — the `burst` that lands alongside this brings those. */
        if(d.sk && d.sk.fused){
          const ink = fzInk(d.sk);
          rings.push({x:d.x,y:d.y,r:10,vr:d.r*4.6,life:.50,max:.50,col:ink.b,w:11,sq:0.34});
          rings.push({x:d.x,y:d.y,r:6, vr:d.r*2.1,life:.68,max:.68,col:ink.a,w:5, sq:0.34});
        }
        shake=Math.min(26,shake+5); break;
      }
      case 'slash': {
        slashes.push({x:d.x,y:d.y,ang:d.ang,life:.26,max:.26,col:d.col,len:rnd(150,90)});
        /* the strike sheds its element on contact — a fire dash leaves embers
           rising, a frost dash flings shards, a blade dash sprays fast streaks */
        const e = EFX[d.el] || EFX_DEFAULT;
        for(let i=0;i<8;i++){ const aa=rnd(TAU);
          spawn({x:d.x, y:d.y, vx:Math.cos(aa)*rnd(200,60), vy:Math.sin(aa)*rnd(180,50)+e.rise*0.5,
            col:d.col, life:rnd(.4,.18), r:rnd(3.4,1.2), grav:e.grav, drag:e.drag, sh:e.sh, rot:aa}); }
        /* a fused dash cuts twice — the second stroke crosses the first, one
           blade per parent family, so Sanguine Edge and Ten Thousand Winds
           land an X rather than a single line */
        if(d.sk && d.sk.fused){
          const ink = fzInk(d.sk);
          slashes.push({x:d.x,y:d.y,ang:d.ang+1.05,life:.30,max:.30,col:ink.b,len:rnd(190,120)});
          slashes.push({x:d.x,y:d.y,ang:d.ang-0.34,life:.22,max:.22,col:ink.hot,len:rnd(230,150)});
          fzImpact(d.x, d.y, d.sk, 0.9);
        }
        break;
      }
      case 'ghost': ghosts.push({x:d.x,y:d.y,life:.34,max:.34,side:d.side,col:d.col,el:d.el}); break;
      case 'heal':
        if(d.amt > 12) sfx.heal(d.f.x);
        floats.push({x:d.f.x,y:d.f.y-60,vy:-46,life:.9,max:.9,txt:'+'+Math.round(d.amt),col:'#8dffa8'});
        /* motes drift UP and gather — restoration reads as something being
           given back, the opposite of damage scattering away */
        for(let i=0;i<18;i++) spawn({x:d.f.x+rnd(30,-30),y:d.f.y+rnd(24,-24),
          vx:rnd(24,-24),vy:rnd(-70,-130),col:'#8dffa8',life:rnd(1,.5),r:rnd(3.6,1.4),grav:-30});
        /* a soft contracting ring for larger heals — a visible "mend" pulse */
        if(d.amt > 12){
          rings.push({x:d.f.x,y:d.f.y,r:52,vr:-70,life:.5,max:.5,col:'#8dffa8',w:3});
          glow(d.f.x,d.f.y-6,40,'#8dffa8',0.4);
        }
        break;
      case 'buff': {
        sfx.shield(d.f.x);
        const e = efxOf(d.sk);
        rings.push({x:d.f.x,y:d.f.y,r:60,vr:-90,life:.55,max:.55,col:d.sk.col,w:4});
        /* the gather-in motes wear the caster's element: a summon's pact
           pulls dark motes inward, a holy blessing draws bright ones */
        for(let i=0;i<22;i++){const a=rnd(TAU);
          efxSpark(d.sk, d.f.x+Math.cos(a)*70, d.f.y+Math.sin(a)*70,
            {vx:-Math.cos(a)*150, vy:-Math.sin(a)*150, life:.5, r:rnd(3.6,1.6), drag:.9, rise:0.3});}
        glow(d.f.x,d.f.y,60*e.glow,d.sk.col,0.5);
        /* a fused ward stamps its own seal on the floor and rises on a
           two-tone collar — Sanctuary and Nowhere Ward should not share a
           silhouette with a common shield */
        if(d.sk.fused){
          const ink = fzInk(d.sk);
          stamps.push({ink, x:d.f.x, y:ARENA_H+18, rad:104, life:0.95, max:0.95});
          rings.push({x:d.f.x, y:ARENA_H+18, r:20, vr:200, life:.55, max:.55,
            col:ink.b, w:6, sq:0.30});
          for(let i=0;i<Math.round(14*ink.k);i++){
            const aa = rnd(TAU);
            fzMote(d.sk, d.f.x+Math.cos(aa)*90, ARENA_H+18+Math.sin(aa)*28,
              {vx:-Math.cos(aa)*60, vy:rnd(-120,-220), life:rnd(1,.5)});
          }
        }
        log(`${d.f.name} — <b style="color:${d.sk.col}">${d.sk.name}</b>`);
        break;
      }
      case 'cast':
        if(d.basic) sfx.basic(d.f.x); else sfx.cast(d.sk, d.f.x);
        if(!d.basic){
          log(`${d.f.name} casts <b style="color:${d.sk.col}">${d.sk.name}</b>`);
          flareSkill(d.f, d.idx);
          /* the cast flash sheds the skill's element, so you can read what's
             coming from the burst around the caster before the act resolves */
          for(let i=0;i<12;i++){const a=rnd(TAU);
            efxSpark(d.sk, d.f.x, d.f.y-8, {ang:a, spd:rnd(160,50), life:rnd(.5,.2), r:rnd(3,1.2)});}
          /* A FUSION does not use the cast vocabulary — see fuseCast(). */
          if(d.sk.fused) fuseCast(d.sk, d.f);
        }
        break;
      case 'shieldHit':
        rings.push({x:d.t.x,y:d.t.y,r:44,vr:60,life:.3,max:.3,col:'#dff0ff',w:3}); break;
      /* A summon's ARRIVAL is half of how you tell the three pets apart —
         by the time the sprite has settled the moment has passed, so each
         one announces itself with its own element, sound and weight. The
         sim already emitted these two events; nothing was listening. */
      case 'spawn': {
        const f = d.f;
        if(!f.minion) break;            // champions and mobs enter silently
        if(f.petArt === 'direwolves'){
          /* wolves come up out of the floor: dirt, low scuff, small kick */
          sfx.noise(0.18, 0.18, 520, 0.9, 0, {pan:sfx.panOf(f.x), cents:80});
          for(let i=0;i<16;i++){
            const a = rnd(TAU);
            spawn({x:f.x+rnd(16,-16), y:f.y+16, vx:Math.cos(a)*rnd(180,60), vy:rnd(-30,-130),
              col:'#c9a67e', life:rnd(.6,.3), r:rnd(3.2,1.4), grav:320, drag:0.9});
          }
          rings.push({x:f.x, y:f.y+14, r:6, vr:230, life:.35, max:.35, col:'#ffb98a', w:3});
          shake = Math.min(20, shake+3);
        } else if(f.petArt === 'bonebulwark'){
          /* the sentinel is assembled, not conjured: shards fly OUT and the
             floor takes the hit, which is what sells it as the tanky one */
          sfx.tone(90, 0.30, 'square', 0.20, 44, 0, {pan:sfx.panOf(f.x), partial:1.5, wet:0.3});
          sfx.noise(0.22, 0.24, 300, 0.7, 0, {pan:sfx.panOf(f.x), cents:60});
          for(let i=0;i<15;i++)
            spawn({x:f.x+rnd(20,-20), y:f.y+rnd(10,-16), vx:rnd(170,-170), vy:rnd(-60,-230),
              col:'#e8dcc0', life:rnd(.8,.4), r:rnd(3.6,1.6), grav:420, drag:0.92,
              sh:'streak', rot:rnd(TAU), spin:rnd(8,-8)});
          rings.push({x:f.x, y:f.y+12, r:10, vr:300, life:.45, max:.45, col:'#e8dcc0', w:5});
          smoke(f.x, f.y+10, '#3a3122', 6);
          shake = Math.min(26, shake+9);
        } else {
          /* the wraith is pulled INWARD from the dark — motes converge and
             the ring collapses, the opposite gesture from the other two */
          sfx.tone(660, 0.34, 'sine', 0.12, 300, 0, {pan:sfx.panOf(f.x), partial:2, wet:0.36});
          for(let i=0;i<20;i++){
            const a = rnd(TAU), rr = rnd(90,50);
            spawn({x:f.x+Math.cos(a)*rr, y:f.y+Math.sin(a)*rr*0.7,
              vx:-Math.cos(a)*rnd(190,110), vy:-Math.sin(a)*rnd(150,80)-20,
              col:'#9ecfff', life:rnd(.55,.3), r:rnd(3.4,1.4), drag:0.9});
          }
          rings.push({x:f.x, y:f.y, r:56, vr:-115, life:.5, max:.5, col:'#9ecfff', w:3});
        }
        break;
      }
      /* a pet timing out is not a death — soft, local, and it leaves nothing
         behind, so an expiry never reads as "something just died" */
      case 'unsummon': {
        const f = d.f;
        sfx.tone(400, 0.22, 'sine', 0.08, 170, 0, {pan:sfx.panOf(f.x), wet:0.2});
        smoke(f.x, f.y, f.petArt === 'bonebulwark' ? '#4a3f2c' : '#2a2440', 5);
        for(let i=0;i<12;i++)
          spawn({x:f.x+rnd(14,-14), y:f.y+rnd(10,-10), vx:rnd(50,-50), vy:rnd(-40,-110),
            col:f.accent || '#cfe4ff', life:rnd(.7,.35), r:rnd(3,1.2), grav:-30, drag:0.93});
        rings.push({x:f.x, y:f.y, r:22, vr:90, life:.35, max:.35, col:f.accent || '#cfe4ff', w:2});
        break;
      }
      case 'death': {
        const f = d.f;
        /* A minion popping should not read like a champion falling. The
           `quiet` flag (set when pets are cleaned up) gets a small, local
           puff — no full-screen flash, no world-stopping shake. */
        if(d.quiet || f.minion){
          sfx.death(f.x);
          rings.push({x:f.x,y:f.y,r:8,vr:520,life:.5,max:.5,col:f.side?'#ff8fae':'#7fd4ff',w:5});
          burst(f.x,f.y,'#ffffff',24,1.6); burst(f.x,f.y,f.side?'#ff5d7a':'#5fd0ff',30,1.4);
          smoke(f.x,f.y,'#241c33',8);
          shake = Math.min(26, shake+6);
          break;
        }
        sfx.death(f.x);
        for(let w=0;w<3;w++) rings.push({x:f.x,y:f.y,r:10+w*20,vr:700-w*140,life:.9,max:.9,
          col:w?f.side?'#ff8fae':'#7fd4ff':'#fff',w:9-w*2});
        burst(f.x,f.y,'#ffffff',90,3); burst(f.x,f.y,f.side?'#ff5d7a':'#5fd0ff',110,2.6);
        smoke(f.x,f.y,'#241c33',26);
        /* a slow column of embers rises off the fallen champion — the moment
           lingers a beat instead of just flashing and clearing */
        for(let i=0;i<26;i++)
          spawn({x:f.x+rnd(34,-34), y:f.y+rnd(10,-30), vx:rnd(30,-30), vy:rnd(-40,-150),
            col:f.side?'#ffb0c4':'#bfe4ff', life:rnd(1.5,.7), r:rnd(3.4,1.2), grav:-24, drag:0.95});
        shake = 30; flashScr = 1; flashCol='#fff';
        break;
      }
      /* sudden death: the arena itself starts billing everyone still up */
      case 'sudden':
        sfx.sudden();
        sdBanner = 2.6;
        log(`<b style="color:#ffb37a">SUDDEN DEATH</b> — the arena claims
             ${Math.round(SD_FRAC*100)}% max hp from every survivor, every ${SD_PERIOD}s`);
        break;
      /* one tithe landing. Without a beat of feedback the bars would just
         lurch down on their own every five seconds with nothing on screen
         to blame it on. */
      case 'suddenTick': {
        sfx.sudden();
        shake = Math.min(26, shake + 8);
        flashScr = 0.5; flashCol = '#ff7a4a';
        for(const f of d.fighters){
          if(f.dead) continue;
          const amt = Math.min(f.hp, f.max * d.frac);
          floats.push({x:f.x+rnd(14,-14), y:f.y-40, vy:-46, life:0.9, max:0.9,
            txt:'-'+Math.round(amt), crit:false, col:'#ff8a5a'});
          burst(f.x, f.y-8, '#ff6a3a', 10, 1.1);
        }
        log(`The arena takes its due — <b style="color:#ffb37a">${Math.round(d.frac*100)}%</b> max hp`);
        break;
      }
      case 'draw':
        log(`<b style="color:#cbb6ff">DRAW</b> — neither champion yields`);
        break;

      /* ══ CHAMPION ULTIMATES ══
         These are the only hand-fired events in the game, so they are
         allowed to be louder than anything a skill does. The player pressed
         a button; the screen has to answer. */
      case 'ultCast': {
        const f = d.f, c = d.champ;
        sfx.ult(c.id, f.x);
        shake = Math.min(26, shake + 7);
        flashScr = 0.5; flashCol = c.acc;
        rings.push({x:f.x, y:f.y, r:16, vr:520, life:.45, max:.45, col:'#fff', w:4});
        rings.push({x:f.x, y:f.y, r:8,  vr:250, life:.7,  max:.7,  col:c.acc, w:9});
        for(let i=0;i<26;i++){ const a = i*TAU/26;
          spawn({x:f.x, y:f.y, vx:Math.cos(a)*rnd(400,220), vy:Math.sin(a)*rnd(400,220),
            col:c.acc, life:.4, r:2.6, drag:.85, sh:'streak', add:true}); }
        log(`${f.name} — <b style="color:${c.acc}">${c.name}</b>`);
        break;
      }
      /* Reversal ate a hit. This has to look like a REFUSAL, not like a
         hit that missed: the number still appears, but gold and rising,
         and it is the ward that flashes rather than the body. */
      case 'ultAbsorb': {
        const f = d.f;
        sfx.absorb(f.x);
        floats.push({x:f.x+rnd(16,-16), y:f.y-34, vy:-44, life:.85, max:.85,
          txt:'+'+Math.round(d.amt), col:'#ffce5a'});
        rings.push({x:f.x, y:f.y, r:56, vr:-150, life:.34, max:.34, col:'#ffce5a', w:3});
        for(let i=0;i<10;i++){ const a = rnd(TAU);
          spawn({x:f.x+Math.cos(a)*62, y:f.y+Math.sin(a)*62,
            vx:-Math.cos(a)*230, vy:-Math.sin(a)*230, col:'#ffce5a',
            life:.32, r:rnd(3.2,1.4), drag:.88, add:true}); }
        shake = Math.min(26, shake + 1.6);
        break;
      }
      /* the payout: everything banked leaves at once */
      case 'ultNova': {
        const f = d.f;
        sfx.nova(f.x);
        Time.slowmo(f.x, f.y);
        shake = Math.min(26, shake + 16);
        flashScr = 0.95; flashCol = '#ffce5a';
        rings.push({x:f.x, y:f.y, r:20, vr:1250, life:.55, max:.55, col:'#fff', w:6});
        rings.push({x:f.x, y:f.y, r:12, vr:820,  life:.8,  max:.8,  col:'#ffce5a', w:16});
        burst(f.x, f.y, '#ffffff', 34, 2.8); burst(f.x, f.y, '#ffce5a', 46, 2.5);
        smoke(f.x, f.y, '#3a2a12', 10);
        for(let s=0;s<14;s++){ const a = s*TAU/14;
          spawn({x:f.x, y:f.y, vx:Math.cos(a)*rnd(760,520), vy:Math.sin(a)*rnd(760,520),
            col:'#fff', life:.34, r:3, drag:.82, sh:'streak', add:true}); }
        log(`<b style="color:#ffce5a">REVERSAL</b> — ${Math.round(d.stored)} stored ·
             ${Math.round(d.heal)} healed · ${Math.round(d.blast)} returned to ${d.hit}`);
        break;
      }
      /* a window that ate nothing. It must be visibly, audibly WASTED —
         a silent no-op would read as a bug rather than as a misplay. */
      case 'ultFizzle': {
        const f = d.f;
        sfx.fizzle(f.x);
        floats.push({x:f.x, y:f.y-46, vy:-30, life:1, max:1, txt:'WASTED', col:'#6b7398'});
        rings.push({x:f.x, y:f.y, r:58, vr:-90, life:.4, max:.4, col:'#6b7398', w:2});
        log(`<b style="color:#8b93b8">REVERSAL</b> — nothing arrived. The window closes empty.`);
        break;
      }
      /* the theft. Two bursts: white at the catch, cyan trailing after the
         projectile as it turns — the eye needs to be told to follow it back. */
      case 'ultSteal': {
        sfx.steal(d.x);
        Time.slowmo(d.x, d.y);
        shake = Math.min(26, shake + 9);
        flashScr = 0.7; flashCol = '#9fe6ff';
        rings.push({x:d.x, y:d.y, r:10, vr:640, life:.42, max:.42, col:'#fff', w:5});
        rings.push({x:d.x, y:d.y, r:34, vr:-220, life:.4, max:.4, col:'#4ec3f5', w:4});
        burst(d.x, d.y, '#dff4ff', 22, 2.2);
        for(let s=0;s<12;s++){ const a = s*TAU/12;
          spawn({x:d.x, y:d.y, vx:Math.cos(a)*rnd(520,300), vy:Math.sin(a)*rnd(520,300),
            col:'#9fe6ff', life:.3, r:2.4, drag:.84, sh:'streak', add:true}); }
        floats.push({x:d.x, y:d.y-40, vy:-38, life:.95, max:.95, txt:'TAKEN', col:'#9fe6ff'});
        log(`<b style="color:#4ec3f5">SUPPRESSION</b> — ${d.f.name} takes
             ${d.a.sk && d.a.sk.name ? d.a.sk.name : 'the attack'} off ${d.from.name}`);
        break;
      }
      /* every cooldown emptied at once — the feedback is the RAIL, because
         that is where the player will look to see what they just bought */
      case 'ultForce': {
        const f = d.f;
        sfx.force(f.x);
        shake = Math.min(26, shake + 10);
        flashScr = 0.8; flashCol = '#ffce5a';
        rings.push({x:f.x, y:f.y, r:14, vr:900, life:.5, max:.5, col:'#ffce5a', w:5});
        rings.push({x:f.x, y:f.y, r:70, vr:-260, life:.42, max:.42, col:'#fff', w:3});
        burst(f.x, f.y, '#ffce5a', 30, 2.3);
        for(let i=0;i<Math.max(4, f.build.length);i++){
          const a = i*TAU/Math.max(4, f.build.length);
          spawn({x:f.x+Math.cos(a)*90, y:f.y+Math.sin(a)*90,
            vx:-Math.cos(a)*300, vy:-Math.sin(a)*300, col:'#ff9f6a',
            life:.38, r:3.2, drag:.86, sh:'streak', add:true});
        }
        floats.push({x:f.x, y:f.y-48, vy:-40, life:1, max:1,
          txt:d.refreshed ? `${d.refreshed} READY` : 'HASTE', col:'#ffce5a'});
        log(`<b style="color:#ffce5a">TOTAL FORCE</b> — ${d.refreshed} skill${d.refreshed===1?'':'s'}
             refreshed · triple cast speed`);
        break;
      }
    }
  }
};

/* Flash the rail row that just fired. Restarting a CSS animation needs the
   class removed, a reflow forced, then re-added — without the reflow the
   browser coalesces both changes and nothing plays on rapid re-casts. */
function flareSkill(f, idx){
  if(idx === undefined) return;
  const side = f.team === 0 ? 0 : 1;
  if(side === 1 && sim.pve) return;          // right rail shows monsters there
  if(railState[side].f !== f) return;        // that fighter isn't on screen
  const host = $(side ? '#sk2' : '#sk1'), el = host.children[idx];
  if(!el) return;
  el.classList.remove('fire');
  void el.offsetWidth;
  el.classList.add('fire');
}

/* ═══════════════════════════════════════════════════════════════
   THE FUSED CAST — the one moment in a battle that gets a cinematic

   Called once per fused cast, from the `cast` event. Everything here is
   fire-and-forget: it seeds particles, rings, a world-space rite and the
   screen banner, then returns. Nothing polls it and the sim never waits.

   Ordering below is the ordering on screen — implosion first because it is
   the only gesture that has to be read BEFORE the bang to work.
   ═══════════════════════════════════════════════════════════════ */
const FZ_RITE = 1.3;

/* The recipe drives the whole palette. elemsOf() returns every family the
   fusion carries, priority-ordered; two colours is what the eye can track,
   so the rest only feed the arcs on the sigil. Same-family recipes
   (Manafold, Null Aperture) collapse to one element and fall back to the
   skill colour for the second, which keeps them monochrome on purpose —
   they ARE the single-element fusions.

   Memoised by id: the cast rite needs this once, but the ACT renderers ask
   for it every frame for the whole duration of a field, and elemsOf walks
   the tag list each call. */
/* Family colour, with the skill's own as the fallback. Module scope rather
   than a local inside fzPal: fuseCast builds the rite's arcCols from it too,
   and as a local it was a ReferenceError that killed every fused cast after
   the detonation — taking the rite, column, halo and banner with it. */
const fzFamCol = (e, sk) => (FAMILY[e] && FAMILY[e].col) || (sk && sk.col) || '#ffffff';

const _fzPal = {};
function fzPal(sk){
  let p = _fzPal[sk.id];
  if(p) return p;
  const els  = (typeof elemsOf === 'function' ? elemsOf(sk) : []) || [];
  const fcol = e => fzFamCol(e, sk);
  p = _fzPal[sk.id] = {
    a: els[0] ? fcol(els[0]) : (sk.col || '#ffffff'),
    b: els[1] ? fcol(els[1]) : (sk.col || '#ffffff'),
    n: Math.max(els.length, 1),
    els
  };
  return p;
}

/* ═══════════════════════════════════════════════════════════════
   THE SHARED FUSION FX LAYER

   A fusion used to render as a common skill with wider strokes: sk.vfx
   (1.75-2.2) is folded into the combo multiplier V in core.js, and that
   was the whole of it. Bigger is not special, so these five helpers give
   every fused act three things a common skill cannot have:

     · BOTH PARENT COLOURS. fzPal already resolves the recipe's families
       for the cast rite; reusing it here is what makes the effect and the
       cast read as one object instead of two events that happen to share
       a colour.
     · GRADE. `k` below rises 0.55 -> 1.30 across ✦1..✦9 and multiplies
       every count, density and alpha downstream, so a ✦9 out-classes a
       ✦1 by volume rather than by a numeral on the rail.
     · A HOT FILAMENT. The three-pass stroke (haze/body/core) that the
       gravity well's spiral arms use is the single detail that separates
       a drawn line from a thing made of energy. Lifted into fzPass so
       every renderer gets it for one call.
   ═══════════════════════════════════════════════════════════════ */

/* Grade weight. Deliberately does NOT start at 0: a ✦1 fusion still cost
   two draft slots, so the floor is 0.55 rather than nothing, and the top
   is 1.30 rather than 9x — this scales DETAIL, not power. */
const _fzInk = {};
function fzInk(sk){
  let k = _fzInk[sk.id];
  if(k) return k;
  const p = fzPal(sk), g = sk.grade || 1;
  return (_fzInk[sk.id] = {
    a: p.a, b: p.b, hot: '#ffffff', els: p.els,
    grade: g,
    k: 0.55 + (clamp(g,1,9) - 1)/8 * 0.75,
    /* the recipe's own colour, kept separate from the family pair: some
       passes want the authored blend rather than either parent */
    col: sk.col || p.a,
    mono: p.a === p.b,
    /* `cA`/`cB`/`arcs`/`arcCols`/`grade` are exactly the fields fzSigil
       reads off a rite, so an ink object can be handed straight to it —
       the effect stamps the SAME seal the cast drew, at arena scale. */
    cA: p.a, cB: p.b,
    arcs: Math.max(1, Math.min(3, p.els.length)),
    arcCols: (p.els.length ? p.els : [null]).slice(0,3)
      .map(el => el ? fzFamCol(el, sk) : (sk.col || '#ffffff'))
  });
}

/* Three passes over whatever path the caller just built: a wide haze in
   the SECOND family colour, the body in the first, then a hot hairline.
   The two-tone split is the point — a single-colour three-pass stroke is
   just a glow, whereas haze in B under body in A reads as two elements
   occupying the same line, which is what a fusion is.

   Caller owns the path (beginPath through to the last lineTo); this only
   strokes it, so a 24-segment spiral costs one path and three strokes
   rather than three paths. */
function fzPass(ink, A, w, V, hotBoost){
  const hb = hotBoost || 0;
  ctx.strokeStyle = ink.b;   ctx.globalAlpha = A*0.18; ctx.lineWidth = w*3.2*V; ctx.stroke();
  ctx.strokeStyle = ink.a;   ctx.globalAlpha = A*0.62; ctx.lineWidth = w*V;     ctx.stroke();
  ctx.strokeStyle = ink.hot; ctx.globalAlpha = A*(0.34+hb);
  ctx.lineWidth = Math.max(0.8, w*0.30*V); ctx.stroke();
}

/* A fused mote. efxSpark already round-robins the parent elements per
   particle for fused skills (see efxTurn in arena-art.js), so the spray
   is dual-element for free — this only forces additive blending and lets
   grade buy a little more life and size. */
function fzMote(sk, x, y, opt){
  opt = opt || {};
  const k = fzInk(sk).k;
  return efxSpark(sk, x, y, Object.assign({}, opt, {
    add: true,
    r:    (opt.r    != null ? opt.r    : rnd(3.6,1.4)) * (0.8 + k*0.35),
    life: (opt.life != null ? opt.life : rnd(.6,.25))  * (0.85 + k*0.25)
  }));
}

/* The moment of contact. Mirrors the crit treatment in World.on('hit') —
   paired rings, a spike star, debris — but in the two parent colours and
   on the GROUND PLANE, which is what stops it reading as a screen-space
   decal stuck over the arena.

   This exists because the acts that need it most vanish on impact: a
   meteor, a dash slash and a projectile are all gone the frame they land,
   so there is no act left for drawActs to embellish. */
function fzImpact(x, y, sk, pow){
  const ink = fzInk(sk);
  const P = (pow || 1) * (0.75 + ink.k*0.45);
  /* two fronts at different speeds so the blast has depth, squashed onto
     the floor so it belongs to the arena rather than to the camera */
  rings.push({x, y, r:8,  vr:560*P, life:.40, max:.40, col:ink.a,   w:9*P,  sq:0.42});
  rings.push({x, y, r:6,  vr:300*P, life:.58, max:.58, col:ink.b,   w:5*P,  sq:0.42});
  rings.push({x, y, r:10, vr:820*P, life:.26, max:.26, col:ink.hot, w:3.4*P});
  /* spike star: arm count IS the grade, alternating the parent colours,
     so the recipe and the tier are both legible in one frame */
  const arms = 6 + Math.round(ink.k*6);
  for(let s=0;s<arms;s++){
    const aa = s*TAU/arms + rnd(.12,-.12);
    spawn({x, y, vx:Math.cos(aa)*rnd(520,300)*P, vy:Math.sin(aa)*rnd(430,240)*P,
      col: s%2 ? ink.a : ink.b, life:.26, r:2.8*P, drag:.8, sh:'streak', add:true});
  }
  for(let i=0;i<Math.round(10*ink.k)+6;i++)
    fzMote(sk, x, y, {ang:rnd(TAU), spd:rnd(300,80)*P, life:rnd(.7,.28)});
  glow(x, y, 42*P, ink.a, 0.5);
}

/* A small counter-rotating rune collar. The cast rite stamps a big sigil
   on the floor; this is the same vocabulary shrunk down to travel WITH
   the effect, so a fused projectile or orbiting body is visibly still
   part of the rite that launched it. Kept deliberately tiny — it must
   never compete with the body it is decorating. */
function fzCollar(ink, x, y, rad, rot, A, squash){
  const sq = squash == null ? 1 : squash;
  ctx.save(); ctx.translate(x,y); ctx.scale(1, sq);
  ctx.globalAlpha = A*0.5; ctx.strokeStyle = ink.b; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(0,0,rad,0,TAU); ctx.stroke();
  /* ticks, and one bright arc chasing the other way — counter-rotation is
     what keeps it from reading as a rigid decal glued to the body */
  const N = 8 + Math.round(ink.k*6);
  ctx.globalAlpha = A*0.7; ctx.strokeStyle = ink.a; ctx.lineWidth = 1.8;
  ctx.beginPath();
  for(let i=0;i<N;i++){
    const aa = rot + i*TAU/N, c = Math.cos(aa), s = Math.sin(aa);
    ctx.moveTo(c*rad*0.94, s*rad*0.94); ctx.lineTo(c*rad*1.16, s*rad*1.16);
  }
  ctx.stroke();
  ctx.globalAlpha = A*0.9; ctx.strokeStyle = ink.hot; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0,0,rad*1.05, -rot*1.7, -rot*1.7 + 0.9); ctx.stroke();
  ctx.restore(); ctx.globalAlpha = 1;
}

function fuseCast(sk, f){
  const els = fzPal(sk).els;
  const cA = fzPal(sk).a, cB = fzPal(sk).b;
  const x = f.x, y = f.y - 8;
  const grade = sk.grade || 1;

  /* ── 1. IMPLOSION ──
     Motes launched from a wide ring with an inward + tangential velocity, so
     they spiral rather than fall straight in, and with drag disabled and
     speed solved as radius/life they all ARRIVE together on the caster. That
     synchronised arrival is what makes it read as a gathering instead of a
     cloud; a spread of arrival times just looks like ordinary debris played
     backwards. jit/rise are zeroed so the element's own drift cannot bend a
     mote off its line — the spiral has to stay clean to be legible. */
  for(let i=0;i<38;i++){
    const a = rnd(TAU), rr = rnd(300,150);
    const life = rnd(.40,.26), sp = rr/life, swirl = 0.36;
    efxSpark(sk, x + Math.cos(a)*rr, y + Math.sin(a)*rr*0.8, {
      vx: -Math.cos(a)*sp - Math.sin(a)*sp*swirl,
      vy: -Math.sin(a)*sp*0.8 + Math.cos(a)*sp*swirl,
      life, r:rnd(4.6,1.8), grav:0, drag:1, rise:0, jit:0, add:true});
  }

  /* ── 2. DETONATION ──
     Three shockwaves at different speeds and widths so the front has depth,
     then a spoke star whose arm count tracks GRADE — a ✦4 fusion throws a
     visibly denser star than a ✦1, which is the only place grade is
     communicated by the FX itself rather than by a numeral. Arms alternate
     the two family colours, so the recipe is in the star too.

     Note there is no glow() call here, deliberately. Events are emitted from
     inside sim.step(), which frame() runs BEFORE it clears the canvas — so
     anything drawn directly from a handler is painted over in the same frame
     and never reaches the screen. Only state pushes survive from here. The
     rite's core flash (drawRites) carries the bloom instead, from inside the
     render pass where it actually shows. */
  rings.push({x, y, r:6, vr:1180, life:.42, max:.42, col:'#ffffff', w:7});
  rings.push({x, y, r:6, vr:780,  life:.60, max:.60, col:cA, w:15});
  rings.push({x, y, r:6, vr:480,  life:.78, max:.78, col:cB, w:9});
  const arms = 10 + grade*3;
  for(let s=0;s<arms;s++){
    const a = s*TAU/arms + rnd(.09,-.09);
    spawn({x, y, vx:Math.cos(a)*rnd(920,640), vy:Math.sin(a)*rnd(780,540),
      col: s%2 ? cA : cB, life:.32, r:3.4, drag:.8, sh:'streak', add:true});
  }
  burst(x, y, '#ffffff', 26, 2.6);
  for(let i=0;i<32;i++){
    const a = rnd(TAU);
    efxSpark(sk, x, y, {ang:a, spd:rnd(440,120), life:rnd(.95,.35),
      r:rnd(5,2), add:true});
  }
  smoke(x, y+16, '#241a3a', 8);

  shake = Math.min(26, shake + 15);
  flashScr = Math.max(flashScr, 0.7); flashCol = cA;
  Time.punch(x, y);
  if(sfx.fuseCast) sfx.fuseCast(sk, x);

  /* ── 3. THE RITE + 4. THE COLUMN ──
     One entry, drawn by drawRites(). Both live off a single lifetime so the
     column collapsing and the sigil settling stay phase-locked. */
  rites.push({x, y:f.y, cy:y, life:FZ_RITE, max:FZ_RITE,
    col:sk.col, cA, cB, grade,
    /* one arc per family, capped at 3 — the recipes never exceed it and an
       uncapped loop would divide the ring into unreadable slivers */
    arcs: Math.max(1, Math.min(3, els.length)),
    arcCols: (els.length ? els : [null]).slice(0,3).map(e => e ? fzFamCol(e, sk) : sk.col),
    seed: rnd(TAU)});

  /* ── 5. BANNER ──
     Throttled: a fusion on an 8s cooldown cannot restart the banner inside
     its own tail, and two fusions in a build cannot fight over the band. */
  if(fzBanner <= 0.55){
    fzBanner = FZ_BANNER;
    fzName   = sk.name;
    fzCol    = sk.col;
    fzGrade  = sk.grade || 0;
    fzColA   = cA; fzColB = cB;
    fzRecipe = els.map(e => (FAMILY[e] && FAMILY[e].name) || e).join(' · ');
    fzKind   = String(sk.kind || '');
  }
}

/* One sigil disc: a rune circle seen at a shallow angle.

   Built with translate → scale(1, squash) → arcs, in that order. Scaling
   before drawing means every feature is laid out on a circle and then the
   whole plane is squashed, so ticks and arcs travel around a FIXED ellipse
   the way a disc lying flat would. Rotating an already-squashed ellipse
   instead would swing the ellipse itself around like a tumbling coin, which
   reads as a mistake rather than as spin.

   `detail` 1 draws the full rune (rims, ticks, family arcs, grade pips);
   detail 0 draws just the rims and ticks, for the ground echo — a second
   fully-detailed circle only competes with the first for attention. */
function fzSigil(R, cx, cy, rad, squash, rot, a, detail){
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, squash);

  /* outer rim plus a hairline just inside it — a double rule is the cheapest
     way to make a ring look engraved rather than drawn */
  ctx.globalAlpha = a*0.9; ctx.strokeStyle = R.cA; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0,0,rad,0,TAU); ctx.stroke();
  ctx.globalAlpha = a*0.45; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0,0,rad*0.92,0,TAU); ctx.stroke();

  /* ticks on the rim, spinning one way */
  ctx.globalAlpha = a*0.7; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4;
  ctx.beginPath();
  for(let k=0;k<28;k++){
    const ang = rot + k*TAU/28, c = Math.cos(ang), s = Math.sin(ang);
    ctx.moveTo(c*rad*0.96, s*rad*0.96);
    ctx.lineTo(c*rad*1.10, s*rad*1.10);
  }
  ctx.stroke();

  if(detail){
    /* one heavy arc per parent family, spinning the OTHER way. Counter-
       rotation is what stops the circle reading as one rigid decal, and the
       arcs are where the recipe is actually legible: three colours turning
       against the rim is unmistakably "this came from three skills". */
    const seg = TAU/R.arcs * 0.62;
    ctx.lineWidth = 9;
    for(let k=0;k<R.arcs;k++){
      const a0 = -rot*1.35 + k*TAU/R.arcs;
      ctx.globalAlpha = a*0.8;
      ctx.strokeStyle = R.arcCols[k] || R.cA;
      ctx.beginPath(); ctx.arc(0,0,rad*0.74, a0, a0+seg); ctx.stroke();
    }
    /* inner counter-ring + grade pips. The pip count IS the grade, drawn at
       arena scale — the rail numeral says ✦3, this says it in shape. */
    ctx.globalAlpha = a*0.55; ctx.strokeStyle = R.cB; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(0,0,rad*0.48,0,TAU); ctx.stroke();

    ctx.globalAlpha = a*0.95; ctx.fillStyle = '#ffffff';
    for(let k=0;k<R.grade;k++){
      const ang = -rot*1.35 + k*TAU/R.grade + Math.PI/R.grade;
      const px = Math.cos(ang)*rad*1.02, py = Math.sin(ang)*rad*1.02, s = 9;
      ctx.beginPath();
      ctx.moveTo(px, py-s); ctx.lineTo(px+s*0.62, py);
      ctx.lineTo(px, py+s); ctx.lineTo(px-s*0.62, py);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* The world-space half of a fused cast.

   THREE planes, because one is not enough here and each is doing a job the
   others can't:

     · the RUNE, squashed around the champion itself. This has to be at the
       caster, not on the floor — the arena draws its fighters floating well
       above the shadow line, so a rune on the floor plane sits 240px below
       the champion and reads as a separate event happening near their feet.
     · the ECHO on the actual floor plane, wider and plainer. This is what
       grounds the strike, and it borrows the same line the nova scorch and
       every fighter shadow already use (ARENA_H+18).
     · the COLUMN joining the two, plus a HALO upright at the caster. The
       arena has no vertical vocabulary at all, so a shaft straight up the
       screen cuts through everything else on it. */
function drawRites(rdt, t){
  for(let i=rites.length-1;i>=0;i--){
    const R = rites[i]; R.life -= rdt;
    if(R.life<=0){ rites.splice(i,1); continue; }

    /* clamped because every stage below feeds p into a radius or an alpha, and
       one out-of-range frame is a thrown IndexSizeError rather than a wobble */
    const p    = clamp(1 - R.life/R.max, 0, 1);          // 0 → 1
    const fade = p > 0.66 ? 1 - (p-0.66)/0.34 : 1;       // long soft exit
    const sc   = fzBack(clamp(p/0.24, 0, 1));            // snap-out overshoot
    const rot  = t*0.75 + R.seed;
    const rad  = 122 * sc;
    const gy   = ARENA_H + 18;                           // the arena floor line

    /* white-hot core, only for the first breath. This is the whole bloom for
       the detonation — fuseCast cannot draw it (see the note there), so it
       lives here, inside the render pass where it actually reaches a pixel. */
    if(p < 0.22){
      const q = 1 - p/0.22;
      glow(R.x, R.cy, 60 + 220*(1-q), '#ffffff', q*0.7);
      glow(R.x, R.cy, 130 + 190*(1-q), R.cA, q*0.5);
      glow(R.x, R.cy, 100 + 150*(1-q), R.cB, q*0.35);
    }

    /* ── light column ──
       Runs from the floor echo up through the champion and off the top of the
       arena, so the two discs are visibly one event. Widest at the strike and
       narrowing as it dies, so the shaft reads as collapsing into the caster
       rather than fading out where it stands. */
    if(p < 0.55){
      const cp = p/0.55, w = 8 + (1-fzOut(cp))*62;
      const g = ctx.createLinearGradient(R.x, gy, R.x, gy-520);
      g.addColorStop(0,    R.cA+'00');
      g.addColorStop(0.14, R.cA+'d0');
      g.addColorStop(0.46, '#ffffff70');
      g.addColorStop(1,    R.cB+'00');
      ctx.globalAlpha = (1-cp)*0.7;
      ctx.fillStyle = g;
      ctx.fillRect(R.x - w/2, gy-520, w, 534);
      ctx.globalAlpha = 1;
    }

    /* ground echo first, so the champion's own rune sits on top of it */
    fzSigil(R, R.x, gy, rad*1.55, 0.24, -rot*0.5, fade*0.4, 0);
    fzSigil(R, R.x, R.cy, rad, 0.34, rot, fade, 1);

    /* ── halo ──
       Upright, at chest height, with a bright arc chasing around it. Rises as
       it fades, so the rite ends by lifting off the caster instead of just
       switching off. */
    const hr = 52 * sc, hy = R.cy - fzOut(p)*30;
    ctx.globalAlpha = fade*0.5;
    ctx.strokeStyle = R.cB; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(R.x, hy, hr, 0, TAU); ctx.stroke();
    ctx.globalAlpha = fade*0.95;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.arc(R.x, hy, hr, -rot*2.4, -rot*2.4 + 1.05); ctx.stroke();
    ctx.globalAlpha = 1;

    /* embers riding the column up off the floor echo, thinning as it closes */
    if(p < 0.6 && Math.random() < 0.9){
      spawn({x:R.x + rnd(rad*0.7,-rad*0.7), y:gy + rnd(6,-6),
        vx:rnd(24,-24), vy:rnd(-240,-430),
        col: Math.random()<0.5 ? R.cA : R.cB,
        life:rnd(1.1,.6), r:rnd(3.6,1.4), grav:-30, drag:0.96, add:true});
    }
  }
}

function log(html){
  const el = $('#log');
  const d = document.createElement('div');
  d.innerHTML = html;
  el.prepend(d);
  while(el.children.length>7) el.lastChild.remove();
}
/* ---------- drawing ---------- */
function glowOn(c,x,y,r,col,a=1){
  const g = c.createRadialGradient(x,y,0,x,y,r);
  g.addColorStop(0, col); g.addColorStop(0.35, col+'88'); g.addColorStop(1, col+'00');
  c.globalAlpha = a; c.fillStyle = g;
  c.beginPath(); c.arc(x,y,r,0,TAU); c.fill(); c.globalAlpha = 1;
}
function glow(x,y,r,col,a=1){ glowOn(ctx,x,y,r,col,a); }

/* ═══════════════════════════════════════════════════════════════
   CHAMPION BODIES

   Three silhouettes, one per ultimate, and the silhouette is the tell:
   you should be able to name the ultimate you are facing from across
   the arena before it ever fires. Each entry also owns its bob, because
   weight is motion — the hexagon cannot read as heavy if it bobs at the
   same rate as the star.

   Every function takes an explicit context `c` and draws in local space
   (already translated to the fighter and scaled). That is what lets the
   select screen animate the same bodies on its own little canvases:
   the portrait you pick from is the renderer you get, not a drawing of it.

   `base` stays the side colour and always survives as a rim, so P1 and P2
   never blur together in a mirror match.
   ═══════════════════════════════════════════════════════════════ */
const CHAMP_ART = {

  /* REVERSAL — a hexagonal keep. Everything here is weight: the core
     turns slowly, the bob is long, and six armour plates ride the
     OPPOSITE direction, so the silhouette is permanently turning
     against itself. A body that looks like it is bracing. */
  hex: {
    bobF: 0.55, bobA: 6.5,
    pal: { core:'#3a3590', deep:'#211d5c', edge:'#ffce5a' },
    draw(c, t, R, P){
      const A = this.pal, hurt = P.hurt;
      /* plates first: the core then sits on top and reads as the thing
         being guarded rather than as decoration between them */
      const pr = R*1.44, half = 0.29;
      for(let i=0;i<6;i++){
        const a = -t*0.44 + i*TAU/6;
        c.beginPath();
        c.arc(0,0, pr+6.5, a-half, a+half);
        c.arc(0,0, pr-6.5, a+half, a-half, true);
        c.closePath();
        c.globalAlpha = 0.80; c.fillStyle = A.edge; c.fill();
        c.globalAlpha = 1; c.lineWidth = 1.2; c.strokeStyle = '#05070f'; c.stroke();
        c.beginPath(); c.arc(Math.cos(a)*pr, Math.sin(a)*pr, 1.8, 0, TAU);
        c.globalAlpha = 0.8; c.fillStyle = '#fff8e0'; c.fill(); c.globalAlpha = 1;
      }
      /* three stacked hexagons — the stack is what gives it thickness */
      for(let L=0;L<3;L++){
        const rr = R*(1 - L*0.21), rot = t*0.20 + L*0.09;
        c.beginPath();
        for(let i=0;i<6;i++){
          const a = rot + i*TAU/6, px = Math.cos(a)*rr, py = Math.sin(a)*rr;
          i ? c.lineTo(px,py) : c.moveTo(px,py);
        }
        c.closePath();
        c.globalAlpha = 0.62 + L*0.19;
        c.fillStyle = L===2 ? A.edge : (L ? A.core : A.deep);
        c.fill(); c.globalAlpha = 1;
        c.lineWidth = 2.1 - L*0.55;
        c.strokeStyle = hurt>0 ? '#ffffff' : (L===0 ? A.edge : A.core);
        c.stroke();
      }
      c.beginPath();
      for(let i=0;i<6;i++){
        const a = t*0.20 + i*TAU/6, px = Math.cos(a)*R*1.10, py = Math.sin(a)*R*1.10;
        i ? c.lineTo(px,py) : c.moveTo(px,py);
      }
      c.closePath();
      c.globalAlpha = 0.9; c.lineWidth = 1.5; c.strokeStyle = P.base; c.stroke();
      c.globalAlpha = 1;
    }
  },

  /* TOTAL FORCE — a spiked star mid-spin with its shards held CLOSE.
     Fast rotation and a tight orbit: this is a body that already looks
     like it is casting, which is exactly what the ultimate turns it into. */
  star: {
    bobF: 1.9, bobA: 3.2, orbits: false,
    pal: { core:'#ffce5a', deep:'#c8791f', edge:'#fff3cf' },
    draw(c, t, R, P){
      const A = this.pal, hurt = P.hurt;
      /* seven shards, radius ~1.1R — close enough to read as one object */
      for(let i=0;i<7;i++){
        const a = -t*3.3 + i*TAU/7;
        const rr = R*1.13 + Math.sin(t*7.5 + i*1.7)*4;
        const px = Math.cos(a)*rr, py = Math.sin(a)*rr;
        c.save(); c.translate(px,py); c.rotate(a + Math.PI/2);
        c.beginPath(); c.moveTo(0,-6.5); c.lineTo(3.4,3.5); c.lineTo(-3.4,3.5);
        c.closePath();
        c.globalAlpha = 0.92; c.fillStyle = P.acc; c.fill();
        c.globalAlpha = 1; c.lineWidth = 0.9; c.strokeStyle = '#05070f'; c.stroke();
        c.restore();
        /* motion streak behind each shard — the speed IS the character */
        c.beginPath();
        c.arc(0,0, rr, a+0.10, a+0.40);
        c.globalAlpha = 0.30; c.lineWidth = 2.2; c.strokeStyle = A.edge; c.stroke();
        c.globalAlpha = 1;
      }
      const spin = t*2.5, pts = 8, puls = 1 + Math.sin(t*9)*0.035;
      for(let L=0;L<2;L++){
        c.beginPath();
        for(let i=0;i<pts*2;i++){
          const a = spin*(L?-0.5:1) + i*Math.PI/pts;
          const rr = (i%2 ? R*0.46 : R*1.02*(L?0.66:1)) * puls;
          const px = Math.cos(a)*rr, py = Math.sin(a)*rr;
          i ? c.lineTo(px,py) : c.moveTo(px,py);
        }
        c.closePath();
        c.globalAlpha = L ? 0.95 : 0.85;
        c.fillStyle = L ? A.edge : A.core; c.fill();
        c.globalAlpha = 1; c.lineWidth = L ? 1 : 1.9;
        c.strokeStyle = hurt>0 ? '#ffffff' : (L ? A.core : A.deep); c.stroke();
      }
      c.beginPath(); c.arc(0,0, R*0.20, 0, TAU);
      c.fillStyle = '#fff'; c.globalAlpha = 0.75 + Math.sin(t*11)*0.2; c.fill();
      c.globalAlpha = 1;
      c.beginPath(); c.arc(0,0, R*1.06, 0, TAU);
      c.globalAlpha = 0.55; c.lineWidth = 1.4; c.strokeStyle = P.base; c.stroke();
      c.globalAlpha = 1;
    }
  },

  /* SUPPRESSION — concentric rings, many layers, all of them slow. It is
     the only one of the three that does not look like it is doing
     anything, which is the point: it is waiting for you to commit. */
  rings: {
    bobF: 0.75, bobA: 4.2,
    pal: { core:'#4ec3f5', deep:'#12496e', edge:'#dff4ff' },
    draw(c, t, R, P){
      const A = this.pal, hurt = P.hurt;
      const SPEC = [[1.20, -0.19, 0.62], [0.98, 0.26, 0.78],
                    [0.74, -0.34, 0.92], [0.52, 0.44, 1.18]];
      for(let i=0;i<SPEC.length;i++){
        const [rf, sp, gap] = SPEC[i];
        const rr = R*rf*(1 + Math.sin(t*0.9 + i)*0.022);
        const a0 = t*sp + i*0.7;
        c.beginPath(); c.arc(0,0, rr, a0, a0 + TAU - gap);
        c.globalAlpha = 0.34 + i*0.15;
        c.lineWidth = 4.2 - i*0.55;
        c.strokeStyle = hurt>0 ? '#ffffff' : (i%2 ? P.acc : A.core);
        c.lineCap = 'round'; c.stroke(); c.lineCap = 'butt';
        c.globalAlpha = 1;
        /* one node per ring marks where the gap closes, so the slow
           rotation is legible instead of looking like a static circle */
        const nx = Math.cos(a0)*rr, ny = Math.sin(a0)*rr;
        c.beginPath(); c.arc(nx, ny, 2.6 - i*0.3, 0, TAU);
        c.fillStyle = A.edge; c.globalAlpha = 0.85; c.fill(); c.globalAlpha = 1;
      }
      c.beginPath(); c.arc(0,0, R*0.30, 0, TAU);
      c.fillStyle = A.deep; c.globalAlpha = 0.95; c.fill();
      c.globalAlpha = 1; c.lineWidth = 1.6;
      c.strokeStyle = hurt>0 ? '#fff' : A.core; c.stroke();
      c.beginPath(); c.arc(0,0, R*0.13, 0, TAU);
      c.fillStyle = A.edge; c.globalAlpha = 0.7 + Math.sin(t*2.2)*0.2; c.fill();
      c.globalAlpha = 1;
      c.beginPath(); c.arc(0,0, R*1.34, 0, TAU);
      c.globalAlpha = 0.5; c.lineWidth = 1.3; c.strokeStyle = P.base; c.stroke();
      c.globalAlpha = 1;
    }
  },
};
function champArt(f){ return (f && f.champ && CHAMP_ART[f.champ.art]) || null; }


function drawFighter(f, t){
  /* A champion owns its own bob: the hexagon has to feel heavy and the
     star has to feel fast, and rate is most of what carries that. */
  const CA = champArt(f);
  const R = 34;
  const bob = Math.sin(t*(CA ? CA.bobF : 1.6) + f.side*3) * (CA ? CA.bobA : 5);
  const x = f.x, y = f.y + bob;
  /* side colour stays the primary read (you must never confuse the two
     fighters); the build's accent shows in the shards and the sigil */
  const base = f.side ? '#ff5d7a' : '#5fd0ff';
  /* a champion's accent is its own — that colour is the promise the
     select screen made, and the arena has to keep it */
  const acc = (f.champ && f.champ.acc) || f.accent || base;
  const hurt = f.flash;
  const sc = 1 + f.scaleP*0.16 - hurt*0.06;

  /* ground shadow + reflection */
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(f.x, ARENA_H+18, R*1.25, R*0.34, 0,0,TAU); ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glow(x, y, R*3.6, base, 0.30 + f.scaleP*0.3);
  ctx.restore();

  ctx.save();
  ctx.translate(x,y); ctx.scale(sc,sc);

  /* orbiting shards — carry the build accent so the kit is readable.
     Total Force draws its own tight orbit and would otherwise wear two. */
  const orbs = (CA && CA.orbits === false) ? 0 : 3;
  for(let i=0;i<orbs;i++){
    const a = t*1.25*(f.side?-1:1) + i*TAU/orbs;
    const rr = R*1.85 + Math.sin(t*2+i)*5;
    const ox = Math.cos(a)*rr, oy = Math.sin(a)*rr*0.55;
    ctx.save(); ctx.globalCompositeOperation='lighter';
    glow(ox,oy,13,acc,0.85);
    ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(ox,oy,2.4,0,TAU); ctx.fill();
    ctx.restore();
  }

  /* sigil ring — a slow accent-coloured arc, the fighter's "crest" */
  ctx.save();
  ctx.globalCompositeOperation='lighter';
  ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(0, 0, R*2.25, t*0.5, t*0.5 + TAU*0.34);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R*2.25, t*0.5 + TAU*0.5, t*0.5 + TAU*0.84);
  ctx.stroke();
  ctx.restore();

  /* core body. A champion replaces the generic polygon stack outright —
     the silhouette is the whole point of picking one. */
  if(CA){
    CA.draw(ctx, t, R, {base, acc, hurt});
  } else
  for(let L=0;L<3;L++){
    const rr = R*(1-L*0.22), sides = 6, rot = t*(0.4+L*0.35)*(L%2?-1:1);
    ctx.beginPath();
    for(let i=0;i<=sides;i++){
      const a = rot + i*TAU/sides;
      const w = rr*(1+Math.sin(t*3+i)*0.04);
      const px = Math.cos(a)*w, py = Math.sin(a)*w;
      i? ctx.lineTo(px,py) : ctx.moveTo(px,py);
    }
    ctx.closePath();
    ctx.globalAlpha = 0.30 + L*0.18;
    ctx.fillStyle = L===2 ? '#ffffff' : base;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = hurt>0 ? '#fff' : base; ctx.lineWidth = 1.6 - L*0.4;
    ctx.stroke();
  }
  /* hurt flash overlay */
  if(hurt>0){
    ctx.globalAlpha = hurt*0.7; ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(0,0,R,0,TAU); ctx.fill(); ctx.globalAlpha=1;
  }
  /* ── open ultimate window ──
     Whether a window is OPEN is the single most decision-relevant fact on
     the board for both players, so it gets a full-body treatment and not a
     corner icon. Each shape says what it does: Reversal fills as it banks
     damage, Suppression sweeps like a radar looking for something to catch. */
  if(f.ultT > 0 && f.champ){
    const c = f.champ, k = clamp(f.ultT / (c.dur||1), 0, 1);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    if(c.id === 'reversal'){
      /* the ward brightens with what it has eaten — a full one is a threat */
      const load = clamp(f.ultStore / (f.max*0.25), 0, 1);
      ctx.strokeStyle = '#ffce5a'; ctx.lineWidth = 2.4 + load*3;
      ctx.globalAlpha = 0.55 + load*0.4;
      ctx.beginPath();
      for(let i=0;i<=6;i++){
        const a = t*0.5 + i*TAU/6, rr = R*1.72;
        const px = Math.cos(a)*rr, py = Math.sin(a)*rr;
        i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
      }
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 0.10 + load*0.30; ctx.fillStyle = '#ffce5a'; ctx.fill();
      glow(0, 0, R*(2.0 + load*0.9), '#ffce5a', 0.20 + load*0.35);
    } else if(c.id === 'suppress'){
      /* a sweeping radar arc: it is hunting for something to take */
      const sw = t*5.5;
      ctx.strokeStyle = '#9fe6ff'; ctx.lineWidth = 2.2; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(0,0, R*1.68, sw, sw + TAU*0.30); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,0, R*1.68, sw + Math.PI, sw + Math.PI + TAU*0.30); ctx.stroke();
      ctx.globalAlpha = 0.42; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(0,0, R*1.96, 0, TAU); ctx.stroke();
      glow(0, 0, R*2.1, '#4ec3f5', 0.26);
    } else if(c.id === 'totalforce'){
      /* haste lines: short radial ticks spinning fast, one per skill slot */
      const n = Math.max(4, f.build.length);
      ctx.strokeStyle = '#ffce5a'; ctx.lineWidth = 2; ctx.globalAlpha = 0.5 + k*0.35;
      for(let i=0;i<n;i++){
        const a = t*6.5 + i*TAU/n;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a)*R*1.5, Math.sin(a)*R*1.5);
        ctx.lineTo(Math.cos(a)*R*1.92, Math.sin(a)*R*1.92);
        ctx.stroke();
      }
      glow(0, 0, R*2.2, '#ffce5a', 0.16 + k*0.2);
    }
    ctx.restore();
  }
  /* the cast flare, kept separate from the window so a Total Force —
     which has no window to speak of — still punches on the frame it fires */
  if(f.ultFlash > 0){
    const uf = f.ultFlash;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = uf*0.8;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 + uf*3;
    ctx.beginPath(); ctx.arc(0, 0, R*(1.3 + (1-uf)*1.9), 0, TAU); ctx.stroke();
    ctx.restore();
  }
  /* shield bubble */
  if(f.shield>0){
    ctx.strokeStyle='#dff0ff'; ctx.globalAlpha=0.5+Math.sin(t*7)*0.16; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.arc(0,0,R*1.55,0,TAU); ctx.stroke();
    ctx.globalAlpha=0.10; ctx.fillStyle='#bfe0ff'; ctx.fill(); ctx.globalAlpha=1;
  }
  ctx.restore();

  /* status motes */
  ctx.save(); ctx.globalCompositeOperation='lighter';
  if(f.has('burn') && Math.random()<0.5)
    spawn({x:x+rnd(30,-30),y:y+rnd(20,-20),vx:rnd(20,-20),vy:rnd(-60,-140),
      col:'#ff9a4d',life:rnd(.7,.3),r:rnd(4,1.6)});
  if(f.has('bleed') && Math.random()<0.4)
    spawn({x:x+rnd(30,-30),y:y+rnd(20,-20),vx:rnd(30,-30),vy:rnd(40,-10),
      col:'#9dff6b',life:rnd(.8,.4),r:rnd(3.4,1.4),grav:120});
  if(f.has('chill')){ glow(x,y,R*1.5,'#a8e6ff',0.20); }
  if(f.has('pact')||f.has('dmgAmp')){ glow(x,y,R*2.1,'#ffb03d',0.16); }
  ctx.restore();

  /* ── persistent CC state ──
     Drawn every frame for the whole duration, because "am I locked right
     now" is the single most important thing to read off a fighter, and an
     impact-only flash answers it for 0.4s out of a 3s silence. Each kind
     draws a different SHAPE around the body. */
  const cc = f.ccActive;
  if(cc){
    const v = CC_VIS[cc], st = f.st[cc];
    ctx.save(); ctx.globalCompositeOperation='lighter';
    if(cc==='stun'){
      /* discrete stars wheeling overhead — the classic, and unmistakable */
      for(let i=0;i<3;i++){
        const a = t*4.2 + i*TAU/3;
        const sx = x + Math.cos(a)*R*0.95, sy = y - R*1.5 + Math.sin(a)*R*0.3;
        glow(sx, sy, 11, v.col, 0.9);
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(sx,sy,2.2,0,TAU); ctx.fill();
      }
      glow(x, y, R*1.7, v.col, 0.16);
    } else if(cc==='freeze'){
      /* angular ice shell: hard facets, no rotation — frozen means STILL */
      ctx.strokeStyle=v.col; ctx.lineWidth=2.2; ctx.globalAlpha=0.85;
      ctx.beginPath();
      for(let i=0;i<=7;i++){
        const a = i*TAU/7 - 0.3;
        const rr = R*(1.5 + (i%2?0.22:0));
        const px = x+Math.cos(a)*rr, py = y+Math.sin(a)*rr;
        i? ctx.lineTo(px,py) : ctx.moveTo(px,py);
      }
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha=0.14; ctx.fillStyle=v.col; ctx.fill();
      ctx.globalAlpha=1;
      glow(x, y, R*2.0, v.col, 0.22);
      if(Math.random()<0.25) spawn({x:x+rnd(38,-38), y:y+rnd(30,-30),
        vx:rnd(14,-14), vy:rnd(24,6), col:v.col, life:rnd(.9,.5), r:rnd(2.6,1)});
    } else if(cc==='silence'){
      /* a clamped rune ring: locked in place, slashed through */
      ctx.strokeStyle=v.col; ctx.lineWidth=2.4; ctx.globalAlpha=0.8;
      ctx.beginPath(); ctx.arc(x, y-R*1.05, R*0.62, 0, TAU); ctx.stroke();
      ctx.lineWidth=3;
      ctx.beginPath();
      ctx.moveTo(x-R*0.44, y-R*1.49); ctx.lineTo(x+R*0.44, y-R*0.61);
      ctx.stroke();
      ctx.globalAlpha=1;
      glow(x, y-R*1.05, R*0.9, v.col, 0.3);
    } else {
      /* root: spikes climbing out of the floor, anchored at the shadow */
      const gy = ARENA_H + 14;
      ctx.strokeStyle=v.col; ctx.lineWidth=3.2; ctx.globalAlpha=0.85;
      for(let i=0;i<6;i++){
        const sx = f.x + (i-2.5)*13;
        const h = R*(0.85 + Math.sin(i*1.7)*0.3);
        ctx.beginPath(); ctx.moveTo(sx, gy);
        ctx.quadraticCurveTo(sx + (i%2?7:-7), gy-h*0.6, sx + (i%2?3:-3), gy-h);
        ctx.stroke();
      }
      ctx.globalAlpha=1;
      glow(f.x, gy, R*1.5, v.col, 0.25);
    }
    /* shared duration arc — a shrinking timer so you can plan around it */
    if(st && st.max){
      const p = clamp(st.t / st.max, 0, 1);
      ctx.strokeStyle=v.col; ctx.globalAlpha=0.9; ctx.lineWidth=3;
      ctx.beginPath();
      ctx.arc(x, y, R*2.6, -Math.PI/2, -Math.PI/2 + TAU*p);
      ctx.stroke(); ctx.globalAlpha=1;
    }
    ctx.restore();
  }
}

/* ═══════════════════════════════════════════════════════════════
   PIXEL-ART CUTE MONSTER RENDERER — used for PvE enemies only
   ═══════════════════════════════════════════════════════════════ */
function drawMonster(f, t){
  const R = f.R || 30;
  const bob = Math.sin(t*1.8 + f.sway)*4;
  const x = f.x, y = f.y + bob;
  const hurt = f.flash;
  const sc = 1 + f.scaleP*0.12 - hurt*0.05;

  /* Pixel-perfect rendering hint */
  ctx.imageSmoothingEnabled = false;

  /* Ground shadow */
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(f.x, ARENA_H+18, R*1.15, R*0.28, 0,0,TAU);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(x,y);
  ctx.scale(sc,sc);

  /* Boss gets a subtle glow */
  if(f.boss){
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(0, 0, R*2.8, '#ffb056', 0.25);
    ctx.restore();
  }

  /* Draw pixel art cute monster body */
  const pixelSize = f.boss ? 2.6 : 2.8;
  const isBoss = f.boss;

  /* Color palette based on monster type */
  const palette = isBoss ?
    {main:'#ffb056', outline:'#7a3d10', light:'#ffe8b3', horn:'#ffe8b3',
    gem:'#ff4a6b', eyewhite:'#ffffff', dark:'#7a3d10', blush:'#ff9a7a', white:'#ffffff'} :
    {main:'#ff7a8a', outline:'#8a2f42', light:'#ffb4c1', eyewhite:'#ffffff',
    dark:'#8a2f42', blush:'#fff59d', white:'#ffffff'};

  /* Helper to draw a pixel */
  const px = (ox, oy, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(ox*pixelSize - pixelSize/2, oy*pixelSize - pixelSize/2, pixelSize, pixelSize);
  };

  /* Cute blob body pattern - different for boss vs normal */
  if(isBoss){
    const w = 22, h = 22;
    const body = [
      '   #..  .......  ..#  ',
      '  .##....OOOOO....##. ',
      ' ..##O.OOOOLOOOO.O##..',
      ' .OAAAOOOOOLOOOOOAAAO.',
      ' .OAAAOOOOOOOOOOOAAAO.',
      ' .OAAAOOOOOOOOOOOAAAO.',
      ' ..OOOOOOOOOOOOOOOOO..',
      '  ..OOOWWOOOOOWWOOO.. ',
      '  .OOOWNNWOOOWNNWOOO. ',
      '  ..OOOWNOOOOOWNOOO.. ',
      '   .BBBOOOOOOOOOBBB.  ',
      'OOO.BBBOOOOOOOOOBBB.OO',
      ' OOO.OOOOOGOGOOOOO.OOO',
      ' OOO.OOOOOOOOOOOOO.OOO',
      ' OOO.OOOOAAAAAOOOO.OOO',
      '   .OOOOOAAAAAOOOOO.  ',
      '   ..OOOAAAAAAAOOO..  ',
      '    .OOOOAAAAAOOOO.   ',
      '    .OOOOAAAAAOOOO.   ',
      '    ..OOOOOOOOOOO..   ',
      '     ...OOOOOOO...    ',
      '       ....O....      '
    ];
    const charMap = {
      '#': palette.horn, '.': palette.outline, 'O': palette.main,
      'L': palette.gem, 'A': palette.light, 'W': palette.eyewhite,
      'N': palette.dark, 'B': palette.blush, 'G': palette.white
    };
    for(let r=0;r<body.length;r++){
      for(let c=0;c<body[r].length;c++){
        const ch = body[r][c];
        if(ch!==' ') px(c-w/2, r-h/2, charMap[ch]);
      }
    }
  } else {
    const w = 16, h = 15;
    const body = [
      '                ',
      '       ###      ',
      '   ..###O###..  ',
      '   ..OOOOOOO..  ',
      '  ##.OOOOOOO.## ',
      '  #.OOOOOOOOO.# ',
      '  #..OOOOOOO..# ',
      ' ##.LALOOOLLL.##',
      ' #..LWW.O.LWL..#',
      ' ##N.........N##',
      '  #N.........N# ',
      '  #...........# ',
      '  ##.........## ',
      '   ##.......##  ',
      '     ..###..    '
    ];
    const charMap = {
      '#': palette.outline, '.': palette.main, 'O': palette.light,
      'L': palette.eyewhite, 'A': palette.white, 'W': palette.dark,
      'N': palette.blush
    };
    for(let r=0;r<body.length;r++){
      for(let c=0;c<body[r].length;c++){
        const ch = body[r][c];
        if(ch!==' ') px(c-w/2, r-h/2, charMap[ch]);
      }
    }
  }

  /* Hurt flash overlay */
  if(hurt>0){
    ctx.globalAlpha = hurt*0.5;
    ctx.fillStyle='#fff';
    ctx.fillRect(-R*0.8, -R*0.8, R*1.6, R*1.6);
    ctx.globalAlpha=1;
  }

  /* Shield bubble */
  if(f.shield>0){
    ctx.strokeStyle='#dff0ff';
    ctx.globalAlpha=0.4+Math.sin(t*6)*0.12;
    ctx.lineWidth=2;
    ctx.beginPath();
    ctx.arc(0,0,R*1.4,0,TAU);
    ctx.stroke();
    ctx.globalAlpha=0.08;
    ctx.fillStyle='#bfe0ff';
    ctx.fill();
    ctx.globalAlpha=1;
  }

  ctx.restore();

  /* Status effects - same as fighters */
  ctx.save();
  ctx.globalCompositeOperation='lighter';
  if(f.has('burn') && Math.random()<0.5)
    spawn({x:x+rnd(25,-25),y:y+rnd(15,-15),vx:rnd(15,-15),vy:rnd(-50,-100),
      col:'#ff9a4d',life:rnd(.6,.3),r:rnd(3,1.2)});
  if(f.has('bleed') && Math.random()<0.4)
    spawn({x:x+rnd(25,-25),y:y+rnd(15,-15),vx:rnd(25,-25),vy:rnd(30,-10),
      col:'#9dff6b',life:rnd(.7,.3),r:rnd(2.8,1.2),grav:100});
  if(f.has('chill')){ glow(x,y,R*1.3,'#a8e6ff',0.18); }
  ctx.restore();

  /* CC effects - simplified for monsters */
  const cc = f.ccActive;
  if(cc){
    const v = CC_VIS[cc];
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    if(cc==='stun'){
      for(let i=0;i<3;i++){
        const a = t*4 + i*TAU/3;
        const sx = x + Math.cos(a)*R*0.85, sy = y - R*1.3 + Math.sin(a)*R*0.25;
        glow(sx, sy, 9, v.col, 0.8);
        ctx.fillStyle='#fff';
        ctx.beginPath();
        ctx.arc(sx,sy,1.8,0,TAU);
        ctx.fill();
      }
    } else if(cc==='freeze'){
      ctx.strokeStyle=v.col;
      ctx.lineWidth=2;
      ctx.globalAlpha=0.75;
      ctx.beginPath();
      ctx.arc(x, y, R*1.4, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha=0.12;
      ctx.fillStyle=v.col;
      ctx.fill();
      ctx.globalAlpha=1;
    }
    ctx.restore();
  }

  ctx.imageSmoothingEnabled = true;
}

/* ═══════════════════════════════════════════════════════════════
   PIXEL-ART PET RENDERER
   Every summon skill gets its OWN creature. Before this, anything
   without `mob` fell through to drawFighter, so all three summons
   rendered as the same champion polygon at the wrong size (that
   function hardcodes R=34 and ignores the pet's R=20).

   Sprites follow the same idiom as drawMonster: a string grid, one
   char per pixel, drawn with fillRect only — no offscreen canvases
   and no image allocation, so adding pets costs nothing but rects.
   ═══════════════════════════════════════════════════════════════ */
const _PW = [0,0];   // scratch wobble vector, reused to keep the draw loop allocation-free

const PET_ART = {
  /* WRAITH — hooded spirit, gold crown gem, no legs. The hem is three
     lobes so the sway reads as cloth rather than as walking. */
  wraithcall: {
    ps: 2.6, accCh: 'a', eyeRows: [5,6], lid: 6,
    g: [
      '     .a.     ',
      '   ..aaa..   ',
      '  .ooaaaoo.  ',
      ' .ooooooooo. ',
      '.ooooooooooo.',
      '.oowpooowpoo.',
      '.ooppoooppoo.',
      '.bboodddoobb.',
      '.ooooooooooo.',
      '.ooooooooooo.',
      ' .ooooooooo. ',
      '.ooo.ooo.ooo.',
      ' ... ... ... ',
    ],
    pal: {'.':'#2f2a4d', o:'#a9c6f5', l:'#dcebff', d:'#3b2f5c',
          w:'#ffffff', p:'#2f2a4d', b:'#ff9ec4', a:'#ffd76b', A:'#fff6d0'},
    wob(r, c, t, f){
      _PW[0] = 0; _PW[1] = 0;
      /* phase per LOBE, not per column: a per-column phase rounds adjacent
         pixels of the same lobe to different offsets and tears it apart */
      if(r >= 11)      _PW[0] = Math.sin(t*3.2 + f.sway + Math.min(2, c>>2)*1.5)*0.9;
      else if(r <= 2)  _PW[0] = Math.sin(t*2.0 + f.sway)*0.6;           // crown lags
      else             _PW[0] = Math.sin(t*1.6 + f.sway)*0.35;
      return _PW;
    }
  },

  /* DIRE WOLF — side view, brush tail up at the back. Legs lift on
     alternating phases and petIdx offsets the cycle so a pair of
     wolves never marches in lockstep. */
  direwolves: {
    ps: 2.4, accCh: 'a', eyeRows: [5,6], lid: 6,
    g: [
      '..               ',
      '.oo.       ...   ',
      '.ooo.     .ooo.  ',
      ' .ooo.   .ooooo. ',
      ' .ooo..  .oooooo.',
      '  .oooooooowpoo. ',
      '  .oooooooowpddd ',
      '  .ooooooooooolld',
      '  .olllllllllll. ',
      '  .oo.     ooo.  ',
      '  .oo.     .oo.  ',
      '  .oo.     .oo.  ',
      '  .aa.     .aa.  ',
    ],
    pal: {'.':'#2b3050', o:'#9aa6c4', l:'#e8eef8', d:'#3d4468',
          w:'#ffffff', p:'#2b3050', b:'#ffb4c1', a:'#ffc9a0', A:'#fff3e6'},
    wob(r, c, t, f){
      _PW[0] = 0; _PW[1] = 0;
      const ph = t*7 + f.sway + (f.petIdx||0)*1.9;
      /* row 9 is where the legs meet the belly and row 4 is the tail root:
         both stay put, so the limbs BEND instead of detaching */
      if(r >= 10)             _PW[1] = -Math.max(0, Math.sin(ph + (c > 8 ? Math.PI : 0)))*1.3;
      else if(r <= 3 && c <= 6) _PW[0] = Math.sin(t*4.5 + f.sway)*0.8;  // tail tip
      else if(r <= 6 && c >= 9) _PW[1] = Math.sin(t*3.5 + f.sway)*0.5;  // head
      return _PW;
    }
  },

  /* BONE SENTINEL — squat skull warden behind a tower shield. Wide and
     low so it reads as a wall, not as a damage pet. The shield drifts
     on its own rhythm, which sells the weight. */
  bonebulwark: {
    ps: 2.7, accCh: 'A', eyeRows: [3,4], lid: 4,
    g: [
      '  ......       ',
      ' .oooooo. ...  ',
      ' .oooooo. .aa. ',
      ' .owwowwo..aa. ',
      ' .oppoppo..aa. ',
      ' .obooobo..aa. ',
      ' .o.o.o.o..AA. ',
      '  ....... .AA. ',
      ' .ooooooooaa.  ',
      '.o.oooooooaa.  ',
      '.o.ooooo. .aa. ',
      '.o..ooo.. .aa. ',
      ' ..ooo..  .aa. ',
      '  .o. .o. ...  ',
      '  ... ...      ',
    ],
    pal: {'.':'#57482f', o:'#efe6cf', l:'#fffaf0', d:'#3d3220',
          w:'#ffffff', p:'#3d3220', b:'#ffb59b', a:'#b9c4dc', A:'#f2f7ff'},
    wob(r, c, t, f){
      _PW[0] = 0; _PW[1] = 0;
      /* y only. Any x drift opens a gap between the shield and the arm,
         and a floating shield reads as a bug, not as weight. */
      if(c >= 10) _PW[1] = Math.sin(t*1.7 + f.sway)*0.7;
      else if(r <= 7) _PW[0] = Math.sin(t*1.5 + f.sway)*0.5;            // skull
      else            _PW[1] = Math.abs(Math.sin(t*1.5 + f.sway))*0.6;  // heave
      return _PW;
    }
  }
};

/* Flatten a grid to a cell list once, then keep it on the art object.
   Sorted by glyph so the draw loop sets fillStyle a handful of times
   instead of once per pixel. */
function petCells(A){
  if(A._cells) return A._cells;
  const h = A.g.length, w = A.g[0].length;
  A.w = w; A.h = h;
  const out = [];
  for(let r=0;r<h;r++){
    const row = A.g[r];
    for(let c=0;c<w;c++){
      const ch = row[c];
      if(ch === ' ') continue;
      out.push({r, c, ch, eye: ch === 'w' || ch === 'p'});
    }
  }
  out.sort((a,b) => a.ch < b.ch ? -1 : a.ch > b.ch ? 1 : 0);
  A._cells = out;
  return out;
}

function drawPet(f, t){
  const A = PET_ART[f.petArt] || PET_ART.wraithcall;
  const cells = petCells(A);
  const R = f.R || 20;
  const hurt = f.flash;
  const bob = Math.sin(t*1.5 + f.sway)*3;
  const x = f.x, y = f.y + bob;

  /* the last beat of a pet's timer is a real decision point for the
     player, so it dims and flickers out instead of just vanishing */
  const ttl = f.life == null ? 9 : f.life;
  const dim = ttl < 1.2 ? (0.35 + 0.65*clamp(ttl/1.2,0,1))*(0.85 + 0.15*Math.sin(t*22)) : 1;
  const sc = 1 + f.scaleP*0.35 - hurt*0.06;

  ctx.imageSmoothingEnabled = false;

  /* ground shadow — world space, so it must not inherit the facing flip */
  ctx.save();
  ctx.globalAlpha = 0.30*dim;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(f.x, ARENA_H+18, R*1.05, R*0.24, 0,0,TAU);
  ctx.fill();
  ctx.restore();

  /* team rim: both sides' pets wear the summon's colour, so without this
     an enemy wraith and your wraith would be indistinguishable */
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glow(x, y, R*2.4, f.side ? '#ff5d7a' : '#5fd0ff', (0.16 + f.scaleP*0.35)*dim);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = dim;
  ctx.translate(x, y);
  ctx.scale(f.facing < 0 ? -1 : 1, 1);
  ctx.scale(sc, sc);

  const ps = A.ps, pal = A.pal, acc = f.accent || pal[A.accCh];
  /* deterministic blink, phase-shifted per pet by its own sway */
  const blink = ((t*0.9 + f.sway*3) % 4.0) < 0.16;

  let last = '';
  for(let i=0;i<cells.length;i++){
    const cell = cells[i];
    let ch = cell.ch;
    if(blink && cell.eye) ch = (cell.r === A.lid) ? 'd' : 'o';
    const col = ch === A.accCh ? acc : (pal[ch] || pal.o);
    if(col !== last){ ctx.fillStyle = col; last = col; }
    const wob = A.wob(cell.r, cell.c, t, f);
    /* offsets are rounded to whole pixels — a fractional fillRect would
       antialias its edges and the sprite would go soft while it moved */
    const ox = cell.c - A.w/2 + Math.round(wob[0]);
    const oy = cell.r - A.h/2 + Math.round(wob[1]);
    ctx.fillRect(ox*ps - ps/2, oy*ps - ps/2, ps, ps);
  }

  if(hurt > 0){
    ctx.globalAlpha = hurt*0.5*dim;
    ctx.fillStyle = '#fff';
    ctx.fillRect(-R*0.75, -R*0.75, R*1.5, R*1.5);
    ctx.globalAlpha = dim;
  }
  if(f.shield > 0){
    ctx.strokeStyle = '#dff0ff';
    ctx.globalAlpha = (0.4 + Math.sin(t*6)*0.12)*dim;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0,0,R*1.35,0,TAU); ctx.stroke();
    ctx.globalAlpha = 0.08*dim;
    ctx.fillStyle = '#bfe0ff'; ctx.fill();
    ctx.globalAlpha = dim;
  }
  ctx.restore();

  /* status motes — same grammar as fighters and monsters, tighter radius */
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if(f.has('burn') && Math.random()<0.45)
    spawn({x:x+rnd(18,-18), y:y+rnd(12,-12), vx:rnd(15,-15), vy:rnd(-50,-100),
      col:'#ff9a4d', life:rnd(.6,.3), r:rnd(2.8,1.1)});
  if(f.has('bleed') && Math.random()<0.35)
    spawn({x:x+rnd(18,-18), y:y+rnd(12,-12), vx:rnd(22,-22), vy:rnd(30,-10),
      col:'#9dff6b', life:rnd(.7,.3), r:rnd(2.6,1.1), grav:100});
  if(f.has('chill')) glow(x, y, R*1.25, '#a8e6ff', 0.18);
  ctx.restore();

  /* CC — pets get the readable subset: stars for stun, a shell for freeze */
  const cc = f.ccActive;
  if(cc){
    const v = CC_VIS[cc];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if(cc === 'stun'){
      for(let i=0;i<3;i++){
        const a = t*4 + i*TAU/3;
        const sx = x + Math.cos(a)*R*0.8, sy = y - R*1.25 + Math.sin(a)*R*0.22;
        glow(sx, sy, 8, v.col, 0.75);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, TAU); ctx.fill();
      }
    } else if(cc === 'freeze'){
      ctx.strokeStyle = v.col; ctx.lineWidth = 2; ctx.globalAlpha = 0.72;
      ctx.beginPath(); ctx.arc(x, y, R*1.35, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 0.12; ctx.fillStyle = v.col; ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  ctx.imageSmoothingEnabled = true;
}

function drawActs(sim, t){
  ctx.save(); ctx.globalCompositeOperation='lighter';
  for(const a of sim.acts){
    const sk = a.sk, col = sk.col||'#fff';
    /* combo visual scale — the whole point of vfxOf. A skill that is
       anchoring an active combo renders bigger and brighter, so the
       player SEES the synergy firing instead of trusting a tooltip.
       Basics have no id and never combo, hence the guard. */
    const V = (!a.basic && a.f && a.f.combo && sk.id)
      ? (a.f.combo.vfxOf[sk.id] || 1) : 1;
    const lit = V > 1;
    switch(a.k){
      case 'proj': {
        if(a.delay>0) break;
        const e = efxOf(sk);
        /* trail ribbon — width and inner-core colour take on the element,
           so a fireball trails fat and warm while a shard flies thin */
        if(a.trail.length>3){
          ctx.beginPath(); ctx.moveTo(a.trail[0],a.trail[1]);
          for(let i=2;i<a.trail.length;i+=2) ctx.lineTo(a.trail[i],a.trail[i+1]);
          ctx.strokeStyle=col; ctx.globalAlpha=0.5; ctx.lineWidth=(a.basic?2.5:5.5)*V*e.trailW;
          ctx.lineCap='round'; ctx.stroke();
          /* every projectile gets a hot inner core; combo ones burn brighter */
          ctx.strokeStyle=e.core; ctx.globalAlpha=lit?0.55:0.4;
          ctx.lineWidth=(lit?1.8:1.2)*V; ctx.stroke();
          ctx.globalAlpha=1;
        }
        glow(a.x,a.y,(a.basic?15:26)*V*e.glow,col,0.95);
        /* one signature spark shed each frame — element decides how it moves
           (fire licks upward, frost/earth sheds falling shards, storm forks) */
        if(!a.basic && Math.random()<0.9)
          efxSpark(sk, a.x, a.y, {spd:rnd(50,10), r:rnd(3,1.1)*V, life:rnd(.45,.2)});
        if(lit){
          /* orbiting sparks mark a combo-charged projectile */
          for(let i=0;i<3;i++){
            const oa = t*9 + i*TAU/3, orr = 13*V;
            spawn({x:a.x+Math.cos(oa)*orr, y:a.y+Math.sin(oa)*orr,
              vx:rnd(30,-30), vy:rnd(30,-30), col, life:rnd(.3,.14), r:rnd(2.4,1)});
          }
        }
        /* Heading comes from the last two trail samples, so the body
           points where it is actually going — these projectiles home, so
           that direction keeps changing in flight. Falls back to facing
           before the trail has two samples to work with. */
        let pang = a.f.facing>0 ? 0 : Math.PI;
        const tn = a.trail.length;
        if(tn>=4){
          const tdx = a.trail[tn-2]-a.trail[tn-4], tdy = a.trail[tn-1]-a.trail[tn-3];
          if(tdx||tdy) pang = Math.atan2(tdy,tdx);
        }
        /* Element-authored silhouette instead of a disc: fire flies as a
           teardrop, frost as a faceted crystal, blight as a lumpy mass.
           An element with no `shape` (and every basic attack) keeps the
           original dot, so this stays safe to extend. */
        const br = (a.basic?2.6:4.4)*V;
        if(e.shape && !a.basic){
          const pseed = a.id*1.37;
          /* a broader body in the skill colour under the hot core gives the
             shape a readable edge against the trail it is dragging */
          ctx.globalAlpha=0.55; ctx.fillStyle=col;
          e.shape(a.x, a.y, br*1.5, pang, t, pseed); ctx.fill();
          ctx.globalAlpha=1;   ctx.fillStyle=e.core;
          e.shape(a.x, a.y, br*0.85, pang, t, pseed); ctx.fill();
        } else {
          ctx.fillStyle=e.core; ctx.beginPath(); ctx.arc(a.x,a.y,br,0,TAU); ctx.fill();
        }
        /* ── fused projectile ──
           A ticked collar spinning round the body, plus an ECHO body some
           samples back down the trail in the other parent's colour. Two
           bodies flying as one object is what makes Voltaic Rush read as a
           fusion rather than a recoloured bolt. */
        if(sk.fused && !a.basic){
          const ink = fzInk(sk);
          fzCollar(ink, a.x, a.y, br*3.1, t*3.1, 0.75, 0.60);
          if(tn >= 12){
            const ex = a.trail[tn-12], ey = a.trail[tn-11];
            ctx.globalAlpha = 0.45; ctx.fillStyle = ink.b;
            if(e.shape) e.shape(ex, ey, br*1.15, pang, t, a.id*1.37+9.4);
            else { ctx.beginPath(); ctx.arc(ex, ey, br*0.85, 0, TAU); }
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          if(Math.random() < 0.5) fzMote(sk, a.x, a.y, {spd:rnd(80,20), r:rnd(3.2,1.2)*V});
        }
        break;
      }
      case 'beam': {
        const e = efxOf(sk);
        const p = a.t/a.dur, w = (a.basic?4:13)*(0.55+Math.sin(t*40)*0.12)*(1-p*0.3)*V;
        const x1=a.f.x+a.f.facing*40, y1=a.f.y-8, x2=a.foe.x, y2=a.foe.y-8;
        const len = Math.hypot(x2-x1, y2-y1) || 1;
        ctx.lineCap='round'; ctx.lineJoin='round';
        /* The bolt is REGENERATED on a ~22Hz clock rather than every
           frame: reseeding at 60fps reads as television static, while
           holding a silhouette for a few frames and then snapping to a
           new one is how a real discharge behaves. */
        const tick = Math.floor(t*22);
        const rng  = _srand(a.id*7919 + tick*104729);
        /* Displacement budget scales with the element's jitter, so a storm
           beam thrashes and a holy lance only breathes — but both get the
           self-similar structure from boltPath, where the kinks have
           kinks. That is the part a straight line with noise never gets. */
        const chaos = clamp(0.045 + e.jit*0.05, 0.05, 0.20);
        const bolt  = boltPath(x1,y1,x2,y2, len*chaos, 5, rng,
                               e.jit>=0.5 ? 0.16+e.jit*0.07 : 0);
        /* outer haze -> body -> hot core, all tracing the SAME path, so the
           bolt reads as one object with depth instead of stacked strokes */
        ctx.strokeStyle=col;
        ctx.globalAlpha=0.22; ctx.lineWidth=w*3.4;
        tracePts(bolt.main); ctx.stroke();
        ctx.globalAlpha=0.85; ctx.lineWidth=w;
        tracePts(bolt.main); ctx.stroke();
        /* inner core takes the element's hot colour instead of flat white */
        ctx.globalAlpha=1; ctx.strokeStyle=e.core; ctx.lineWidth=Math.max(1,w*0.32);
        tracePts(bolt.main); ctx.stroke();
        /* branches: dimmer and thinner, and they terminate in mid-air
           rather than reaching the target — they carry no damage */
        if(bolt.forks.length){
          ctx.strokeStyle=col; ctx.globalAlpha=0.5; ctx.lineWidth=Math.max(1,w*0.34);
          for(const fk of bolt.forks) if(fk.length>1){ tracePts(fk); ctx.stroke(); }
          ctx.strokeStyle=e.core; ctx.globalAlpha=0.7; ctx.lineWidth=Math.max(0.8,w*0.13);
          for(const fk of bolt.forks) if(fk.length>1){ tracePts(fk); ctx.stroke(); }
        }
        /* storm/wind beams crackle: a second discharge on its own seed
           gives the channel volume — a real bolt is a bundle of filaments,
           not a single line */
        if(e.jit>=1){
          const rng2 = _srand(a.id*104729 + tick*7919 + 17);
          const b2 = boltPath(x1,y1,x2,y2, len*chaos*0.7, 4, rng2, 0.10);
          ctx.strokeStyle=e.core; ctx.globalAlpha=0.30+Math.sin(t*50)*0.14;
          ctx.lineWidth=Math.max(1,w*0.22);
          tracePts(b2.main); ctx.stroke();
          for(const fk of b2.forks) if(fk.length>1){ tracePts(fk); ctx.stroke(); }
        }
        ctx.globalAlpha=1; ctx.lineJoin='miter';
        glow(x2,y2,(34+Math.sin(t*30)*6)*V*e.glow,col,0.8);
        /* signature motes stream along the beam toward the target — seeded
           from the bolt's ACTUAL vertices, so they follow its kinks
           instead of drifting along the straight line underneath */
        const rate = lit ? 1 : 0.7;
        if(Math.random()<rate){
          const bp = bolt.main[clamp((Math.random()*bolt.main.length)|0, 0, bolt.main.length-1)];
          efxSpark(sk, bp[0], bp[1],
            {vx:(x2-x1)*0.12+rnd(40,-40), vy:rnd(-30,-90), r:rnd(3.4,1.2)*V, life:rnd(.5,.2)});
        }
        /* ── fused beam ──
           Two counter-wound helices sleeve the channel, one per parent
           colour, fattest at mid-span and pinched at both ends so they read
           as braided around the bolt rather than crossing in front of it.
           Turn count is the grade: ✦9 Thermal Lance is visibly tighter
           wound than ✦1. */
        if(sk.fused){
          const ink = fzInk(sk);
          const nx = -(y2-y1)/len, ny = (x2-x1)/len;
          const turns = 1.6 + ink.k*2.4;
          const amp   = w*1.9 + 7;
          for(const dirn of [1,-1]){
            const ik = dirn>0 ? ink : {a:ink.b, b:ink.a, hot:ink.hot};
            ctx.beginPath();
            for(let i=0;i<=28;i++){
              const q  = i/28;
              const off = Math.sin(q*turns*TAU + t*7.5*dirn) * amp * Math.sin(q*Math.PI);
              const px = x1+(x2-x1)*q + nx*off, py = y1+(y2-y1)*q + ny*off;
              i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
            }
            fzPass(ik, 0.8, 2.1, V, 0.12);
          }
          /* collar at the muzzle so the lance has a source, not just a line */
          fzCollar(ink, x1, y1, w*2.6+14, -t*2.4, 0.7, 1);
          ctx.globalAlpha=1;
        }
        break;
      }
      case 'nova': {
        if(a.t<0) break;
        const p = clamp(a.t/0.45,0,1), r = a.r;
        const e = efxOf(sk);
        /* Every ring below is a many-point polygon whose radius is
           modulated by several harmonics at once (blobPath), never an
           arc. A blast front tearing outward is not a perfect circle.
           Because the harmonics have integer frequencies the outline
           closes with no seam, and rotating the sample angle by `spin`
           makes the lumps travel around the ring — so the wave writhes
           as it expands instead of merely scaling up. */
        const seed = a.id*3.77;
        const spin = t*0.9;
        /* distortion eases off as the wave spends its energy */
        const amp  = 0.16 + (1-p)*0.13;
        ctx.lineJoin='round';
        /* leading shockwave ring */
        ctx.strokeStyle=col; ctx.globalAlpha=(1-p)*0.9; ctx.lineWidth=(16*(1-p)+2)*V;
        blobPath(a.f.x, a.f.y, r, amp, seed, 1, spin); ctx.stroke();
        /* trailing inner ring reads as depth, not a flat circle — its own
           seed and drift rate stop it being a scaled copy of the front */
        ctx.globalAlpha=(1-p)*0.35; ctx.lineWidth=3*V;
        blobPath(a.f.x, a.f.y, r*0.72, amp*0.8, seed+11.3, 1, spin*1.35); ctx.stroke();
        /* a hot edge right at the wavefront sells the force; it wears the
           element's core colour so a void nova rimmed pale-violet reads
           differently from a fire nova rimmed warm gold. Same seed and
           spin as the front, so it hugs the leading ring exactly. */
        ctx.globalAlpha=(1-p)*0.75; ctx.strokeStyle=e.core; ctx.lineWidth=2*V;
        blobPath(a.f.x, a.f.y, r*1.01, amp, seed, 1, spin); ctx.stroke();
        /* ground scorch under an expanding nova — same treatment, squashed
           onto the floor plane */
        ctx.globalAlpha=(1-p)*0.20; ctx.strokeStyle=col; ctx.lineWidth=5*V;
        blobPath(a.f.x, ARENA_H+16, r*0.9, amp*0.7, seed+5.1, 0.27, spin*0.6); ctx.stroke();
        ctx.globalAlpha=1; ctx.lineJoin='miter';
        /* ── fused nova ──
           A second shell a beat behind in the other parent colour, counter-
           drifting so the two fronts scissor rather than nest; then a ring
           of radial lances snapping out along the ACTUAL distorted
           wavefront. Iron Sentence lands as a verdict, not a ripple. */
        if(sk.fused){
          const ink = fzInk(sk);
          ctx.lineJoin='round';
          ctx.strokeStyle=ink.b; ctx.globalAlpha=(1-p)*0.5; ctx.lineWidth=(9*(1-p)+1.5)*V;
          blobPath(a.f.x, a.f.y, r*0.86, amp*1.15, seed+21.7, 1, -spin*1.1); ctx.stroke();
          const L = 6 + Math.round(ink.k*7);
          ctx.lineCap='round';
          ctx.beginPath();
          for(let i=0;i<L;i++){
            const aa = i*TAU/L + spin*0.5;
            const rr = r*(1 + _loopNoise(aa + spin, seed, 6)*amp);
            const c = Math.cos(aa), s = Math.sin(aa)*0.85;
            ctx.moveTo(a.f.x+c*rr*0.70, a.f.y+s*rr*0.70);
            ctx.lineTo(a.f.x+c*rr*1.16, a.f.y+s*rr*1.16);
          }
          fzPass(ink, (1-p)*0.9, 2.6, V, 0.22);
          ctx.lineCap='butt'; ctx.lineJoin='miter'; ctx.globalAlpha=1;
        }
        if(Math.random()<0.9*V){
          const aa=rnd(TAU);
          /* debris leaves from the DISTORTED wavefront — sampling the same
             noise the outline uses means motes launch off the lumps
             instead of off a phantom circle underneath them */
          const rr = r*(1 + _loopNoise(aa + spin, seed, 6)*amp);
          /* debris thrown along the wavefront carries the element's shape
             and motion — earth flings tumbling shards, fire licks upward */
          efxSpark(sk, a.f.x+Math.cos(aa)*rr, a.f.y+Math.sin(aa)*rr*0.85,
            {vx:Math.cos(aa)*rnd(220,80), vy:Math.sin(aa)*rnd(200,60), r:rnd(4,1.4)*V, life:rnd(.5,.2)});
        }
        break;
      }
      case 'cone': {
        const p = a.t/a.dur, fx=a.f.x, fy=a.f.y-8, dir=a.f.facing;
        ctx.globalAlpha=(1-p)*0.5;
        const g2 = ctx.createRadialGradient(fx,fy,10,fx,fy,sk.reach);
        g2.addColorStop(0,col); g2.addColorStop(1,col+'00');
        ctx.fillStyle=g2;
        ctx.beginPath(); ctx.moveTo(fx,fy);
        ctx.arc(fx,fy,sk.reach, dir>0?-sk.spread:Math.PI-sk.spread,
                             dir>0? sk.spread:Math.PI+sk.spread);
        ctx.closePath(); ctx.fill();
        /* bright edges on the cone boundary — a gradient wedge alone reads
           as fog; the hard rims make it read as a directed blast */
        ctx.globalAlpha=(1-p)*0.8; ctx.strokeStyle=col; ctx.lineWidth=2.5*V;
        for(const s of [-1,1]){
          const ea = s*sk.spread;
          ctx.beginPath(); ctx.moveTo(fx,fy);
          ctx.lineTo(fx+Math.cos(ea)*sk.reach*dir, fy+Math.sin(ea)*sk.reach);
          ctx.stroke();
        }
        /* travelling pressure arc sweeping outward through the wedge */
        const wp = (a.t*2.2)%1;
        ctx.globalAlpha=(1-p)*(1-wp)*0.7; ctx.lineWidth=3.5*V;
        ctx.beginPath();
        ctx.arc(fx,fy, sk.reach*wp, dir>0?-sk.spread:Math.PI-sk.spread,
                                    dir>0? sk.spread:Math.PI+sk.spread);
        ctx.stroke();
        ctx.globalAlpha=1;
        /* ── fused cone ──
           A volley of blade arcs marching out through the wedge, alternating
           parent colours and narrowing as they go, instead of one gradient
           of fog with a single pressure line in it. Blade count is the
           grade, so ✦9 Razor Gale is a wall of cuts. */
        if(sk.fused){
          const ink = fzInk(sk);
          const N = 3 + Math.round(ink.k*3);
          ctx.lineCap='round';
          for(let i=0;i<N;i++){
            const q  = (a.t*1.5 + i/N) % 1;
            const rr = sk.reach*(0.16 + q*0.88);
            const spd2 = sk.spread*(0.5 + q*0.55);
            const ik = i%2 ? {a:ink.b, b:ink.a, hot:ink.hot} : ink;
            ctx.beginPath();
            ctx.arc(fx, fy, rr, dir>0?-spd2:Math.PI-spd2, dir>0?spd2:Math.PI+spd2);
            fzPass(ik, (1-p)*(1-q*0.75)*0.9, 2.5, V, 0.15);
          }
          ctx.lineCap='butt'; ctx.globalAlpha=1;
        }
        if(Math.random()<0.9){
          const aa=rnd(sk.spread,-sk.spread), rr=rnd(sk.reach);
          /* spray carries the element: a flame cone billows upward, a frost
             cone spits shards that fall, a storm cone scatters wide */
          efxSpark(sk, fx+Math.cos(aa)*rr*dir, fy+Math.sin(aa)*rr,
            {vx:Math.cos(aa)*260*dir, vy:Math.sin(aa)*260, r:rnd(6,2)*V, life:rnd(.6,.25)});
        }
        break;
      }
      case 'rain': {
        if(a.t<0) break;
        if(!a.done){
          const p = a.t/a.fall;
          const sy = a.ty - 520*(1-p);
          /* target reticle — a crosshair, not just a ring, so the landing
             spot is unambiguous when several are falling at once */
          ctx.strokeStyle=col; ctx.globalAlpha=0.35+p*0.5; ctx.lineWidth=2*V;
          ctx.beginPath(); ctx.ellipse(a.tx,a.ty,90*(0.5+p*0.5),26*(0.5+p*0.5),0,0,TAU); ctx.stroke();
          /* inner ring closes as impact approaches: a readable countdown */
          ctx.globalAlpha=0.25+p*0.6; ctx.lineWidth=1.6*V;
          ctx.beginPath(); ctx.ellipse(a.tx,a.ty,90*(1-p*0.75),26*(1-p*0.75),0,0,TAU); ctx.stroke();
          ctx.globalAlpha=0.5+p*0.4; ctx.lineWidth=1.4*V;
          for(const s of [-1,1]){
            ctx.beginPath(); ctx.moveTo(a.tx+s*98, a.ty); ctx.lineTo(a.tx+s*66, a.ty); ctx.stroke();
          }
          ctx.globalAlpha=1;
          /* ── fused reticle ──
             The same seal the cast drew, stamped flat on the floor exactly
             where the strike will land and tightening as it falls. The
             detail pass (arcs + grade pips) only comes in late, so the early
             frames stay readable when a barrage is inbound. */
          if(sk.fused){
            const rink = fzInk(sk);
            fzSigil(rink, a.tx, a.ty, 96*(0.55+p*0.5), 0.28,
                    t*1.3 + a.id, (0.28+p*0.55), p>0.45);
          }
          /* falling body — a tumbling chunk of rock, not a line segment */
          const e = efxOf(sk);
          const seed = a.id*2.399;
          /* spin is driven by height, so the rock ROLLS as it descends;
             the per-id offset stops a barrage tumbling in lockstep */
          const spin = sy*0.018 + a.id*1.7;
          const mr   = 15*V;
          /* motion-blurred wake: three tapered, noise-bent plumes instead
             of one ruler-straight line, so the rock reads as tearing
             through the air rather than being drawn on top of it */
          ctx.strokeStyle=col; ctx.lineCap='round';
          for(let i=0;i<3;i++){
            const seg=5, L=(120+i*30)*V;
            ctx.globalAlpha=0.45-i*0.12; ctx.lineWidth=Math.max(1,(8-i*2.4)*V);
            ctx.beginPath(); ctx.moveTo(a.tx, sy);
            for(let s=1;s<=seg;s++){
              const q=s/seg;
              /* widening lateral wander (×q) makes the plume fan out behind */
              ctx.lineTo(a.tx + _vnoise(q*3 + seed + i*7 + t*5)*11*V*q, sy - L*q);
            }
            ctx.stroke();
          }
          ctx.globalAlpha=1;
          glow(a.tx,sy,28*V*e.glow,col,1);
          /* ── fused meteor ──
             A wide shroud in the OTHER parent colour flaring behind the mass,
             plus a collar riding with it. Two elements bound into one falling
             object, rather than one rock tinted a blend of them. */
          if(sk.fused){
            const mink = fzInk(sk);
            glow(a.tx, sy, 42*V, mink.b, 0.5);
            ctx.globalAlpha=0.40; ctx.fillStyle=mink.b;
            shpRough(a.tx, sy, mr*1.6, -spin*0.35, 0, seed+7.7); ctx.fill();
            ctx.globalAlpha=1;
            fzCollar(mink, a.tx, sy, mr*2.1, -spin, 0.7, 0.5);
            if(Math.random()<0.7)
              fzMote(sk, a.tx+rnd(14,-14), sy,
                {vx:rnd(60,-60), vy:rnd(-60,-190), r:rnd(4.4,1.6)*V});
          }
          /* the meteor itself: an irregular polygon sampled at a FIXED
             noise time, so its outline is rigid and merely rotates —
             a solid tumbling, rather than a blob boiling in place */
          ctx.globalAlpha=0.85; ctx.fillStyle=col;
          shpRough(a.tx, sy, mr, spin, 0, seed); ctx.fill();
          /* a facet plate catching the light, counter-rotating slightly so
             the rock reads as three-dimensional */
          ctx.globalAlpha=1; ctx.fillStyle=e.core;
          shpRough(a.tx, sy, mr*0.46, -spin*0.6, 0, seed+3.1); ctx.fill();
          /* hard rim keeps the silhouette legible over its own glow */
          ctx.lineJoin='round';
          ctx.globalAlpha=0.7; ctx.strokeStyle=e.core; ctx.lineWidth=1.5*V;
          shpRough(a.tx, sy, mr, spin, 0, seed); ctx.stroke();
          ctx.lineJoin='miter'; ctx.globalAlpha=1;
          if(Math.random()<0.8)
            efxSpark(sk, a.tx+rnd(10,-10), sy, {vx:rnd(50,-50), vy:rnd(-40,-160), r:rnd(5,2)*V, life:rnd(.6,.25)});
        }
        break;
      }
      /* ── FIELDS ────────────────────────────────────────────────────
         Every field used to be the same radial-gradient disc with a
         pulsing ring, recoloured per skill — six skills, one silhouette.
         Each now gets a bespoke ARCHETYPE instead, and they share only
         the things that should be shared: a ground-plane footprint, a
         grow-in, and a flash synced to the damage tick.

         Two constraints shape all of this:
         1. drawActs runs under globalCompositeOperation='lighter', so
            black paints NOTHING. A void core cannot be drawn dark — it
            has to be an unpainted hole ringed by light, and every halo
            around one must be an ANNULUS gradient (transparent at the
            centre) or it fills the hole back in.
         2. The arena is a ground plane. Anything circular is squashed
            onto it by SQ and anything structural rises from that
            footprint, so a field sits in the floor instead of floating
            in front of the camera like a screen-space decal.          */
      case 'field': {
        const e = efxOf(sk);
        const seed = a.id*2.71;
        const gy = a.y + 18;          // floor line the field sits on
        const SQ = 0.34;              // ground-plane squash
        /* grow-in (ease-out cubic) and fade-out envelopes. A field used
           to pop in fully formed and vanish mid-pulse; now it opens and
           closes, which is most of why it reads as an event. */
        const gi = 1 - Math.pow(1 - clamp(a.t/0.42, 0, 1), 3);
        const fo = clamp((a.dur - a.t)/0.6, 0, 1);
        const A  = gi * fo;                       // master alpha
        /* Radius grows in but is NEVER scaled by V: sk.area is the real
           damage radius, and inflating it for a combo would lie about
           where the field actually hits. V drives widths and glow only. */
        const R  = sk.area * (0.42 + 0.58*gi);
        /* Flash synced to the ACTUAL damage tick — a.next counts down
           from a.per, so this spikes to 1 the instant the field bites
           and decays over 0.22s. The field pulses because it is hurting
           someone, not on a decorative sine. */
        const tick = a.per ? clamp(1 - (a.per - a.next)/0.22, 0, 1) : 0;
        const flash = tick*tick;

        /* Fusion fields dispatch on the ARCHETYPE, never on sk.id: ids are
           minted per grade (`fz_magmavein_3`), so keying on the id the way
           the tier skills below do would match nothing and drop all seven
           fusion fields into the fallback disc. `ink` carries both parent
           family colours plus the grade weight `k` every count below
           multiplies by, so ✦9 is visibly denser than ✦1. */
        const fz  = sk.fused ? (sk.fuseOf || '') : '';
        const ink = fz ? fzInk(sk) : null;
        /* whole damage ticks elapsed — the discrete clock the archetypes that
           BUILD (the tomb closing, the vein erupting) step on */
        const bite = a.per ? Math.floor(a.t/a.per) : 0;

        if(sk.id==='gravitywell' || sk.id==='singularity'){
          /* ── ACCRETION VORTEX ──────────────────────────────────────
             Spiral arms wound onto the floor plane, and a genuine hole
             at the middle: the horizon rim is stroked bright and the
             halo around it is an ANNULUS, so the centre stays unpainted
             and reads black against the lit floor. Singularity is the
             same grammar wound tighter and faster, plus a polar jet —
             an escalation of the tier-3 well, not a recolour of it. */
          const big   = sk.id==='singularity';
          const arms  = big ? 7 : 5;
          const twist = big ? 1.9 : 1.3;
          const rot   = -t*(big ? 2.1 : 1.45);
          ctx.lineCap='round';
          for(let k=0;k<arms;k++){
            const a0 = rot + k*TAU/arms;
            ctx.beginPath();
            for(let i=0;i<=24;i++){
              const q  = i/24;                     // 1 = rim, 0 = core
              const rr = R*(1 - q*0.94);
              const aa = a0 + q*twist*TAU;
              const x  = a.x + Math.cos(aa)*rr, y = gy + Math.sin(aa)*rr*SQ;
              i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
            }
            /* one path, three passes: haze, body, hot filament — the arm
               gains depth without tripling the geometry cost */
            ctx.strokeStyle=col;
            ctx.globalAlpha=A*0.16*(1+flash*0.7); ctx.lineWidth=9*V; ctx.stroke();
            ctx.globalAlpha=A*0.55;               ctx.lineWidth=2.4*V; ctx.stroke();
            ctx.strokeStyle=e.core;
            ctx.globalAlpha=A*(0.30+flash*0.45);  ctx.lineWidth=1*V; ctx.stroke();
          }
          /* infalling debris: short tails riding the same spiral the arms
             use, so matter visibly travels the arms into the core */
          ctx.strokeStyle=e.core;
          for(let s=0;s<(big?14:9);s++){
            const h  = _hash1(seed + s*3.1), h2 = _hash1(seed + s*3.1 + 9);
            const ph = (t*(0.5 + h2*0.55) + h) % 1;   // 0 rim → 1 core
            ctx.globalAlpha = A*(1-ph)*0.75;
            ctx.lineWidth = (1.6 + h2)*V;
            ctx.beginPath();
            for(let i=0;i<=4;i++){
              const q  = clamp(ph + i*0.035, 0, 1);
              const rr = R*(1-q)*0.98;
              const aa = h*TAU + q*twist*TAU + rot;
              const x  = a.x + Math.cos(aa)*rr, y = gy + Math.sin(aa)*rr*SQ;
              i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
            }
            ctx.stroke();
          }
          ctx.lineCap='butt';
          /* event horizon: bright rim, hollow middle */
          const hr = R*(big?0.20:0.16)*(1 + Math.sin(t*6)*0.05 + flash*0.12);
          const hg = ctx.createRadialGradient(a.x,gy,hr*0.72, a.x,gy,hr*3.1);
          hg.addColorStop(0,   col+'00');    // centre stays UNPAINTED
          hg.addColorStop(0.30,col+'dd');
          hg.addColorStop(1,   col+'00');
          ctx.globalAlpha=A*(0.75+flash*0.25); ctx.fillStyle=hg;
          ctx.beginPath(); ctx.arc(a.x, gy, hr*3.1, 0, TAU); ctx.fill();
          ctx.globalAlpha=A*0.95; ctx.strokeStyle=e.core; ctx.lineWidth=2.2*V;
          ctx.beginPath(); ctx.ellipse(a.x, gy, hr, hr*0.62, 0,0,TAU); ctx.stroke();
          if(big){
            /* polar jet — the tier-5 tell. Two tapering columns of light
               thrown off the poles of the horizon. */
            /* Only the UP jet is drawn: the arena is a floor, so a downward
               jet would have to punch through it, and a symmetric pair on
               a ground plane just reads as a smear across the middle.
               Height is well past the disc radius — a jet that does not
               clearly escape the accretion disc reads as a bulge. */
            const jh = R*1.35*(0.88 + Math.sin(t*3.1)*0.12);
            const jw = hr*0.5;
            /* haze, then body, then a hot filament up the axis: same three
               passes the spiral arms use, so the jet belongs to the same
               object rather than looking pasted on */
            for(const pass of [[jw*2.6, 0.20, col], [jw, 0.5, col], [jw*0.28, 0.8, e.core]]){
              const jg = ctx.createLinearGradient(a.x, gy, a.x, gy - jh);
              jg.addColorStop(0,    pass[2]+'00');   // hidden inside the horizon
              jg.addColorStop(0.16, pass[2]+'ee');
              jg.addColorStop(1,    pass[2]+'00');   // dissipates at the top
              ctx.globalAlpha=A*pass[1]*(0.8+flash*0.4); ctx.fillStyle=jg;
              ctx.beginPath();
              ctx.moveTo(a.x - pass[0], gy);
              ctx.lineTo(a.x + pass[0], gy);
              ctx.lineTo(a.x + pass[0]*0.22, gy - jh);
              ctx.lineTo(a.x - pass[0]*0.22, gy - jh);
              ctx.closePath(); ctx.fill();
            }
          }
        } else if(sk.id==='plaguewell'){
          /* ── BUBBLING MIRE ─────────────────────────────────────────
             Deliberately the only field with NO rotational symmetry: a
             lopsided pool whose outline crawls, with bubbles that rise,
             thin and burst. Rotation is what made every old field feel
             machined; a swamp should look grown. */
          /* 4 harmonics, not 7: fewer and bigger lobes, so the pool has a
             couple of distinct bays instead of a faint all-over ripple
             that just re-traces the footprint ellipse. */
          const ph = _phases(seed, 4);
          /* Base high and amplitude modest: the pool must still cover the
             footprint it damages. At amp 0.34 one bay collapsed inward far
             enough to leave a third of the hit radius visibly empty, which
             reads as "the sludge is over there" — wrong, and unfair. */
          const pool = aa => R*(0.90 + _loopNoiseP(aa + t*0.30, ph, 4)*0.15);
          ctx.beginPath();
          for(let i=0;i<=48;i++){
            const aa = i/48*TAU, rr = pool(aa);
            const x  = a.x + Math.cos(aa)*rr, y = gy + Math.sin(aa)*rr*SQ;
            i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
          }
          ctx.closePath();
          /* the sludge itself has to have BODY — at the old alphas the pool
             was a rim with nothing in it. Filled hot in the middle and
             carried most of the way out before it falls off. */
          const pg = ctx.createRadialGradient(a.x,gy,R*0.04, a.x,gy,R);
          pg.addColorStop(0,   col+'ff');
          pg.addColorStop(0.45,col+'9c');
          pg.addColorStop(0.82,col+'46');
          pg.addColorStop(1,   col+'00');
          ctx.globalAlpha=A*(0.62+flash*0.30); ctx.fillStyle=pg; ctx.fill();
          ctx.globalAlpha=A*0.72; ctx.strokeStyle=col; ctx.lineWidth=2.4*V; ctx.stroke();
          /* tide marks: the pool has drained and refilled, and the rings it
             left behind give the surface depth the flat gradient cannot */
          ctx.globalAlpha=A*0.30; ctx.lineWidth=1.2*V;
          for(const q of [0.74, 0.52, 0.33]){
            ctx.beginPath();
            for(let i=0;i<=32;i++){
              const aa = i/32*TAU, rr = pool(aa)*q;
              const x = a.x + Math.cos(aa)*rr, y = gy + Math.sin(aa)*rr*SQ;
              i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
            }
            ctx.closePath(); ctx.stroke();
          }
          /* sludge veins creeping outward from the middle */
          ctx.strokeStyle=col; ctx.lineCap='round';
          for(let v=0;v<11;v++){
            const va = _hash1(seed+v*1.7)*TAU;
            /* bounded by the pool outline AT THIS ANGLE, not by R: the pool
               is lopsided, so a vein measured against R punched out through
               the shallow bays and read as a spike, not as sludge */
            const vl = pool(va)*(0.55 + _hash1(seed+v*1.7+5)*0.38);
            ctx.globalAlpha=A*0.34; ctx.lineWidth=(1.2 + _hash1(seed+v+70)*1.8)*V;
            /* Veins start PART WAY out, not at the centre. Eleven strokes
               leaving one pixel is a starburst — a decoration with an
               obvious middle — whereas veins that begin at scattered
               depths read as sludge seeping through itself. */
            const q0 = 0.16 + _hash1(seed+v*1.7+91)*0.22;
            const p0 = q0*vl;
            ctx.beginPath();
            ctx.moveTo(a.x + Math.cos(va)*p0, gy + Math.sin(va)*p0*SQ);
            for(let s=1;s<=7;s++){
              const q = q0 + (1-q0)*(s/7);
              const bend = _vnoise(v*4.3 + q*3.2 + t*0.8)*R*0.16*q;
              const aa = va + bend/Math.max(R*q, 1);
              ctx.lineTo(a.x + Math.cos(aa)*vl*q, gy + Math.sin(aa)*vl*q*SQ);
            }
            ctx.stroke();
          }
          ctx.lineCap='butt';
          /* bubbles: rise, swell, thin out, pop. Drawn as rings (the film)
             with a highlight, never as filled dots — a filled dot is a
             particle, a ring is a bubble. */
          for(let b=0;b<24;b++){
            const h1 = _hash1(seed+b*2.3), h2 = _hash1(seed+b*2.3+31);
            const bp = (t*(0.45 + h2*0.5) + h1) % 1;
            const ba = h1*TAU, brr = pool(ba)*(0.12 + h2*0.80);
            const bx = a.x + Math.cos(ba)*brr;
            const by = gy + Math.sin(ba)*brr*SQ - bp*26*V;
            /* swell as it rises, and the biggest are big enough to read as
               bubbles rather than as sparks that forgot to move */
            const br = (4.5 + h2*9)*V*(0.55 + bp*0.8);
            const fade = (1-bp)*(1-bp);
            /* the film: a bright arc across the TOP of the ring and a dim
               one under it — an evenly-lit ring reads as a hoop, a ring
               that catches light on one side reads as a sphere */
            ctx.strokeStyle = col;
            ctx.globalAlpha = A*fade*0.5;  ctx.lineWidth = 1.2*V;
            ctx.beginPath(); ctx.arc(bx, by, br, 0.5, Math.PI-0.1); ctx.stroke();
            ctx.globalAlpha = A*fade*0.95; ctx.lineWidth = 1.8*V;
            ctx.beginPath(); ctx.arc(bx, by, br, Math.PI+0.15, TAU+0.3); ctx.stroke();
            ctx.globalAlpha = A*fade*0.7; ctx.fillStyle = e.core;
            ctx.beginPath(); ctx.arc(bx - br*0.34, by - br*0.36, br*0.26, 0, TAU); ctx.fill();
          }
        } else if(sk.id==='frostcathedral'){
          /* ── GOTHIC CATHEDRAL ──────────────────────────────────────
             The name promises architecture, so it builds some: a ring of
             ice pillars joined by POINTED arches, with a spire at the
             centre. Pillars are depth-sorted and the far ones are dimmed
             and shortened, which is what turns a flat ring of sticks
             into a room the fighters are standing inside. */
          const N = 14, H = R*0.34;
          const idx = [];
          for(let i=0;i<N;i++) idx.push(i);
          const angOf = i => i*TAU/N + t*0.32;
          /* back to front: sin<0 is the far side of the ellipse */
          idx.sort((u,w) => Math.sin(angOf(u)) - Math.sin(angOf(w)));
          const px = i => a.x + Math.cos(angOf(i))*R*0.9;
          const py = i => gy  + Math.sin(angOf(i))*R*0.9*SQ;
          /* depth 0 (far) → 1 (near), used for both alpha and height */
          const dp = i => (Math.sin(angOf(i)) + 1)*0.5;
          for(const i of idx){
            const d = dp(i), x0 = px(i), y0 = py(i);
            const h = H*(0.62 + d*0.38)*(0.9 + _hash1(seed+i)*0.2);
            const al = A*(0.3 + d*0.55);
            /* shaft, tapering — two edges rather than one line, so it
               has width and reads as a column not a wire */
            const w0 = 3.4*V*(0.7+d*0.5), w1 = w0*0.45;
            ctx.globalAlpha=al*0.8; ctx.fillStyle=col;
            ctx.beginPath();
            ctx.moveTo(x0-w0, y0); ctx.lineTo(x0+w0, y0);
            ctx.lineTo(x0+w1, y0-h); ctx.lineTo(x0-w1, y0-h);
            ctx.closePath(); ctx.fill();
            /* lit edge down one side of every shaft */
            ctx.globalAlpha=al; ctx.strokeStyle=e.core; ctx.lineWidth=1*V;
            ctx.beginPath(); ctx.moveTo(x0-w0*0.5, y0); ctx.lineTo(x0-w1*0.5, y0-h); ctx.stroke();
            /* crystal finial */
            ctx.globalAlpha=al*(0.85+flash*0.15); ctx.fillStyle=e.core;
            ctx.beginPath();
            ctx.moveTo(x0, y0-h-7*V); ctx.lineTo(x0+2.6*V, y0-h);
            ctx.lineTo(x0, y0-h+2*V); ctx.lineTo(x0-2.6*V, y0-h);
            ctx.closePath(); ctx.fill();
            /* pointed arch to the NEXT pillar: two quadratics meeting at
               a raised apex, sampled by hand so the curve flattens the
               same way everywhere */
            const j = (i+1)%N, x1 = px(j), y1 = py(j);
            const apx = (x0+x1)*0.5, apy = (y0+y1)*0.5 - h - R*0.10;
            const spring = 0.55;                       // where the arch starts
            const sx0 = x0, sy0 = y0 - h*spring, sx1 = x1, sy1 = y1 - h*spring;
            ctx.globalAlpha=al*0.5; ctx.strokeStyle=col; ctx.lineWidth=1.6*V;
            ctx.beginPath();
            for(let s=0;s<=8;s++){
              const q=s/8, iq=1-q;
              const cx0 = x0, cy0 = y0-h;              // control: top of shaft
              const bx = iq*iq*sx0 + 2*iq*q*cx0 + q*q*apx;
              const by = iq*iq*sy0 + 2*iq*q*cy0 + q*q*apy;
              s ? ctx.lineTo(bx,by) : ctx.moveTo(bx,by);
            }
            for(let s=0;s<=8;s++){
              const q=s/8, iq=1-q;
              const cx1 = x1, cy1 = y1-h;
              const bx = iq*iq*apx + 2*iq*q*cx1 + q*q*sx1;
              const by = iq*iq*apy + 2*iq*q*cy1 + q*q*sy1;
              ctx.lineTo(bx,by);
            }
            ctx.stroke();
          }
          /* central spire, taller than the colonnade so the silhouette
             has a peak instead of reading as a flat crown of spikes */
          const sh = H*1.5*(0.94 + Math.sin(t*2.2)*0.06);
          ctx.globalAlpha=A*0.34; ctx.fillStyle=col;
          ctx.beginPath();
          ctx.moveTo(a.x-6.5*V, gy); ctx.lineTo(a.x+6.5*V, gy); ctx.lineTo(a.x, gy-sh);
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha=A*(0.55+flash*0.4); ctx.strokeStyle=e.core; ctx.lineWidth=1.4*V;
          ctx.beginPath(); ctx.moveTo(a.x, gy); ctx.lineTo(a.x, gy-sh); ctx.stroke();
          ctx.globalAlpha=A*0.5; ctx.fillStyle=e.core;
          shpCrystal(a.x, gy-sh, 7*V, t*1.1, 0, seed); ctx.fill();
          /* frost creeping across the floor inside the colonnade */
          ctx.globalAlpha=A*0.3; ctx.strokeStyle=col; ctx.lineWidth=1.2*V;
          ctx.beginPath(); ctx.ellipse(a.x, gy, R*0.62, R*0.62*SQ, 0,0,TAU); ctx.stroke();
        } else if(sk.id==='grasproots'){
          /* ── ERUPTING ROOTS ────────────────────────────────────────
             Roots claw UP out of the floor and hook back over, growing
             with `gi` so the cast is visibly the ground breaking open.
             Everything else here is a ring; this one is a thicket, and
             the cracks under it are what sell the eruption.            */
          /* soil cracks first — they belong under the roots */
          ctx.strokeStyle=col; ctx.globalAlpha=A*0.3; ctx.lineWidth=1.3*V;
          for(let c=0;c<10;c++){
            const ca = _hash1(seed+c*5.9)*TAU, cl = R*(0.3+_hash1(seed+c*5.9+4)*0.62);
            ctx.beginPath(); ctx.moveTo(a.x, gy);
            for(let s=1;s<=4;s++){
              const q=s/4, jag = (_hash1(seed+c*5.9+s)-0.5)*0.32;
              const aa = ca + jag*q;
              ctx.lineTo(a.x + Math.cos(aa)*cl*q, gy + Math.sin(aa)*cl*q*SQ);
            }
            ctx.stroke();
          }
          ctx.lineCap='round'; ctx.lineJoin='round';
          const NR = 10;
          for(let r=0;r<NR;r++){
            const h1 = _hash1(seed+r*3.7), h2 = _hash1(seed+r*3.7+13);
            const ra = r*TAU/NR + (h1-0.5)*0.5;
            const reach = R*(0.55 + h2*0.45);
            const arc   = R*(0.30 + h1*0.26);          // how high it lifts
            const sway  = Math.sin(t*1.5 + r)*0.06;
            /* grow from the base outward, so early frames show stubs */
            const grow  = clamp(gi*1.25 - r*0.02, 0.05, 1);
            const pts = [];
            for(let s=0;s<=10;s++){
              const q = (s/10)*grow;
              const rr = reach*q;
              const aa = ra + sway*q;
              /* lift follows sin(q*pi*0.85): out of the ground, over the
                 top, and starting back down — a claw, not a rainbow */
              const lift = Math.sin(q*Math.PI*0.85)*arc;
              const wob  = _vnoise(r*7.1 + q*3.4)*R*0.05;
              pts.push([a.x + Math.cos(aa)*rr + wob,
                        gy  + Math.sin(aa)*rr*SQ - lift]);
            }
            /* taper: stroke the whole root thick, then the inner portion
               thicker still, so it is fat at the base and fine at the tip */
            ctx.globalAlpha=A*0.55; ctx.strokeStyle=col;
            ctx.lineWidth=2*V; tracePts(pts); ctx.stroke();
            ctx.globalAlpha=A*0.5; ctx.lineWidth=4.6*V;
            tracePts(pts.slice(0, 6)); ctx.stroke();
            ctx.globalAlpha=A*0.45; ctx.lineWidth=7*V;
            tracePts(pts.slice(0, 3)); ctx.stroke();
            /* one offshoot per root, from a stable mid vertex */
            if(h2 > 0.35 && grow > 0.6){
              const bi = 4 + ((h1*3)|0);
              const bp = pts[Math.min(bi, pts.length-1)];
              const bang = ra + (h1-0.5)*1.5 - Math.PI*0.25;
              const bl = R*0.2*grow;
              ctx.globalAlpha=A*0.4; ctx.lineWidth=1.6*V;
              ctx.beginPath(); ctx.moveTo(bp[0], bp[1]);
              ctx.lineTo(bp[0] + Math.cos(bang)*bl, bp[1] + Math.sin(bang)*bl*0.7);
              ctx.stroke();
            }
            /* claw tip catches the light */
            const tip = pts[pts.length-1];
            ctx.globalAlpha=A*(0.6+flash*0.4); ctx.fillStyle=e.core;
            ctx.beginPath(); ctx.arc(tip[0], tip[1], 2.2*V, 0, TAU); ctx.fill();
          }
          ctx.lineCap='butt'; ctx.lineJoin='miter';
        } else if(sk.id==='oblivionchain'){
          /* ── ORBITING CHAINS ───────────────────────────────────────
             Real chain, not beads: consecutive links alternate 90° of
             twist (one seen face-on, the next edge-on), which is the
             single detail that makes a row of ovals read as a chain.
             Links are scaled and dimmed by depth and the ring is drawn
             in two halves around the sigil, so the chain passes BEHIND
             the middle of the field and in front again.                */
          /* Link count and length are tied to the ring's circumference, not
             picked by eye: at 16 links of fixed size they sat far apart and
             read as beads on a wire. A link is sized to just OVERLAP its
             neighbour, which is what interlocks them. */
          const NL = 22, chR = R*0.82;
          const step = TAU*chR/NL;          // spacing along the major axis
          const linkL = step*0.62;          // half-length, generous enough to touch
          const rot = t*0.75;
          const angOf = i => rot + i*TAU/NL;
          const depth = i => (Math.sin(angOf(i)) + 1)*0.5;      // 0 far → 1 near
          const drawLink = i => {
            const la = angOf(i), d = depth(i);
            const lx = a.x + Math.cos(la)*chR;
            const ly = gy  + Math.sin(la)*chR*SQ;
            const sc = (0.72 + d*0.5)*V;
            /* tangent of the ellipse, plus the 90° alternation */
            const tang = Math.atan2(Math.cos(la)*SQ, -Math.sin(la));
            const face = i%2 === 0;
            /* face-on links are wide ovals; edge-on links are thin slits */
            const rx = (face ? linkL : linkL*0.38)*sc;
            const ry = linkL*0.56*sc;
            ctx.save(); ctx.translate(lx, ly); ctx.rotate(tang);
            /* iron body, then the hole through it, then a highlight on the
               near edge — three strokes is what separates a forged link
               from a drawn oval */
            ctx.globalAlpha = A*(0.34 + d*0.52)*(0.85 + flash*0.15);
            ctx.strokeStyle = col; ctx.lineWidth = (2.2 + d*1.8)*V;
            ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.stroke();
            ctx.globalAlpha = A*(0.22 + d*0.34);
            ctx.strokeStyle = e.core; ctx.lineWidth = 0.9*V;
            ctx.beginPath(); ctx.ellipse(0, 0, rx*0.58, ry*0.5, 0, 0, TAU); ctx.stroke();
            /* highlight only on the front-facing links */
            if(d > 0.55){
              ctx.globalAlpha = A*(d-0.55)*1.5;
              ctx.strokeStyle = e.core; ctx.lineWidth = 1.1*V;
              ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, Math.PI*1.15, TAU-0.2); ctx.stroke();
            }
            ctx.restore();
          };
          const back = [], front = [];
          for(let i=0;i<NL;i++) (depth(i) < 0.5 ? back : front).push(i);
          for(const i of back) drawLink(i);
          /* binding sigil on the floor: two counter-rotating triangles
             inside a ring — geometric and deliberate, the opposite of
             the plague pool's crawl */
          const sr = R*0.34;
          ctx.strokeStyle=col; ctx.globalAlpha=A*0.45; ctx.lineWidth=1.6*V;
          ctx.beginPath(); ctx.ellipse(a.x, gy, sr, sr*SQ, 0,0,TAU); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(a.x, gy, sr*0.72, sr*0.72*SQ, 0,0,TAU); ctx.stroke();
          for(const dir of [1,-1]){
            ctx.globalAlpha=A*(0.4+flash*0.35); ctx.lineWidth=1.4*V;
            ctx.beginPath();
            for(let s=0;s<=3;s++){
              const aa = dir*t*0.5 + s*TAU/3 + (dir<0 ? Math.PI/3 : 0);
              const x = a.x + Math.cos(aa)*sr*0.86, y = gy + Math.sin(aa)*sr*0.86*SQ;
              s ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
            }
            ctx.stroke();
          }
          /* taut tethers from the sigil out to a few links — the chains
             are anchored to the ground mark, not merely near it */
          ctx.strokeStyle=col; ctx.globalAlpha=A*(0.16+flash*0.4); ctx.lineWidth=1.2*V;
          for(let i=0;i<NL;i+=6){
            const la = angOf(i);
            ctx.beginPath();
            ctx.moveTo(a.x + Math.cos(la)*sr*0.8, gy + Math.sin(la)*sr*0.8*SQ);
            ctx.lineTo(a.x + Math.cos(la)*chR,    gy + Math.sin(la)*chR*SQ);
            ctx.stroke();
          }
          /* the hollow eye of the field: annulus only, centre unpainted */
          const eg = ctx.createRadialGradient(a.x,gy,R*0.05, a.x,gy,R*0.26);
          eg.addColorStop(0, col+'00'); eg.addColorStop(0.45, col+'aa'); eg.addColorStop(1, col+'00');
          ctx.globalAlpha=A*(0.5+flash*0.5); ctx.fillStyle=eg;
          ctx.beginPath(); ctx.arc(a.x, gy, R*0.26, 0, TAU); ctx.fill();
          for(const i of front) drawLink(i);
        /* ── FUSION FIELD ARCHETYPES ──────────────────────────────
           Keyed on sk.fuseOf, so all nine grades of a recipe share a
           silhouette and differ only in density. Placed AHEAD of the
           fallback disc, which stays the safety net for anything added
           later. Every one of these carries both parent family colours
           and obeys the two rules above: the arena is a floor, and
           black paints nothing. */
        } else if(fz==='magmavein'){
          /* ── FISSURE NETWORK ───────────────────────────────────────
             "The ground splits and something older comes up through it."
             A branching crack network laid into the floor. Each crack is
             three passes over one path — a wide crust shoulder in the
             earthen parent, a molten seam that is hottest mid-run and
             cools to the tips, then a white filament — and on every
             damage tick one crack goes white-hot and vents a gout of
             rising embers. Crack count is the grade, so a ✦9 vein webs
             the whole footprint where a ✦1 only splits it. */
          const NC = 5 + Math.round(ink.k*4);
          /* the crack venting THIS tick walks the network, so successive
             eruptions travel round the field instead of repeating */
          const erupt = ((bite % NC) + NC) % NC;
          const crackPts = (ca, len, wob, sd) => {
            const pts = [];
            for(let s=0;s<=9;s++){
              const q  = s/9;
              const aa = ca + _vnoise(sd + q*2.4)*wob;
              const rr = len*q;
              pts.push([a.x + Math.cos(aa)*rr, gy + Math.sin(aa)*rr*SQ]);
            }
            return pts;
          };
          const tracePath = pts => {
            ctx.beginPath();
            for(let i=0;i<pts.length;i++)
              i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
          };
          ctx.lineCap='round'; ctx.lineJoin='round';
          for(let c=0;c<NC;c++){
            const h1 = _hash1(seed + c*3.1), h2 = _hash1(seed + c*3.1 + 17);
            const ca = h1*TAU, len = R*(0.60 + h2*0.38);
            const heat = c===erupt ? flash : 0;
            const main = crackPts(ca, len, 0.30, seed + c*5.7);

            /* the broken ground the seam runs through */
            tracePath(main);
            ctx.strokeStyle=ink.b; ctx.globalAlpha=A*(0.20+heat*0.20);
            ctx.lineWidth=(9 + heat*7)*V; ctx.stroke();
            /* the seam, stroked segment by segment because a single
               stroke cannot taper — hot in the middle, cold at the tips */
            for(let s=0;s<main.length-1;s++){
              const q  = (s+0.5)/(main.length-1);
              const hq = Math.sin(q*Math.PI);
              ctx.beginPath();
              ctx.moveTo(main[s][0], main[s][1]);
              ctx.lineTo(main[s+1][0], main[s+1][1]);
              ctx.strokeStyle=ink.a;
              ctx.globalAlpha=A*(0.26 + hq*0.55 + heat*0.35);
              ctx.lineWidth=(1.6 + hq*2.8 + heat*2.6)*V; ctx.stroke();
            }
            tracePath(main);
            ctx.strokeStyle=ink.hot; ctx.globalAlpha=A*(0.14+heat*0.62);
            ctx.lineWidth=Math.max(0.8, (0.9+heat*1.5)*V); ctx.stroke();
            /* on the tick a bright pulse TRAVELS out along the crack —
               the vein is feeding something, not merely glowing */
            if(tick > 0){
              const i0 = clamp(Math.floor(tick*(main.length-1)), 0, main.length-2);
              ctx.beginPath();
              ctx.moveTo(main[i0][0], main[i0][1]);
              ctx.lineTo(main[i0+1][0], main[i0+1][1]);
              ctx.strokeStyle=ink.hot; ctx.globalAlpha=A*(1-tick)*0.95;
              ctx.lineWidth=4.5*V; ctx.stroke();
            }
            /* one branch per crack — split ground, not a starburst */
            const bi = Math.round((0.42 + _hash1(seed+c+61)*0.26)*(main.length-1));
            const bs = main[bi];
            const bang = ca + (h2<0.5 ? 1 : -1)*(0.5 + h1*0.5);
            ctx.beginPath(); ctx.moveTo(bs[0], bs[1]);
            for(let s=1;s<=5;s++){
              const q = s/5, aa = bang + _vnoise(seed+c*9.3+q*2)*0.34;
              ctx.lineTo(bs[0] + Math.cos(aa)*len*0.42*q,
                         bs[1] + Math.sin(aa)*len*0.42*q*SQ);
            }
            ctx.strokeStyle=ink.b; ctx.globalAlpha=A*0.16; ctx.lineWidth=5*V; ctx.stroke();
            ctx.strokeStyle=ink.a; ctx.globalAlpha=A*(0.32+heat*0.3);
            ctx.lineWidth=1.6*V; ctx.stroke();
          }
          ctx.lineCap='butt'; ctx.lineJoin='miter';

          /* the dome — the "something older". FILLED, not hollowed: this
             is the one part of the field that is matter rather than a
             hole, so it gets a real gradient body. */
          const dr = R*(0.19 + 0.05*Math.sin(t*1.7))*(0.7 + gi*0.3);
          const dg = ctx.createRadialGradient(a.x, gy-dr*0.3, dr*0.05, a.x, gy, dr*1.15);
          dg.addColorStop(0,    ink.hot+'ff');
          dg.addColorStop(0.28, ink.a+'cc');
          dg.addColorStop(0.70, ink.a+'55');
          dg.addColorStop(1,    ink.a+'00');
          ctx.globalAlpha=A*(0.7+flash*0.3); ctx.fillStyle=dg;
          blobPath(a.x, gy, dr, 0.13, seed+8.2, 0.62, t*0.4); ctx.fill();
          ctx.globalAlpha=A*(0.5+flash*0.5); ctx.strokeStyle=ink.hot; ctx.lineWidth=1.6*V;
          blobPath(a.x, gy, dr, 0.13, seed+8.2, 0.62, t*0.4); ctx.stroke();

          /* heat shimmer: the arena has almost no vertical vocabulary, so
             a column of wisps over the dome is what sells the temperature */
          ctx.strokeStyle=ink.a; ctx.globalAlpha=A*0.18; ctx.lineWidth=1.4*V;
          for(let w=0;w<5;w++){
            const wx = a.x + (w-2)*dr*0.44;
            ctx.beginPath();
            for(let s=0;s<=6;s++){
              const q = s/6;
              const px = wx + _vnoise(w*7.7 + q*3 + t*1.6)*11*q;
              s ? ctx.lineTo(px, gy - q*R*0.55) : ctx.moveTo(px, gy);
            }
            ctx.stroke();
          }
          ctx.globalAlpha=1;
          /* embers vent from the erupting crack and RISE (negative grav) */
          if(tick > 0.5 && Math.random() < 0.9){
            const ea = _hash1(seed + erupt*3.1)*TAU, eq = rnd(0.9, 0.2);
            const ex = a.x + Math.cos(ea)*R*0.7*eq, ey = gy + Math.sin(ea)*R*0.7*eq*SQ;
            for(let i=0;i<3;i++)
              fzMote(sk, ex+rnd(9,-9), ey,
                {vx:rnd(55,-55), vy:rnd(-140,-300), grav:-40, life:rnd(1.1,.6)});
          }

        } else if(fz==='umbralcollapse'){
          /* ── FOLDING SHELL ─────────────────────────────────────────
             Shells march INWARD and vanish at the middle — the reverse
             of every other field here, and the whole reason it reads as
             space being folded up rather than a blast going off. The
             centre is left unpainted and ringed by an ANNULUS so it
             stays black under `lighter`. */
          const NS = 3 + Math.round(ink.k*3);
          for(let s=0;s<NS;s++){
            const q = 1 - ((t*0.42 + s/NS) % 1);      // 1 rim → 0 core
            const rr = R*(0.14 + q*0.86);
            const fade = Math.sin(q*Math.PI)*0.9 + 0.1;
            blobPath(a.x, gy, rr, 0.10 + (1-q)*0.12, seed + s*13.1, SQ, -t*0.5 + s);
            fzPass(s%2 ? {a:ink.b, b:ink.a, hot:ink.hot} : ink,
                   A*fade*0.8, 2.2, V, flash*0.4);
          }
          /* creases where the shells fold, radial and brightening on the
             tick — a shell with no creases reads as a bubble */
          const NT = 5 + Math.round(ink.k*4);
          ctx.beginPath();
          for(let i=0;i<NT;i++){
            const aa = i*TAU/NT - t*0.35;
            const c = Math.cos(aa), sn = Math.sin(aa)*SQ;
            ctx.moveTo(a.x + c*R*0.19, gy + sn*R*0.19);
            ctx.lineTo(a.x + c*R*1.01, gy + sn*R*1.01);
          }
          fzPass(ink, A*(0.28+flash*0.40), 1.6, V, flash*0.3);
          /* the hole: annulus only, so the middle stays unpainted */
          const ug = ctx.createRadialGradient(a.x,gy,R*0.05, a.x,gy,R*0.28);
          ug.addColorStop(0, ink.a+'00');
          ug.addColorStop(0.55, ink.a+'cc');
          ug.addColorStop(1, ink.a+'00');
          ctx.globalAlpha=A*(0.55+flash*0.45); ctx.fillStyle=ug;
          ctx.beginPath(); ctx.arc(a.x, gy, R*0.28, 0, TAU); ctx.fill();
          ctx.globalAlpha=A*(0.7+flash*0.3); ctx.strokeStyle=ink.hot; ctx.lineWidth=1.8*V;
          ctx.beginPath(); ctx.ellipse(a.x, gy, R*0.13, R*0.13*SQ, 0,0,TAU); ctx.stroke();
          ctx.globalAlpha=1;

        } else if(fz==='glaciertomb'){
          /* ── SARCOPHAGUS ───────────────────────────────────────────
             "The ground closes over them, one slow layer at a time."
             Slabs rise out of the footprint and lean inward, and a NEW
             layer is laid on every damage tick — so across the field's
             life the tomb visibly corbels shut over whoever is inside.
             Depth-sorted back to front, the same trick that turns the
             frost cathedral's ring of sticks into a room. */
          const HITS = Math.max(2, sk.hits || 4);
          const LAY = Math.min(1 + bite, Math.min(5, HITS));
          const N   = 9 + Math.round(ink.k*4);
          const angOf = (l,i) => i*TAU/N + l*TAU/(N*2) + t*0.12;
          const cells = [];
          for(let l=0;l<LAY;l++) for(let i=0;i<N;i++) cells.push([l,i]);
          cells.sort((u,w) => Math.sin(angOf(u[0],u[1])) - Math.sin(angOf(w[0],w[1])));
          for(let c=0;c<cells.length;c++){
            const l = cells[c][0], i = cells[c][1];
            /* how far this layer has grown since it was laid */
            const g2 = clamp((a.t - l*(a.per||0.6))/0.45, 0, 1);
            if(g2 <= 0) continue;
            const aa = angOf(l,i);
            const d  = (Math.sin(aa)+1)*0.5;              // 0 far → 1 near
            const lr = R*(0.93 - l*0.10);
            const bx = a.x + Math.cos(aa)*lr, by = gy + Math.sin(aa)*lr*SQ;
            const h  = R*0.17*g2*(0.7 + d*0.5);
            const lean = R*0.085*l*g2;
            const tx2 = bx - Math.cos(aa)*lean, ty2 = by - h - Math.sin(aa)*lean*SQ;
            const wdt = (TAU*lr/N)*0.44;
            const px = -Math.sin(aa)*wdt, py = Math.cos(aa)*wdt*SQ;
            ctx.beginPath();
            ctx.moveTo(bx-px, by-py); ctx.lineTo(bx+px, by+py);
            ctx.lineTo(tx2+px*0.72, ty2+py*0.72); ctx.lineTo(tx2-px*0.72, ty2-py*0.72);
            ctx.closePath();
            const ik = l%2 ? {a:ink.b, b:ink.a, hot:ink.hot} : ink;
            /* a faint body so the slab is ICE rather than a wireframe,
               dimmer on the far side — that gradient across the ring is
               what makes it read as enclosing space */
            ctx.fillStyle=ik.a; ctx.globalAlpha=A*(0.09 + d*0.15)*g2; ctx.fill();
            fzPass(ik, A*(0.26 + d*0.44)*g2, 1.5, V, flash*0.3);
          }
          /* the lid, thickening as the layers stack */
          const closed = clamp(LAY/Math.min(5,HITS), 0, 1);
          if(closed > 0.25){
            const lidR = R*0.46*closed;
            /* The lid sits over the brightest part of the ring, and under
               `lighter` a fill plus three stroke passes there clips to flat
               white — the tomb loses its slabs at the exact moment it is
               meant to read as SHUT. Hold the fill down and taper the rim
               back as it closes, so full closure is a dense cap rather than
               a hole burned in the frame. */
            ctx.globalAlpha=A*closed*0.07; ctx.fillStyle=ink.b;
            blobPath(a.x, gy - R*0.26*closed, lidR, 0.08, seed+4.4, 0.5, t*0.1); ctx.fill();
            fzPass(ink, A*(0.42 - closed*0.14), 1.8, V, flash*0.18);
          }
          ctx.globalAlpha=1;
          /* frost falls off the slabs instead of rising off the floor */
          if(Math.random()<0.8){
            const aa = rnd(TAU);
            fzMote(sk, a.x+Math.cos(aa)*R*0.93, gy+Math.sin(aa)*R*0.93*SQ - R*0.2,
              {vx:rnd(30,-30), vy:rnd(90,20), grav:180, life:rnd(.8,.4)});
          }

        } else if(fz==='rotcrown'){
          /* ── CROWN OF THORNS ───────────────────────────────────────
             "It crowns them, and then it eats." Thorns rise from the
             footprint and hook INWARD over the middle — the grasping
             roots' arc-lift pointed the other way — above a web that
             re-strings itself on every damage tick. And it drips. */
          const NTh = 8 + Math.round(ink.k*6);
          const tips = [];
          ctx.lineCap='round'; ctx.lineJoin='round';
          for(let i=0;i<NTh;i++){
            const aa = i*TAU/NTh + t*0.16;
            const h1 = _hash1(seed + i*2.9);
            const bx = a.x + Math.cos(aa)*R*0.94, by = gy + Math.sin(aa)*R*0.94*SQ;
            const H  = R*(0.30 + h1*0.22)*gi;
            const pts = [];
            for(let s=0;s<=8;s++){
              const q = s/8;
              /* rises on a quarter-sine, then curls back over the centre
                 on a q² pull — the two together make a hook, where either
                 alone would only make a stalk or a ramp */
              const lift = Math.sin(q*Math.PI*0.62)*H;
              const inw  = q*q*R*(0.42 + h1*0.24);
              pts.push([bx - Math.cos(aa)*inw, by - lift - Math.sin(aa)*inw*SQ]);
            }
            const tip = pts[pts.length-1];
            tips.push(tip);
            ctx.beginPath();
            for(let s=0;s<pts.length;s++)
              s ? ctx.lineTo(pts[s][0],pts[s][1]) : ctx.moveTo(pts[s][0],pts[s][1]);
            fzPass(i%2 ? {a:ink.b, b:ink.a, hot:ink.hot} : ink,
                   A*(0.52+flash*0.30), 2.6*(0.7+h1*0.6), V, flash*0.25);
            /* barbs along the back of the thorn, on the path normal */
            ctx.beginPath();
            for(let s=2;s<pts.length-1;s+=2){
              const dx = pts[s+1][0]-pts[s-1][0], dy = pts[s+1][1]-pts[s-1][1];
              const m = Math.hypot(dx,dy)||1, bl = R*0.055;
              ctx.moveTo(pts[s][0], pts[s][1]);
              ctx.lineTo(pts[s][0] - dy/m*bl, pts[s][1] + dx/m*bl);
            }
            ctx.strokeStyle=ink.a; ctx.globalAlpha=A*0.5; ctx.lineWidth=1.4*V; ctx.stroke();
            if(Math.random() < 0.05 + flash*0.30)
              fzMote(sk, tip[0], tip[1],
                {vx:rnd(20,-20), vy:rnd(40,10), grav:340, drag:1, life:rnd(.9,.5)});
          }
          ctx.lineCap='butt'; ctx.lineJoin='miter';
          /* the web strung between the tips, re-chorded each tick */
          ctx.beginPath();
          for(let i=0;i<tips.length;i++){
            const j = (i + 2 + (bite % 2)) % tips.length;
            ctx.moveTo(tips[i][0], tips[i][1]); ctx.lineTo(tips[j][0], tips[j][1]);
          }
          fzPass(ink, A*(0.13+flash*0.30), 1.3, V, flash*0.2);
          /* gore pooling under the crown */
          const rg = ctx.createRadialGradient(a.x,gy,R*0.03, a.x,gy,R*0.44);
          rg.addColorStop(0,    ink.hot+'aa');
          rg.addColorStop(0.35, ink.a+'88');
          rg.addColorStop(1,    ink.a+'00');
          ctx.globalAlpha=A*(0.40+flash*0.40); ctx.fillStyle=rg;
          blobPath(a.x, gy, R*0.44, 0.16, seed+2.2, SQ, t*0.2); ctx.fill();
          ctx.globalAlpha=1;

        } else if(fz==='nullaperture'){
          /* ── IRIS ──────────────────────────────────────────────────
             Deliberately MACHINED where the gravity well is fluid: an
             aperture whose blades dilate and snap on the damage tick,
             around a genuinely unpainted pupil. Blade count is the
             grade, so ✦9 is a finer instrument than ✦1. */
          const NB = 6 + Math.round(ink.k*5);
          const open = 0.28 + Math.sin(t*1.3)*0.09 + flash*0.26;
          const rot  = t*0.28;
          ctx.save(); ctx.translate(a.x, gy); ctx.scale(1, SQ);
          /* housing: two rules and a ring of index marks — hard edges,
             evenly spaced, nothing organic anywhere */
          ctx.globalAlpha=A*0.52; ctx.strokeStyle=ink.b; ctx.lineWidth=3.4*V;
          ctx.beginPath(); ctx.arc(0,0,R*0.98,0,TAU); ctx.stroke();
          ctx.globalAlpha=A*0.30; ctx.lineWidth=1.4*V;
          ctx.beginPath(); ctx.arc(0,0,R*0.88,0,TAU); ctx.stroke();
          ctx.globalAlpha=A*0.48; ctx.strokeStyle=ink.a; ctx.lineWidth=2*V;
          ctx.beginPath();
          for(let i=0;i<NB*3;i++){
            const aa = rot + i*TAU/(NB*3), c=Math.cos(aa), s=Math.sin(aa);
            ctx.moveTo(c*R*0.90, s*R*0.90); ctx.lineTo(c*R*0.98, s*R*0.98);
          }
          ctx.stroke();
          /* the blades. Each stops SHORT of the middle on a straight
             chord, which is what leaves the pupil unpainted — a blade
             drawn to the centre would fill the hole back in. */
          for(let i=0;i<NB;i++){
            const a0 = -rot*1.4 + i*TAU/NB, a1 = a0 + TAU/NB*1.06;
            const ir = R*open;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a0)*R*0.9, Math.sin(a0)*R*0.9);
            ctx.lineTo(Math.cos(a0)*ir,    Math.sin(a0)*ir);
            ctx.lineTo(Math.cos(a1)*ir,    Math.sin(a1)*ir);
            ctx.lineTo(Math.cos(a1)*R*0.9, Math.sin(a1)*R*0.9);
            ctx.closePath();
            const bc = i%2 ? ink.b : ink.a;
            ctx.fillStyle=bc;   ctx.globalAlpha=A*(0.09 + flash*0.10); ctx.fill();
            ctx.strokeStyle=bc; ctx.globalAlpha=A*0.55; ctx.lineWidth=1.6*V; ctx.stroke();
          }
          ctx.globalAlpha=A*(0.85+flash*0.15); ctx.strokeStyle=ink.hot; ctx.lineWidth=2.4*V;
          ctx.beginPath(); ctx.arc(0,0,R*open,0,TAU); ctx.stroke();
          ctx.restore();
          /* warp rings pinch INWARD toward the pupil — the aperture is
             taking, not radiating */
          for(let w=0;w<3;w++){
            const q = 1 - ((t*0.6 + w/3) % 1);
            const rr = R*(open + q*(0.95-open));
            ctx.globalAlpha=A*Math.sin(q*Math.PI)*0.38;
            ctx.strokeStyle=ink.hot; ctx.lineWidth=1.4*V;
            ctx.beginPath(); ctx.ellipse(a.x, gy, rr, rr*SQ, 0,0,TAU); ctx.stroke();
          }
          ctx.globalAlpha=1;
          if(Math.random()<0.8){
            const aa = rnd(TAU);
            fzMote(sk, a.x+Math.cos(aa)*R*0.95, gy+Math.sin(aa)*R*0.95*SQ,
              {vx:-Math.cos(aa)*rnd(420,220), vy:-Math.sin(aa)*rnd(420,220)*SQ,
               drag:0.94, life:rnd(.6,.3)});
          }

        } else if(fz==='nullity'){
          /* ── ERASURE GRID ──────────────────────────────────────────
             The field works by DELETING, so the visual has to be things
             going missing rather than things arriving: a lattice clipped
             to the footprint whose cells wink out, leaving hollow rims
             the eye reads as holes. A struck-through rune above the
             middle carries the silence. */
          const CELL = Math.max(15, R*0.20 - ink.k*4);
          ctx.save();
          ctx.beginPath(); ctx.ellipse(a.x, gy, R*0.99, R*0.99*SQ, 0,0,TAU); ctx.clip();
          ctx.globalAlpha=A*0.30; ctx.strokeStyle=ink.b; ctx.lineWidth=1.2*V;
          ctx.beginPath();
          for(let gx=-R; gx<=R; gx+=CELL){
            ctx.moveTo(a.x+gx, gy-R*SQ); ctx.lineTo(a.x+gx, gy+R*SQ);
          }
          for(let gv=-R*SQ; gv<=R*SQ; gv+=CELL*SQ){
            ctx.moveTo(a.x-R, gy+gv); ctx.lineTo(a.x+R, gy+gv);
          }
          ctx.stroke();
          /* the cells that are currently GONE. Which ones is seeded on
             the tick, so the erasure marches instead of flickering. */
          const NX = Math.max(1, Math.floor(2*R/CELL));
          const gone = 3 + Math.round(ink.k*7);
          for(let i=0;i<gone;i++){
            const h1 = _hash1(seed + i*4.7 + bite*1.3);
            const h2 = _hash1(seed + i*4.7 + bite*1.3 + 29);
            /* Sample inside the footprint DISC and then snap to the lattice,
               rather than indexing the bounding box directly: a fifth of the
               box lies outside the ellipse, and those picks were being eaten
               by the clip — the erasure bunched to whichever quadrant the
               hash happened to favour instead of spreading. sqrt(h2) makes
               the radius area-uniform so the middle isn't over-picked. */
            const ang2 = h1*TAU, rad2 = Math.sqrt(h2)*0.80;
            const kx = clamp(Math.round((Math.cos(ang2)*rad2*R + R)/CELL), 0, NX-1);
            const ky = clamp(Math.round((Math.sin(ang2)*rad2*R + R)/CELL), 0, NX-1);
            const cx2 = a.x - R    + kx*CELL;
            const cy2 = gy - R*SQ  + ky*CELL*SQ;
            ctx.globalAlpha=A*(0.48+flash*0.5); ctx.strokeStyle=ink.a; ctx.lineWidth=2*V;
            ctx.strokeRect(cx2, cy2, CELL, CELL*SQ);
            ctx.globalAlpha=A*(0.28+flash*0.4); ctx.strokeStyle=ink.hot; ctx.lineWidth=1*V;
            ctx.strokeRect(cx2+2, cy2+1, CELL-4, Math.max(1, CELL*SQ-2));
          }
          ctx.restore();
          /* the rune, struck through */
          ctx.save(); ctx.translate(a.x, gy - R*0.42);
          const rr2 = R*0.21*(0.85+flash*0.15);
          ctx.globalAlpha=A*0.68; ctx.strokeStyle=ink.a; ctx.lineWidth=2.4*V;
          ctx.beginPath();
          for(let s=0;s<6;s++){
            const aa = -Math.PI/2 + s*TAU/6;
            const px = Math.cos(aa)*rr2, py = Math.sin(aa)*rr2*0.8;
            s ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
          }
          ctx.closePath(); ctx.stroke();
          ctx.globalAlpha=A*(0.78+flash*0.22); ctx.strokeStyle=ink.hot; ctx.lineWidth=3*V;
          ctx.beginPath();
          ctx.moveTo(-rr2*1.15, rr2*0.55); ctx.lineTo(rr2*1.15, -rr2*0.55); ctx.stroke();
          ctx.restore();
          ctx.globalAlpha=1;
          /* nothing rises out of an erasure — motes fall into the floor */
          if(Math.random()<0.6){
            const aa = rnd(TAU), q = rnd(1,0.2);
            fzMote(sk, a.x+Math.cos(aa)*R*q, gy+Math.sin(aa)*R*q*SQ - 44,
              {vx:rnd(20,-20), vy:rnd(120,40), grav:60, life:rnd(.5,.25)});
          }

        } else if(fz==='vitaefamine'){
          /* ── DRAINING MAW ──────────────────────────────────────────
             Everything travels INWARD and the throat stays unpainted —
             a mouth, not a light. Siphon threads sweep from the rim to
             the middle, a bead crawls down each one, and the tide rings
             recede instead of expanding. */
          const NTr = 7 + Math.round(ink.k*6);
          ctx.lineCap='round';
          for(let i=0;i<NTr;i++){
            const h1 = _hash1(seed + i*3.3);
            const a0 = i*TAU/NTr + t*0.22;
            const sweep = 0.55 + h1*0.5;
            ctx.beginPath();
            for(let s=0;s<=14;s++){
              const q  = s/14;                       // 1 rim → 0 throat
              const rr = R*(0.20 + (1-q)*0.78);
              /* the thread SWEEPS as it comes in, so the draw reads as a
                 spiral drag rather than a spoke */
              const aa = a0 + q*sweep;
              const px = a.x + Math.cos(aa)*rr, py = gy + Math.sin(aa)*rr*SQ;
              s ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
            }
            const ik = i%2 ? {a:ink.b, b:ink.a, hot:ink.hot} : ink;
            fzPass(ik, A*(0.38+flash*0.30), 1.8, V, flash*0.2);
            /* the bead: it swells as it nears the throat, so the thread
               is visibly CARRYING something down it */
            const bq  = 1 - ((t*0.55 + h1) % 1);
            const brr = R*(0.20 + (1-bq)*0.78);
            const baa = a0 + bq*sweep;
            const bx = a.x + Math.cos(baa)*brr, by = gy + Math.sin(baa)*brr*SQ;
            ctx.globalAlpha=A*0.85; ctx.fillStyle=ink.hot;
            ctx.beginPath(); ctx.arc(bx, by, (2.2 + (1-bq)*2.2)*V, 0, TAU); ctx.fill();
            glow(bx, by, 13*V, ik.a, A*0.5);
          }
          ctx.lineCap='butt';
          for(let w=0;w<3;w++){
            const q = 1 - ((t*0.5 + w/3) % 1);
            const rr = R*(0.20 + q*0.78);
            ctx.globalAlpha=A*Math.sin(q*Math.PI)*0.34;
            ctx.strokeStyle=ink.b; ctx.lineWidth=2.6*V;
            blobPath(a.x, gy, rr, 0.09, seed+w*7.7, SQ, t*0.3); ctx.stroke();
          }
          /* the throat: annulus rim over an unpainted middle, with a lip
             that works on the damage tick */
          const lip = R*(0.19 + flash*0.05);
          const tg = ctx.createRadialGradient(a.x,gy,lip*0.25, a.x,gy,lip*1.5);
          tg.addColorStop(0,   ink.a+'00');
          tg.addColorStop(0.5, ink.a+'cc');
          tg.addColorStop(1,   ink.a+'00');
          ctx.globalAlpha=A*(0.55+flash*0.45); ctx.fillStyle=tg;
          ctx.beginPath(); ctx.arc(a.x, gy, lip*1.5, 0, TAU); ctx.fill();
          ctx.globalAlpha=A*(0.78+flash*0.22); ctx.strokeStyle=ink.hot; ctx.lineWidth=2.2*V;
          ctx.beginPath(); ctx.ellipse(a.x, gy, lip, lip*SQ, 0,0,TAU); ctx.stroke();
          ctx.globalAlpha=1;

        } else {
          /* fallback for any field skill added later — the original disc */
          const pulse = 0.5+Math.sin(t*5)*0.16;
          ctx.globalAlpha = A*0.28;
          const g3 = ctx.createRadialGradient(a.x,a.y,4,a.x,a.y,R);
          g3.addColorStop(0,col); g3.addColorStop(0.55,col+'55'); g3.addColorStop(1,col+'00');
          ctx.fillStyle=g3; ctx.beginPath(); ctx.arc(a.x,a.y,R,0,TAU); ctx.fill();
          ctx.globalAlpha=A*0.7; ctx.strokeStyle=col; ctx.lineWidth=2*V;
          ctx.beginPath(); ctx.arc(a.x,a.y,R*pulse,0,TAU); ctx.stroke();
        }

        /* shared footprint, drawn LAST so it reads as the field's edge on
           the floor rather than a line the structure sits on top of.
           Geometric archetypes get a clean ellipse, grown ones get a
           noisy outline — the boundary itself carries the character. */
        const organic = sk.id==='plaguewell' || sk.id==='grasproots' ||
                        fz==='magmavein'    || fz==='rotcrown' ||
                        fz==='vitaefamine'  || fz==='umbralcollapse';
        ctx.globalAlpha=A*(0.42+flash*0.3);
        ctx.strokeStyle=ink ? ink.a : col; ctx.lineWidth=2.2*V;
        if(organic){ blobPath(a.x, gy, R*0.99, 0.07, seed+3, SQ, t*0.25); ctx.stroke(); }
        else { ctx.beginPath(); ctx.ellipse(a.x, gy, R*0.99, R*0.99*SQ, 0,0,TAU); ctx.stroke(); }
        /* a fused field's edge is drawn TWICE — once per parent — with the
           second rule set slightly inside, so the boundary itself says which
           two families made it */
        if(ink){
          ctx.globalAlpha=A*(0.26+flash*0.24); ctx.strokeStyle=ink.b; ctx.lineWidth=1.4*V;
          if(organic){ blobPath(a.x, gy, R*0.93, 0.07, seed+3, SQ, t*0.25); ctx.stroke(); }
          else { ctx.beginPath(); ctx.ellipse(a.x, gy, R*0.93, R*0.93*SQ, 0,0,TAU); ctx.stroke(); }
        }
        ctx.globalAlpha=1;

        /* field motes — unchanged behaviour, but launched from the ground
           ellipse instead of a screen-space circle so they rise out of
           the footprint rather than drifting in from off the floor */
        if(Math.random()<0.9){
          const aa = rnd(TAU);
          const ex = a.x + Math.cos(aa)*R, ey = gy + Math.sin(aa)*R*SQ;
          const pull = e.pull ? rnd(420,220) : rnd(280,120);
          efxSpark(sk, ex, ey, {vx:-Math.cos(aa)*pull, vy:-Math.sin(aa)*pull*SQ,
            r:rnd(4,1.6)*V, life:rnd(.7,.35), drag:0.95, rise: e.rise<-80?1:0.3});
        }
        break;
      }
      case 'orbit': {
        const e = efxOf(sk);
        const oink = sk.fused ? fzInk(sk) : null;
        for(let i=0;i<sk.count;i++){
          const aa = a.a + i*TAU/sk.count;
          const ox = a.f.x+Math.cos(aa)*90, oy = a.f.y+Math.sin(aa)*90*0.6;
          /* tether back to the caster — shows these are BOUND to the fighter
             rather than free-floating lights that happen to be nearby */
          ctx.strokeStyle=col; ctx.globalAlpha=0.16; ctx.lineWidth=1.4*V;
          ctx.beginPath(); ctx.moveTo(a.f.x, a.f.y); ctx.lineTo(ox, oy); ctx.stroke();
          ctx.globalAlpha=1;
          glow(ox,oy,22*V*e.glow,col,0.95);
          /* orbiting body cores wear the element's hot colour — a holy
             orbit glows warm gold, a void orbit dark violet */
          ctx.fillStyle=e.core; ctx.beginPath(); ctx.arc(ox,oy,3.6*V,0,TAU); ctx.fill();
          if(Math.random()<0.5)
            efxSpark(sk, ox, oy, {spd:rnd(80,20), r:rnd(3,1.2)*V, life:rnd(.45,.2)});
          /* a collar per body, alternating which parent leads, so the ring
             of satellites carries both families around the caster */
          if(oink){
            const ik = i%2 ? {a:oink.b, b:oink.a, hot:oink.hot, k:oink.k} : oink;
            fzCollar(ik, ox, oy, 11*V, -a.a*2.2 + i, 0.65, 0.6);
          }
        }
        /* ── fused orbit ──
           The satellites are CHORDED to each other by a rotating polygon web
           and stand on a floor seal, so Phase Tempest reads as one bound
           apparatus rather than N independent motes. */
        if(oink && sk.count > 1){
          const step = sk.count > 3 ? 2 : 1;   // a star for 4+, a ring for 3
          ctx.beginPath();
          for(let i=0;i<sk.count;i++){
            const a1 = a.a + i*TAU/sk.count, a2 = a.a + ((i+step)%sk.count)*TAU/sk.count;
            ctx.moveTo(a.f.x+Math.cos(a1)*90, a.f.y+Math.sin(a1)*90*0.6);
            ctx.lineTo(a.f.x+Math.cos(a2)*90, a.f.y+Math.sin(a2)*90*0.6);
          }
          fzPass(oink, 0.5, 1.5, V, 0.05);
          ctx.globalAlpha=1;
          fzSigil(oink, a.f.x, ARENA_H+18, 104, 0.3, -a.a*0.7, 0.30, false);
        }
        break;
      }
    }
  }
  ctx.restore();
}

function drawFx(rdt, t){
  ctx.save(); ctx.globalCompositeOperation='lighter';

  /* fused-cast rites go down FIRST so the floor circle sits under the debris
     the same cast threw, not on top of it */
  drawRites(rdt, t);

  /* floor seals from fused effects — grow out and fade, detail dropping first */
  for(let i=stamps.length-1;i>=0;i--){
    const s = stamps[i]; s.life-=rdt;
    if(s.life<=0){ stamps.splice(i,1); continue; }
    const q = 1 - s.life/s.max;                 // 0 → 1
    fzSigil(s.ink, s.x, s.y, s.rad*(0.5+fzOut(q)*0.5), 0.3,
            t*0.8, (1-q)*0.85, q < 0.65);
  }

  /* ghosts (dash after-images) */
  for(let i=ghosts.length-1;i>=0;i--){
    const g = ghosts[i]; g.life-=rdt;
    if(g.life<=0){ ghosts.splice(i,1); continue; }
    const a = g.life/g.max;
    ctx.globalAlpha = a*0.55;
    ctx.strokeStyle = g.col; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(g.x,g.y,34*(1+(1-a)*0.5),0,TAU); ctx.stroke();
    ctx.globalAlpha=1;
  }
  /* CC shards — converge inward onto the victim, so the effect reads as
     something CLOSING on them rather than exploding outward like damage */
  for(let i=shards.length-1;i>=0;i--){
    const s = shards[i]; s.life-=rdt;
    if(s.life<=0){ shards.splice(i,1); continue; }
    const p = s.life/s.max;              // 1 → 0
    const cx = lerp(s.tx, s.x, p), cy = lerp(s.ty, s.y, p);
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(s.ang);
    ctx.globalAlpha = 1-p*0.35;
    ctx.fillStyle = s.col;
    ctx.beginPath();
    ctx.moveTo(s.r,0); ctx.lineTo(-s.r*0.4, s.r*0.34);
    ctx.lineTo(-s.r*0.4, -s.r*0.34); ctx.closePath(); ctx.fill();
    ctx.restore(); ctx.globalAlpha=1;
  }
  /* status glyphs — a single large symbol that pops and fades, giving the
     lock a readable identity at the moment it lands */
  for(let i=glyphs.length-1;i>=0;i--){
    const g = glyphs[i]; g.life-=rdt;
    if(g.life<=0){ glyphs.splice(i,1); continue; }
    const a = g.life/g.max;
    const s = 1 + (1-a)*0.5;
    ctx.globalAlpha = a*0.95;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font = `700 ${30*s}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = g.col;
    ctx.fillText(g.txt, g.x, g.y - (1-a)*22);
    ctx.globalAlpha=1;
  }
  /* slashes */
  for(let i=slashes.length-1;i>=0;i--){
    const s = slashes[i]; s.life-=rdt;
    if(s.life<=0){ slashes.splice(i,1); continue; }
    const a = s.life/s.max;
    ctx.save(); ctx.translate(s.x,s.y); ctx.rotate(s.ang);
    ctx.globalAlpha=a;
    const g = ctx.createLinearGradient(-s.len/2,0,s.len/2,0);
    g.addColorStop(0,s.col+'00'); g.addColorStop(.5,'#ffffff'); g.addColorStop(1,s.col+'00');
    ctx.fillStyle=g;
    ctx.beginPath();
    ctx.ellipse(0,0,s.len/2, 9*a+1.5, 0,0,TAU); ctx.fill();
    ctx.restore(); ctx.globalAlpha=1;
  }
  /* rings — `sq` squashes onto the arena floor plane. Absent on the older
     screen-space rings (crits, CC, shields), which stay perfect circles. */
  for(let i=rings.length-1;i>=0;i--){
    const r = rings[i]; r.life-=rdt; r.r += r.vr*rdt;
    if(r.life<=0){ rings.splice(i,1); continue; }
    const a = r.life/r.max;
    const rr = Math.max(1, r.r);
    ctx.strokeStyle=r.col; ctx.globalAlpha=a*0.9; ctx.lineWidth=r.w*a+0.6;
    ctx.beginPath();
    if(r.sq) ctx.ellipse(r.x, r.y, rr, rr*r.sq, 0, 0, TAU);
    else     ctx.arc(r.x, r.y, rr, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha=1;
  }
  /* particles */
  for(let i=0;i<P_MAX;i++){
    const p = parts[i]; if(!p.live) continue;
    p.life -= rdt;
    if(p.life<=0){ p.live=false; continue; }
    p.vy += p.grav*rdt;
    p.vx *= Math.pow(p.drag, rdt*60); p.vy *= Math.pow(p.drag, rdt*60);
    p.x += p.vx*rdt; p.y += p.vy*rdt; p.rot += p.spin*rdt;
    const a = p.life/p.max;
    ctx.globalCompositeOperation = p.add ? 'lighter' : 'source-over';
    ctx.globalAlpha = a;
    if(p.sh==='streak'){
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(Math.atan2(p.vy,p.vx));
      ctx.fillStyle=p.col;
      ctx.fillRect(-p.r*3.5, -p.r*0.42, p.r*7, p.r*0.84);
      ctx.restore();
    } else if(p.sh==='shard'){
      /* a small angular sliver — frost/earth debris that tumbles as it
         falls, reading as solid matter rather than a soft spark */
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=p.col;
      const rr=Math.max(0.6,p.r*a);
      ctx.beginPath();
      ctx.moveTo(rr*1.6,0); ctx.lineTo(-rr*0.7, rr*0.7);
      ctx.lineTo(-rr*0.3,0); ctx.lineTo(-rr*0.7,-rr*0.7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if(p.sh==='soft'){
      glow(p.x,p.y,p.r*(2-a),p.col,a*0.32);
    } else {
      ctx.fillStyle=p.col;
      ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.4,p.r*a),0,TAU); ctx.fill();
    }
    ctx.globalAlpha=1;
  }
  ctx.globalCompositeOperation='lighter';

  /* damage numbers */
  ctx.textAlign='center'; ctx.textBaseline='middle';
  for(let i=floats.length-1;i>=0;i--){
    const f = floats[i]; f.life-=rdt; f.y += f.vy*rdt; f.vy += 42*rdt;
    if(f.life<=0){ floats.splice(i,1); continue; }
    const a = clamp(f.life/f.max*1.6,0,1);
    const s = f.crit ? 1 + (1-f.life/f.max)*0.35 : 1;
    ctx.globalAlpha=a;
    ctx.font = `800 ${(f.crit?31:18)*s}px Inter, system-ui, sans-serif`;
    ctx.lineWidth=4; ctx.strokeStyle='#000a'; ctx.strokeText(f.txt,f.x,f.y);
    ctx.fillStyle=f.col; ctx.fillText(f.txt,f.x,f.y);
    if(f.crit){
      ctx.font=`800 ${11*s}px Inter, sans-serif`; ctx.fillStyle='#fff';
      ctx.globalAlpha=a*0.85; ctx.fillText('CRITICAL', f.x, f.y-24*s);
    }
    ctx.globalAlpha=1;
  }
  ctx.restore();
}
/* ═══════════════════════════════════════════════════════════════
   MAIN LOOP — fixed timestep sim, free-running render
   ═══════════════════════════════════════════════════════════════ */
const FIXED = 1/60;
let sim = null, acc = 0, last = 0, running = false, elapsed = 0, endHold = 0;

/* ---- battle speed ----------------------------------------------------
   `battleSpeed` multiplies the SIM only; the renderer keeps running on
   real time, so particles and easing stay smooth at 4x instead of
   turning into a slideshow.

   It is deliberately a separate factor from Time.scale rather than
   folded into it. Time.scale is the slow-mo channel and it eases itself
   back to 1 every frame — writing speed into it would be erased on the
   next update, and a crit would cancel the player's 4x. Multiplying the
   two instead means a crit at 4x still slows down, just from a higher
   floor, which is the behaviour you want.

   The step budget scales with speed too. The guard exists to stop a
   stalled tab from spiralling; at 4x a legitimate frame needs four
   times the steps, and leaving the guard at 8 would silently cap the
   real speed at roughly 2x on a 60Hz display. */
const SPEEDS = [1, 2, 4];
let battleSpeed = 1;

function setSpeed(v, quiet){
  battleSpeed = SPEEDS.includes(v) ? v : 1;
  const bar = $('#speedbar');
  if(bar) bar.querySelectorAll('[data-spd]').forEach(b =>
    b.classList.toggle('on', +b.dataset.spd === battleSpeed));
  if(!quiet){
    /* the buttons are data-sfx="none" so this covers the 1/2/3 keys too;
       tab() rather than click() because changing speed commits nothing */
    sfx.init(); sfx.tab();
    Save.data.speed = battleSpeed; Save.flush();
  }
}

/* Resolve the rest of the fight without drawing it. The sim is
   deterministic and cheap, so this is just the same stepping loop with
   the renderer skipped — the outcome is identical to watching it. */
function skipBattle(){
  /* off-screen means the S key, not the button, so stay silent */
  if(!$('#battle').classList.contains('on')) return;
  sfx.init();
  /* nothing left to skip is a refusal, and a refusal has a sound now —
     the button used to click as though it had done something */
  if(!sim || sim.over !== null){ sfx.deny(); return; }
  sfx.confirm();
  const wasHeadless = World.headless;
  World.headless = true;                 // no particles for frames nobody sees
  let guard = 0;
  while(sim.over === null && guard++ < 60000){ sim.step(FIXED); elapsed += FIXED; }
  World.headless = wasHeadless;
  acc = 0;
  endHold = 99;                          // straight to the result, no victory hold
  /* skipping from a paused fight has to un-pause, or the loop that shows
     the result never runs and the screen sits on a finished battle */
  running = true; last = performance.now();
  syncHud();
}

function frame(now){
  requestAnimationFrame(frame);
  if(!running) return;
  let rdt = Math.min(0.05, (now-last)/1000 || 0);
  last = now;

  Time.update(rdt);

  /* --- simulate --- */
  const sdt = rdt * Time.scale * battleSpeed;
  if(sim && sim.over===null){
    acc += sdt; elapsed += sdt;
    let guard = 0, budget = 8 * battleSpeed;
    while(acc >= FIXED && guard++ < budget){ sim.step(FIXED); acc -= FIXED; }
    syncHud();
  } else if(sim && sim.over!==null){
    endHold += rdt;
    if(endHold > 2.2){ running = false; showResult(); }
  }

  /* --- render --- */
  const t = performance.now()/1000;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#04060d'; ctx.fillRect(0,0,VIEW.w,VIEW.h);

  shake = Math.max(0, shake - rdt*38);
  const sx = rnd(shake,-shake), sy = rnd(shake,-shake);

  ctx.save();
  ctx.translate(VIEW.ox, VIEW.oy); ctx.scale(VIEW.s, VIEW.s);
  /* slow-mo push-in on the impact point */
  if(Time.zoom>1.001){
    ctx.translate(Time.focus.x, Time.focus.y);
    ctx.scale(Time.zoom, Time.zoom);
    ctx.translate(-Time.focus.x, -Time.focus.y);
  }
  ctx.translate(sx,sy);
  ctx.beginPath(); ctx.rect(-40,-40,ARENA_W+80,ARENA_H+80); ctx.clip();

  drawArena(t);
  if(sim){
    /* back-to-front by y so overlap reads correctly */
    const order = [...sim.f].sort((a,b)=>a.y-b.y);
    drawActs(sim,t);
    for(const f of order) if(!f.dead){
      if(f.mob) drawMonster(f,t);
      else if(f.minion) drawPet(f,t);
      else drawFighter(f,t);
    }
  }
  drawFx(rdt,t);

  /* speed lines during slow-mo */
  if(Time.aberr>0.02){
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=Time.aberr*0.16;
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    for(let i=0;i<26;i++){
      const a = (i/26)*TAU + t*0.4, r0=260, r1=620;
      ctx.beginPath();
      ctx.moveTo(Time.focus.x+Math.cos(a)*r0, Time.focus.y+Math.sin(a)*r0);
      ctx.lineTo(Time.focus.x+Math.cos(a)*r1, Time.focus.y+Math.sin(a)*r1);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  /* vignette + crit flash */
  const vg = ctx.createRadialGradient(VIEW.w/2,VIEW.h/2,VIEW.h*0.28,VIEW.w/2,VIEW.h/2,VIEW.h*0.86);
  vg.addColorStop(0,'#00000000'); vg.addColorStop(1,'#000000cc');
  ctx.fillStyle=vg; ctx.fillRect(0,0,VIEW.w,VIEW.h);

  if(flashScr>0.01){
    flashScr = Math.max(0, flashScr - rdt*3.4);
    ctx.globalCompositeOperation='lighter';
    ctx.globalAlpha = flashScr*0.34; ctx.fillStyle = flashCol;
    ctx.fillRect(0,0,VIEW.w,VIEW.h);
    ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
  }
  /* sudden death: creeping ember rim, intensity tracks sim.sudden */
  if(sim && sim.sudden>0.001){
    const s = sim.sudden;
    const pulse = 0.55 + 0.45*Math.sin(t*4.2);
    const rg = ctx.createRadialGradient(VIEW.w/2,VIEW.h/2,VIEW.h*0.22,VIEW.w/2,VIEW.h/2,VIEW.h*0.78);
    rg.addColorStop(0,'#00000000');
    rg.addColorStop(1,`rgba(255,74,42,${(0.16+0.20*s)*pulse})`);
    ctx.globalCompositeOperation='lighter';
    ctx.fillStyle=rg; ctx.fillRect(0,0,VIEW.w,VIEW.h);
    ctx.globalCompositeOperation='source-over';
  }

  /* desaturated bars during slow-mo for a filmic feel */
  if(Time.aberr>0.02){
    const h = VIEW.h*0.055*Time.aberr;
    ctx.fillStyle='#000'; ctx.fillRect(0,0,VIEW.w,h); ctx.fillRect(0,VIEW.h-h,VIEW.w,h);
  }

  /* sudden-death announcement */
  if(sdBanner>0){
    sdBanner = Math.max(0, sdBanner - rdt);
    const life = 1 - sdBanner/2.6;                 /* 0 -> 1 over its lifetime */
    const rise = Math.min(1, life*6);              /* quick slam-in            */
    const fade = sdBanner<0.5 ? sdBanner/0.5 : 1;  /* soft exit                */
    const cy = VIEW.h*0.30 + (1-rise)*34;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    /* backing slab so the text stays legible over the fight */
    ctx.fillStyle='rgba(8,3,2,0.55)';
    ctx.fillRect(0, cy-30, VIEW.w, 60);
    ctx.globalCompositeOperation='lighter';
    ctx.fillStyle='#ff7a4a';
    ctx.shadowColor='#ff4a2a'; ctx.shadowBlur=26;
    ctx.font=`800 ${Math.round(VIEW.h*0.052)}px ui-sans-serif,system-ui,sans-serif`;
    const jit = sdBanner>2.2 ? rnd(-3,3) : 0;      /* impact shudder */
    ctx.fillText('SUDDEN DEATH', VIEW.w/2 + jit, cy);
    ctx.shadowBlur=0;
    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha = fade*0.7;
    ctx.fillStyle='#ffd9c9';
    ctx.font=`600 ${Math.round(VIEW.h*0.021)}px ui-sans-serif,system-ui,sans-serif`;
    ctx.fillText(`the arena claims ${Math.round(SD_FRAC*100)}% max hp every ${SD_PERIOD}s · healing falters`, VIEW.w/2, cy+30);
    ctx.restore();
  }

  /* fused-cast announcement — suppressed entirely while sudden death is on
     screen so the two never fight for the same band. */
  if(fzBanner>0){
    fzBanner = Math.max(0, fzBanner - rdt);
    if(sdBanner<=0) drawFuseBanner(t);
  }
}

/* The screen-space half of a fused cast.

   The ordinary cast has no banner and sudden death has a plain centred one,
   so this deliberately uses a THIRD shape: a slab that wipes open from the
   centre, the name split into the recipe's two family colours, and the recipe
   itself spelled out underneath. The split is the tell — nothing else in the
   game draws text in two colours at once, so even at a glance, before a word
   is read, the treatment alone says "fusion".

   All sizes are fractions of VIEW.h, which is already device-pixel scaled, so
   this holds up from a phone to a 4K window without a second set of numbers. */
function drawFuseBanner(t){
  const p    = 1 - fzBanner/FZ_BANNER;
  const wipe = fzOut(clamp(p/0.22, 0, 1));           // slab opening
  const rise = fzOut(clamp(p/0.16, 0, 1));           // text settling
  const fade = fzBanner < 0.5 ? fzBanner/0.5 : 1;
  const cy   = VIEW.h*0.175 - (1-rise)*20;
  let   nsz  = Math.round(VIEW.h*0.062);              // shrunk to fit, below
  const ssz  = Math.round(VIEW.h*0.019);
  /* Three stacked bands — name, FUSED+pips, recipe — so the slab has to be
     tall enough for all of them plus air. Sized off the name, since that is
     the one line whose height is fixed by legibility rather than by taste. */
  const half = VIEW.h*0.074;                          // slab half-height

  ctx.save();
  ctx.textAlign='center'; ctx.textBaseline='middle';

  /* ── slab ──
     Opens from the centre outward, which points the eye at the name rather
     than dragging it across the screen the way a left-to-right wipe would.
     Kept dark and only semi-opaque: it has to carry white text over a lit
     arena without hiding the fight underneath it. */
  const sw = VIEW.w*wipe;
  ctx.globalAlpha = fade*0.62;
  const sg = ctx.createLinearGradient(VIEW.w/2 - sw/2, 0, VIEW.w/2 + sw/2, 0);
  sg.addColorStop(0,    '#05060c00');
  sg.addColorStop(0.28, '#05060cee');
  sg.addColorStop(0.72, '#05060cee');
  sg.addColorStop(1,    '#05060c00');
  ctx.fillStyle = sg;
  ctx.fillRect(VIEW.w/2 - sw/2, cy-half, sw, half*2);

  ctx.globalCompositeOperation='lighter';

  /* hairline rules top and bottom, each in one family's colour — the recipe
     frames the name before you read either */
  ctx.globalAlpha = fade*0.85;
  for(const [yy,cc] of [[cy-half, fzColA], [cy+half, fzColB]]){
    const rg = ctx.createLinearGradient(VIEW.w/2 - sw/2, 0, VIEW.w/2 + sw/2, 0);
    rg.addColorStop(0, cc+'00'); rg.addColorStop(0.5, cc); rg.addColorStop(1, cc+'00');
    ctx.fillStyle = rg;
    ctx.fillRect(VIEW.w/2 - sw/2, yy-1, sw, 2);
  }

  /* ── the name ──
     Drawn three times: the two family colours offset apart, then white on
     top. The offset collapses to zero over the first third, so the letters
     visibly SNAP together out of their two halves — the fusion assembling
     itself, in the one element the player is already looking at. */
  const split = (1 - fzOut(clamp(p/0.34,0,1))) * VIEW.h*0.012;
  const jit   = p < 0.10 ? rnd(3,-3) : 0;
  const name  = fzName.toUpperCase();
  if('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(nsz*0.07)}px`;
  /* Fusion names run from CATACLYSM to TEN THOUSAND WINDS — twice the width —
     and a portrait viewport is barely wider than the short one at full size.
     So the size is measured down to fit rather than picked: the banner is the
     one element that MUST stay readable, and a clipped name would undo the
     whole point of naming the skill. Measured after letterSpacing is set,
     since spacing is part of the width. */
  ctx.font = `800 ${nsz}px ui-sans-serif,system-ui,sans-serif`;
  const nfit = VIEW.w*0.88;
  const nw   = ctx.measureText(name).width;
  if(nw > nfit){
    nsz = Math.max(12, Math.floor(nsz * nfit/nw));
    if('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(nsz*0.07)}px`;
    ctx.font = `800 ${nsz}px ui-sans-serif,system-ui,sans-serif`;
  }
  const nx = VIEW.w/2 + jit, ny = cy - half*0.30;

  ctx.globalAlpha = fade*0.9;
  ctx.fillStyle = fzColA; ctx.fillText(name, nx - split, ny);
  ctx.fillStyle = fzColB; ctx.fillText(name, nx + split, ny);
  ctx.globalAlpha = fade;
  ctx.shadowColor = fzCol; ctx.shadowBlur = 30;
  ctx.fillStyle = '#ffffff'; ctx.fillText(name, nx, ny);
  ctx.shadowBlur = 0;

  /* a specular sheen travelling across the slab once, early — the cue that
     the thing just landed and is still hot */
  if(p < 0.55){
    const sp = p/0.55, band = VIEW.w*0.22;
    const cxs = VIEW.w*(-0.15) + sp*VIEW.w*1.3;
    const hg = ctx.createLinearGradient(cxs-band, 0, cxs+band, 0);
    hg.addColorStop(0, '#ffffff00');
    hg.addColorStop(0.5, '#ffffff');
    hg.addColorStop(1, '#ffffff00');
    ctx.globalAlpha = fade*(1-sp)*0.16;
    ctx.fillStyle = hg;
    ctx.fillRect(VIEW.w/2 - sw/2, cy-half, sw, half*2);
  }
  if('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  /* ── grade line, then the recipe ──
     "FUSED" alone was the old subtitle and it said nothing the name didn't.
     The recipe is the interesting fact: it is WHY this skill is stronger, and
     seeing "Fire · Frost · Storm" is what makes the cost of the slots feel
     paid back. Kind is appended because a fusion's delivery often differs
     from either parent's.

     The word and the pips are drawn separately, and laid out by measuring
     rather than by padding a single string: the pips carry the family colour
     (so the grade is colour-coded to the recipe) while FUSED stays near-white
     and legible. One fillText in fzCol made the whole line vanish into the
     name's glow whenever the skill colour was dark. */
  ctx.globalCompositeOperation='source-over';
  const pips = '✦'.repeat(clamp(fzGrade,0,6));
  const sub  = [fzRecipe, fzKind].filter(Boolean).join('  ·  ');
  ctx.font = `800 ${ssz}px ui-sans-serif,system-ui,sans-serif`;
  if('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(ssz*0.16)}px`;

  const gy2 = cy + half*0.34;
  const gap = ssz*0.9;
  const wW  = ctx.measureText('FUSED').width;
  const wP  = pips ? ctx.measureText(pips).width : 0;
  const tot = wW + (pips ? (wP + gap)*2 : 0);
  const lx  = VIEW.w/2 - tot/2;

  ctx.textAlign = 'left';
  if(pips){
    ctx.globalAlpha = fade*0.9; ctx.fillStyle = fzColA;
    ctx.fillText(pips, lx, gy2);
    ctx.fillStyle = fzColB;
    ctx.fillText(pips, lx + wP + gap + wW + gap, gy2);
  }
  ctx.globalAlpha = fade*0.95; ctx.fillStyle = '#eef2ff';
  ctx.fillText('FUSED', lx + (pips ? wP + gap : 0), gy2);

  ctx.textAlign = 'center';
  ctx.globalAlpha = fade*0.7;
  ctx.font = `600 ${Math.round(ssz*0.92)}px ui-sans-serif,system-ui,sans-serif`;
  ctx.fillStyle = '#cdd6f5';
  const subT = sub.toUpperCase();
  /* recipes reach VOID · SHADOW · CONTROL · FIELD, so this line needs the same
     measure-down treatment as the name */
  const sfit = VIEW.w*0.86, swid = ctx.measureText(subT).width;
  if(swid > sfit){
    const z = Math.max(9, Math.floor(ssz*0.92 * sfit/swid));
    if('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(z*0.16)}px`;
    ctx.font = `600 ${z}px ui-sans-serif,system-ui,sans-serif`;
  }
  ctx.fillText(subT, VIEW.w/2, cy + half*0.72);
  if('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  ctx.restore();
}
requestAnimationFrame(frame);

/* ---------- HUD ---------- */
/* The health bars still show the two SIDES. In PvE side 1 is the pack as a
   whole, so its bar aggregates: full when every monster is untouched, empty
   when the stage is clear. Individual monsters get their own rail rows. */
function syncHud(){
  const a = sim.f[0];
  const foes = sim.f.filter(x => x.team !== 0);
  const hpFrac = list => {
    let cur = 0, max = 0;
    for(const x of list){ cur += Math.max(0,x.hp); max += x.max; }
    return max ? cur/max : 0;
  };
  const bFrac = sim.pve ? hpFrac(foes) : (foes[0] ? foes[0].hp/foes[0].max : 0);
  $('#hp1').style.transform = `scaleX(${a.hp/a.max})`;
  $('#hp2').style.transform = `scaleX(${bFrac})`;
  $('#sh1').style.transform = `scaleX(${clamp(a.shield/a.max,0,1)})`;
  $('#sh2').style.transform = `scaleX(${clamp(sim.pve?0:(foes[0]?foes[0].shield/foes[0].max:0),0,1)})`;
  $('#v1').textContent = Math.ceil(a.hp) + (a.shield>0?` +${Math.ceil(a.shield)}`:'');
  $('#v2').textContent = sim.pve
    ? `${sim.living(1).length} left`
    : (foes[0] ? Math.ceil(foes[0].hp) + (foes[0].shield>0?` +${Math.ceil(foes[0].shield)}`:'') : '0');
  const m = Math.floor(elapsed/60), s = Math.floor(elapsed%60);
  $('#clock').textContent = `${m}:${String(s).padStart(2,'0')}`;

  /* The ambience reads tension off the bars we just drew — whichever side is
     closest to dying sets it, so the bed tightens for a comeback as readily
     as for a rout. Free: both fractions are already computed above. */
  sfx.amb.set(1 - Math.min(a.hp/a.max, bFrac));

  /* Both rails render the SAME number of slots so the arena is framed
     symmetrically — a 3-skill build next to a 7-skill one used to leave
     one column dangling. The short side is padded with dim empty
     sockets rather than stretched, so row height stays constant and a
     slot means the same thing on both sides. */
  const slots = railSlots(a, foes);
  syncRail(0, a, slots);
  /* right rail: one opponent's skills in a duel, the monster roster in PvE */
  if(sim.pve) syncRoster(slots);
  else if(foes[0]) syncRail(1, foes[0], slots);
  syncUltBar();
}

/* ── ultimate bar ──
   The one control the player still holds once the gate opens, so it is a
   real button rather than a status readout: pressable, keyboard-bound, and
   loud about whether it is ready.

   Rebuilt only when the SET of buttons changes; every frame after that it
   just updates classes and the window bar. Rebuilding each frame would
   restart the ready-pulse animation continuously and it would never pulse. */
const ultState = { sig:null, btns:[] };
function syncUltBar(){
  const host = $('#ultbar');
  if(!host) return;
  /* who gets a button: every champion the local machine is allowed to fire,
     plus a read-only chip for an AI rival so its charge is not a secret */
  const rows = [];
  for(const f of sim.f){
    if(!f.champ || f.minion) continue;
    rows.push({f, mine: !f.autoUlt});
  }
  const sig = rows.map(r => r.f.uidTag + ':' + r.f.champ.id + ':' + r.mine).join('|');
  if(sig !== ultState.sig){
    ultState.sig = sig;
    host.innerHTML = '';
    ultState.btns = [];
    rows.forEach(r=>{
      const c = r.f.champ;
      const el = document.createElement(r.mine ? 'button' : 'div');
      el.className = 'ultbtn' + (r.mine ? '' : ' ai');
      el.style.setProperty('--ck', c.acc);
      const key = r.f.team === 0 ? 'Q' : 'P';
      el.innerHTML = r.mine
        ? `<div class="uk">Ultimate · ${key}</div><div class="un">${c.name}</div>
           <div class="us"></div><div class="uw"></div>`
        : `<div class="uk">Rival</div><div class="un">${c.name}</div><div class="uw"></div>`;
      if(r.mine) el.onclick = ()=>tryUlt(r.f);
      host.appendChild(el);
      ultState.btns.push({el, f:r.f, mine:r.mine,
        us:el.querySelector('.us'), uw:el.querySelector('.uw')});
    });
  }
  for(const b of ultState.btns){
    const f = b.f, live = f.ultT > 0;
    b.el.classList.toggle('live', live);
    b.el.classList.toggle('ready', !live && f.ultReady && b.mine);
    b.el.classList.toggle('spent', !live && !f.ultReady);
    b.uw.style.transform = live ? `scaleX(${clamp(f.ultT/(f.champ.dur||1),0,1)})` : 'scaleX(0)';
    if(b.us){
      /* while Reversal is open the useful number is not the clock, it is
         how much is in the bank — that is what decides whether the payout
         was worth the press */
      b.us.textContent = live
        ? (f.champ.id === 'reversal' ? `STORED ${Math.round(f.ultStore)}` : 'ACTIVE')
        : (f.ultReady ? 'READY' : 'SPENT');
    }
  }
}

/* One gate for both input paths (button and key), so a click and a
   keypress can never disagree about whether a press was legal. */
function tryUlt(f){
  if(!sim || sim.over !== null || !f || !f.champ) return;
  if(!$('#battle').classList.contains('on')) return;
  sfx.init();
  /* A refused press is an interface event, not a combat one: it gets deny()
     rather than the arena's resist blip, which is deliberately near-silent
     and left a dead button feeling like a broken button. */
  if(!f.ultReady || f.ultT > 0){ sfx.deny(); return; }
  /* silence is the one CC that blocks it, and a silenced press must SAY so
     — otherwise a dead button reads as a broken button */
  if(f.has('silence')){
    flashMsg(`${f.name} is silenced`, 'deny');
    return;
  }
  sim.fireUlt(f);
  syncUltBar();
}

/* One shared slot count: whichever side has more to show sets the height
   for both. PvE counts the monster roster, since that is what the right
   rail lists there. */
function railSlots(a, foes){
  const right = sim.pve ? foes.length : (foes[0] ? foes[0].build.length : 0);
  return Math.max(a.build.length, right, 1);
}

/* Grow or trim the dim placeholder slots that sit under the real rows.
   Only ever touches the tail, so the live rows above are never rebuilt. */
function padRail(host, slots){
  while(host.children.length > slots && host.lastChild.classList.contains('empty'))
    host.lastChild.remove();
  while(host.children.length < slots){
    const el = document.createElement('div');
    el.className = 'sk empty';
    el.setAttribute('aria-hidden', 'true');
    host.append(el);
  }
  host._slots = host.children.length;
}

/* Rail rows are built once per fighter and then only mutated, because
   rebuilding 10 rows every frame at 60fps churns the DOM for nothing.
   `_real` remembers how many of a rail's slots are live skills. */
const railState = [{}, {}];
function syncRail(side, f, slots){
  const host = $(side ? '#sk2' : '#sk1'), st = railState[side];
  if(st.f !== f || host._real !== f.build.length){
    st.f = f; buildRail(host, f);
    $(side ? '#rh2' : '#rh1').textContent = `${f.name} · ${f.build.length} skill${f.build.length===1?'':'s'}`;
  }
  if(host._slots !== slots) padRail(host, slots);
  for(let i=0;i<f.build.length;i++){
    const sk = BY_ID[f.build[i].id], el = host.children[i], left = f.cds[i];
    const p = clamp(1 - left/sk.cd, 0, 1);
    el.firstChild.style.transform = `scaleX(${p})`;
    const rdy = left <= 0;
    if(rdy !== el._rdy){ el._rdy = rdy; el.classList.toggle('rdy', rdy); }
    /* Numeric countdown — the thing the fill bar could not tell you.
       One decimal under 10s so the last moments actually tick, whole
       seconds above that to stop the digits flickering. */
    const txt = rdy ? 'READY' : (left < 10 ? left.toFixed(1) : Math.ceil(left)+'');
    if(el._txt !== txt){ el._txt = txt; el.lastChild.textContent = txt; }
  }
  /* CC banner: says why a rotation has stalled */
  const cc = f.ccActive;
  const ccEl = $(side ? '#cc2' : '#cc1');
  const ccTxt = cc ? `${CC_LABEL[cc]||cc} ${f.st[cc].t.toFixed(1)}s` : '';
  if(ccEl.textContent !== ccTxt) ccEl.textContent = ccTxt;
  $(side ? '#rail2' : '#rail1').classList.toggle('gag', !!cc && !f.canCast);
}
const CC_LABEL = {stun:'Stunned', freeze:'Frozen', silence:'Silenced', root:'Rooted'};

function buildRail(host, f){
  host.innerHTML = '';
  /* combo members are highlighted with the same idea the draft uses: a
     glowing border, so the synergy is legible mid-fight and not only in
     the codex. */
  const inCombo = new Map();
  for(const c of activeCombos(f.build))
    for(const id of c.members) inCombo.set(id, comboCol(c));
  for(let i=0;i<f.build.length;i++){
    const b = f.build[i], sk = BY_ID[b.id];
    const el = document.createElement('div');
    /* `fused` stacks with `cmb`: a fusion can still anchor a combo, and the
       two markers read differently (double rim vs glowing border). */
    el.className = 'sk' + (inCombo.has(b.id) ? ' cmb' : '') + (sk.fused ? ' fused' : '');
    el.style.setProperty('--sc', sk.col);
    if(inCombo.has(b.id)) el.style.setProperty('--cbc', inCombo.get(b.id));
    el.innerHTML = `<div class="swipe"></div><span class="dot"></span>`;
    const nm = document.createElement('span');
    nm.className = 'sn';
    /* fusions never level, so the level numeral slot shows the grade */
    nm.textContent = sk.name + (sk.fused ? ' ✦' + sk.grade
                                         : (b.lvl>1 ? ' ' + 'I'.repeat(b.lvl) : ''));
    nm.title = sk.name;
    const cd = document.createElement('span');
    cd.className = 'sd';
    el.append(nm, cd);
    host.append(el);
  }
  host._real = f.build.length;   // live rows; padding slots are appended after
  host._slots = f.build.length;
}

/* PvE right rail: living monsters, boss first. Rebuilt only when the
   roster's shape changes (a spawn or a death), not every frame. */
function syncRoster(slots){
  const host = $('#sk2'), foes = sim.f.filter(x => x.team !== 0);
  const sig = foes.map(x => x.uidTag).join(',');
  if(host._sig !== sig){
    host._sig = sig;
    host.innerHTML = '';
    for(const x of foes){
      const el = document.createElement('div');
      el.className = 'mob' + (x.boss ? ' boss' : '');
      el.style.setProperty('--sc', x.accent);
      el.innerHTML = `<div class="mf"></div><div class="mn"><span></span><b></b></div>`;
      el.querySelector('span').textContent = x.name;
      host.append(el);
    }
    host._real = foes.length;
    host._slots = foes.length;
    $('#rh2').textContent = `Enemies · ${foes.length}`;
  }
  if(slots != null && host._slots !== slots) padRail(host, slots);
  for(let i=0;i<foes.length;i++){
    const x = foes[i], el = host.children[i];
    if(!el) continue;
    el.querySelector('.mf').style.transform = `scaleX(${Math.max(0,x.hp)/x.max})`;
    const v = x.dead ? '—' : Math.ceil(x.hp)+'';
    const b = el.querySelector('b');
    if(b.textContent !== v) b.textContent = v;
    el.classList.toggle('dead', !!x.dead);
  }
  const cc = $('#cc2'); if(cc.textContent) cc.textContent = '';
  $('#rail2').classList.remove('gag');
}
