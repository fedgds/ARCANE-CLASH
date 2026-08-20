/* ═══════════════════════════════════════════════════════════════
   SKILL ICONS — one glyph vocabulary, every screen.

   A skill used to be a paragraph. The draft is five of them side by
   side under a timer, and reading five paragraphs is not a decision,
   it is homework. So every skill now also has a drawn identity, and
   the same drawing appears wherever the game names that skill: shop
   card, loadout card, detail panel, contribution chart, codex.

   THE LANGUAGE — four independent reads, stacked on one plate:

     silhouette  what the skill DOES with space. One form per `kind`,
                 eleven forms, all clearly different in outline: a dart
                 with a tail, a fanned volley, a lance, concentric
                 rings, a wedge, falling shards, a slash with
                 after-images, a tilted orbit, a hex zone, a warded
                 core, a summoning sigil. Drawn in the skill's own
                 colour, so the accent players already associate with
                 the card carries the shape.

     cage        crowd control. A CC skill keeps its delivery
                 silhouette but shrinks inside four heavy clamps, so
                 "this one takes their turn away" is a silhouette
                 change and not a hue change.

     badge       the status rider, bottom right: a dark chip with a
                 shape-first pictogram — flame, snowflake, cracked
                 plate, droplet, cross, shield, chevrons, chain. The
                 status colour is reinforcement, never the message.

     notches     tier, bottom left: five slots, `tier` of them filled
                 and tall. Countable, so tier survives greyscale and
                 never depends on the tier colour alone. Below 27px the
                 slots are too fine to count, so the same number is swept
                 around the plate rim instead — a fifth of the perimeter
                 per tier.

     runes       family, top left, only on the large sizes: up to two
                 chips carrying the element/synergy marks. Families
                 are the combo system, so this is the "what does this
                 build toward" read.

   No external assets, no fonts, no canvas, no gradients with ids that
   could collide when the same skill is drawn twice on one screen: a
   plain inline <svg> in a 64×64 box, which means it works from a
   file:// open and scales to any size we ask for.

   THREE SIZES, ONE DRAWING. `detail` drops layers rather than
   redrawing them, so a 16px chart marker and an 84px hero are
   provably the same object:
     micro (≤26px)  plate + silhouette + status badge + tier rim
     card  (≤52px)  plate + silhouette + status badge + tier notches
     full  (>52px)  + family runes

   Every one of the 60 skills comes out unique at every size: `kind`,
   `fx`, `tier` and family have no colliding four-tuple in the catalog,
   and the four reads above are exactly those four axes. (Verified — see
   the icon probe in the commit notes.)

   Load order: after battle-render.js, because the four crowd-control
   colours are read from its CC_VIS rather than duplicated here, and
   before draft.js, which is the first script that draws a card.
   ═══════════════════════════════════════════════════════════════ */

/* ── geometry helpers ── */
const sicoR  = n => Math.round(n * 10) / 10;
const sicoPt = (cx, cy, r, deg) => {
  const a = deg * Math.PI / 180;
  return [sicoR(cx + r * Math.cos(a)), sicoR(cy + r * Math.sin(a))];
};
/* an arc of a circle between two angles, as a path fragment */
function sicoArc(cx, cy, r, d0, d1){
  const [x0, y0] = sicoPt(cx, cy, r, d0), [x1, y1] = sicoPt(cx, cy, r, d1);
  return `M${x0} ${y0}A${r} ${r} 0 ${Math.abs(d1 - d0) > 180 ? 1 : 0} ${d1 > d0 ? 1 : 0} ${x1} ${y1}`;
}
const sicoEsc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── kind silhouettes ──
   Every form is authored in the same 64×64 box with the caster on the
   left and the target on the right, so "outward" reads the same way on
   every card. Where a skill's own numbers can change the drawing
   without muddying it they do: a faster bolt gets a longer tail, a
   longer channel a thicker lance, more hits more shards. */
