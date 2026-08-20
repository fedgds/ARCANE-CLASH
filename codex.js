/* ═══════════════════════════════════════════════════════════════
   CODEX — the skill/combo reference screen and its looping

   per-skill preview. Only does work while the Codex tab is open.

   Reads the catalog from core.js; draws with arena-art.js.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ═══════════════════════════════════════════════════════════════
   CODEX — the player-facing skill reference. Shows what a skill
   DOES at each level; it deliberately does not show win rates, which
   are a tuning artefact and only tell a player "don't pick that".
   ═══════════════════════════════════════════════════════════════ */
const KIND_LORE = {
  proj:'Single conjured missile. Tracks its mark.',
  multiproj:'Splits on release; each fragment seeks.',
  beam:'Channelled. Damage lands in ticks while held.',
  nova:'Detonates on the caster. Punishes close range.',
  cone:'Sweeps a forward arc. Needs the enemy in front.',
  rain:'Falls on a zone. Ignores line of sight.',
  dash:'Closes the gap and strikes on the way through.',
  orbit:'Companions circle you and strike what comes near.',
  field:'Persistent zone. Grinds anything standing in it.',
  self:'Cast on yourself. No damage of its own.',
  summon:'Calls a familiar that fights beside you until its time runs out.',
};
const FX_LORE = {
  burn:'Burns for extra damage over time.',
  bleed:'Poison stacks; bypasses shields.',
  chill:'Slows the enemy — their cooldowns crawl.',
  shred:'Strips armour so every later hit lands harder.',
  heal:'Restores health outright.',
  shield:'Absorbs damage until it breaks.',
  haste:'Your own cooldowns shorten.',
  dr:'Blunts incoming damage.',
  dmgAmp:'Everything you throw hits harder.',
  thorns:'Attackers cut themselves on you.',
  crit:'Critical strikes land far more often — and crits bend time.',
  pact:'Trade your own health for raw power.',
  reflect:'A share of damage is thrown back.',
  vamp:'Damage dealt returns to you as health.',
  exec:'Far deadlier against a wounded enemy.',
  pull:'Drags the enemy in and holds them there.',
  immune:'Nothing lands at all for a moment — no crit, no shield spend, no chip.',
  summon:'Calls an ally into the fight. It can be killed like anything else.',
};
let codexTier = 0;                      // 0 = all
let codexView = 'skills';               // 'skills' | 'combos' | 'fusions'

/* ═══════════════════════════════════════════════════════════════
   SKILL PREVIEW — a tiny looping demonstration per skill.

   This deliberately does NOT reuse the battle renderer. That one is
   driven by live Sim acts and assumes arena coordinates, a shared
   particle pool and a global camera; hosting 46 of those would mean
   46 running sims. Instead each preview is a self-contained loop over
   a local particle list on its own small canvas, sharing only the
   per-kind SHAPE vocabulary so what you see here matches what the
   skill actually does in a fight.

   All previews share one rAF driver and only paint canvases that are
   currently on screen (IntersectionObserver), so a 46-card grid costs
   roughly what the handful of visible cards cost.
   ═══════════════════════════════════════════════════════════════ */
