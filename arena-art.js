/* ═══════════════════════════════════════════════════════════════
   ARENA ART — the Moonlit Colosseum backdrop, plus the cosmetic

   geometry and the elemental particle vocabulary.

   Purely decorative: the sim never reads anything in here. Loads
   after core.js (it needs ARENA_W/ARENA_H, TAU, rnd) and before
   codex.js, which draws its skill previews with these helpers.
   See core.js for the full load order.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ═══════════════════════════════════════════════════════════════
   ARENA BACKDROP — "The Moonlit Colosseum"

   Composition, back to front:
     sky wash → nebula → stars → mountain ridge → moon + corona →
     moon-gate → tiered stands + arcade → flanking pillars →
     barrier wall → floor plane → inlaid rune ring → framing columns

   Everything listed above is STATIC. It is rasterised once into an
   offscreen canvas at 2x supersample and blitted each frame, so the
   per-frame cost is one drawImage plus the handful of layers that
   genuinely move: star twinkle, the crowd, torch flame and its light
   pool on the sand, the rotating rune ring, and drifting mist.

   Coordinate notes that constrain the design:
     · fighters roam x∈[120,880], y∈[130,380] (see Fighter.step clamps),
       so the floor must reach y≈130 even at the far corners and no
       scenery may intrude on that box.
     · the framing columns therefore live outside x∈[100,900].
     · the whole architecture band is squeezed into y∈[-40,120]. It
       reads as grand by cropping — pillars and arcade run off the top
       of the frame rather than being drawn small enough to fit.
   ═══════════════════════════════════════════════════════════════ */

/* --- geometry, all in arena space --- */
const AR = {
  pad: 60,                                    /* bleed around the blit   */
  rimCx: 500, rimCy: 345, rimRx: 1500, rimRy: 225,  /* barrier rim arc   */
  vpX: 500, vpY: 46,                          /* floor vanishing point   */
  moonX: 500, moonY: 62, moonR: 64,
  ringCx: 500, ringCy: 296, ringRx: 358, ringRy: 126,
  portal: 130                                 /* half-width of the gate  */
};
const BG_TOP = -AR.pad;
const BG_W   = ARENA_W + AR.pad*2;
const BG_H   = ARENA_H + 400 + AR.pad;
const BG_SS  = 2;

/* Barrier rim: a very shallow arc. It has to stay above y≈128 across the
   whole fighter box, which forces it nearly straight — the oval sweep of
   the arena is carried by the floor markings instead. */
const rimY = x => AR.rimCy - AR.rimRy*Math.sqrt(Math.max(0, 1 - ((x-AR.rimCx)/AR.rimRx)**2));
const wallTop = x => rimY(x) - 32;

/* Top of the seating. Dips away at the centre to open the moon-gate,
   climbs toward the frame edges where the stands are nearest camera. */
function standTop(x){
  const d = Math.abs(x - AR.rimCx);
  const k = clamp((d - AR.portal)/370, 0, 1);
  return lerp(80, 20, Math.pow(k, 0.65));
}

/* deterministic hashes — never Math.random in a draw call */
const aH  = n     => { const s = Math.sin(n*127.1 + 311.7)*43758.5453123; return s - Math.floor(s); };
const aH2 = (n,m) => { const s = Math.sin(n*269.5 + m*183.3)*43758.5453123; return s - Math.floor(s); };

/* torch anchors — shared so the static sconce and the live flame agree */
const TORCHES = [
  {x:  52, y: 214, s: 1.20},   /* framing column, left   */
  {x: 948, y: 214, s: 1.20},   /* framing column, right  */
  {x: 372, y: 104, s: 0.80},   /* gate pillar, left      */
  {x: 628, y: 104, s: 0.80},   /* gate pillar, right     */
  {x: 196, y:  96, s: 0.62},   /* stands, left           */
  {x: 804, y:  96, s: 0.62}    /* stands, right          */
];

function gGlow(g, x, y, r, col, a){
  const rg = g.createRadialGradient(x, y, 0, x, y, r);
  rg.addColorStop(0, col); rg.addColorStop(0.35, col+'88'); rg.addColorStop(1, col+'00');
  g.globalAlpha = a; g.fillStyle = rg;
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.globalAlpha = 1;
}

/* ───────────────────────── STATIC LAYERS ───────────────────────── */

function bgSky(g){
  const sky = g.createLinearGradient(0, BG_TOP, 0, 210);
  sky.addColorStop(0.00, '#0a0725');
  sky.addColorStop(0.28, '#1b1049');
  sky.addColorStop(0.55, '#331a72');
  sky.addColorStop(0.80, '#4d2490');
  sky.addColorStop(1.00, '#5c2f9c');
  g.fillStyle = sky;
  g.fillRect(BG_TOP, BG_TOP, BG_W, 210 - BG_TOP);

  /* nebula: a few soft additive blooms so the sky isn't a flat ramp */
  g.save(); g.globalCompositeOperation = 'lighter';
  const neb = [
    [190,  10, 210, '#6a3fc8', 0.38],
    [820,  26, 240, '#5433b4', 0.34],
    [500, -30, 300, '#3a4fd0', 0.26],
    [660,  86, 160, '#a044c8', 0.22],
    [300, 100, 150, '#3f78e0', 0.20]
  ];
  for(const [x,y,r,c,a] of neb) gGlow(g, x, y, r, c, a);
  g.restore();

  /* one lazy aurora ribbon drawn as a stack of thin quadratic bands */
  g.save(); g.globalCompositeOperation = 'lighter';
  for(let i=0;i<7;i++){
    const yo = 18 + i*7, a = 0.05*(1 - i/7);
    g.globalAlpha = a; g.strokeStyle = i%2 ? '#6fe0c8' : '#7aa8ff';
    g.lineWidth = 10 - i*0.8;
    g.beginPath();
    g.moveTo(-60, yo + 40);
    g.quadraticCurveTo(240, yo - 26, 520, yo + 16);
    g.quadraticCurveTo(800, yo + 52, 1060, yo - 4);
    g.stroke();
  }
  g.restore();
}

function bgStars(g){
  g.save();
  for(let i=0;i<260;i++){
    const x = aH(i*1.7)*BG_W + BG_TOP;
    const y = BG_TOP + aH2(i, 4.3)*205;
    if(y > 150 && Math.abs(x-500) > AR.portal) continue;  /* hidden by stands anyway */
    const b = aH2(i, 9.1);
    g.globalAlpha = 0.20 + b*0.62;
    g.fillStyle = b > 0.86 ? '#ffe9c4' : (b > 0.6 ? '#ffffff' : '#b9cdff');
    const r = 0.5 + b*1.25;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  /* a dozen bright four-point sparkles */
  g.globalCompositeOperation = 'lighter';
  for(let i=0;i<14;i++){
    const x = aH(i*5.1+2)*BG_W + BG_TOP;
    const y = BG_TOP + aH2(i, 7.7)*150;
    if(Math.abs(x-500) < 40 && y < 140) continue;         /* keep off the moon */
    const L = 4 + aH2(i,3.3)*7;
    g.globalAlpha = 0.5; g.strokeStyle = '#dbe9ff'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x-L, y); g.lineTo(x+L, y); g.moveTo(x, y-L); g.lineTo(x, y+L);
    g.stroke();
    gGlow(g, x, y, L*1.6, '#cfe0ff', 0.22);
  }
  g.restore();
}