function sicoKind(sk, col){
  const S = [];
  const st = (d, w, o, extra) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${o}"${extra || ''}/>`;
  const fl = (d, o) => `<path d="${d}" fill="${col}" fill-opacity="${o}"/>`;
  const ci = (cx, cy, r, o) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}" fill-opacity="${o}"/>`;
  const ring = (r, w, o, extra) => `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${o}"${extra || ''}/>`;

  switch(sk.kind){

    /* single bolt in flight, tail behind it */
    case 'proj': {
      S.push(fl('M53 32L37 24.5L41 32L37 39.5Z', 1));
      S.push(st('M31 32H21', 3.4, .6));
      S.push(st('M17 32H11', 3.4, .28));
      if((sk.spd || 480) >= 540){          // fast bolts read as fast
        S.push(st('M29 25L23 22.5', 2.2, .3));
        S.push(st('M29 39L23 41.5', 2.2, .3));
      }
      break;
    }

    /* a volley: the same dart, fanned */
    case 'multiproj': {
      const n = Math.max(2, Math.min(4, sk.hits || 3)), sp = 24;
      for(let i = 0; i < n; i++){
        const a = sicoR(-sp + i * (sp * 2 / (n - 1)));
        S.push(`<g transform="rotate(${a} 14 32)">`
          + fl('M52 32L39 26.5L42.5 32L39 37.5Z', 1)
          + st('M33 32H24', 3, .5)
          + `</g>`);
      }
      break;
    }

    /* a held channel: emitter, lance, impact */
    case 'beam': {
      const w = sicoR(5 + Math.min(4, (sk.hits || 4) / 2.6));
      S.push(ci(12, 32, 5.6, 1));
      S.push(st('M14 32H50', w, .78));
      S.push(`<path d="M17 32H47" fill="none" stroke="#ffffff" stroke-width="${sicoR(w * .3)}" stroke-opacity=".5" stroke-linecap="round"/>`);
      S.push(st('M53 32H59', 2.6, .85));
      S.push(st('M51.5 26L57 21.5', 2.2, .5));
      S.push(st('M51.5 38L57 42.5', 2.2, .5));
      break;
    }

    /* detonation on the caster: rings out, spikes through them */
    case 'nova': {
      S.push(ci(32, 32, 4.6, 1));
      S.push(ring(11, 3, .85));
      S.push(ring(18.5, 2.4, .5));
      S.push(ring(25, 2, .3, ' stroke-dasharray="3.5 5"'));
      for(const a of [45, 135, 225, 315]){
        const [x0, y0] = sicoPt(32, 32, 21, a), [x1, y1] = sicoPt(32, 32, 30, a);
        S.push(st(`M${x0} ${y0}L${x1} ${y1}`, 2.6, .55));
      }
      break;
    }

    /* a swept arc in front of the caster */
    case 'cone': {
      S.push(fl('M16 32L54 11L54 53Z', .12));
      S.push(st('M16 32L54 11', 2.8, .9));
      S.push(st('M16 32L54 53', 2.8, .9));
      S.push(st(sicoArc(16, 32, 22, -29, 29), 2.6, .55));
      S.push(st(sicoArc(16, 32, 32, -29, 29), 2.2, .3));
      S.push(ci(16, 32, 3.4, 1));
      break;
    }

    /* something falls on a marked patch of ground */
    case 'rain': {
      const h = sk.hits || 4;
      const xs = h >= 7 ? [15, 23.5, 32, 40.5, 49] : h >= 4 ? [17, 27, 37, 47] : [20, 32, 44];
      S.push(`<ellipse cx="32" cy="49" rx="19" ry="6" fill="none" stroke="${col}" stroke-width="2.4" stroke-opacity=".55"/>`);
      S.push(`<ellipse cx="32" cy="49" rx="9" ry="2.8" fill="${col}" fill-opacity=".22"/>`);
      xs.forEach((x, i) => {
        const y0 = 8 + (i % 2) * 5, y1 = y0 + 16;
        S.push(st(`M${x} ${y0}L${x} ${y1}`, 3, .8));
        S.push(fl(`M${x - 3.4} ${y1}L${x + 3.4} ${y1}L${x} ${y1 + 6.4}Z`, .95));
      });
      break;
    }

    /* a blink through the target — the after-images are the hit count */
    case 'dash': {
      const h = sk.hits || 4;
      S.push(st('M12 42L38 14', 4.6, .95));
      S.push(fl('M38 14L44 9L41 18Z', .9));
      S.push(st('M21 50L45 24', 3.4, .5));
      if(h >= 6) S.push(st('M9 30L23 15', 2.6, .28));
      if(h >= 8) S.push(st('M14 17L40 43', 3, .5));   // a second blade crosses
      break;
    }

    /* companions on a tilted ring around the caster */
    case 'orbit': {
      const n = Math.max(1, Math.min(3, sk.count || 2));
      S.push(`<g transform="rotate(-24 32 32)">`);
      S.push(`<ellipse cx="32" cy="32" rx="23" ry="9.5" fill="none" stroke="${col}" stroke-width="2.6" stroke-opacity=".6"/>`);
      for(let i = 0; i < n; i++){
        const [x, y] = [sicoR(32 + 23 * Math.cos(i * 2 * Math.PI / n)),
                        sicoR(32 + 9.5 * Math.sin(i * 2 * Math.PI / n))];
        S.push(`<circle cx="${x}" cy="${y}" r="4.6" fill="${col}"/>`);
      }
      S.push(`</g>`);
      S.push(fl('M32 23.5L38.5 32L32 40.5L25.5 32Z', .95));
      break;
    }

    /* a zone that stays put and grinds */
    case 'field': {
      const hex = [0, 60, 120, 180, 240, 300].map(a => sicoPt(32, 31, 21, a));
      S.push(`<path d="M${hex.map(p => p.join(' ')).join('L')}Z" fill="${col}" fill-opacity=".1" stroke="${col}" stroke-width="2.6" stroke-opacity=".8"/>`);
      S.push(`<ellipse cx="32" cy="42" rx="13" ry="4.6" fill="none" stroke="${col}" stroke-width="2" stroke-opacity=".5"/>`);
      for(const x of [25, 32, 39]) S.push(st(`M${x} 39L${x} 26`, 2.2, .45, ' stroke-dasharray="2.6 3.4"'));
      S.push(ci(32, 42, 2.6, .9));
      break;
    }

    /* nothing leaves the caster: a warded core */
    case 'self': {
      S.push(fl('M32 19L41 32L32 45L23 32Z', .92));
      S.push(`<path d="M32 25L36 32L32 39L28 32Z" fill="#ffffff" fill-opacity=".2"/>`);
      S.push(st(sicoArc(32, 32, 20, 118, 242), 3, .8));
      S.push(st(sicoArc(32, 32, 20, -62, 62), 3, .8));
      S.push(st(sicoArc(32, 32, 26, 142, 218), 2.2, .32));
      S.push(st(sicoArc(32, 32, 26, -38, 38), 2.2, .32));
      break;
    }

    /* a circle, and something standing in it */
    case 'summon': {
      const n = Math.max(1, Math.min(2, sk.count || 1));
      S.push(`<circle cx="32" cy="33" r="20" fill="none" stroke="${col}" stroke-width="2" stroke-opacity=".42" stroke-dasharray="3.4 4.6"/>`);
      S.push(`<path d="M14 25H50L32 51Z" fill="${col}" fill-opacity=".08" stroke="${col}" stroke-width="1.8" stroke-opacity=".3"/>`);
      if(n === 1){
        S.push(ci(32, 27, 5.6, 1));
        S.push(fl('M23 46Q23 34.5 32 34.5Q41 34.5 41 46Z', .9));
      } else {
        for(const cx of [22, 42]){
          S.push(ci(cx, 27.5, 4.4, 1));
          S.push(fl(`M${cx - 7} 45Q${cx - 7} 35.5 ${cx} 35.5Q${cx + 7} 35.5 ${cx + 7} 45Z`, .88));
        }
      }
      break;
    }
  }
  return S.join('');
}

