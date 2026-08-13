/* ═══════════════════════════════════════════════════════════════
   MAIN — champion select, screen navigation, event wiring, boot.

   Loads LAST, and has to: every handler below binds a DOM node and
   calls into the files above.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";
/* ═══════════════════════════════════════════════════════════════
   CHAMPION SELECT

   Runs before the draft, and in hotseat it runs twice — P1 picks, then P2,
   from the SAME three. Champions are not a contested resource the way cards
   are: a mirror is a legitimate matchup, and denying your rival the tank by
   picking it first would be a draft decision made before the draft.

   `Sel.after` is the continuation, so one screen serves the duel, the
   hotseat and the delve without any of them knowing about the others.
   ═══════════════════════════════════════════════════════════════ */
const Sel = {
  side: 0,          // which player is choosing
  both: false,      // hotseat: run again for player 2 on confirm
  pick: null,       // current highlighted id
  after: null,      // called once every required pick is in
  back: null,       // where Back returns to; null means the title screen
  cards: [],        // {el, canvas, champ} — animated portraits

  open(opt){
    this.both  = !!opt.both;
    this.after = opt.after;
    this.back  = opt.back || null;
    this.side  = 0;
    this.begin();
  },
  begin(){
    /* re-offer whatever this player chose last time as the default: over a
       session most players have a main, and re-picking it every match is
       friction with no decision in it */
    const last = Save.data.champs && Save.data.champs[this.side];
    this.pick = champOf(last) ? last : null;
    show('select');
    this.render();
  },
  render(){
    const two = this.both;
    $('#selWho').textContent = two ? `${Save.data.names[this.side]}` : 'YOUR CHAMPION';
    $('#selWho').className = 'turnpill ' + (this.side ? 'p2' : 'p1');
    $('#selHint').textContent = two
      ? `Pick ${this.side+1} of 2`
      : (G.vsAI ? 'Your rival will bring one too' : '');
    $('#selNote').innerHTML = 'One charge per battle, fired by hand — '
      + `<b class="mono">${this.side ? 'P' : 'Q'}</b> or the button in the arena. `
      + 'Your drafted skills still cast themselves.';

    const host = $('#champCards');
    host.innerHTML = '';
    this.cards = [];
    CHAMPIONS.forEach((c, i)=>{
      const el = document.createElement('div');
      el.className = 'champ' + (this.pick===c.id ? ' on' : '');
      el.style.setProperty('--ck', c.acc);
      el.tabIndex = 0;
      el.innerHTML = `
        <span class="key">${i+1}</span>
        <canvas class="pv"></canvas>
        <div class="body">
          <div class="kick">${c.kicker}</div>
          <div class="nm">${c.name}</div>
          <div class="tag">${c.tag}</div>
          <div class="desc">${c.desc}</div>
          <div class="note">${c.note}</div>
        </div>`;
      const choose = ()=>{ this.choose(c.id); };
      el.onclick = choose;
      el.ondblclick = ()=>{ this.choose(c.id); this.confirm(); };
      el.onkeydown = e => { if(e.key==='Enter'||e.key===' '){ e.preventDefault(); choose(); } };
      host.appendChild(el);
      this.cards.push({el, cv:el.querySelector('.pv'), champ:c});
    });
    this.sync();
    this.fitPortraits();
  },
  choose(id){
    if(this.pick === id) return;
    this.pick = id;
    sfx.click();
    this.sync();
  },
  sync(){
    for(const c of this.cards) c.el.classList.toggle('on', c.champ.id === this.pick);
    const go = $('#selGo');
    const c = champOf(this.pick);
    go.disabled = !c;
    go.textContent = c
      ? (this.both && this.side === 0 ? `${c.name} — next player` : `${c.name} — confirm`)
      : 'Confirm';
    go.style.setProperty('--pri', c ? c.acc : '#4a7cf0');
  },
  confirm(){
    if(!champOf(this.pick)) return;
    sfx.buy();
    G.champs[this.side] = this.pick;
    Save.data.champs = Save.data.champs || [null,null];
    Save.data.champs[this.side] = this.pick;
    Save.flush();
    if(this.both && this.side === 0){ this.side = 1; this.begin(); return; }
    /* 1P: the AI brings one too, chosen at random from the other two so the
       matchup is not the same every session — and a mirror stays possible,
       because a mirror is a real matchup, just an unlikely one */
    if(!this.both){
      const others = CHAMPIONS.filter(c => c.id !== this.pick);
      G.champs[1] = RNG.f() < 0.15
        ? this.pick
        : others[RNG.int(others.length)].id;
    }
    this.stop();
    const go = this.after; this.after = null;
    if(go) go();
  },
  /* Portraits are live canvases running the arena's own body renderer, so
     what you pick is literally what you get. They stop the moment the screen
     closes — 3 idling canvases behind a battle is the same mistake the codex
     preview already had to fix. */
  raf: 0,
  fitPortraits(){
    const dpr = Math.min(2, devicePixelRatio || 1);
    for(const c of this.cards){
      const r = c.cv.getBoundingClientRect();
      if(!r.width) continue;
      c.cv.width = Math.round(r.width*dpr); c.cv.height = Math.round(r.height*dpr);
      c.ctx = c.cv.getContext('2d');
      c.ctx.setTransform(dpr,0,0,dpr,0,0);
      c.w = r.width; c.h = r.height;
    }
    if(!this.raf) this.raf = requestAnimationFrame(ts => this.tick(ts));
  },
  tick(ts){
    this.raf = 0;
    if(!$('#select').classList.contains('on')) return;
    const t = ts/1000;
    for(const c of this.cards){
      if(!c.ctx || !c.w) continue;
      const art = CHAMP_ART[c.champ.art];
      const g = c.ctx;
      g.clearRect(0,0,c.w,c.h);
      const R = Math.min(30, c.h*0.20);
      const bob = Math.sin(t*art.bobF) * art.bobA * 0.7;
      const cx = c.w/2, cy = c.h*0.54 + bob;
      /* ground shadow, so the body stands in the well rather than floating */
      g.save(); g.globalAlpha = 0.4; g.fillStyle = '#000';
      g.beginPath(); g.ellipse(cx, c.h*0.90, R*1.2, R*0.26, 0, 0, TAU); g.fill();
      g.restore();
      g.save(); g.globalCompositeOperation = 'lighter';
      glowOn(g, cx, cy, R*3.2, c.champ.acc, 0.26);
      g.restore();
      g.save(); g.translate(cx, cy);
      art.draw(g, t, R, {base:c.champ.acc, acc:c.champ.acc, hurt:0});
      g.restore();
    }
    this.raf = requestAnimationFrame(ts2 => this.tick(ts2));
  },
  stop(){
    if(this.raf){ cancelAnimationFrame(this.raf); this.raf = 0; }
    this.cards = [];
  },
};
$('#selGo').onclick   = ()=>Sel.confirm();
/* Back returns to wherever select was opened FROM — the ascension screen
   sets `back`, everything else falls through to the title. Without this,
   backing out of champion select silently discards the modifier choice. */