function bgMoon(g){
  const {moonX:mx, moonY:my, moonR:mr} = AR;
  g.save();

  /* corona — wide, then a tighter hot core */
  g.globalCompositeOperation = 'lighter';
  gGlow(g, mx, my, mr*3.6, '#3f6ac4', 0.42);
  gGlow(g, mx, my, mr*2.0, '#7ea6ee', 0.34);
  gGlow(g, mx, my, mr*1.28,'#cfe2ff', 0.30);

  /* a pair of thin halo rings, the sort of thing that sells "celestial" */
  g.globalAlpha = 0.16; g.strokeStyle = '#a9c8ff'; g.lineWidth = 1.4;
  g.beginPath(); g.ellipse(mx, my, mr*1.85, mr*1.85, 0, 0, TAU); g.stroke();
  g.globalAlpha = 0.09; g.lineWidth = 3;
  g.beginPath(); g.ellipse(mx, my, mr*2.45, mr*2.45, 0, 0, TAU); g.stroke();
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;

  /* disc. Peak value is held a little off pure white so the surface
     markings below still have somewhere to sit. */
  const d = g.createRadialGradient(mx - mr*0.30, my - mr*0.34, mr*0.10, mx, my, mr);
  d.addColorStop(0.00, '#f4f8ff');
  d.addColorStop(0.42, '#dfeafc');
  d.addColorStop(0.78, '#bdd1f1');
  d.addColorStop(1.00, '#8fa9d3');
  g.fillStyle = d;
  g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fill();

  /* surface, clipped to the disc. Deliberately low contrast — crisp rims at
     this size read as soap bubbles rather than as craters. */
  g.save();
  g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.clip();

  /* maria: broad soft plains, stacked to fake a gradient falloff. These,
     not the craters, are what make the disc read as a moon at this size. */
  const maria = [
    [ 0.22,  0.30, 0.48, 0.34,  0.6],
    [-0.34,  0.10, 0.30, 0.23, -0.4],
    [ 0.30, -0.34, 0.22, 0.16,  0.9],
    [-0.06,  0.54, 0.36, 0.20,  0.2]
  ];
  for(const m of maria){
    for(let k=0;k<3;k++){
      g.globalAlpha = 0.055;
      g.fillStyle = '#8399c4';
      g.beginPath();
      g.ellipse(mx + m[0]*mr, my + m[1]*mr,
                m[2]*mr*(1 - k*0.24), m[3]*mr*(1 - k*0.24), m[4], 0, TAU);
      g.fill();
    }
  }

  /* craters: small, soft, and only the larger ones get a hint of a rim */
  for(let i=0;i<16;i++){
    const a   = aH(i*3.1)*TAU;
    const rr  = Math.sqrt(aH2(i,1.9))*mr*0.88;
    const cx0 = mx + Math.cos(a)*rr, cy0 = my + Math.sin(a)*rr;
    const cr  = 2.2 + aH2(i,6.2)*5.5;
    g.globalAlpha = 0.10 + aH2(i,2.4)*0.09;
    g.fillStyle = '#8ca3cc';
    g.beginPath(); g.ellipse(cx0, cy0, cr, cr*0.9, a, 0, TAU); g.fill();
    if(cr > 5){
      g.globalAlpha = 0.11; g.strokeStyle = '#e8f1ff'; g.lineWidth = 0.9;
      g.beginPath();
      g.ellipse(cx0-0.6, cy0-0.6, cr, cr*0.9, a, Math.PI*1.05, Math.PI*1.65);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  g.restore();

  /* limb darkening — a sphere, not a disc */
  const limb = g.createRadialGradient(mx, my, mr*0.55, mx, my, mr);
  limb.addColorStop(0.0, '#1b254700');
  limb.addColorStop(1.0, '#1b2547');
  g.globalAlpha = 0.26;
  g.fillStyle = limb;
  g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fill();
  g.globalAlpha = 1;
  g.restore();
}

function bgMountains(g){
  /* two ridges; the far one is barely a value shift off the sky */
  const ridges = [
    {base: 116, hi: 74, col: '#1a1540', a: 0.95, seed: 3.2, n: 11},
    {base: 126, hi: 50, col: '#100c2c', a: 1.00, seed: 8.6, n: 9}
  ];
  g.save();
  for(const R of ridges){
    g.globalAlpha = R.a; g.fillStyle = R.col;
    g.beginPath();
    g.moveTo(BG_TOP, R.base);
    for(let i=0;i<=R.n;i++){
      const x  = BG_TOP + (i/R.n)*BG_W;
      const pk = R.base - (0.35 + aH2(i, R.seed)*0.65)*R.hi;
      const xm = BG_TOP + ((i-0.5)/R.n)*BG_W;
      g.lineTo(xm, R.base - (0.2 + aH2(i+40, R.seed)*0.35)*R.hi);
      g.lineTo(x, pk);
    }
    g.lineTo(BG_TOP + BG_W, R.base);
    g.closePath(); g.fill();
  }
  g.restore();
}

/* the raised gate the moon sits behind: steps, balustrade, a dais */
function bgMoonGate(g){
  const cx = AR.rimCx;
  /* Everything below the wall head is buried by bgBarrier, so the whole
     structure has to live above wallTop — it reads as silhouette against
     the disc, which is also the cheapest way to get depth here. */
  const head = wallTop(cx);
  g.save();

  /* cold light leaking out from behind the dais, so it separates from the moon */
  g.globalCompositeOperation = 'lighter';
  gGlow(g, cx, head - 8, 150, '#6f95e0', 0.16);
  g.globalCompositeOperation = 'source-over';

  /* three tiers stepping up out of the wall head. Kept low on purpose — the
     dais is a plinth the moon rises from, not a wall across it. The widest
     tucks behind the gate pillars at 372/628, which sells the recession. */
  const tiers = [
    {hw: 140, h: 6, fill: '#20244180', lip: '#4c5590'},
    {hw: 114, h: 5, fill: '#1c2039',   lip: '#434b7f'},
    {hw:  92, h: 5, fill: '#181c33',   lip: '#3b4372'}
  ];
  let y = head + 3;
  for(const t of tiers){
    y -= t.h;
    g.fillStyle = t.fill;
    g.fillRect(cx - t.hw, y, t.hw*2, t.h + 3);
    g.fillStyle = t.lip;                        /* moonlit tread edge */
    g.fillRect(cx - t.hw, y, t.hw*2, 1.3);
  }

  /* Balustrade. Posts are wider than the slots between them — the other way
     round and the run reads as teeth against a disc this bright. */
  const by = y;
  g.fillStyle = '#161a30';
  for(let x = cx - 60; x <= cx + 60; x += 6.2){
    g.fillRect(x - 1.7, by - 7, 3.4, 7);
  }
  g.fillRect(cx - 62, by - 9.4, 124, 2.4);
  g.fillStyle = '#454d84'; g.fillRect(cx - 62, by - 9.4, 124, 1.0);

  /* two slim braziers bracketing the rail, standing on the top tier */
  for(const s of [-1, 1]){
    const bx = cx + s*80;
    g.fillStyle = '#161a30';
    g.fillRect(bx - 1.6, by - 13, 3.2, 13);       /* stem */
    g.beginPath();                                 /* basin: narrow foot, wide mouth */
    g.moveTo(bx - 2.8, by - 13); g.lineTo(bx + 2.8, by - 13);
    g.lineTo(bx + 6.5, by - 19.5); g.lineTo(bx - 6.5, by - 19.5);
    g.closePath(); g.fill();
    g.fillStyle = '#4c5590'; g.fillRect(bx - 7.2, by - 20.6, 14.4, 1.5);
    /* cold flame — votive, distinct from the warm torches on the barrier */
    g.save(); g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.85; g.fillStyle = '#a8dcff';
    g.beginPath();
    g.moveTo(bx, by - 30); g.lineTo(bx + 3.0, by - 24.5);
    g.lineTo(bx, by - 20); g.lineTo(bx - 3.0, by - 24.5);
    g.closePath(); g.fill();
    g.restore();
    gGlow(g, bx, by - 24, 20, '#6fc4ef', 0.40);
  }
  g.restore();
}

/* one ornate column. Used for the gate pillars and the framing columns. */
function bgPillar(g, cx, topY, botY, w, opt){
  const o = opt || {};
  const dim = o.dim || 1;                 /* 1 = moonlit, <1 = foreground */
  const mix = (a, b) => {                 /* darken a hex toward #0d0a18 */
    const n = parseInt(a.slice(1), 16);
    const r = Math.round(((n>>16)&255)*b + 13*(1-b));
    const gg= Math.round(((n>>8)&255)*b + 10*(1-b));
    const bb= Math.round((n&255)*b + 24*(1-b));
    return '#' + ((1<<24) + (r<<16) + (gg<<8) + bb).toString(16).slice(1);
  };
  g.save();

  const shaftT = topY + (o.capH || 26);
  /* shaft with a lateral gradient: moonlight from the upper left */
  const lg = g.createLinearGradient(cx-w/2, 0, cx+w/2, 0);
  lg.addColorStop(0.00, mix('#2a2e55', dim));
  lg.addColorStop(0.24, mix('#7d86bd', dim));
  lg.addColorStop(0.46, mix('#5b6398', dim));
  lg.addColorStop(0.80, mix('#272b52', dim));
  lg.addColorStop(1.00, mix('#181b38', dim));
  g.fillStyle = lg;
  g.fillRect(cx-w/2, shaftT, w, botY-shaftT);

  /* fluting */
  g.globalAlpha = 0.5;
  for(let i=1;i<6;i++){
    const fx = cx - w/2 + (i/6)*w;
    g.strokeStyle = i < 3 ? mix('#8f98cf', dim) : mix('#1d2141', dim);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(fx, shaftT+4); g.lineTo(fx, botY-2); g.stroke();
  }
  g.globalAlpha = 1;

  /* capital */
  const cw = w*1.42;
  g.fillStyle = mix('#4d5490', dim);
  g.beginPath();
  g.moveTo(cx-w/2-2, shaftT); g.lineTo(cx+w/2+2, shaftT);
  g.lineTo(cx+cw/2, shaftT-13); g.lineTo(cx-cw/2, shaftT-13);
  g.closePath(); g.fill();
  g.fillStyle = mix('#646cab', dim); g.fillRect(cx-cw/2, shaftT-19, cw, 6);
  g.fillStyle = mix('#8188c4', dim); g.fillRect(cx-cw/2, shaftT-19, cw, 1.8);
  /* volute curls */
  g.strokeStyle = mix('#7d86bd', dim); g.lineWidth = 2; g.globalAlpha = 0.8;
  for(const s of [-1,1]){
    g.beginPath();
    g.arc(cx + s*(cw/2-5), shaftT-9, 4.5, 0, Math.PI*1.4, s<0);
    g.stroke();
  }
  g.globalAlpha = 1;

  /* a lit rune band partway down the shaft */
  if(o.rune !== false){
    const ry = shaftT + (botY-shaftT)*0.34;
    g.fillStyle = mix('#1a1d3a', dim); g.fillRect(cx-w/2, ry, w, 12);
    g.save(); g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.85*dim; g.fillStyle = '#79d6ff';
    for(let i=0;i<3;i++){
      const gx = cx - w/2 + w*(0.24 + i*0.26);
      g.fillRect(gx-1, ry+3, 2, 6);
      g.fillRect(gx-3, ry+(i%2?3:8), 6, 1.6);
    }
    g.restore();
    gGlow(g, cx, ry+6, w*1.5, '#4fb8e8', 0.26*dim);
  }

  /* base */
  g.fillStyle = mix('#3a4070', dim); g.fillRect(cx-w/2-5, botY-14, w+10, 14);
  g.fillStyle = mix('#4e5590', dim); g.fillRect(cx-w/2-8, botY-6,  w+16, 6);
  g.fillStyle = mix('#6a72ac', dim); g.fillRect(cx-w/2-8, botY-6,  w+16, 1.5);
  g.restore();
}

/* the tiered seating, the arcade above it, and the vomitoria below */
function bgStands(g){
  const ROWS = 9;
  const cols = ['#332a63', '#3e3477'];

  for(const side of [-1, 1]){
    const x0 = side < 0 ? BG_TOP : AR.rimCx + AR.portal;
    const x1 = side < 0 ? AR.rimCx - AR.portal : BG_TOP + BG_W;

    /* seating rows, far (top) to near (bottom) so nearer rows overlap */
    for(let r = ROWS-1; r >= 0; r--){
      const kTop = Math.pow((r+1)/ROWS, 1.35);   /* rows bunch toward the top */
      const kBot = Math.pow(r/ROWS, 1.35);
      g.fillStyle = cols[r%2];
      g.beginPath();
      for(let x = x0; x <= x1; x += 8){
        const y = lerp(wallTop(x), standTop(x), kTop);
        x === x0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      for(let x = x1; x >= x0; x -= 8){
        g.lineTo(x, lerp(wallTop(x), standTop(x), kBot));
      }
      g.closePath(); g.fill();

      /* riser highlight along the row's top edge */
      g.strokeStyle = '#584d9c'; g.lineWidth = 1; g.globalAlpha = 0.9;
      g.beginPath();
      for(let x = x0; x <= x1; x += 8){
        const y = lerp(wallTop(x), standTop(x), kTop);
        x === x0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke(); g.globalAlpha = 1;
    }

    /* radial aisles cutting up through the seating */
    g.save(); g.globalAlpha = 0.55; g.fillStyle = '#1c1636';
    for(let i=0;i<4;i++){
      const ax = lerp(x0, x1, side<0 ? 0.14+i*0.24 : 0.10+i*0.24);
      const yb = wallTop(ax), yt = standTop(ax);
      const spread = 5 + (yb-yt)*0.06;
      g.beginPath();
      g.moveTo(ax-spread, yb); g.lineTo(ax+spread, yb);
      g.lineTo(ax+2.2, yt);    g.lineTo(ax-2.2, yt);
      g.closePath(); g.fill();
    }
    g.restore();

    /* arcade: a run of arches crowning the stands, cropped by the frame */
    const aStep = 46;
    for(let x = (side<0 ? x0+16 : x1-16); side<0 ? x < x1-10 : x > x0+10; x += side<0 ? aStep : -aStep){
      const top = standTop(x);
      const h = 30, w = 17;
      /* pier */
      g.fillStyle = '#2b305a';
      g.fillRect(x-w-3, top-h, 6, h);
      g.fillRect(x+w-3, top-h, 6, h);
      /* dark opening with a rounded head */
      g.fillStyle = '#0e1026';
      g.beginPath();
      g.moveTo(x-w+3, top);
      g.lineTo(x-w+3, top-h+w-3);
      g.arc(x, top-h+w-3, w-3, Math.PI, 0);
      g.lineTo(x+w-3, top);
      g.closePath(); g.fill();
      /* lit inner edge */
      g.strokeStyle = '#454c85'; g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x-w+3, top); g.lineTo(x-w+3, top-h+w-3);
      g.arc(x, top-h+w-3, w-3, Math.PI, 0);
      g.lineTo(x+w-3, top);
      g.stroke();
      /* cornice over the arch */
      g.fillStyle = '#3a4171'; g.fillRect(x-w-5, top-h-6, (w+5)*2, 6);
      g.fillStyle = '#565d99'; g.fillRect(x-w-5, top-h-6, (w+5)*2, 1.5);
    }

    /* vomitoria — dark entrance tunnels at the foot of the stands */
    for(let i=0;i<2;i++){
      const vx = lerp(x0, x1, side<0 ? 0.26+i*0.40 : 0.34+i*0.40);
      const vy = wallTop(vx), vw = 20, vh = 22;
      g.fillStyle = '#0b0d20';
      g.beginPath();
      g.moveTo(vx-vw, vy); g.lineTo(vx-vw, vy-vh+vw);
      g.arc(vx, vy-vh+vw, vw, Math.PI, 0);
      g.lineTo(vx+vw, vy); g.closePath(); g.fill();
      g.strokeStyle = '#3c4275'; g.lineWidth = 1.5; g.stroke();
      /* a warm ember spilling out of the tunnel mouth */
      g.save(); g.globalCompositeOperation = 'lighter';
      gGlow(g, vx, vy-4, 22, '#c06a2a', 0.30);
      g.restore();
    }
  }
}

/* A hooded stone guardian on a plinth. Read at ~60px tall, so it is built
   from silhouette masses rather than anatomy — the hood and the shoulders
   are what make it legible; the lit edge does the rest. */
function bgStatue(g, cx, footY, h, faceIn){
  g.save();
  const w = h*0.30;
  const s = faceIn;                       /* +1 looks right, -1 looks left */

  /* plinth */
  const pw = w*1.5;
  g.fillStyle = '#2b2350'; g.fillRect(cx-pw/2, footY-h*0.20, pw, h*0.20);
  g.fillStyle = '#3b3168'; g.fillRect(cx-pw/2-3, footY-h*0.20, pw+6, 5);
  g.fillStyle = '#564a8c'; g.fillRect(cx-pw/2-3, footY-h*0.20, pw+6, 1.6);
  g.fillStyle = '#1d1838'; g.fillRect(cx-pw/2, footY-4, pw, 4);

  const topY = footY - h;
  const shY  = topY + h*0.26;             /* shoulder line */
  const hipY = footY - h*0.20;

  /* robe: a tapering mass, slightly wider at the hem */
  const rg = g.createLinearGradient(cx-w, 0, cx+w, 0);
  rg.addColorStop(0.00, '#241e44');
  rg.addColorStop(0.28, '#6a5f9e');
  rg.addColorStop(0.55, '#463c73');
  rg.addColorStop(1.00, '#1b1636');
  g.fillStyle = rg;
  g.beginPath();
  g.moveTo(cx - w*0.52, shY);
  g.lineTo(cx + w*0.52, shY);
  g.lineTo(cx + w*0.80, hipY);
  g.lineTo(cx - w*0.80, hipY);
  g.closePath(); g.fill();

  /* fold lines in the robe */
  g.strokeStyle = '#2a2350'; g.lineWidth = 1; g.globalAlpha = 0.7;
  for(let i=-1;i<=1;i++){
    g.beginPath();
    g.moveTo(cx + i*w*0.24, shY + h*0.04);
    g.lineTo(cx + i*w*0.34, hipY);
    g.stroke();
  }
  g.globalAlpha = 1;

  /* shoulders + hood as one silhouette */
  g.fillStyle = '#584c8e';
  g.beginPath();
  g.moveTo(cx - w*0.58, shY + 2);
  g.quadraticCurveTo(cx - w*0.52, topY + h*0.12, cx - w*0.20, topY + h*0.06);
  g.quadraticCurveTo(cx, topY - h*0.02, cx + w*0.20, topY + h*0.06);
  g.quadraticCurveTo(cx + w*0.52, topY + h*0.12, cx + w*0.58, shY + 2);
  g.closePath(); g.fill();
  /* lit edge, moonlight from upper-left */
  g.strokeStyle = '#9d92d4'; g.lineWidth = 1.4; g.globalAlpha = 0.75;
  g.beginPath();
  g.moveTo(cx - w*0.58, shY + 2);
  g.quadraticCurveTo(cx - w*0.52, topY + h*0.12, cx - w*0.20, topY + h*0.06);
  g.quadraticCurveTo(cx, topY - h*0.02, cx + w*0.10, topY + h*0.03);
  g.stroke(); g.globalAlpha = 1;

  /* the hood's shadowed opening, turned slightly toward the arena */
  g.fillStyle = '#100c22';
  g.beginPath();
  g.ellipse(cx + s*w*0.06, topY + h*0.12, w*0.20, h*0.075, 0, 0, TAU);
  g.fill();
  /* two ember eyes — the one detail that gives the statue presence */
  g.save(); g.globalCompositeOperation = 'lighter';
  for(const e of [-1, 1]){
    const ex = cx + s*w*0.06 + e*w*0.085, ey = topY + h*0.12;
    g.globalAlpha = 0.9; g.fillStyle = '#ffd08a';
    g.beginPath(); g.arc(ex, ey, 1.1, 0, TAU); g.fill();
    gGlow(g, ex, ey, 5, '#ff9a40', 0.35);
  }
  g.restore();

  /* a greatsword planted point-down in front of the robe */
  const bx = cx - s*w*0.42, byTop = shY + h*0.06, byBot = hipY + h*0.02;
  g.fillStyle = '#3d3568'; g.fillRect(bx-1.6, byTop, 3.2, byBot-byTop);
  g.fillStyle = '#7b71b4'; g.fillRect(bx-1.6, byTop, 1.2, byBot-byTop);
  g.fillStyle = '#4a4177'; g.fillRect(bx-w*0.20, byTop, w*0.40, 3);   /* crossguard */
  g.fillStyle = '#6d63a6';
  g.beginPath(); g.arc(bx, byTop-3, 2.2, 0, TAU); g.fill();           /* pommel */

  g.restore();
}

/* hanging banners — cloth with a gold trim and a sigil */
function bgBanner(g, x, y, w, h, col, trim){
  g.save();
  const lg = g.createLinearGradient(x-w/2, 0, x+w/2, 0);
  lg.addColorStop(0, '#00000055'); lg.addColorStop(0.35, col); lg.addColorStop(1, '#00000077');
  g.fillStyle = lg;
  g.beginPath();
  g.moveTo(x-w/2, y); g.lineTo(x+w/2, y); g.lineTo(x+w/2, y+h);
  g.lineTo(x, y+h-7); g.lineTo(x-w/2, y+h);
  g.closePath(); g.fill();
  g.fillStyle = trim; g.fillRect(x-w/2, y, w, 3);
  /* sigil: a simple diamond, reads at this size where a crest would not */
  g.globalAlpha = 0.85; g.fillStyle = trim;
  g.beginPath();
  const sy = y + h*0.42, s = w*0.20;
  g.moveTo(x, sy-s); g.lineTo(x+s*0.72, sy); g.lineTo(x, sy+s); g.lineTo(x-s*0.72, sy);
  g.closePath(); g.fill();
  g.globalAlpha = 1;
  g.restore();
}

/* the barrier wall between the sand and the front row */
function bgBarrier(g){
  g.save();
  /* wall face */
  g.beginPath();
  for(let x = BG_TOP; x <= BG_TOP+BG_W; x += 8){
    const y = wallTop(x);
    x === BG_TOP ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  for(let x = BG_TOP+BG_W; x >= BG_TOP; x -= 8) g.lineTo(x, rimY(x));
  g.closePath();
  const wg = g.createLinearGradient(0, 80, 0, 140);
  wg.addColorStop(0, '#3b4173'); wg.addColorStop(0.55, '#2a2e56'); wg.addColorStop(1, '#1c1f3d');
  g.fillStyle = wg; g.fill();

  /* recessed panels */
  for(let x = BG_TOP+14; x < BG_TOP+BG_W; x += 54){
    const y = wallTop(x);
    g.fillStyle = '#23264a'; g.fillRect(x, y+8, 38, 16);
    g.strokeStyle = '#454c85'; g.lineWidth = 1; g.globalAlpha = 0.6;
    g.strokeRect(x+0.5, y+8.5, 37, 15); g.globalAlpha = 1;
    /* a small boss in the middle of each panel */
    g.fillStyle = '#525a95';
    g.beginPath(); g.arc(x+19, y+16, 2.6, 0, TAU); g.fill();
  }

  /* Capping moulding. Drawn with a horizontal gradient so it burns brightest
     behind the gate and dies away at the frame edges — a single even line all
     the way across reads as a fence and cuts the picture in half. */
  const mg1 = g.createLinearGradient(0, 0, ARENA_W, 0);
  mg1.addColorStop(0.00, '#1d1934');
  mg1.addColorStop(0.30, '#4a4074');
  mg1.addColorStop(0.50, '#6a5c9c');
  mg1.addColorStop(0.70, '#4a4074');
  mg1.addColorStop(1.00, '#1d1934');
  g.lineWidth = 3.4; g.strokeStyle = mg1;
  g.beginPath();
  for(let x = BG_TOP; x <= BG_TOP+BG_W; x += 8){
    const y = wallTop(x);
    x === BG_TOP ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  const mg2 = g.createLinearGradient(0, 0, ARENA_W, 0);
  mg2.addColorStop(0.00, '#2a2447');
  mg2.addColorStop(0.50, '#9d92d4');
  mg2.addColorStop(1.00, '#2a2447');
  g.lineWidth = 1.2; g.strokeStyle = mg2; g.globalAlpha = 0.8;
  g.beginPath();
  for(let x = BG_TOP; x <= BG_TOP+BG_W; x += 8){
    const y = wallTop(x) - 1.6;
    x === BG_TOP ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke(); g.globalAlpha = 1;
  g.restore();
}

/* the sand: a true ground plane radiating from the vanishing point */
function bgFloor(g){
  const {vpX:vx, vpY:vy} = AR;
  g.save();

  /* clip to everything below the rim so nothing bleeds onto the wall */
  g.beginPath();
  g.moveTo(BG_TOP, BG_TOP+BG_H);
  for(let x = BG_TOP; x <= BG_TOP+BG_W; x += 8) g.lineTo(x, rimY(x));
  g.lineTo(BG_TOP+BG_W, BG_TOP+BG_H);
  g.closePath();
  g.clip();

  /* Base. The sand is kept a good deal darker than instinct suggests: it
     fills most of the frame, and the fighters (saturated blue / red) have
     to sit on top of it. Brightest just behind the fighters where the moon
     rakes in, falling away hard toward the camera. */
  const fg = g.createLinearGradient(0, 110, 0, 470);
  fg.addColorStop(0.00, '#514369');
  fg.addColorStop(0.14, '#413353');
  fg.addColorStop(0.40, '#2f2540');
  fg.addColorStop(0.70, '#221a30');
  fg.addColorStop(1.00, '#140f1f');
  g.fillStyle = fg;
  g.fillRect(BG_TOP, 100, BG_W, BG_H);

  /* a broad sheen where the moon's light lands */
  g.save(); g.globalCompositeOperation = 'lighter';
  const sh = g.createRadialGradient(500, 150, 10, 500, 205, 430);
  sh.addColorStop(0, '#7f92d04a'); sh.addColorStop(1, '#7f92d000');
  g.fillStyle = sh; g.fillRect(BG_TOP, 100, BG_W, 420);
  g.restore();

  /* Stone mottling. Soft-edged radial falloffs, not flat ellipses — hard
     edged patches at low alpha read as stains rather than as weathering. */
  g.save();
  for(let i=0;i<44;i++){
    const px = aH(i*1.9+3)*BG_W + BG_TOP;
    const py = 120 + aH2(i, 4.4)*360;
    const pr = 50 + aH2(i, 8.8)*110;
    const up = aH2(i, 5.2) > 0.5;
    const mg = g.createRadialGradient(px, py, 0, px, py, pr);
    const a  = (0.07 + aH2(i, 2.7)*0.07).toFixed(3);
    mg.addColorStop(0, (up ? '#9a88ba' : '#1a1428') + Math.round(a*255).toString(16).padStart(2,'0'));
    mg.addColorStop(1, (up ? '#9a88ba' : '#1a1428') + '00');
    g.fillStyle = mg;
    g.save();
    g.translate(px, py); g.scale(1, 0.42); g.translate(-px, -py);
    g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
    g.restore();
  }
  g.restore();

  /* Concentric paving joints — ellipses about the vanishing point, so the
     spacing opens up naturally toward the viewer. Deliberately faint: at
     full strength the regular grid reads as graph paper, not stone. */
  g.strokeStyle = '#160f22'; g.lineWidth = 1.4; g.globalAlpha = 0.34;
  let R = 190;
  for(let i=0;i<16 && R < 1500; i++){
    g.beginPath(); g.ellipse(vx, vy, R, R*0.40, 0, 0, TAU); g.stroke();
    R *= 1.16;
  }
  /* radial joints, fainter still — they converge behind the gate and get
     busy fast */
  g.globalAlpha = 0.20;
  for(let i=0;i<=44;i++){
    const a = Math.PI*(0.04 + (i/44)*0.92);
    g.beginPath();
    g.moveTo(vx + Math.cos(a)*180, vy + Math.sin(a)*180*0.40);
    g.lineTo(vx + Math.cos(a)*1500, vy + Math.sin(a)*1500*0.40);
    g.stroke();
  }
  g.globalAlpha = 1;

  /* highlight on the upper edge of each concentric course, as though the
     slabs are very slightly proud of one another */
  g.strokeStyle = '#8f80ad'; g.lineWidth = 0.9; g.globalAlpha = 0.10;
  R = 190;
  for(let i=0;i<16 && R < 1500; i++){
    g.beginPath(); g.ellipse(vx, vy-1.4, R, R*0.40, 0, 0, TAU); g.stroke();
    R *= 1.16;
  }
  g.globalAlpha = 1;

  /* the inlaid duelling ring: a band of paler stone cut into the floor,
     with a bevelled edge. Kept low-contrast — the live glow does the work. */
  const {ringCx:rx0, ringCy:ry0, ringRx:rrx, ringRy:rry} = AR;
  g.strokeStyle = '#4a3f63'; g.lineWidth = 13;
  g.beginPath(); g.ellipse(rx0, ry0, rrx, rry, 0, 0, TAU); g.stroke();
  g.strokeStyle = '#6b5f8a'; g.lineWidth = 1.6; g.globalAlpha = 0.6;
  g.beginPath(); g.ellipse(rx0, ry0, rrx-6.5, rry-2.3, 0, 0, TAU); g.stroke();
  g.beginPath(); g.ellipse(rx0, ry0, rrx+6.5, rry+2.3, 0, 0, TAU); g.stroke();
  g.globalAlpha = 1;
  /* inner marks */
  g.strokeStyle = '#2c2340'; g.lineWidth = 1.5; g.globalAlpha = 0.6;
  g.beginPath(); g.ellipse(rx0, ry0, rrx*0.60, rry*0.60, 0, 0, TAU); g.stroke();
  g.globalAlpha = 0.42;
  g.beginPath(); g.ellipse(rx0, ry0, rrx*0.28, rry*0.28, 0, 0, TAU); g.stroke();
  g.globalAlpha = 1;
  /* studs around the band */
  g.fillStyle = '#7a6d99'; g.globalAlpha = 0.75;
  for(let i=0;i<32;i++){
    const a = (i/32)*TAU;
    g.beginPath();
    g.arc(rx0 + Math.cos(a)*rrx, ry0 + Math.sin(a)*rry, 1.9, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;

  /* cracks and scattered debris so the sand isn't a clean vector plane */
  g.strokeStyle = '#1c1529'; g.globalAlpha = 0.55;
  for(let i=0;i<26;i++){
    let px = aH(i*2.3)*BG_W + BG_TOP;
    let py = 140 + aH2(i,5.5)*330;
    g.lineWidth = 0.8 + aH2(i,1.1)*1.4;
    g.beginPath(); g.moveTo(px, py);
    for(let s=0;s<5;s++){
      px += (aH2(i*7+s, 2.2)-0.5)*46;
      py += (aH2(i*7+s, 9.4)-0.5)*22;
      g.lineTo(px, py);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  for(let i=0;i<80;i++){
    const px = aH(i*4.7+9)*BG_W + BG_TOP;
    const py = 132 + aH2(i,3.8)*350;
    const r  = 0.8 + aH2(i,6.6)*2.4;
    g.globalAlpha = 0.25 + aH2(i,2.9)*0.4;
    g.fillStyle = aH2(i,8.1) > 0.65 ? '#a596c2' : '#15101f';
    g.beginPath(); g.ellipse(px, py, r, r*0.6, 0, 0, TAU); g.fill();
  }
  g.globalAlpha = 1;

  /* darken the extreme foreground and the left/right margins — this is what
     keeps the eye on the fighters rather than on the scenery */
  const vg = g.createLinearGradient(0, 360, 0, 560);
  vg.addColorStop(0, '#0a061800');
  vg.addColorStop(1, '#0a0618dd');
  g.fillStyle = vg; g.fillRect(BG_TOP, 360, BG_W, 200);
  const hgL = g.createLinearGradient(BG_TOP, 0, 240, 0);
  hgL.addColorStop(0, '#0a0618bb'); hgL.addColorStop(1, '#0a061800');
  g.fillStyle = hgL; g.fillRect(BG_TOP, 100, 300, 460);
  const hgR = g.createLinearGradient(760, 0, BG_TOP+BG_W, 0);
  hgR.addColorStop(0, '#0a061800'); hgR.addColorStop(1, '#0a0618bb');
  g.fillStyle = hgR; g.fillRect(760, 100, 300, 460);
  g.restore();
}

/* torch sconce hardware (the flame itself is drawn live) */
function bgSconces(g){
  for(const T of TORCHES){
    const s = T.s;
    g.save();
    g.fillStyle = '#2b2f55';
    g.beginPath();
    g.moveTo(T.x-9*s, T.y); g.lineTo(T.x+9*s, T.y);
    g.lineTo(T.x+5*s, T.y+12*s); g.lineTo(T.x-5*s, T.y+12*s);
    g.closePath(); g.fill();
    g.fillStyle = '#464d84'; g.fillRect(T.x-11*s, T.y-2.5*s, 22*s, 3*s);
    g.fillStyle = '#1a1d38'; g.fillRect(T.x-2*s, T.y+12*s, 4*s, 10*s);
    g.restore();
  }
}

/* The two colossal columns that frame the shot. They are nearest camera and
   backlit by the moon, so they play as near-silhouette with a rim light —
   dark repoussoir that keeps the moon the brightest thing on screen. */
function bgFraming(g){
  for(const s of [-1, 1]){
    const cx = s < 0 ? 46 : 954;
    /* a slab of wall behind the column, to seal the frame edge */
    g.fillStyle = '#0d0a1c';
    g.fillRect(s < 0 ? BG_TOP : 900, BG_TOP, 100 - BG_TOP, BG_H);
    g.fillStyle = '#131029';
    g.fillRect(s < 0 ? BG_TOP : 908, BG_TOP, 92 - BG_TOP, BG_H);

    bgPillar(g, cx, BG_TOP, 470, 56, {capH: 30, rune: true, dim: 0.46});

    /* rim light down the inner edge, where the arena's glow catches it */
    const rx = cx + s*28;
    const rg = g.createLinearGradient(rx - s*7, 0, rx + s*2, 0);
    rg.addColorStop(0, '#6d78b800'); rg.addColorStop(1, '#8b96d8aa');
    g.fillStyle = rg;
    g.fillRect(Math.min(rx - s*7, rx + s*2), BG_TOP, 9, BG_H);

    bgBanner(g, cx, 250, 44, 108, '#5e1a2c', '#a8823a');
  }
}

/* ───────────────────────── ASSEMBLY ───────────────────────── */

let _bg = null;
function arenaBg(){
  if(_bg) return _bg;
  const c = document.createElement('canvas');
  c.width  = Math.round(BG_W*BG_SS);
  c.height = Math.round(BG_H*BG_SS);
  const g = c.getContext('2d');
  g.scale(BG_SS, BG_SS);
  g.translate(-BG_TOP, -BG_TOP);
  buildArenaStatic(g);
  _bg = c;
  return c;
}

function buildArenaStatic(g){
  bgSky(g);
  bgStars(g);
  bgMountains(g);
  bgMoon(g);
  bgMoonGate(g);
  bgStands(g);
  /* gate pillars flank the moon; they run off the top of the frame */
  bgPillar(g, 372, BG_TOP, rimY(372), 40, {capH: 26});
  bgPillar(g, 628, BG_TOP, rimY(628), 40, {capH: 26});
  bgBanner(g, 372, 150, 30, 74, '#3d2470', '#c9a24a');
  bgBanner(g, 628, 150, 30, 74, '#3d2470', '#c9a24a');
  bgBarrier(g);
  /* guardians stand on the wall head, flanking the gate */
  bgStatue(g, 300, wallTop(300)+4, 66,  1);
  bgStatue(g, 700, wallTop(700)+4, 66, -1);
  bgFloor(g);
  bgSconces(g);
  bgFraming(g);
}

/* ───────────────────────── LIVE LAYERS ─────────────────────────
   Everything below runs every frame. Kept to a few hundred ops: the
   expensive structure is already baked into the blit above.        */

function liveStars(t){
  const g = ctx;
  g.save(); g.globalCompositeOperation = 'lighter';
  for(let i=0;i<260;i+=5){                       /* same generator as bgStars */
    const x = aH(i*1.7)*BG_W + BG_TOP;
    const y = BG_TOP + aH2(i, 4.3)*205;
    if(y > 150 && Math.abs(x-500) > AR.portal) continue;
    const tw = 0.5 + 0.5*Math.sin(t*1.7 + i*2.3);
    g.globalAlpha = 0.30*tw*tw;
    g.fillStyle = '#e8f1ff';
    g.beginPath(); g.arc(x, y, 1.5 + tw*1.4, 0, TAU); g.fill();
  }
  g.restore();
}

function liveCrowd(t){
  const g = ctx;
  g.save(); g.globalCompositeOperation = 'lighter';
  for(let i=0;i<150;i++){
    const x = aH(i*3.9 + 1.3)*ARENA_W;
    if(Math.abs(x - AR.rimCx) < AR.portal + 6) continue;
    const k  = 0.06 + aH2(i, 5.7)*0.88;
    const y  = lerp(wallTop(x), standTop(x), k) + 2;
    /* each spectator bobs on their own phase; a slow wave crosses the bowl */
    const wave = Math.sin(t*1.6 - x*0.012 + i*0.9);
    const bob  = wave*1.3;
    const fl   = 0.42 + 0.58*(0.5 + 0.5*Math.sin(t*2.6 + i*1.7));
    g.globalAlpha = 0.30*fl*(0.45 + k*0.55);     /* nearer rows read brighter */
    g.fillStyle = i%7 === 0 ? '#ffd2a0' : (i%3 === 0 ? '#cfd8ff' : '#8ea6e8');
    g.beginPath(); g.arc(x, y + bob, 1.5, 0, TAU); g.fill();
  }
  g.restore();
}

function liveTorches(t){
  const g = ctx;
  g.save();
  for(let ti=0; ti<TORCHES.length; ti++){
    const T = TORCHES[ti], s = T.s;
    const ph = ti*2.7;
    /* two detuned sines beat against each other — cheap, non-periodic flicker */
    const fk = 0.72 + 0.28*Math.sin(t*11 + ph) * Math.sin(t*6.3 + ph*1.7);
    const bx = T.x, by = T.y - 2*s;

    g.globalCompositeOperation = 'lighter';
    /* light thrown onto the surrounding stone */
    gGlow(g, bx, by, 46*s*fk, '#ff9a40', 0.34*fk);
    gGlow(g, bx, by, 18*s*fk, '#ffd89a', 0.42*fk);

    /* flame body: a teardrop built from two quadratics, three shrinking layers */
    const layers = [[1.00, '#ff6a1e', 0.55], [0.66, '#ffab3c', 0.70], [0.34, '#ffe9b0', 0.85]];
    for(const [sc, col, a] of layers){
      const h = (26*s)*fk*sc, w = (7.5*s)*sc;
      const sway = Math.sin(t*4.2 + ph)*2.2*s*sc;
      g.globalAlpha = a;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(bx - w, by);
      g.quadraticCurveTo(bx - w*1.15 + sway*0.4, by - h*0.55, bx + sway, by - h);
      g.quadraticCurveTo(bx + w*1.15 + sway*0.4, by - h*0.55, bx + w, by);
      g.quadraticCurveTo(bx, by + 3.5*s*sc, bx - w, by);
      g.closePath(); g.fill();
    }

    /* embers peeling off the top */
    for(let e=0;e<3;e++){
      const life = ((t*0.55 + aH2(ti*4+e, 2.1)) % 1);
      const ex = bx + Math.sin(t*2.4 + e*2.1 + ph)*8*s;
      const ey = by - 24*s - life*40*s;
      g.globalAlpha = 0.5*(1-life)*fk;
      g.fillStyle = '#ffb257';
      g.beginPath(); g.arc(ex, ey, 1.5*s*(1-life*0.6), 0, TAU); g.fill();
    }

    /* pool of light on the sand below, only for the low torches */
    if(T.y > 150){
      const py = 300 + (T.y-214)*0.4;
      g.globalAlpha = 0.16*fk;
      const pg = g.createRadialGradient(bx, py, 4, bx, py, 190);
      pg.addColorStop(0, '#ff9a40'); pg.addColorStop(1, '#ff9a4000');
      g.fillStyle = pg;
      g.beginPath(); g.ellipse(bx, py, 190, 76, 0, 0, TAU); g.fill();
    }
  }
  g.restore();
}

/* The inlaid ring wakes up. Deliberately restrained: this sits directly
   under the fighters, so it glows just enough to read as enchanted stone
   and never competes with the skill VFX drawn on top of it. */
function liveRing(t){
  const g = ctx;
  const {ringCx:cx, ringCy:cy, ringRx:rx, ringRy:ry} = AR;
  g.save();
  g.globalCompositeOperation = 'lighter';

  /* slow breathing wash over the band */
  const breathe = 0.5 + 0.5*Math.sin(t*0.8);
  g.globalAlpha = 0.05 + breathe*0.035;
  g.strokeStyle = '#5aa8ff'; g.lineWidth = 13;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.stroke();

  /* 16 runes riding the band, each pulsing on its own phase */
  for(let i=0;i<16;i++){
    const a = (i/16)*TAU + t*0.06;
    const px = cx + Math.cos(a)*rx, py = cy + Math.sin(a)*ry;
    const pulse = 0.35 + 0.65*(0.5 + 0.5*Math.sin(t*2.1 + i*1.3));
    g.globalAlpha = 0.20*pulse;
    g.fillStyle = i%3 === 0 ? '#b98cff' : '#7fd8ff';
    /* a tiny glyph: stem plus crossbar, enough to read as writing */
    g.fillRect(px-0.8, py-3.6, 1.6, 7.2);
    g.fillRect(px-2.8, py + (i%2 ? -2.8 : 1.2), 5.6, 1.3);
    g.globalAlpha = 0.09*pulse;
    g.beginPath(); g.arc(px, py, 6, 0, TAU); g.fill();
  }

  /* a light sweep chasing round the ring */
  const sa = (t*0.5) % TAU;
  g.globalAlpha = 0.13;
  g.strokeStyle = '#cfe8ff'; g.lineWidth = 3.5;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, sa, sa + 0.5); g.stroke();
  g.globalAlpha = 0.06; g.lineWidth = 10;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, sa, sa + 0.5); g.stroke();

  g.restore();
}

/* low mist crawling over the sand, plus a few motes drifting up the shot */
function liveMist(t){
  const g = ctx;
  g.save();
  g.globalCompositeOperation = 'lighter';
  for(let i=0;i<7;i++){
    const sp = 12 + aH(i*2.2)*16;
    const x  = ((t*sp + aH(i*5.5)*1400) % 1320) - 160;
    const y  = 150 + aH2(i, 3.1)*230;
    const w  = 150 + aH2(i, 7.4)*200;
    const h  = 20 + aH2(i, 1.6)*26;
    g.globalAlpha = 0.045 + 0.03*Math.sin(t*0.7 + i*1.9);
    const mg = g.createRadialGradient(x, y, 2, x, y, w);
    mg.addColorStop(0, '#9fb6e8'); mg.addColorStop(1, '#9fb6e800');
    g.fillStyle = mg;
    g.beginPath(); g.ellipse(x, y, w, h, 0, 0, TAU); g.fill();
  }
  /* drifting dust caught in the moonlight */
  for(let i=0;i<26;i++){
    const life = ((t*0.14 + aH(i*3.3)) % 1);
    const x = aH(i*6.1)*ARENA_W + Math.sin(t*0.6 + i)*14;
    const y = lerp(430, 90, life);
    g.globalAlpha = 0.30*Math.sin(life*Math.PI);
    g.fillStyle = i%4 === 0 ? '#ffd9a8' : '#cfe0ff';
    g.beginPath(); g.arc(x, y, 1.1, 0, TAU); g.fill();
  }
  g.restore();
}

/* ───────────────────────── ENTRY POINT ───────────────────────── */

function drawArena(t){
  ctx.drawImage(arenaBg(), BG_TOP, BG_TOP, BG_W, BG_H);
  liveStars(t);
  liveCrowd(t);
  liveMist(t);
  liveRing(t);
  liveTorches(t);
}

/* ═══════════════════════════════════════════════════════════════
   PROCEDURAL GEOMETRY — cosmetic only; the sim never reads any of it.

   Additive noise on a circle still reads as a circle with a wobble, and
   noise on a straight line still reads as a straight line. These
   helpers build silhouettes that are structurally irregular instead:
   recursive subdivision for lightning, harmonic radius modulation for
   blast fronts, and closed per-element paths for projectile bodies.
   ═══════════════════════════════════════════════════════════════ */

/* Cheap deterministic hash -> 0..1. Used to derive stable phases and
   offsets from a seed, so a shape can be regenerated identically for
   as many frames as we like. */
function _hash1(n){ const s = Math.sin(n*127.1 + 311.7)*43758.5453123; return s - Math.floor(s); }

/* xorshift PRNG. A bolt reseeded every frame flickers like TV snow, so
   callers advance the seed on a slower clock: the bolt HOLDS its shape
   for a few frames, then snaps to a new one. */
function _srand(seed){
  let s = (seed>>>0) || 1;
  return function(){ s^=s<<13; s>>>=0; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; };
}

/* Smooth 1-D value noise, -1..1. For open-ended wobble (falling wakes,
   trails) where the two ends never have to meet up. */
function _vnoise(x){
  const i = Math.floor(x), f = x - i, u = f*f*(3-2*f);
  return lerp(_hash1(i), _hash1(i+1), u)*2 - 1;
}

/* Periodic noise for CLOSED outlines, -1..1. A sum of harmonics with
   INTEGER frequencies, so f(a) === f(a+TAU) exactly and a ring shows no
   seam where the loop wraps. Amplitude falls off as ~1/f, the usual
   recipe that makes layered noise look natural rather than buzzy. */
/* The phase of each harmonic depends only on (seed, harm), never on the
   angle — so computing it inside the vertex loop meant one Math.sin per
   harmonic per vertex, i.e. several hundred wasted trig calls for every
   ring drawn. Cache the phase table per seed instead; output is
   bit-identical, the cost drops to one sin per harmonic per vertex. */
const _phaseCache = new Map();
function _phases(seed, harm){
  const key = seed + '|' + harm;
  let p = _phaseCache.get(key);
  if(p === undefined){
    p = new Float64Array(harm + 1);       // p[harm] holds the amplitude sum
    let amp = 1, tot = 0;
    for(let k=1; k<=harm; k++){
      p[k-1] = _hash1(seed*7.31 + k*13.7)*TAU;
      tot += amp; amp *= 0.62;
    }
    p[harm] = tot;
    /* acts are transient, so bound the cache rather than leak one entry
       per projectile for the lifetime of the page */
    if(_phaseCache.size > 512) _phaseCache.clear();
    _phaseCache.set(key, p);
  }
  return p;
}
/* Evaluate the harmonic sum against an ALREADY-resolved phase table.
   Vertex loops call this directly so the per-vertex cost is pure trig,
   with no map lookup or key construction in the inner loop. */
function _loopNoiseP(a, ph, harm){
  let v = 0, amp = 1;
  for(let k=1; k<=harm; k++){ v += Math.sin(a*k + ph[k-1]) * amp; amp *= 0.62; }
  return v/ph[harm];
}
/* Convenience wrapper for one-off samples (e.g. placing a single spark). */
function _loopNoise(a, seed, harm){
  harm = harm || 5;
  return _loopNoiseP(a, _phases(seed, harm), harm);
}

/* ── LIGHTNING ───────────────────────────────────────────────────
   Recursive midpoint displacement. Split a segment, kick its midpoint
   along the PERPENDICULAR (which keeps both endpoints exactly where
   they were, so the bolt still connects caster to target), then recurse
   on each half with the displacement budget cut back. That self-similar
   structure is the whole difference between a real bolt and a straight
   line with noise added: the kinks have kinks.

   Forks peel off a midpoint at an angle and are generated by the same
   routine, so a branch is a bolt in miniature rather than a smooth
   whisker. Returns {main:[[x,y],...], forks:[[[x,y],...],...]}.       */
function boltPath(x1, y1, x2, y2, disp, depth, rng, forkChance, _forks){
  const forks = _forks || [];
  const pts = [[x1, y1]];
  (function sub(ax, ay, bx, by, d, dep){
    if(dep <= 0){ pts.push([bx, by]); return; }
    const dx = bx-ax, dy = by-ay, len = Math.hypot(dx, dy) || 1;
    const mx = (ax+bx)*0.5, my = (ay+by)*0.5;
    const off = (rng()*2 - 1) * d;
    const px = mx + (-dy/len)*off, py = my + (dx/len)*off;
    if(dep > 1 && forkChance > 0 && rng() < forkChance){
      const fa = Math.atan2(by-py, bx-px) + (rng()<0.5?-1:1)*(0.35 + rng()*0.55);
      const fl = Math.hypot(bx-px, by-py) * (0.35 + rng()*0.40);
      forks.push(boltPath(px, py, px+Math.cos(fa)*fl, py+Math.sin(fa)*fl,
                          d*0.6, dep-1, rng, 0, forks).main);
    }
    sub(ax, ay, px, py, d*0.55, dep-1);
    sub(px, py, bx, by, d*0.55, dep-1);
  })(x1, y1, x2, y2, disp, depth);
  return {main: pts, forks: forks};
}

/* Trace an array of [x,y] points into the current path. */
function tracePts(pts){
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

/* ── BLAST FRONT ─────────────────────────────────────────────────
   A many-point polygon whose radius breathes under several harmonics at
   once. Because those frequencies are incommensurate the outline never
   settles into "rounded polygon" or "pulsing star", and rotating the
   sample angle over time (`spin`) walks the lumps around the ring, so
   an expanding front writhes rather than just scaling up.
   `squash` flattens it for waves that lie on the ground plane.        */
function blobPath(cx, cy, r, amp, seed, squash, spin){
  squash = squash==null ? 1 : squash;
  const N = clamp((r*0.5)|0, 20, 64);       // vertex count follows size
  const ph = _phases(seed, 6), sp = spin||0;   // hoisted: constant per ring
  ctx.beginPath();
  for(let i=0;i<=N;i++){
    const a  = i/N*TAU;
    const rr = r * (1 + _loopNoiseP(a + sp, ph, 6)*amp);
    const x  = cx + Math.cos(a)*rr, y = cy + Math.sin(a)*rr*squash;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/* ── PROJECTILE SILHOUETTES ──────────────────────────────────────
   A round dot is the one shape that reads as placeholder art. Each
   element instead supplies shape(x, y, r, ang, t, seed), which traces a
   CLOSED path oriented along `ang` (its direction of travel) and leaves
   fill/stroke/alpha to the caller.                                    */

/* fire / blood / life — a teardrop: round nose, tail streaming behind.
   Two quadratics, so the profile is a true curve rather than a fan of
   segments; the tail length and lash are driven off `t` so a flame
   never freezes into a static logo. */
function shpDrop(x, y, r, ang, t, seed){
  const c = Math.cos(ang), s = Math.sin(ang);
  const X = (a,b)=> x + a*c - b*s, Y = (a,b)=> y + a*s + b*c;
  const nose  = r*1.25;
  const tail  = -r*(2.2 + Math.sin(t*22 + seed)*0.5);
  const bulge = r*(0.92 + Math.sin(t*17 + seed*1.3)*0.10);
  const wag   = Math.sin(t*19 + seed*2.1)*r*0.35;
  const nx = X(nose,0), ny = Y(nose,0);
  const tx = X(tail,wag), ty = Y(tail,wag);
  ctx.beginPath(); ctx.moveTo(nx, ny);
  ctx.quadraticCurveTo(X(r*0.2, bulge), Y(r*0.2, bulge), tx, ty);
  ctx.quadraticCurveTo(X(r*0.2,-bulge), Y(r*0.2,-bulge), nx, ny);
  ctx.closePath();
}

/* frost — a six-sided crystal. Alternating long and short vertices make
   it faceted instead of a regular hexagon, and the whole form is
   stretched along travel so it reads as a thrown shard. */
function shpCrystal(x, y, r, ang, t, seed){
  const c = Math.cos(ang), s = Math.sin(ang);
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a = i*TAU/6, rad = r*(i%2 ? 0.62 : 1.15);
    const lx = Math.cos(a)*rad*1.45, ly = Math.sin(a)*rad*0.80;
    const px = x + lx*c - ly*s, py = y + lx*s + ly*c;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

/* blight / void / shadow / earth — an indefinite lumpy mass. Periodic
   noise per vertex keeps the outline irregular but seamless; drifting
   the sample with `t` makes it churn instead of merely spinning. Pass
   t = 0 for a rigid silhouette that only rotates (see the meteors). */
function shpRough(x, y, r, ang, t, seed){
  const N = 9;
  const ph = _phases(seed, 4), dt = t*1.4;     // hoisted: constant per body
  ctx.beginPath();
  for(let i=0;i<N;i++){
    const a   = i/N*TAU;
    const rad = r*(0.78 + (_loopNoiseP(a + dt, ph, 4)*0.5 + 0.5)*0.62);
    const px  = x + Math.cos(a+ang)*rad, py = y + Math.sin(a+ang)*rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

/* blade / wind / swift — a thin sliver: long nose, short tail. */
function shpSliver(x, y, r, ang){
  const c = Math.cos(ang), s = Math.sin(ang);
  const X = (a,b)=> x + a*c - b*s, Y = (a,b)=> y + a*s + b*c;
  ctx.beginPath();
  ctx.moveTo(X(r*2.3, 0),   Y(r*2.3, 0));
  ctx.lineTo(X(0,  r*0.62), Y(0,  r*0.62));
  ctx.lineTo(X(-r*1.5, 0),  Y(-r*1.5, 0));
  ctx.lineTo(X(0, -r*0.62), Y(0, -r*0.62));
  ctx.closePath();
}

/* storm — a zigzag mote whose kink is driven by noise, so it stutters
   along its own axis the way a spark jumps. */
function shpBolt(x, y, r, ang, t, seed){
  const c = Math.cos(ang), s = Math.sin(ang);
  const X = (a,b)=> x + a*c - b*s, Y = (a,b)=> y + a*s + b*c;
  const w = r*0.70, k = _vnoise(t*24 + seed)*r*0.6;
  ctx.beginPath();
  ctx.moveTo(X(r*2.0, 0),       Y(r*2.0, 0));
  ctx.lineTo(X(r*0.3,  w+k),    Y(r*0.3,  w+k));
  ctx.lineTo(X(-r*0.4, w*0.25), Y(-r*0.4, w*0.25));
  ctx.lineTo(X(-r*2.0,-k*0.5),  Y(-r*2.0,-k*0.5));
  ctx.lineTo(X(-r*0.4,-w*0.25), Y(-r*0.4,-w*0.25));
  ctx.lineTo(X(r*0.3, -w+k),    Y(r*0.3, -w+k));
  ctx.closePath();
}

/* holy / arcane / control — a four-point star that breathes and turns. */
function shpStar(x, y, r, ang, t, seed){
  const pts = 4, spin = ang + t*1.2;
  ctx.beginPath();
  for(let i=0;i<pts*2;i++){
    const a   = spin + i*Math.PI/pts;
    const rad = i%2 ? r*0.34 : r*(1.60 + Math.sin(t*9 + seed)*0.18);
    const px  = x + Math.cos(a)*rad, py = y + Math.sin(a)*rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

/* ═══════════════════════════════════════════════════════════════
   ELEMENTAL VISUAL IDENTITY — cosmetic only; the sim never reads it.

   Every skill already carries a TAGS entry (its family list). We reuse
   that to give each element a BEHAVIOUR signature for its particles and
   trails, so two skills of the same `kind` but different element no
   longer look identical: fire rises and smoulders, frost sheds falling
   shards, storm forks and jitters, void drags inward, blood falls heavy,
   holy ascends softly, blade cuts thin and fast.

   Fields:
     sh     particle shape ('dot' | 'streak' | 'shard' | 'soft')
     rise   vertical launch bias  (negative = upward)
     grav   gravity applied per second (negative = floats up)
     drag   velocity retention (lower = snappier decay)
     glow   multiplier on glow radius / brightness
     jit    lateral jitter added to spark spawns
     trailW multiplier on trail ribbon width
     core   colour of the hot inner core
     smoke  optional dark smoke tint for smouldering elements
     pull   motes converge on origin instead of scattering
     soft   prefer soft additive puffs over hard dots
     shape  closed-path silhouette for the projectile body (see below)
   ═══════════════════════════════════════════════════════════════ */
const EFX = {
  fire:   {sh:'dot',    rise:-130, grav:-30, drag:0.90, glow:1.18, jit:1.0, trailW:1.20, smoke:'#2a140a', core:'#ffe6b0'},
  frost:  {sh:'shard',  rise:10,   grav:90,  drag:0.93, glow:1.02, jit:0.4, trailW:1.00,                  core:'#eaffff'},
  storm:  {sh:'streak', rise:-20,  grav:20,  drag:0.85, glow:1.12, jit:2.4, trailW:0.92,                  core:'#ffffff'},
  arcane: {sh:'dot',    rise:-30,  grav:0,   drag:0.93, glow:1.12, jit:0.7, trailW:1.00,                  core:'#dfffff'},
  void:   {sh:'dot',    rise:0,    grav:0,   drag:0.95, glow:1.22, jit:0.6, trailW:1.15, pull:true,       core:'#e6d0ff'},
  blade:  {sh:'streak', rise:-10,  grav:160, drag:0.90, glow:0.96, jit:0.3, trailW:0.85,                  core:'#ffffff'},
  blood:  {sh:'dot',    rise:20,   grav:300, drag:0.90, glow:1.02, jit:0.5, trailW:1.05,                  core:'#ffd0dc'},
  holy:   {sh:'dot',    rise:-160, grav:-40, drag:0.92, glow:1.30, jit:0.4, trailW:1.15, soft:true,       core:'#fffbe6'},
  shadow: {sh:'soft',   rise:-40,  grav:-10, drag:0.95, glow:1.06, jit:0.8, trailW:1.05, soft:true,       core:'#d9b8ff'},
  blight: {sh:'dot',    rise:-6,   grav:90,  drag:0.94, glow:1.00, jit:0.6, trailW:1.00, smoke:'#16240a', core:'#e6ffb0'},
  earth:  {sh:'shard',  rise:-20,  grav:360, drag:0.87, glow:0.92, jit:0.5, trailW:1.10, smoke:'#241a10', core:'#ffe9c0'},
  wind:   {sh:'streak', rise:-30,  grav:15,  drag:0.90, glow:0.96, jit:1.1, trailW:0.90,                  core:'#eafff5'},
  life:   {sh:'dot',    rise:-120, grav:-20, drag:0.92, glow:1.06, jit:0.4, trailW:1.00,                  core:'#eaffea'},
  swift:  {sh:'streak', rise:-20,  grav:10,  drag:0.90, glow:0.96, jit:0.9, trailW:0.90,                  core:'#f0fff8'},
  control:{sh:'dot',    rise:-10,  grav:0,   drag:0.93, glow:1.10, jit:0.5, trailW:1.00,                  core:'#fff0d0'},
};
const EFX_DEFAULT = {sh:'dot', rise:-30, grav:40, drag:0.92, glow:1.0, jit:0.6, trailW:1.0, core:'#ffffff'};
/* Per-element projectile silhouette. Held in its own table so the
   behaviour fields above stay scannable, then folded onto the EFX
   entries so callers only ever need `efxOf(sk).shape`. Elements absent
   from this table keep the default disc. */
const EFX_SHAPE = {
  fire:  shpDrop,    blood: shpDrop,    life:  shpDrop,
  frost: shpCrystal,
  storm: shpBolt,
  void:  shpRough,   shadow:shpRough,   blight:shpRough,  earth:shpRough,
  blade: shpSliver,  wind:  shpSliver,  swift: shpSliver,
  holy:  shpStar,    arcane:shpStar,    control:shpStar,
};
for(const k in EFX_SHAPE) if(EFX[k]) EFX[k].shape = EFX_SHAPE[k];
/* When a skill has several families we pick ONE to drive its look. The
   priority favours the more visually dominant element so, e.g., a
   void/frost skill reads as void. */
const ELEM_PRIORITY = ['void','fire','frost','storm','holy','blood','blight',
  'shadow','earth','life','blade','wind','swift','arcane','control'];
const _elemCache = {};
function elemOf(sk){
  if(!sk || !sk.id) return null;
  if(sk.id in _elemCache) return _elemCache[sk.id];
  const tags = TAGS[sk.id] || [];
  let el = null;
  for(const p of ELEM_PRIORITY) if(tags.indexOf(p) >= 0){ el = p; break; }
  if(!el) el = tags[0] || null;
  return (_elemCache[sk.id] = el);
}
function efxOf(sk){ return EFX[elemOf(sk)] || EFX_DEFAULT; }

/* ── dual-element sparks for fused skills ───────────────────────
   Picking one element is right for a normal skill, but it throws away the
   thing that makes a fusion look like a fusion. A Thermal Lance built from
   fire and frost should visibly shed BOTH — fire licks that rise and trail
   warm smoke, and frost shards that fall and glitter — rather than
   resolving to whichever family wins ELEM_PRIORITY.

   Only the per-particle spawn alternates. efxOf() stays single-element on
   purpose: it also supplies `shape`, the projectile silhouette, which is
   read every frame for the body — alternating that would make the
   projectile flicker between a drop and a crystal. So the body reads as
   the dominant element and the spray reads as all of them, which is the
   right split anyway.

   Same-family recipes (Manafold, Null Aperture) dedupe to one element and
   fall straight through to the normal path.                          */
const _elemsCache = {};
function elemsOf(sk){
  if(!sk || !sk.id) return [];
  if(sk.id in _elemsCache) return _elemsCache[sk.id];
  const tags = TAGS[sk.id] || [];
  const els = ELEM_PRIORITY.filter(p => tags.indexOf(p) >= 0);
  return (_elemsCache[sk.id] = els.length ? els : [elemOf(sk)].filter(Boolean));
}
/* Round-robin cursor per skill id. Deliberately a plain counter rather
   than random: it guarantees an even split over any burst, so a two-spark
   puff still shows both elements instead of rolling the same one twice. */
const _elemTurn = {};
function efxTurn(sk){
  const els = elemsOf(sk);
  if(els.length < 2) return efxOf(sk);
  const i = (_elemTurn[sk.id] = ((_elemTurn[sk.id]||0) + 1) % els.length);
  return EFX[els[i]] || EFX_DEFAULT;
}
/* Blend two hex colours. `t` 0 keeps a, 1 keeps b. */
function efxMix(a, b, t){
  const na = parseInt(a.slice(1),16), nb = parseInt(b.slice(1),16);
  const c = (s) => Math.round((((na>>s)&255))*(1-t) + (((nb>>s)&255))*t);
  return '#' + ((1<<24) + (c(16)<<16) + (c(8)<<8) + c(0)).toString(16).slice(1);
}
/* A fused spark leans its colour toward the family it is representing,
   otherwise every particle would be the fusion's single identity colour
   and the dual-element behaviour would be invisible. Kept partial so the
   fusion still reads as one skill rather than two overlaid. */
const _fuseColCache = {};
function efxFuseCol(sk, el){
  if(!el || !FAMILY[el]) return sk.col || '#fff';
  const k = sk.id + '|' + el;
  return _fuseColCache[k] ||
    (_fuseColCache[k] = efxMix(sk.col || '#fff', FAMILY[el].col, 0.55));
}

/* Spawn one signature spark for a skill at (x,y).
   opt overrides: ang, spd, vx, vy, col, life, r, grav, drag, sh, rise, jit. */
function efxSpark(sk, x, y, opt){
  const e = sk && sk.fused ? efxTurn(sk) : efxOf(sk); opt = opt || {};
  const spd = opt.spd!=null ? opt.spd : rnd(120,40);
  const ang = opt.ang!=null ? opt.ang : rnd(TAU);
  const jit = e.jit * (opt.jit!=null?opt.jit:1);
  let vx = (opt.vx!=null?opt.vx:Math.cos(ang)*spd) + rnd(30,-30)*jit;
  let vy = (opt.vy!=null?opt.vy:Math.sin(ang)*spd) + e.rise*(opt.rise!=null?opt.rise:1) + rnd(20,-20)*jit;
  /* fused sparks tint toward whichever family this one is standing in for */
  let col = opt.col;
  if(!col && sk && sk.fused && e !== EFX_DEFAULT){
    const els = elemsOf(sk);
    if(els.length > 1) col = efxFuseCol(sk, els[_elemTurn[sk.id]||0]);
  }
  return spawn({x, y, vx, vy, col:col||sk.col||'#fff',
    life:opt.life!=null?opt.life:rnd(.6,.25), r:opt.r!=null?opt.r:rnd(3.4,1.2),
    grav:opt.grav!=null?opt.grav:e.grav, drag:opt.drag!=null?opt.drag:e.drag,
    sh:opt.sh||e.sh, rot:ang, spin:opt.spin||0, add:opt.add});
}