/* four clamps around a shrunken silhouette: the shape says "held", the
   badge inside the clamps says which way */
function sicoCage(col){
  const w = 3.4;
  const arm = d => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity=".9" stroke-linecap="round"/>`;
  return arm('M9 23V15A6 6 0 0 1 15 9H23')
       + arm('M41 9H49A6 6 0 0 1 55 15V23')
       + arm('M55 41V49A6 6 0 0 1 49 55H41')
       + arm('M23 55H15A6 6 0 0 1 9 49V41')
       + `<circle cx="6.4" cy="32" r="2.2" fill="${col}" fill-opacity=".8"/>`
       + `<circle cx="57.6" cy="32" r="2.2" fill="${col}" fill-opacity=".8"/>`;
}

/* ── status riders ──
   One pictogram per rider, shape-first: every one of these is
   distinguishable with the colour thrown away, because colour is the
   last thing a player can rely on. `cc:1` takes its colour live from
   the battle renderer's CC_VIS so the four crowd-control hues are
   defined in exactly one place. */
const SICO_FX = {
  burn:   {name:'Burn',      col:'#ff7a3d', g:c =>
    `<path d="M0 -5.4C3 -2.2 4 -0.6 4 1.4A4 4 0 0 1 -4 1.4C-4 -0.8 -1.8 -2.4 0 -5.4Z" fill="${c}"/>`
  + `<path d="M0 -1.4C1.4 0.2 1.8 1 1.8 1.8A1.8 1.8 0 0 1 -1.8 1.8C-1.8 0.9 -1.1 0.3 0 -1.4Z" fill="#ffffff" fill-opacity=".35"/>`},

  chill:  {name:'Chill',     col:'#8fd8ff', g:c =>
    `<g stroke="${c}" stroke-width="1.5"><path d="M0 -5.2V5.2"/><path d="M-4.5 -2.6L4.5 2.6"/><path d="M-4.5 2.6L4.5 -2.6"/></g>`},

  shred:  {name:'Shred',     col:'#d59a5a', g:c =>
    `<path d="M0 -5.4L4.6 -3.2V0.8C4.6 3.4 2.3 4.8 0 5.6C-2.3 4.8 -4.6 3.4 -4.6 0.8V-3.2Z" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M-1.6 -3L1 -0.4L-1 1.2L1.6 3.8" stroke="${c}" stroke-width="1.4"/>`},

  bleed:  {name:'Poison',    col:'#9dff6b', g:c =>
    `<path d="M0 -5.6C2.6 -2 4 -0.4 4 1.4A4 4 0 0 1 -4 1.4C-4 -0.4 -2.6 -2 0 -5.6Z" fill="${c}"/>`
  + `<g fill="${c}" fill-opacity=".85"><circle cx="-4.4" cy="5" r="1"/><circle cx="0" cy="6" r="1"/><circle cx="4.4" cy="5" r="1"/></g>`},

  heal:   {name:'Heal',      col:'#8dffa8', g:c =>
    `<path d="M0 -5.2V5.2M-5.2 0H5.2" stroke="${c}" stroke-width="2.6"/>`},

  shield: {name:'Shield',    col:'#9fc4ff', g:c =>
    `<path d="M0 -5.4L4.6 -3.2V0.8C4.6 3.4 2.3 4.8 0 5.6C-2.3 4.8 -4.6 3.4 -4.6 0.8V-3.2Z" fill="${c}" fill-opacity=".3" stroke="${c}" stroke-width="1.6"/>`},

  haste:  {name:'Haste',     col:'#d0ffe8', g:c =>
    `<path d="M-4.8 -4L-0.2 0L-4.8 4M0.8 -4L5.4 0L0.8 4" stroke="${c}" stroke-width="1.9"/>`},

  dr:     {name:'Armour',    col:'#cbbf9a', g:c =>
    `<path d="M0 -5.4L4.6 -3.2V0.8C4.6 3.4 2.3 4.8 0 5.6C-2.3 4.8 -4.6 3.4 -4.6 0.8V-3.2Z" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M-2.8 -0.4H2.8" stroke="${c}" stroke-width="1.9"/>`},

  dmgAmp: {name:'Damage up', col:'#ffd88a', g:c =>
    `<path d="M-4.6 -1.2L0 -5.6L4.6 -1.2M-4.6 4.4L0 0L4.6 4.4" stroke="${c}" stroke-width="1.9"/>`},

  thorns: {name:'Thorns',    col:'#ff9aa8', g:c =>
    `<circle r="2.9" stroke="${c}" stroke-width="1.6"/>`
  + `<g stroke="${c}" stroke-width="1.5">${[0, 60, 120, 180, 240, 300].map(a => {
        const [x0, y0] = sicoPt(0, 0, 3.8, a), [x1, y1] = sicoPt(0, 0, 6, a);
        return `<path d="M${x0} ${y0}L${x1} ${y1}"/>`;
      }).join('')}</g>`},

  crit:   {name:'Crit',      col:'#ff9c6b', g:c =>
    `<path d="M0 -3.4L2.6 0L0 3.4L-2.6 0Z" fill="${c}"/>`
  + `<g stroke="${c}" stroke-width="1.4">${[45, 135, 225, 315].map(a => {
        const [x0, y0] = sicoPt(0, 0, 3.8, a), [x1, y1] = sicoPt(0, 0, 6.2, a);
        return `<path d="M${x0} ${y0}L${x1} ${y1}"/>`;
      }).join('')}</g>`},

  pact:   {name:'Pact',      col:'#ff5d7a', g:c =>
    `<path d="M0 -5.6C2.6 -2 4 -0.4 4 1.4A4 4 0 0 1 -4 1.4C-4 -0.4 -2.6 -2 0 -5.6Z" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M0 3.6V-1.2M-1.9 0.6L0 -1.4L1.9 0.6" stroke="${c}" stroke-width="1.5"/>`},

  reflect:{name:'Reflect',   col:'#cfe8ff', g:c =>
    `<path d="M4.8 -5.4V5.4" stroke="${c}" stroke-width="2"/>`
  + `<path d="M-5.2 -2.8H2.2M-0.4 -5L2.2 -2.8L-0.4 -0.6" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M2.2 2.8H-5.2M-2.6 0.6L-5.2 2.8L-2.6 5" stroke="${c}" stroke-width="1.5"/>`},

  vamp:   {name:'Lifesteal', col:'#ff7ad9', g:c =>
    `<path d="M0 -5.6C2.6 -2 4 -0.4 4 1.4A4 4 0 0 1 -4 1.4C-4 -0.4 -2.6 -2 0 -5.6Z" fill="${c}"/>`
  + `<path d="M0 -1.6V3M-2.3 0.7H2.3" stroke="#080d18" stroke-width="1.6"/>`},

  exec:   {name:'Execute',   col:'#ffb03d', g:c =>
    `<path d="M-5.2 -4.6H5.2" stroke="${c}" stroke-width="2"/>`
  + `<path d="M-4 -1.6H4L0 5.6Z" fill="${c}"/>`},

  pull:   {name:'Pull',      col:'#b07bff', g:c =>
    `<circle r="1.8" fill="${c}"/>`
  + `<path d="M-6 0H-3.2M-4.8 -1.8L-3 0L-4.8 1.8" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M6 0H3.2M4.8 -1.8L3 0L4.8 1.8" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M0 -5.6V-3.4M0 5.6V3.4" stroke="${c}" stroke-width="1.5" stroke-opacity=".6"/>`},

  immune: {name:'Immune',    col:'#d9f2ff', g:c =>
    `<circle r="5.4" stroke="${c}" stroke-width="1.4" stroke-opacity=".55"/>`
  + `<circle r="3" stroke="${c}" stroke-width="1.8"/>`
  + `<circle r="1" fill="${c}"/>`},

  summon: {name:'Summon',    col:'#9ecfff', g:c =>
    `<circle cy="-2.6" r="2.4" fill="${c}"/>`
  + `<path d="M-4.2 5.2Q-4.2 0.2 0 0.2Q4.2 0.2 4.2 5.2Z" fill="${c}"/>`},

  /* ── crowd control ── */
  stun:   {name:'Stun',    cc:1, g:c =>
    `<path d="M0 -5.8L1.5 -1.6L5.8 0L1.5 1.6L0 5.8L-1.5 1.6L-5.8 0L-1.5 -1.6Z" fill="${c}"/>`
  + `<g fill="${c}" fill-opacity=".7"><circle cx="-5" cy="-4.6" r="1.2"/><circle cx="5" cy="4.6" r="1.2"/></g>`},

  freeze: {name:'Freeze',  cc:1, g:c =>
    `<path d="${[0, 60, 120, 180, 240, 300].map((a, i) => (i ? 'L' : 'M') + sicoPt(0, 0, 5.4, a - 90).join(' ')).join('')}Z" fill="${c}" fill-opacity=".35" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M0 -3V3M-2.4 -1.4L2.4 1.4" stroke="${c}" stroke-width="1.2" stroke-opacity=".8"/>`},

  silence:{name:'Silence', cc:1, g:c =>
    `<circle r="4.8" stroke="${c}" stroke-width="1.7"/>`
  + `<path d="M-3.5 3.5L3.5 -3.5" stroke="${c}" stroke-width="1.7"/>`},

  root:   {name:'Root',    cc:1, g:c =>
    `<path d="M0 -5.6V1.6" stroke="${c}" stroke-width="2"/>`
  + `<path d="M0 0.6Q-3.6 2.2 -4.8 5.6M0 0.6Q3.6 2.2 4.8 5.6" stroke="${c}" stroke-width="1.5"/>`
  + `<path d="M-2.8 -3.4L0 -1.4L2.8 -3.4" stroke="${c}" stroke-width="1.4" stroke-opacity=".7"/>`},

  /* ── positioning and survival ── */
  knock:  {name:'Knockback', col:'#b8ffe0', g:c =>
    `<path d="M-5 -5.2V5.2" stroke="${c}" stroke-width="2"/>`
  + `<path d="M-2 0H4.8M2.2 -2.6L5 0L2.2 2.6" stroke="${c}" stroke-width="1.6"/>`},

  wall:   {name:'Ward wall', col:'#bfe0ff', g:c =>
    `<g fill="${c}"><rect x="-5.4" y="-5.2" width="4.6" height="3.1" rx=".9"/><rect x="0.8" y="-5.2" width="4.6" height="3.1" rx=".9"/>`
  + `<rect x="-2.6" y="-1.5" width="5.2" height="3.1" rx=".9"/>`
  + `<rect x="-5.4" y="2.2" width="4.6" height="3.1" rx=".9"/><rect x="0.8" y="2.2" width="4.6" height="3.1" rx=".9"/></g>`},

  swap:   {name:'Swap',      col:'#d68cff', g:c =>
    `<path d="M-5.2 -2.4H4.4M1.8 -4.8L4.6 -2.4L1.8 0" stroke="${c}" stroke-width="1.6"/>`
  + `<path d="M5.2 2.4H-4.4M-1.8 0L-4.6 2.4L-1.8 4.8" stroke="${c}" stroke-width="1.6"/>`},

  undying:{name:'Undying',   col:'#ffce5a', g:c =>
    `<path d="M-5.2 5.2H5.2" stroke="${c}" stroke-width="2"/>`
  + `<path d="M0 3.2V-4.4M-2.9 -1.5L0 -4.6L2.9 -1.5" stroke="${c}" stroke-width="1.8"/>`},

  link:   {name:'Bound',     col:'#ff7ad9', g:c =>
    `<circle cx="-2.5" r="3.2" stroke="${c}" stroke-width="1.6"/>`
  + `<circle cx="2.5" r="3.2" stroke="${c}" stroke-width="1.6"/>`},
};
/* CC hues live in battle-render.js; read them there rather than keep a
   second copy that could drift */