$('#selBack').onclick = ()=>{
  sfx.click(); Sel.stop(); Sel.after = null;
  const to = Sel.back; Sel.back = null;
  if(to) to(); else { show('title'); renderRecord(); }
};
addEventListener('keydown', e=>{
  if(!$('#select').classList.contains('on')) return;
  if(e.key>='1' && e.key<='3'){
    const c = CHAMPIONS[+e.key-1]; if(c) Sel.choose(c.id);
  } else if(e.key==='Enter'){ Sel.confirm(); }
  else if(e.key==='Escape'){ Sel.stop(); Sel.after=null; show('title'); }
});
addEventListener('resize', ()=>{ if($('#select').classList.contains('on')) Sel.fitPortraits(); });

/* ═══════════════════════════════════════════════════════════════
   NAV + BOOT
   ═══════════════════════════════════════════════════════════════ */
function show(id){
  $$('.screen').forEach(s=>s.classList.toggle('on', s.id===id));
  if(id!=='battle') running = false;
  if(id==='draft'){ const p=$('#detail').closest('.panel'); if(p) p.classList.remove('open'); }
  /* Below 860px the app is ordinary document flow (body scrolls), so
     switching screens doesn't reposition the viewport the way the
     absolutely-positioned desktop screens do. Without this, jumping from
     a scrolled-down title/panel to a new screen leaves the browser at
     its old scroll offset, so the new screen appears to render "further
     down the page" instead of replacing the view. */
  window.scrollTo(0, 0);
}

/* --- audio boot: the context can only start inside a user gesture --- */
function audioKick(){ sfx.init(); sfx.resume(); }
addEventListener('pointerdown', audioKick, {once:true});
addEventListener('keydown', audioKick, {once:true});
/* browsers suspend the context when the tab is hidden */
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) sfx.resume(); });

function paintMute(){
  $('#bMute').textContent = sfx.muted ? '♪ Off' : '♪ On';
  $('#bMute').style.opacity = sfx.muted ? '.5' : '1';
}
$('#bMute').onclick = ()=>{
  sfx.init();
  sfx.setMuted(!sfx.muted);
  Save.data.muted = sfx.muted; Save.flush();
  paintMute();
  if(!sfx.muted) sfx.click();
};