const Preview = {
  items: [],          // {cv, ctx, sk, t, parts, live}
  raf: 0,
  io: null,

  reset(){
    this.items.length = 0;
    if(this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if(this.io) this.io.disconnect();
    this.io = ('IntersectionObserver' in window)
      ? new IntersectionObserver(es=>{
          for(const e of es){
            const it = this.items.find(i=>i.cv===e.target);
            if(it) it.live = e.isIntersecting;
          }
        }, {rootMargin:'120px'})
      : null;
  },

  add(cv, sk){
    const c = cv.getContext('2d');
    const it = {cv, ctx:c, sk, t:Math.random()*2, parts:[], live:!this.io};
    this.items.push(it);
    if(this.io) this.io.observe(cv);
    return it;
  },

  start(){
    if(this.raf) return;
    let last = performance.now();
    const tick = now=>{
      const dt = Math.min(0.05, (now-last)/1000); last = now;
      for(const it of this.items) if(it.live) this.draw(it, dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  /* one preview frame. LOOP is the cycle length; every kind maps its
     phase onto 0..1 so the demo reads as a repeating "one cast". */
  draw(it, dt){
    const {ctx:c, cv, sk} = it;
    const W = cv.width, H = cv.height;
    const LOOP = 2.2;
    it.t += dt;
    const cyc = it.t % LOOP, p = cyc / LOOP;
    const col = sk.col || '#fff';

    /* caster sits left, target right — same reading order as the arena */
    const ax = W*0.20, ay = H*0.60, bx = W*0.79, by = H*0.60;

    c.clearRect(0,0,W,H);
    /* faint floor line for grounding */
    c.strokeStyle = '#18203c'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(8, H*0.80); c.lineTo(W-8, H*0.80); c.stroke();

    c.save();
    c.globalCompositeOperation = 'lighter';

    /* local particle pool */
    for(let i=it.parts.length-1;i>=0;i--){
      const q = it.parts[i];
      q.life -= dt;
      if(q.life<=0){ it.parts.splice(i,1); continue; }
      q.vy += (q.grav||0)*dt;
      q.x += q.vx*dt; q.y += q.vy*dt;
      const a = q.life/q.max;
      c.globalAlpha = a;
      c.fillStyle = q.col;
      c.beginPath(); c.arc(q.x, q.y, Math.max(0.4, q.r*a), 0, TAU); c.fill();
    }
    c.globalAlpha = 1;

    const puff = (x,y,n,spd,cc)=>{
      for(let i=0;i<n;i++){
        const a = rnd(TAU), s = rnd(spd, spd*0.3);
        it.parts.push({x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s,
          col:cc||col, life:rnd(.5,.2), max:.5, r:rnd(2.6,1), grav:60});
      }
    };
    const dot = (x,y,r,cc)=>{
      const g = c.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0, cc||col); g.addColorStop(.4,(cc||col)+'99'); g.addColorStop(1,(cc||col)+'00');
      c.fillStyle = g; c.beginPath(); c.arc(x,y,r,0,TAU); c.fill();
    };

    /* --- caster and target pips --- */
    dot(ax, ay, 11, '#5fd0ff');
    c.fillStyle='#cfe9ff'; c.beginPath(); c.arc(ax,ay,3.2,0,TAU); c.fill();
    /* target flinches when the skill is scheduled to connect */
    const impactAt = {proj:.55, multiproj:.55, beam:.30, nova:.45, cone:.35,
                      rain:.60, field:.40, orbit:.40, dash:.45, self:2,
                      summon:.72}[sk.kind] ?? .5;
    const flinch = (p>impactAt && p<impactAt+0.12) ? (1-(p-impactAt)/0.12) : 0;
    if(sk.kind!=='self'){
      dot(bx + flinch*4, by, 11+flinch*5, '#ff5d7a');
      c.fillStyle='#ffd6de'; c.beginPath(); c.arc(bx+flinch*4,by,3.2,0,TAU); c.fill();
    }

    switch(sk.kind){
      case 'proj': case 'multiproj': {
        const n = sk.kind==='multiproj' ? Math.min(sk.hits,3) : 1;
        for(let i=0;i<n;i++){
          const off = i*0.10;
          const q = (p - off);
          if(q<0.08 || q>0.62) continue;
          const k = (q-0.08)/0.54;
          const px = lerp(ax+12, bx-10, k);
          const py = ay + Math.sin(k*Math.PI)*(-6 + i*6);
          c.strokeStyle=col; c.globalAlpha=.45; c.lineWidth=3;
          c.beginPath(); c.moveTo(px-16,py); c.lineTo(px,py); c.stroke();
          c.globalAlpha=1;
          dot(px,py,7);
          c.fillStyle='#fff'; c.beginPath(); c.arc(px,py,1.8,0,TAU); c.fill();
          if(k>0.96) puff(bx-6,by,5,90);
        }
        break;
      }
      case 'beam': {
        if(p>0.18 && p<0.72){
          const w = 4 + Math.sin(it.t*30)*1.2;
          c.strokeStyle=col; c.lineCap='round';
          c.globalAlpha=.3; c.lineWidth=w*3;
          c.beginPath(); c.moveTo(ax+12,ay); c.lineTo(bx-8,by); c.stroke();
          c.globalAlpha=.9; c.lineWidth=w;
          c.beginPath(); c.moveTo(ax+12,ay); c.lineTo(bx-8,by); c.stroke();
          c.strokeStyle='#fff'; c.lineWidth=w*0.3; c.globalAlpha=1;
          c.beginPath(); c.moveTo(ax+12,ay); c.lineTo(bx-8,by); c.stroke();
          dot(bx-8,by,10);
          if(Math.random()<0.5) puff(lerp(ax,bx,Math.random()), ay, 1, 50);
        }
        break;
      }
      case 'nova': {
        /* The wavefront must reach the target at exactly impactAt, or the
           flinch reads as the enemy recoiling from nothing. Rather than
           hand-pick a reach and hope it lines up, solve for it: at
           p=impactAt we want r == distance-to-target, so
             REACH = dist / kAt(impactAt)
           which keeps impactAt the single source of truth. The ring then
           carries on past the target and off the card, which is what an
           expanding shockwave should do. */
        const T0 = 0.12, SPAN = 0.58;
        const REACH = (bx-ax) / Math.max(0.05, (impactAt-T0)/SPAN);
        if(p>T0 && p<T0+SPAN){
          const k=(p-T0)/SPAN, r = k*REACH;
          c.strokeStyle=col; c.globalAlpha=(1-k)*0.95; c.lineWidth=7*(1-k)+1.5;
          c.beginPath(); c.arc(ax,ay,r,0,TAU); c.stroke();
          c.strokeStyle='#fff'; c.globalAlpha=(1-k)*0.7; c.lineWidth=1.5;
          c.beginPath(); c.arc(ax,ay,r*1.02,0,TAU); c.stroke();
          /* ground scorch, flattened, to sell it as a floor-level blast */
          c.strokeStyle=col; c.globalAlpha=(1-k)*0.35; c.lineWidth=2;
          c.beginPath(); c.ellipse(ax,ay+10,r,r*0.28,0,0,TAU); c.stroke();
          c.globalAlpha=1;
          /* spark where the wavefront crosses the target */
          if(!it.novaHit && r >= (bx-ax)){ it.novaHit = 1; puff(bx,by,9,95); }
        }
        if(p<0.10) it.novaHit = 0;
        break;
      }
      case 'cone': {
        /* same derivation as nova: the leading arc must touch the target
           at impactAt, so the sweep distance is solved rather than guessed.
           The static wedge is a separate, shorter radius — it is the
           threat area, and letting it run to the solved sweep distance
           would flood the whole card with gradient. */
        const T0 = 0.15, SPAN = 0.47;
        const SWEEP = (bx-ax) / Math.max(0.05, (impactAt-T0)/SPAN);
        const WEDGE = (bx-ax) + 14;
        if(p>T0 && p<T0+SPAN){
          const k=(p-T0)/SPAN, spread=0.55;
          c.globalAlpha=(1-k)*0.55;
          const g = c.createRadialGradient(ax,ay,6,ax,ay,WEDGE);
          g.addColorStop(0,col); g.addColorStop(1,col+'00');
          c.fillStyle=g;
          c.beginPath(); c.moveTo(ax,ay);
          c.arc(ax,ay,WEDGE,-spread,spread); c.closePath(); c.fill();
          /* leading arc: clamped so it never draws past the wedge it lives in */
          c.globalAlpha=(1-k)*0.9; c.strokeStyle=col; c.lineWidth=2;
          c.beginPath(); c.arc(ax,ay,Math.min(SWEEP*k, WEDGE),-spread,spread); c.stroke();
          /* bright rim edges so the cone has a defined shape */
          c.globalAlpha=(1-k)*0.5; c.lineWidth=1.2;
          for(const s of [-spread, spread]){
            c.beginPath(); c.moveTo(ax,ay);
            c.lineTo(ax+Math.cos(s)*WEDGE, ay+Math.sin(s)*WEDGE); c.stroke();
          }
          c.globalAlpha=1;
          if(!it.coneHit && SWEEP*k >= (bx-ax)){ it.coneHit = 1; puff(bx,by,8,90); }
        }
        if(p<0.13) it.coneHit = 0;
        break;
      }
      case 'rain': {
        const n = Math.min(sk.hits,4);
        for(let i=0;i<n;i++){
          const q = p - i*0.09;
          if(q<0.10 || q>0.70) continue;
          const k=(q-0.10)/0.60;
          const tx = bx + (i-1.5)*13;
          const sy = lerp(-6, by, k);
          c.strokeStyle=col; c.globalAlpha=.75; c.lineWidth=3; c.lineCap='round';
          c.beginPath(); c.moveTo(tx, sy-16); c.lineTo(tx, sy); c.stroke();
          c.globalAlpha=1;
          dot(tx,sy,6);
          /* landing reticle */
          c.strokeStyle=col; c.globalAlpha=.25+k*.5; c.lineWidth=1.4;
          c.beginPath(); c.ellipse(tx, by+6, 11, 3.4, 0,0,TAU); c.stroke();
          c.globalAlpha=1;
          if(k>0.97) puff(tx,by,6,80);
        }
        break;
      }
      case 'field': {
        if(p>0.12){
          const k=Math.min(1,(p-0.12)/0.22);
          const r = (W*0.20)*k, pu = 0.6+Math.sin(it.t*5)*0.18;
          c.globalAlpha=0.26;
          const g = c.createRadialGradient(bx,by,3,bx,by,r);
          g.addColorStop(0,col); g.addColorStop(.6,col+'55'); g.addColorStop(1,col+'00');
          c.fillStyle=g; c.beginPath(); c.arc(bx,by,r,0,TAU); c.fill();
          c.globalAlpha=0.7; c.strokeStyle=col; c.lineWidth=1.6;
          c.beginPath(); c.ellipse(bx,by+5,r*0.95,r*0.30,0,0,TAU); c.stroke();
          c.beginPath(); c.arc(bx,by,r*pu,0,TAU); c.stroke();
          c.globalAlpha=1;
          if(Math.random()<0.45){
            const a=rnd(TAU);
            it.parts.push({x:bx+Math.cos(a)*r, y:by+Math.sin(a)*r,
              vx:-Math.cos(a)*40, vy:-Math.sin(a)*40, col,
              life:.5, max:.5, r:rnd(2.4,1)});
          }
        }
        break;
      }
      case 'orbit': {
        const cnt = sk.count||3;
        for(let i=0;i<cnt;i++){
          const a = it.t*3.2 + i*TAU/cnt;
          const ox = ax+Math.cos(a)*22, oy = ay+Math.sin(a)*22*0.6;
          c.strokeStyle=col; c.globalAlpha=.18; c.lineWidth=1;
          c.beginPath(); c.moveTo(ax,ay); c.lineTo(ox,oy); c.stroke();
          c.globalAlpha=1;
          dot(ox,oy,6);
          c.fillStyle='#fff'; c.beginPath(); c.arc(ox,oy,1.6,0,TAU); c.fill();
          /* trailing motes so the orbit reads as motion even in a
             still frame or a screenshot */
          if(Math.random()<0.12)
            it.parts.push({x:ox, y:oy, vx:-Math.sin(a)*26, vy:Math.cos(a)*16,
              col, life:.35, max:.35, r:rnd(1.8,0.8)});
        }
        /* orbit skills tick damage on the foe: pulse it on the beat so the
           preview shows WHAT IT DOES, not only what it looks like */
        const beat = Math.floor(p*3);
        if(it.orbBeat !== beat){
          it.orbBeat = beat;
          puff(bx,by,6,80);
          it.parts.push({x:bx, y:by, vx:0, vy:0, col:'#fff', life:.2, max:.2, r:5});
        }
        break;
      }
      case 'dash': {
        const hops = Math.min(sk.hits,3);
        const q = p*hops % 1, idx = Math.floor(p*hops);
        const side = idx%2 ? 1 : -1;
        const hx = bx + side*22, hy = by + (idx%2?-5:5);
        /* after-image trail from the caster to the strike point */
        c.globalAlpha=.35; c.strokeStyle=col; c.lineWidth=2;
        c.beginPath(); c.moveTo(lerp(ax,hx,Math.min(1,q*3)), lerp(ay,hy,Math.min(1,q*3)));
        c.lineTo(hx,hy); c.stroke(); c.globalAlpha=1;
        dot(hx,hy,8,'#5fd0ff');
        if(q<0.30){
          c.save(); c.translate(bx,by); c.rotate(side*0.7);
          const g = c.createLinearGradient(-18,0,18,0);
          g.addColorStop(0,col+'00'); g.addColorStop(.5,'#fff'); g.addColorStop(1,col+'00');
          c.fillStyle=g; c.globalAlpha=1-q/0.30;
          c.beginPath(); c.ellipse(0,0,18,3,0,0,TAU); c.fill();
          c.restore(); c.globalAlpha=1;
        }
        /* one spark burst per hop: fires on the frame the hop index
           changes, so a 3-hit dash sparks three times, not every frame */
        if(it.dashIdx !== idx){ it.dashIdx = idx; puff(bx,by,7,105,'#fff'); }
        break;
      }
      case 'self': {
        /* buff: rings contracting onto the caster, then a held aura.
           Invulnerability gets its own treatment further down — a
           contracting ring reads as "I gained a stat", which is exactly
           the wrong story for a window where nothing lands. */
        const k = p<0.5 ? p/0.5 : 1;
        if(sk.fx === 'immune'){
          /* A hard shell snaps shut, then holds with a faceted shimmer,
             then drops. The tell is the SNAP: it has to look binary,
             because the mechanic is binary. */
          if(p < 0.22){
            const q = p/0.22, r = lerp(46, 21, q*q);
            c.strokeStyle=col; c.globalAlpha=q; c.lineWidth=1.5+q*2;
            c.beginPath(); c.arc(ax,ay,r,0,TAU); c.stroke();
            c.globalAlpha=1;
          } else if(p < 0.82){
            const hold = (p-0.22)/0.60;
            /* faceted shell: six chords that rotate slowly */
            const rot = it.t*0.9, r = 21;
            c.globalAlpha = 0.30 + Math.sin(it.t*7)*0.10;
            dot(ax, ay, 26);
            c.globalAlpha = 0.9; c.strokeStyle = col; c.lineWidth = 1.8;
            c.beginPath();
            for(let i=0;i<=6;i++){
              const a = rot + i*TAU/6;
              const px = ax+Math.cos(a)*r, py = ay+Math.sin(a)*r;
              i ? c.lineTo(px,py) : c.moveTo(px,py);
            }
            c.stroke();
            /* incoming shots glance off — the whole point, shown */
            const sh = (hold*3) % 1;
            if(sh < 0.65){
              const sx = lerp(bx, ax+30, sh/0.65);
              c.strokeStyle='#ff5d7a'; c.globalAlpha=0.85; c.lineWidth=3;
              c.beginPath(); c.moveTo(sx+16,by); c.lineTo(sx,by); c.stroke();
              if(sh/0.65 > 0.9) puff(ax+28, ay, 3, 120, '#ff5d7a');
            }
            c.globalAlpha=1;
          } else {
            const q = (p-0.82)/0.18;
            c.strokeStyle=col; c.globalAlpha=(1-q)*0.8; c.lineWidth=2;
            c.beginPath(); c.arc(ax,ay,21+q*14,0,TAU); c.stroke();
            c.globalAlpha=1;
          }
          break;
        }
        if(p<0.5){
          const r = lerp(30, 13, k);
          c.strokeStyle=col; c.globalAlpha=0.85*(1-k*0.4); c.lineWidth=2;
          c.beginPath(); c.arc(ax,ay,r,0,TAU); c.stroke();
          c.globalAlpha=1;
          if(Math.random()<0.5){
            const a=rnd(TAU);
            it.parts.push({x:ax+Math.cos(a)*30, y:ay+Math.sin(a)*30,
              vx:-Math.cos(a)*70, vy:-Math.sin(a)*70, col, life:.45, max:.45, r:rnd(2.4,1)});
          }
        } else {
          dot(ax, ay, 18+Math.sin(it.t*6)*2);
          c.strokeStyle=col; c.globalAlpha=0.5+Math.sin(it.t*6)*0.2; c.lineWidth=1.6;
          c.beginPath(); c.arc(ax,ay,15,0,TAU); c.stroke(); c.globalAlpha=1;
        }
        break;
      }
      case 'summon': {
        /* A sigil opens beside the caster, the familiar rises out of it,
           then goes and hits something. Showing the pet ATTACK matters:
           a summon that just appears reads as a cosmetic, and a player
           needs to see that the thing fights on its own. */
        const n = Math.min(sk.count || 1, 3);
        for(let i=0;i<n;i++){
          const off = i*0.06, q = p - off;
          if(q < 0) continue;
          const px = ax + 26 + i*15, py = ay + (i-(n-1)/2)*15;
          if(q < 0.30){
            /* sigil: a ring plus spokes, brightening */
            const k2 = q/0.30;
            c.save(); c.translate(px, py); c.scale(1, 0.42);
            c.strokeStyle=col; c.globalAlpha=k2; c.lineWidth=2;
            c.beginPath(); c.arc(0,0,16*k2,0,TAU); c.stroke();
            c.lineWidth=1;
            for(let s=0;s<5;s++){
              const a2 = s*TAU/5 + it.t;
              c.beginPath(); c.moveTo(0,0);
              c.lineTo(Math.cos(a2)*16*k2, Math.sin(a2)*16*k2); c.stroke();
            }
            c.restore(); c.globalAlpha=1;
          } else if(q < 0.52){
            /* rise: the body climbs out of the sigil and resolves */
            const k2 = (q-0.30)/0.22;
            c.save(); c.translate(px, py); c.scale(1,0.42);
            c.strokeStyle=col; c.globalAlpha=1-k2; c.lineWidth=2;
            c.beginPath(); c.arc(0,0,16,0,TAU); c.stroke();
            c.restore();
            const ry = py - k2*10;
            c.globalAlpha = k2;
            dot(px, ry, 9);
            c.fillStyle='#fff'; c.globalAlpha=k2;
            c.beginPath(); c.arc(px, ry, 2.6, 0, TAU); c.fill();
            c.globalAlpha=1;
            if(k2>0.9 && Math.random()<0.4) puff(px, ry, 3, 70);
          } else {
            /* lunge at the target and back — one clean swing */
            const k2 = (q-0.52)/0.48;
            const lunge = Math.sin(clamp(k2,0,1)*Math.PI);
            const lx = lerp(px, bx-18, lunge), ly = lerp(py-10, by, lunge);
            dot(lx, ly, 9);
            c.fillStyle='#fff';
            c.beginPath(); c.arc(lx, ly, 2.6, 0, TAU); c.fill();
            c.strokeStyle=col; c.globalAlpha=0.35; c.lineWidth=2;
            c.beginPath(); c.moveTo(lx-Math.sign(bx-px)*13, ly); c.lineTo(lx, ly); c.stroke();
            c.globalAlpha=1;
            if(lunge>0.93) puff(bx-8, by, 4, 110);
          }
        }
        break;
      }
    }

    /* --- rider tell: CC and DoT get a symbol over the victim so the
       preview shows the SECONDARY effect, not just the delivery --- */
    if(sk.fx && p>impactAt && p<impactAt+0.42 && sk.kind!=='self'){
      const a = 1-(p-impactAt)/0.42;
      const v = CC_VIS[sk.fx];
      const sym = v ? v.ico
        : {burn:'🔥', bleed:'☠', chill:'❄', shred:'⚔', vamp:'✚', exec:'✖', pull:'⇆'}[sk.fx];
      if(sym){
        c.globalAlpha = a;
        c.font = '700 15px Inter, system-ui, sans-serif';
        c.textAlign='center'; c.textBaseline='middle';
        c.fillStyle = v ? v.col : col;
        c.fillText(sym, bx, by - 20 - (1-a)*10);
        c.globalAlpha = 1;
      }
    }

    c.restore();
  }
};

function renderCodex(){
  /* view switch: skills vs combos vs fusions */
  const vt = $('#codexView');
  if(vt && !vt.children.length){
    [['skills','Skills'],['combos','Combos'],['fusions','Fusions']].forEach(([v,lab])=>{
      const b = document.createElement('button');
      b.className = 'tab' + (v===codexView?' on':'');
      b.textContent = lab; b.dataset.v = v;
      b.dataset.sfx = 'tab';        // .tab is not in SFX_HIT; opt in explicitly
      b.onclick = ()=>{ codexView = v;
        [...vt.children].forEach(c=>c.classList.toggle('on', c.dataset.v===v));
        paintCodex(); };
      vt.append(b);
    });
  }
  const tabs = $('#codexTabs');
  if(tabs && !tabs.children.length){
    [[0,'All'],[1,'Common'],[2,'Rare'],[3,'Epic'],[4,'Mythic'],[5,'Legendary']].forEach(([t,lab])=>{
      const b = document.createElement('button');
      b.className = 'tab' + (t===codexTier?' on':'');
      b.textContent = lab; b.dataset.t = t;
      b.dataset.sfx = 'tab';
      b.onclick = ()=>{ codexTier = t;
        [...tabs.children].forEach(c=>c.classList.toggle('on', +c.dataset.t===t));
        paintCodex(); };
      tabs.append(b);
    });
  }
  paintCodex();
}
/* Human-readable names for every combo effect key, so the combo codex
   can spell out what a bonus actually does instead of printing `ccPow`.
   `pct` marks values shown as percentages; the rest are flat counts. */
const FX_NAME = {
  critDmg:   ['Critical damage', 1],
  critChance:['Critical chance', 1],
  dmgAmp:    ['All damage', 1],
  cdr:       ['Cooldowns', -1],          // negative: lower is the benefit
  drFlat:    ['Damage taken', -1],
  sustain:   ['Heals and shields', 1],
  vampFlat:  ['Lifesteal on all damage', 1],
  burnPow:   ['Burn damage', 1],
  bleedPow:  ['Poison damage', 1],
  chillPow:  ['Chill strength', 1],
  shredPow:  ['Armour shred', 1],
  execPow:   ['Execute bonus', 1],
  ccPow:     ['Crowd-control duration', 1],
  bleedCap:  ['Extra poison stacks', 0],  // 0: flat integer, not a percent
  immunePow: ['Invulnerability duration', 1],
  petPow:    ['Summon power', 1],
};
function fxRows(fx){
  return Object.entries(fx).map(([k,v])=>{
    const meta = FX_NAME[k];
    if(!meta) return '';
    const [label, mode] = meta;
    let val;
    if(mode === 0)      val = `+${v}`;
    else if(mode < 0)   val = `−${Math.round(v*100)}%`;
    else                val = `+${Math.round(v*100)}%`;
    return `<div class="er"><span class="ev">${val}</span><span class="en">${label}</span></div>`;
  }).join('');
}
/* Which drafted skills can supply a given family — the "how do I build
   this" half of the answer, which a family name alone does not give. */
function skillsInFamily(fam){
  return SKILLS.filter(s => (TAGS[s.id]||[]).includes(fam));
}

function paintCodex(){
  const view = codexView;
  $('#codexGrid').style.display = view==='skills'  ? 'grid' : 'none';
  $('#comboGrid').style.display = view==='combos'  ? 'grid' : 'none';
  const fg = $('#fuseGrid');
  if(fg) fg.style.display = view==='fusions' ? 'grid' : 'none';
  /* The tier filter only means anything to the skill list; leaving the row
     visible over the other two views offers six buttons that do nothing. */
  const tr = $('#codexTabs');
  if(tr && tr.parentElement) tr.parentElement.style.display = view==='skills' ? '' : 'none';
  Preview.reset();
  if(view==='skills')       paintSkills();
  else if(view==='combos')  paintCombos();
  else                      paintFusions();
  Preview.start();
}

/* ── discovery badges ──
   The codex is a reference book, so nothing here is hidden: a skill you
   have never fielded still shows every number, because reading ahead is
   how a player plans a build. The badge only records whether they have
   actually done it. `NEW` means "first fielded today", which needs no
   extra state — Discovery stamps each id with the day key it was met on.

   Defined in the codex block but calling into Discovery, which lives in
   the last script block: both are top-level consts in one shared scope
   and this only runs on a click, long after boot. */
function discBadge(kind, id){
  const L = Discovery.ledger();
  const bucket = kind === 'skill' ? L.skills : kind === 'fusion' ? L.fusions : L.combos;
  const word = kind === 'skill' ? ['Unfielded','Fielded']
             : kind === 'fusion' ? ['Unforged','Forged']
             : ['Unfielded','Triggered'];
  const stamp = bucket[id];
  if(!stamp) return {cls:' undisc', tag:`<span class="disctag">${word[0]}</span>`};
  const fresh = stamp === Daily.dayKey();
  return {
    cls: '',
    tag: fresh ? `<span class="newtag">New</span>`
               : `<span class="disctag seen">${word[1]}</span>`,
  };
}

function paintSkills(){
  const list = SKILLS
    .filter(sk=>!codexTier || sk.tier===codexTier)
    .sort((a,b)=> a.tier-b.tier || a.name.localeCompare(b.name));
  $('#codexGrid').innerHTML = list.map(sk=>{
    const rows = [1,2,3].map(L=>{
      const d = dmgOf(sk,L);
      const eff = skillLine(sk,L).split(' · ').filter(s=>!/dmg$|cd$/.test(s)).join(', ');
      return `<tr><td>LV ${L}</td>
        <td>${d? d+(sk.hits>1?'×'+sk.hits:'') : '—'}</td>
        <td>${eff || '—'}</td></tr>`;
    }).join('');
    const bd = discBadge('skill', sk.id);
    return `<div class="cx${bd.cls}">
      <div class="tierbar" style="background:${sk.col}"></div>
      <div class="cxh">${skillIcon(sk, {size:28})}
        <span class="cxn" style="color:${sk.col}">${sk.name}</span>
        <span class="grow"></span>${bd.tag}</div>
      <!-- tier rides in the demo caption rather than the header: the icon
           needs that 35px, and three of the sixty names would otherwise
           wrap and drag their whole grid row taller -->
      <div class="dcap"><span>${TIER_NAME[sk.tier]} ${sk.kind} · demonstration</span></div>
      <canvas class="demo" data-sk="${sk.id}"></canvas>
      <div class="fams">${famChips(sk.id)}</div>
      <div class="kv"><span>⬤ ${COST[sk.tier]} gold</span><span>${sk.cd}s cooldown</span>
        <span>${sk.hits>1?sk.hits+' hits':'1 hit'}</span></div>
      <div class="lore">${sk.txt||''}</div>
      <div class="lore">${KIND_LORE[sk.kind]||''}${sk.fx&&FX_LORE[sk.fx]?' '+FX_LORE[sk.fx]:''}</div>
      <table><thead><tr><th>Level</th><th>Per hit</th><th>Effect</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  }).join('');

  /* attach a live preview to every canvas we just wrote.
     Backing store is sized in CSS pixels rather than device pixels: the
     previews are small, soft and additive, so the sharpness gain from a
     dpr-scaled buffer does not pay for 46 of them. */
  for(const cv of $$('#codexGrid .demo')){
    const sk = BY_ID[cv.dataset.sk];
    if(!sk) continue;
    const r = cv.getBoundingClientRect();
    cv.width  = Math.max(1, Math.round(r.width || 280));
    cv.height = 78;
    Preview.add(cv, sk);
  }
  $('#labStat').textContent =
    `${list.length} of ${SKILLS.length} skills · ${Discovery.skillCount()} fielded`
    + ` · three copies fuse one level`;
}

/* ── combo codex ──
   Grouped by size so the progression reads: cheap pairs first, then the
   cross-family pairs that reward reading, then the three-skill payoffs.
   Each entry names the families, spells out every bonus in words, and
   lists concrete skills that supply each family — the last part is what
   turns "Frost + Fire" from a riddle into a shopping list. */
function paintCombos(){
  const live = new Set();
  /* if a draft is in progress, mark the combos the human already has */
  try{
    if(G && G.p && G.p[0]) for(const c of activeCombos(toBuild(G.p[0]))) live.add(c.id);
  }catch(e){}

  const groups = [
    ['Same-family pairs',  c=>c.fam.length===2 && c.fam[0]===c.fam[1]],
    ['Cross-family pairs', c=>c.fam.length===2 && c.fam[0]!==c.fam[1]],
    ['Three-skill combos', c=>c.fam.length===3],
  ];

  $('#comboGrid').innerHTML = groups.map(([title, filt])=>{
    const items = COMBOS.filter(filt);
    if(!items.length) return '';
    const cards = items.map(c=>{
      const col = FAMILY[c.fam[0]].col;
      /* unique families, with how many of each the combo needs */
      const need = {};
      for(const f of c.fam) need[f] = (need[f]||0)+1;
      const recipe = Object.entries(need).map(([f,n])=>{
        const fm = FAMILY[f];
        return `<span class="fam" style="background:${fm.col}22;color:${fm.col};border-color:${fm.col}55">${
          n>1?`${n}× `:''}${fm.name}</span>`;
      }).join('<span class="plus">+</span>');
      const sources = Object.keys(need).map(f=>{
        const names = skillsInFamily(f).map(s=>s.name);
        const shown = names.slice(0,5).join(', ');
        const more = names.length>5 ? ` +${names.length-5} more` : '';
        return `<div><b>${FAMILY[f].name}:</b> ${shown}${more}</div>`;
      }).join('');
      /* `live` wins the badge slot when a draft is in progress: "Active
         right now" is more useful than "you have triggered this before". */
      const bd = discBadge('combo', c.id);
      return `<div class="cmb${live.has(c.id)?' live':''}${bd.cls}" style="--cc:${col}">
        <div class="ch"><span class="cn">${c.name}</span>
          <span class="csize">${c.fam.length} skills</span>
          <span class="grow"></span>
          ${live.has(c.id)?'<span class="livetag">Active</span>':bd.tag}</div>
        <div class="recipe">${recipe}</div>
        <div class="eff">${fxRows(c.fx)}</div>
        <div class="er"><span class="ev">×${c.vfx.toFixed(2)}</span>
          <span class="en">Effect size while active</span></div>
        <div class="who">${sources}</div>
      </div>`;
    }).join('');
    return `<div style="grid-column:1/-1;margin:6px 0 2px">
        <b style="font-size:12.5px">${title}</b>
        <span class="stats" style="margin-left:8px">${items.length}</span>
      </div>${cards}`;
  }).join('');

  $('#labStat').textContent =
    `${COMBOS.length} combos · ${Discovery.comboCount()} triggered`
    + ` · one skill anchors only one combo at a time`;
}

/* ── fusion codex ──
   The combo codex above answers "what do I hold together". This one answers
   "what can I destroy two cards to make", which is a different question and
   needs two things the combo cards do not: the grade ladder (the same recipe
   is nine different skills depending on what you fed it) and a picture,
   because the whole point of a fusion is that it does not look like its
   parents. So each card carries a live demo of its grade-5 instance.

   Keyed on the ARCHETYPE — one card per recipe, not per instance. Nine cards
   for Thermal Lance would be nine copies of the same sentence. */
function paintFusions(){
  const own = new Set();
  /* if a draft is in progress, mark the archetypes the human has already
     forged — same courtesy the combo codex pays with `live` */
  try{
    if(G && G.p && G.p[0]) for(const b of toBuild(G.p[0])){
      const sk = BY_ID[b.id];
      if(sk && sk.fused) own.add(sk.fuseOf);
    }
  }catch(e){}

  const groups = [
    ['Two-skill fusions',   r=>r.fam.length===2],
    ['Three-skill fusions', r=>r.fam.length===3],
  ];
  /* Floor, middle and ceiling. The full nine rows would be a wall of numbers
     that all say the same thing; three make the slope legible. */
  const SHOW = [1, 5, 9];

  $('#fuseGrid').innerHTML = groups.map(([title, filt])=>{
    const items = FUSIONS.filter(filt);
    if(!items.length) return '';
    const cards = items.map(rec=>{
      const mid = BY_ID[fuseId(rec.id, 5)];
      const need = {};
      for(const f of rec.fam) need[f] = (need[f]||0)+1;
      const recipe = Object.entries(need).map(([f,n])=>{
        const fm = FAMILY[f];
        return `<span class="fam" style="background:${fm.col}22;color:${fm.col};border-color:${fm.col}55">${
          n>1?`${n}× `:''}${fm.name}</span>`;
      }).join('<span class="plus">+</span>');
      const sources = Object.keys(need).map(f=>{
        const names = skillsInFamily(f).map(s=>s.name);
        const shown = names.slice(0,5).join(', ');
        const more = names.length>5 ? ` +${names.length-5} more` : '';
        return `<div><b>${FAMILY[f].name}:</b> ${shown}${more}</div>`;
      }).join('');
      const rows = SHOW.map(g=>{
        const sk = BY_ID[fuseId(rec.id, g)];
        const d = dmgOf(sk, 1);
        const eff = skillLine(sk,1).split(' · ').filter(s=>!/dmg$|cd$/.test(s)).join(', ');
        return `<tr><td>✦${g}</td>
          <td>${d? d+(sk.hits>1?'×'+sk.hits:'') : '—'}</td>
          <td>${eff || '—'}</td></tr>`;
      }).join('');
      const bd = discBadge('fusion', rec.id);
      return `<div class="cmb${own.has(rec.id)?' live':''}${bd.cls}" style="--cc:${rec.col}">
        <div class="ch">${skillIcon(mid, {size:28})}
          <span class="cn">${rec.name}</span>
          <span class="csize">${rec.fam.length} skills</span>
          <span class="grow"></span>
          ${own.has(rec.id)?'<span class="livetag">Forged</span>':bd.tag}</div>
        <div class="recipe">${recipe}</div>
        <canvas class="demo" data-sk="${mid.id}"></canvas>
        <div class="who" style="color:#93a0c8">${rec.txt||''}</div>
        <div class="who">${KIND_LORE[rec.kind]||''}${
          rec.fx&&FX_LORE[rec.fx]?' '+FX_LORE[rec.fx]:''}</div>
        <div class="eff">
          <div class="er"><span class="ev">${rec.cd}s</span>
            <span class="en">Cooldown · ${rec.hits>1?rec.hits+' hits':'1 hit'}</span></div>
          <div class="er"><span class="ev">×${(rec.vfx||1).toFixed(2)}</span>
            <span class="en">Effect size — always, no combo needed</span></div>
        </div>
        <table><thead><tr><th>Grade</th><th>Per hit</th><th>Effect</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    }).join('');
    return `<div style="grid-column:1/-1;margin:6px 0 2px">
        <b style="font-size:12.5px">${title}</b>
        <span class="stats" style="margin-left:8px">${items.length}</span>
      </div>${cards}`;
  }).join('');

  /* same deal as the skill grid: size the backing store in CSS pixels and let
     the IntersectionObserver keep the off-screen ones idle */
  for(const cv of $$('#fuseGrid .demo')){
    const sk = BY_ID[cv.dataset.sk];
    if(!sk) continue;
    const r = cv.getBoundingClientRect();
    cv.width  = Math.max(1, Math.round(r.width || 280));
    cv.height = 78;
    Preview.add(cv, sk);
  }
  $('#labStat').textContent =
    `${FUSIONS.length} fusions · ${Discovery.fusionCount()} forged`
    + ` · the parents are consumed, and grade follows what you fed it`;
}