const sicoFxCol = (fx, f) => f.cc && typeof CC_VIS !== 'undefined' && CC_VIS[fx]
  ? CC_VIS[fx].col : (f.col || '#9fb0d8');

/* ── family runes ──
   Deliberately abstract where the status badges are pictorial: the two
   sets must not be confusable, and a family is an idea ("void", "bind")
   rather than an event. Small, quiet, in the family's own colour. */
const SICO_RUNE = {
  fire:   c => `<path d="M0 -4.4L4 3.4H-4Z" fill="${c}"/>`,
  frost:  c => `<path d="${[0, 60, 120, 180, 240, 300].map((a, i) => (i ? 'L' : 'M') + sicoPt(0, 0, 4.2, a).join(' ')).join('')}Z" stroke="${c}" stroke-width="1.4"/>`,
  storm:  c => `<path d="M1.6 -4.6L-2.6 0.2H0.6L-1.6 4.6L2.8 -0.6H-0.4Z" fill="${c}"/>`,
  arcane: c => `<circle r="3.8" stroke="${c}" stroke-width="1.3"/><circle r="1.3" fill="${c}"/>`,
  void:   c => `<circle r="4.2" fill="${c}"/><circle r="1.9" fill="#070b14"/>`,
  blade:  c => `<path d="M-3.6 -3.6L3.6 3.6M3.6 -3.6L-3.6 3.6" stroke="${c}" stroke-width="1.6"/>`,
  blood:  c => `<path d="M0 -4.6C2.2 -1.6 3.4 -0.4 3.4 1.2A3.4 3.4 0 0 1 -3.4 1.2C-3.4 -0.4 -2.2 -1.6 0 -4.6Z" fill="${c}"/>`,
  guard:  c => `<path d="M0 -4.4L3.8 -2.6V0.8C3.8 2.8 1.9 4 0 4.6C-1.9 4 -3.8 2.8 -3.8 0.8V-2.6Z" stroke="${c}" stroke-width="1.4"/>`,
  holy:   c => `<circle r="1.6" fill="${c}"/><g stroke="${c}" stroke-width="1.3">${[0, 90, 180, 270].map(a => {
      const [x0, y0] = sicoPt(0, 0, 2.8, a), [x1, y1] = sicoPt(0, 0, 4.8, a);
      return `<path d="M${x0} ${y0}L${x1} ${y1}"/>`;
    }).join('')}</g>`,
  shadow: c => `<path d="M1.2 -4.2A4.2 4.2 0 1 0 1.2 4.2A5.2 5.2 0 0 1 1.2 -4.2Z" fill="${c}"/>`,
  blight: c => `<g fill="${c}"><circle cy="-3.2" r="1.5"/><circle cx="-3" cy="2.2" r="1.5"/><circle cx="3" cy="2.2" r="1.5"/></g>`,
  earth:  c => `<rect x="-3.6" y="-3.6" width="7.2" height="7.2" rx="1" stroke="${c}" stroke-width="1.4"/>`,
  wind:   c => `<path d="M-4.4 -1.8Q-1.8 -4 0.6 -1.8Q3 0.4 4.4 -1.8M-4.4 3Q-1.8 0.8 0.6 3Q3 5.2 4.4 3" stroke="${c}" stroke-width="1.4"/>`,
  life:   c => `<path d="M4 -4C4 1 1 4 -4 4C-4 -1 -1 -4 4 -4Z" fill="${c}"/>`,
  swift:  c => `<path d="M-2.4 -4.4L2.6 0L-2.4 4.4" stroke="${c}" stroke-width="1.8"/>`,
  control:c => `<path d="M-1.4 -4.4H-4V4.4H-1.4M1.4 -4.4H4V4.4H1.4" stroke="${c}" stroke-width="1.5"/>`,
  veil:   c => `<path d="M-4.6 2.6A4.6 4.6 0 0 1 4.6 2.6M-3 4.4A3 3 0 0 1 3 4.4" stroke="${c}" stroke-width="1.4"/><circle cy="-3.2" r="1.3" fill="${c}"/>`,
  bind:   c => `<path d="M-4.2 -3H4.2L0 4.4Z" stroke="${c}" stroke-width="1.4"/><circle cy="-0.8" r="1.2" fill="${c}"/>`,
};