/* --- champion names --- */
function commitNames(){
  const a = $('#nm1').value.trim(), b = $('#nm2').value.trim();
  Save.data.names = [a || 'AZURE WARDEN', b || 'CRIMSON TYRANT'];
  Save.flush();
  renderRecord();
}
$('#nm1').value = Save.data.names[0]==='AZURE WARDEN'    ? '' : Save.data.names[0];
$('#nm2').value = Save.data.names[1]==='CRIMSON TYRANT'  ? '' : Save.data.names[1];
$('#nm1').onchange = $('#nm2').onchange = commitNames;

/* --- 1P / 2P mode --- */
function setMode(vsAI){
  G.vsAI = vsAI;
  $('#bVs1').classList.toggle('on', vsAI);
  $('#bVs2').classList.toggle('on', !vsAI);
  $('#nm2').disabled = vsAI;
  $('#nm2').placeholder = vsAI ? 'CRIMSON TYRANT (AI)' : 'CRIMSON TYRANT';
  $('#modeHint').textContent = vsAI
    ? 'Best of five. Draft a round, fight it, then draft again knowing what beat you — the AI answers your build too.'
    : 'Best of five, hotseat. Both players draft from one shared pool between every round — take a card and your rival cannot.';
  sfx.click();
}
$('#bVs1').onclick = ()=>setMode(true);
$('#bVs2').onclick = ()=>setMode(false);

/* Both modes pick a champion first. The choice belongs BEFORE the draft:
   the ultimate is the one thing you cannot buy, and knowing which one you
   are holding is what makes "draft six long cooldowns" a plan rather than
   an accident. */
$('#bStart').onclick = ()=>{
  commitNames(); sfx.click();
  Sel.open({both: !G.vsAI, after: startDraft});
};
$('#bDelve').onclick = ()=>{
  commitNames(); sfx.click();
  /* Ascension modifiers are chosen before the champion, because which
     modifiers are on changes which champion is the right answer. With
     nothing unlocked yet the screen still opens and explains itself —
     that is where a new player learns the ladder exists. */
  Asc.open();
};
/* No champion select: the daily deals both champions from the seed. */
$('#bDaily').onclick = ()=>{ commitNames(); sfx.click(); Daily.begin(); };
$('#bGhost').onclick = ()=>Ghost.fromInput();
/* Enter in the code field is the same as pressing the button — a pasted
   code is almost always followed by a return key. */
$('#ghostCode').onkeydown = e=>{ if(e.key === 'Enter') Ghost.fromInput(); };
$('#ascBack').onclick = ()=>{ sfx.click(); show('title'); renderRecord(); };
$('#ascGo').onclick   = ()=>{
  sfx.click();
  Sel.open({both:false, after: ()=>Run.start(), back: ()=>Asc.open()});
};
$('#bLab').onclick   = ()=>{ sfx.click(); show('lab'); renderCodex(); };
/* leaving the codex must stop the preview loop — otherwise 46 canvases
   keep animating behind the battle for the rest of the session */
$('#bBack').onclick  = ()=>{ sfx.click(); Preview.reset(); show('title'); };
$('#bReroll').onclick = reroll;
$('#bDone').onclick   = endTurn;
$('#bAgain').onclick  = ()=>{ sfx.click(); beginBattle(); };
$('#bNew').onclick    = ()=>{ sfx.click(); startDraft(); };
$$('#speedbar [data-spd]').forEach(b => {
  b.onclick = () => setSpeed(+b.dataset.spd);
});
$('#bSkip').onclick = skipBattle;
setSpeed(Save.data.speed || 1, true);   // restore without re-saving or clicking
addEventListener('keydown', e=>{
  if(!$('#battle').classList.contains('on')) return;
  if(e.key===' '){ e.preventDefault(); running=!running; last=performance.now(); return; }
  /* 1/2/3 select a speed, S skips — the same keys the buttons expose, so
     a player who never looks at the bar can still drive it */
  if(e.key==='1'||e.key==='2'||e.key==='3'){ setSpeed(SPEEDS[+e.key-1]); return; }
  if(e.key==='s'||e.key==='S'){ skipBattle(); return; }
  /* Q fires player 1's ultimate, P fires player 2's. Two keys far apart on
     the board, because in hotseat two people are reaching for them at once.
     An AI-held champion ignores the key: its charge is not yours to spend. */
  if(e.key==='q'||e.key==='Q'){
    const f = sim && sim.f[0];
    if(f && f.champ && !f.autoUlt){ e.preventDefault(); tryUlt(f); }
    return;
  }
  if(e.key==='p'||e.key==='P'){
    const f = sim && !sim.pve && sim.f[1];
    if(f && f.champ && !f.autoUlt){ e.preventDefault(); tryUlt(f); }
    return;
  }
});
/* boot */
sfx.muted = !!Save.data.muted;
paintMute();
setMode(true);
renderRecord();
fitCanvas();