/* ── plate, tier, badge, runes ── */
function sicoPlate(col){
  return `<rect x="1.6" y="1.6" width="60.8" height="60.8" rx="15" fill="#080d18"/>`
       + `<rect x="1.6" y="1.6" width="60.8" height="60.8" rx="15" fill="${col}" fill-opacity=".07"/>`
       + `<rect x="6" y="6" width="52" height="52" rx="11.5" fill="none" stroke="${col}" stroke-width="1" stroke-opacity=".1"/>`
       + `<rect x="2.5" y="2.5" width="59" height="59" rx="14" fill="none" stroke="${col}" stroke-width="1.6" stroke-opacity=".42"/>`;
}
/* five slots, `tier` of them lit and tall — countable rather than
   colour-coded, so tier survives a colour-blind read and greyscale */
function sicoTier(tier){
  let out = '';
  for(let i = 0; i < 5; i++){
    const x = sicoR(8 + i * 5.4);
    out += i < tier
      ? `<rect x="${x}" y="51.4" width="3.4" height="7.6" rx="1.7" fill="${TIER_COL[tier]}"/>`
      : `<rect x="${x}" y="53.6" width="3.4" height="3.4" rx="1.7" fill="#ffffff" fill-opacity=".15"/>`;
  }
  return out;
}
/* Tier at thumbnail size. A five-slot notch row is mud at 16px, so the
   plate's own rim becomes the meter instead: `tier` fifths of a 212-unit
   perimeter, lit clockwise from the top-left. Same quantity as the
   notches, at the only density this size can carry — and it is the swept
   length, not the hue, that says the number. */
const SICO_RIM = 211.96;                  // perimeter of the 59×59 r14 plate rim
function sicoRim(tier){
  return `<rect x="2.5" y="2.5" width="59" height="59" rx="14" fill="none"`
       + ` stroke="${TIER_COL[tier]}" stroke-width="2.4" stroke-linecap="round"`
       + ` stroke-dasharray="${(SICO_RIM * tier / 5).toFixed(1)} ${SICO_RIM}"`
       + ` stroke-opacity=".92"/>`;
}
/* ── the fused plate ──
   A fusion has no tier worth showing. Internally every one is tier 5, so
   the five-notch row would read "Legendary" for all 198 of them and say
   nothing at all. Its number is its GRADE, 1–9, and nine notches is mud at
   any size this plate reaches.

   So the rim does the counting instead — grade ninths of an inset rim,
   the same swept-length idea sicoRim already uses for tier — and a second
   outer rim plus a ✦ mark say "fused". Three marks, none of them relying
   on colour, and the grade also lands as a numeral at card size and up
   because a swept arc is a quantity you compare, not one you read. */
const SICO_RIM_IN = 195.40;               // perimeter of the 54×54 r12 inner rim
function sicoFused(col, grade, detail){
  const g = Math.max(1, Math.min(FUSE_GRADES, grade || 1));
  let out = `<rect x="2.5" y="2.5" width="59" height="59" rx="14" fill="none"`
          + ` stroke="${col}" stroke-width="1.5" stroke-opacity=".6"/>`
          + `<rect x="5" y="5" width="54" height="54" rx="12" fill="none"`
          + ` stroke="${col}" stroke-width="2.2" stroke-linecap="round"`
          + ` stroke-dasharray="${(SICO_RIM_IN * g / FUSE_GRADES).toFixed(1)} ${SICO_RIM_IN}"`
          + ` stroke-opacity=".95"/>`
          /* ✦ top-right, diagonally opposite the rider badge so they never
             collide and the pair frames the silhouette */
          + `<path d="M50 7.4L51.7 12.1L56.4 13.8L51.7 15.5L50 20.2`
          + `L48.3 15.5L43.6 13.8L48.3 12.1Z" fill="${col}" fill-opacity=".9"/>`;
  if(detail !== 'micro')
    out += `<circle cx="13.5" cy="50" r="9.6" fill="#070b14"/>`
         + `<circle cx="13.5" cy="50" r="9.6" fill="${col}" fill-opacity=".16"/>`
         + `<circle cx="13.5" cy="50" r="9.6" fill="none" stroke="${col}" stroke-width="1.3" stroke-opacity=".78"/>`
         + `<text x="13.5" y="50" text-anchor="middle" dominant-baseline="central"`
         + ` font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" font-weight="800"`
         + ` fill="${col}">${g}</text>`;
  return out;
}
function sicoBadge(fx){
  const f = SICO_FX[fx];
  if(!f) return '';
  const c = sicoFxCol(fx, f);
  return `<circle cx="49.5" cy="49.5" r="11" fill="#070b14"/>`
       + `<circle cx="49.5" cy="49.5" r="11" fill="${c}" fill-opacity=".14"/>`
       + `<circle cx="49.5" cy="49.5" r="11" fill="none" stroke="${c}" stroke-width="1.5" stroke-opacity=".8"/>`
       + `<g transform="translate(49.5 49.5)" fill="none" stroke-linecap="round" stroke-linejoin="round">${f.g(c)}</g>`;
}
function sicoRunes(id){
  return (TAGS[id] || []).slice(0, 2).map((fam, i) => {
    const g = SICO_RUNE[fam], c = (FAMILY[fam] || {}).col || '#9fb0d8';
    const cx = sicoR(13.4 + i * 15.4), cy = 13.4;
    return `<circle cx="${cx}" cy="${cy}" r="7" fill="#070b14"/>`
         + `<circle cx="${cx}" cy="${cy}" r="7" fill="${c}" fill-opacity=".13"/>`
         + `<circle cx="${cx}" cy="${cy}" r="7" fill="none" stroke="${c}" stroke-width="1.2" stroke-opacity=".6"/>`
         + (g ? `<g transform="translate(${cx} ${cy})" fill="none" stroke-linecap="round" stroke-linejoin="round">${g(c)}</g>` : '');
  }).join('');
}

/* ── the public renderer ──
   skillIcon(skill|id, {size, detail, cls, label})

   Memoised on everything that can change the output: renderDraft()
   redraws the whole shop and bench on every buy, sell and reroll, and
   the codex writes sixty of these in one innerHTML, so the second call
   for a given skill is a string lookup. */
const SICO_CACHE = {};
const SICO_KIND_WORD = {
  proj:'projectile', multiproj:'volley', beam:'beam', nova:'nova', cone:'cone',
  rain:'rain', dash:'dash', orbit:'orbit', field:'field', self:'self-buff', summon:'summon',
};
function skillIcon(skill, opts){
  const sk = typeof skill === 'string' ? BY_ID[skill] : skill;
  if(!sk) return '';
  const o = opts || {};
  const size = o.size || 34;
  const detail = o.detail || (size <= 26 ? 'micro' : size <= 52 ? 'card' : 'full');
  const lab = o.label === true ? skillIconLabel(sk) : (typeof o.label === 'string' ? o.label : '');
  const key = `${sk.id}|${size}|${detail}|${o.cls || ''}|${lab}`;
  if(SICO_CACHE[key]) return SICO_CACHE[key];

  const col = sk.col;
  const cc = isCC(sk.fx) && typeof CC_VIS !== 'undefined' ? CC_VIS[sk.fx] : null;
  const shape = `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${sicoKind(sk, col)}</g>`;
  let body = sicoPlate(col)
    /* a held enemy is drawn smaller, inside the clamps */
    + (cc ? `<g transform="translate(32 32) scale(.76) translate(-32 -32)">${shape}</g>` + sicoCage(cc.col)
          : shape);
  if(sk.fused)                body += sicoFused(col, sk.grade, detail) + sicoBadge(sk.fx);
  else if(detail === 'micro') body += sicoRim(sk.tier) + sicoBadge(sk.fx);
  else                        body += sicoTier(sk.tier) + sicoBadge(sk.fx);
  if(detail === 'full')  body += sicoRunes(sk.id);

  /* Decorative by default: everywhere the game draws an icon it also
     writes the same facts as text beside it, and hearing them twice is
     worse than not hearing the picture at all. Pass label:true where
     the icon stands alone. */
  const a11y = lab ? ` role="img" aria-label="${sicoEsc(lab)}"` : ` aria-hidden="true" focusable="false"`;
  return SICO_CACHE[key] = `<svg class="sicon${o.cls ? ' ' + o.cls : ''}" width="${size}" height="${size}"`
    + ` viewBox="0 0 64 64"${a11y}>${lab ? `<title>${sicoEsc(lab)}</title>` : ''}${body}</svg>`;
}

/* Everything the drawing says, in words — the text half of "no
   information conveyed by colour alone". */
/* What a plate's rank is called. A fusion's tier is a fixed 5 that means
   nothing, so it names its grade instead — the number its rim is sweeping. */
const skillTierWord = sk => sk.fused ? `Fused grade ${sk.grade}` : TIER_NAME[sk.tier];
function skillIconLabel(sk){
  const bits = [`${skillTierWord(sk)} ${SICO_KIND_WORD[sk.kind] || sk.kind}`];
  if(sk.fx && SICO_FX[sk.fx]) bits.push(SICO_FX[sk.fx].name);
  const fams = (TAGS[sk.id] || []).map(f => (FAMILY[f] || {}).name).filter(Boolean);
  if(fams.length) bits.push(fams.join(' and '));
  return `${sk.name} — ${bits.join(', ')}`;
}
/* The card meta line: tier, then ONE more word.
   Which word is a deliberate trade. The tag line is 103px wide on a shop
   card, which is two words at this size, and the icon already shouts the
   `kind` — it is the whole silhouette. The rider is the smallest mark on
   the plate, so the rider is what gets spelled out; seeing "Shred" beside
   the cracked-plate badge is how a player learns the badge at all. Skills
   with no rider fall back to naming their kind. */
const skillFxName  = sk => sk.fx && SICO_FX[sk.fx] ? SICO_FX[sk.fx].name : '';
const skillTagWord = sk => skillFxName(sk) || sk.kind;

/* Two words, two spans — because the room for them is not the same on
   every screen. A phone shop column is 151px, and "Legendary · Undying"
   wants 121px of it; something has to go, and the tier is the one the
   plate can still say on its own (five notches, a count, not a hue).
   So the tight grids drop `.ttier`/`.tsep` in CSS and keep the rider,
   which is the mark the picture draws smallest. Desktop keeps both.
   A fusion sets "✦4" there instead of a tier name: it is three characters
   wide, so it survives the tight grids that drop the word entirely. */
const skillTagText = (sk, extra) =>
    `<span class="ttier${sk.fused?' tfz':''}">${sk.fused?'✦'+sk.grade:TIER_NAME[sk.tier]}</span>`
  /* nbsp, not plain spaces: the tag is a flex row so the separator is a
     flex item, and a flex item's leading and trailing spaces collapse
     away — "COMMON · NOVA" would set as "COMMON·NOVA". */
  + `<span class="tsep">&nbsp;·&nbsp;</span>`
  + `<span class="tw">${extra || skillTagWord(sk)}</span>`;

/* The icon + meta + name header, shared by every full-size skill card:
   shop, opponent reveal and PvE reward all show the same object, so
   they draw it with the same function.

   32px, not 34: the two text lines it replaces measure 32.3px together,
   so at 32 the head row is exactly as tall as the stack it replaced and
   no card in the shop grid grows by even a pixel. */
function skillCardHead(sk, o){
  o = o || {};
  return `<div class="chead">${skillIcon(sk, {size:o.size || 32})}`
       + `<div class="cmeta">`
       + `<div class="tag" style="color:${sk.col}">${o.tag != null ? o.tag : skillTagText(sk)}</div>`
       + `<div class="nm" title="${sicoEsc(sk.name)}">`
       /* the name truncates, anything appended to it (a level arrow) does
          not — the chip is the part you cannot infer from the picture */
       +   `<span class="nmt">${sk.name}</span>${o.nameExtra || ''}</div>`
       + `</div></div>`;
}
