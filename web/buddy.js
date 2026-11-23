// The Jarvis companion: a little animated creature in a floating circle.
// Faces and animals are ported from the Daymark companion (robot, cat, puppy, bunny, panda, pig).
//
//   const b = createBuddy(el, { kind, onTap, onDoubleTap, onDrag });
//   b.setState('idle' | 'wake' | 'listening' | 'thinking' | 'speaking' | 'error')
//   b.react('happy' | 'pet' | 'sneeze' | ...);   b.say('text', ms);   b.setKind('cat');

export const KINDS = { robot: 'Robot (Jarvis)', cat: 'Cat', puppy: 'Puppy', bunny: 'Bunny', panda: 'Panda', pig: 'Pig' };

const FACES = {
  okay: { eyes: 'open', mouth: 'small' },
  happy: { eyes: 'open', mouth: 'smile', cheeks: true },
  sad: { eyes: 'droop', mouth: 'frown', tear: true },
  wow: { eyes: 'wide', mouth: 'o' },
  listen: { eyes: 'wide', mouth: 'small' },
  think: { eyes: 'open', mouth: 'wavy', look: [1.8, -1.9] },
  joy: { eyes: 'happy', mouth: 'grin', cheeks: true },
  talkA: { eyes: 'open', mouth: 'open', cheeks: true },
  talkB: { eyes: 'open', mouth: 'smile', cheeks: true },
  giggle: { eyes: 'happy', mouth: 'open', cheeks: true },
  dizzy: { eyes: 'dizzy', mouth: 'wavy' },
  wheee: { eyes: 'wide', mouth: 'open', cheeks: true },
  pet: { eyes: 'happy', mouth: 'smile', cheeks: true },
  laugh: { eyes: 'squeeze', mouth: 'laugh', cheeks: true },
  achoo: { eyes: 'droop', mouth: 'o', look: [0, -1.2] },
  sneeze: { eyes: 'squeeze', mouth: 'open' },
  yawn: { eyes: 'closed', mouth: 'yawn' },
  sleep: { eyes: 'closed', mouth: 'small', zzz: true },
  startled: { eyes: 'wide', mouth: 'o', brow: true },
  love: { eyes: 'heart', mouth: 'grin', cheeks: true },
  wink: { eyes: 'wink', mouth: 'tongue', cheeks: true },
  blep: { eyes: 'open', mouth: 'blep' },
  sideeye: { eyes: 'open', mouth: 'smirk', look: [2.2, 0] },
  huh: { eyes: 'open', mouth: 'smirk', brow: true },
};

const REACTIONS = {
  hello: { face: 'giggle', anim: 'wiggle', ms: 1600, sound: 'poke' },
  happy: { face: 'joy', anim: 'hop', burst: 'spark', ms: 1500 },
  sad: { face: 'sad', anim: 'tilt', ms: 2200, sound: 'sad' },
  poke: { face: 'giggle', anim: 'wiggle', ms: 1200, sound: 'poke' },
  pet: { face: 'pet', anim: 'purr', burst: 'heart', ms: 2300, sound: 'pet', say: ['Ahh, so nice…', 'More pets please!', 'Purrrr…'] },
  tickle: { face: 'laugh', anim: 'shake', ms: 2000, say: ['Hahaha, stop!', 'That tickles!!'] },
  achoo: { face: 'achoo', anim: 'windup', ms: 650, say: ['Ah… ah…'] },
  sneeze: { face: 'sneeze', anim: 'sneeze', burst: 'drop', ms: 1500, sound: 'poke', say: ['ACHOO!', 'Bless me!'] },
  dizzy: { face: 'dizzy', anim: 'spin', ms: 2200, say: ['Whoa, dizzy…', 'Too many boops!'] },
  boing: { face: 'giggle', anim: 'hop', ms: 1200, sound: 'poke' },
  fling: { face: 'wheee', anim: 'flip', burst: 'spark', ms: 1300, say: ['Wheeee!'] },
  yawn: { face: 'yawn', anim: 'stretch', ms: 1700 },
  wake: { face: 'startled', anim: 'jump', ms: 900, say: ["I'm awake!", 'Huh?!'] },
  love: { face: 'love', anim: 'hop', burst: 'heart', ms: 1800, sound: 'pet' },
  wink: { face: 'wink', anim: 'idle', ms: 1100 },
  blep: { face: 'blep', anim: 'idle', ms: 1400 },
  sideeye: { face: 'sideeye', anim: 'idle', ms: 1300 },
};

const STATE_LOOK = {
  idle: { face: 'okay', anim: 'idle' },
  wake: { face: 'happy', anim: 'idle' },
  listening: { face: 'listen', anim: 'idle' },
  thinking: { face: 'think', anim: 'tilt-loop' },
  speaking: { face: 'talkA', anim: 'idle' },
  error: { face: 'sad', anim: 'idle' },
};

// Recorded animal voices from Daymark (see sounds/CREDITS.md). Robot uses synthesized beeps.
const CLIPS = {
  cat: { poke: ['meow-short', 'meow'], pet: ['purr'], sad: ['meow-sad'], listen: ['meow-ask'] },
  puppy: { poke: ['bark', 'yip'], pet: ['yip'], sad: ['whine'], listen: ['bark-double'] },
  bunny: { poke: ['squeak'], pet: ['munch'], sad: ['squeak'], listen: ['squeak'] },
  panda: { poke: ['chirp', 'bleat'], pet: ['munch'], sad: ['bleat'], listen: ['chirp'] },
  pig: { poke: ['oink', 'oink-double'], pet: ['grunt'], sad: ['squeal'], listen: ['oink'] },
};

const SLEEP_AFTER_MS = 60 * 1000;
const QUIRKS = ['wink', 'blep', 'sideeye'];
const BITS = [[-26, -20], [-14, -32], [0, -38], [14, -32], [26, -20], [32, -4]];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

let audioCtx = null;
function beep(freqs, dur = 0.09) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.9;
    }
  } catch { }
}

export function createBuddy(root, opts = {}) {
  let kind = opts.kind || 'robot';
  let soundOn = opts.sound !== false;
  let state = 'idle';
  let reaction = null, reactTimer = 0;
  let asleep = false;
  let shut = false;
  let look = [0, 0];
  let talkFlip = false;
  let lastActive = Date.now();
  let sayTimer = 0;
  const pokes = [];

  root.classList.add('jb');
  root.innerHTML = `
    <div class="jb-say" hidden></div>
    <button class="jb-ball" type="button" aria-label="Jarvis. Tap to talk, double-tap to open, hold to pet.">
      <span class="jb-ring"></span>
      <span class="jb-body"></span>
      <span class="jb-burst"></span>
      <span class="jb-zzz" hidden><span>z</span><span>z</span><span>Z</span></span>
      <span class="jb-dots"><i></i><i></i><i></i></span>
    </button>`;
  const ball = root.querySelector('.jb-ball');
  const body = root.querySelector('.jb-body');
  const sayEl = root.querySelector('.jb-say');
  const burstEl = root.querySelector('.jb-burst');
  const zzz = root.querySelector('.jb-zzz');

  // ------------------------------------------------------------ render
  function currentLook() {
    if (reaction) return { face: reaction.face, anim: reaction.anim, burst: reaction.burst };
    if (asleep && (state === 'idle' || state === 'wake')) return { face: 'sleep', anim: 'sleep' };
    const s = STATE_LOOK[state] || STATE_LOOK.idle;
    if (state === 'speaking') return { face: talkFlip ? 'talkB' : 'talkA', anim: 'idle' };
    return s;
  }
  let lastAnim = '';
  function render() {
    const l = currentLook();
    const face = FACES[l.face] || FACES.okay;
    body.innerHTML = faceSVG(kind, face, face.look || look, shut);
    const anim = l.anim || 'idle';
    if (anim !== lastAnim || (reaction && reaction.fresh)) {
      body.className = 'jb-body';
      void body.offsetWidth; // restart CSS animation
      body.classList.add(anim);
      lastAnim = anim;
      if (reaction) reaction.fresh = false;
    }
    zzz.hidden = !face.zzz;
    root.dataset.state = state;
    root.dataset.kind = kind;
  }

  function burst(type) {
    burstEl.innerHTML = BITS.map(([dx, dy], i) => `<span class="bit ${type}" style="--dx:${dx}px;--dy:${dy}px;animation-delay:${i * 35}ms"><svg viewBox="0 0 12 12">${type === 'heart' ? '<path d="M6 10.6 1.7 6.3a2.6 2.6 0 0 1 4.3-3.5 2.6 2.6 0 0 1 4.3 3.5z"/>' : type === 'drop' ? '<circle cx="6" cy="6" r="3.2"/>' : '<path d="M6 0l1.3 4.7L12 6l-4.7 1.3L6 12 4.7 7.3 0 6l4.7-1.3z"/>'}</svg></span>`).join('');
    setTimeout(() => { burstEl.innerHTML = ''; }, 1200);
  }

  function play(what) {
    if (!soundOn) return;
    const clips = CLIPS[kind]?.[what];
    if (clips) {
      try { const a = new Audio(`sounds/${kind}/${pick(clips)}.mp3`); a.volume = 0.7; a.play().catch(() => { }); } catch { }
    } else {
      beep({ poke: [880, 1320], pet: [660, 880, 1100], sad: [440, 330], listen: [990, 1480] }[what] || [880]);
    }
  }

  // ------------------------------------------------------------ public api
  function react(name, { say: text, ms } = {}) {
    const spec = REACTIONS[name];
    if (!spec) return;
    clearTimeout(reactTimer);
    lastActive = Date.now();
    if (asleep && name !== 'yawn') asleep = false;
    reaction = { ...spec, fresh: true };
    if (spec.burst) burst(spec.burst);
    if (spec.sound) play(spec.sound);
    const line = text || (spec.say && pick(spec.say));
    if (line && (state === 'idle' || state === 'wake')) say(line, spec.ms || 1500);
    render();
    reactTimer = setTimeout(() => { reaction = null; render(); }, ms || spec.ms || 1500);
  }

  function say(text, ms) {
    clearTimeout(sayTimer);
    if (!text) { sayEl.hidden = true; opts.onCaption?.(false); return; }
    sayEl.textContent = text;
    sayEl.hidden = false;
    opts.onCaption?.(true);
    const dur = ms ?? Math.min(12000, 1800 + text.length * 55);
    if (dur > 0) sayTimer = setTimeout(() => { sayEl.hidden = true; opts.onCaption?.(false); }, dur);
  }

  function setState(s) {
    if (s === state) return;
    const prev = state;
    state = s;
    lastActive = Date.now();
    if (s !== 'idle' && s !== 'wake') asleep = false;
    if (s === 'listening' && prev !== 'listening') play('listen');
    render();
  }

  // ------------------------------------------------------------ life: blink, talk, nap, quirks
  setInterval(() => {
    if (state !== 'speaking') return;
    talkFlip = !talkFlip; render();
  }, 160);

  (function blink() {
    setTimeout(() => {
      shut = true; render();
      setTimeout(() => { shut = false; render(); blink(); }, 130);
    }, 2400 + Math.random() * 3600);
  })();

  setInterval(() => {
    if (document.hidden || reaction || asleep || (state !== 'idle' && state !== 'wake')) return;
    const idle = Date.now() - lastActive;
    if (idle > SLEEP_AFTER_MS) {
      react('yawn');
      setTimeout(() => { if (!reaction || reaction.face === 'yawn') { asleep = true; reaction = null; render(); } }, 1700);
      return;
    }
    if (idle > 8000 && Math.random() < 0.2) react(pick(QUIRKS));
  }, 5000);

  // Eyes follow your finger / cursor (web mode).
  window.addEventListener('pointermove', (e) => {
    const box = ball.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2), dy = e.clientY - (box.top + box.height / 2);
    const len = Math.hypot(dx, dy) || 1, reach = Math.min(1, len / 160);
    look = [(dx / len) * 2.2 * reach, (dy / len) * 1.8 * reach];
    if (!reaction && state !== 'thinking') render();
  }, { passive: true });

  // ------------------------------------------------------------ touch
  // tap: talk · double-tap: open · hold: pet · tap nose: sneeze · 5 quick taps: dizzy
  // drag (web mode): move it around, rub back & forth: tickle, fling: wheee
  let press = null, tapTimer = 0, lastTapAt = 0;

  ball.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    lastActive = Date.now();
    const p = { x: e.clientX, y: e.clientY, moved: false, petting: false, turns: 0, dir: 0, lastX: e.clientX, trail: [] };
    p.hold = setTimeout(() => {
      if (press !== p || p.moved) return;
      p.petting = true;
      react('pet');
      opts.onHold?.();
    }, 550);
    press = p;
    try { ball.setPointerCapture(e.pointerId); } catch { }
  });

  ball.addEventListener('pointermove', (e) => {
    const p = press;
    if (!p || !opts.onDrag) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 8) return;
    const now = performance.now();
    p.trail = [...p.trail.filter(([t]) => now - t < 90), [now, e.clientX, e.clientY]];
    const step = e.clientX - p.lastX;
    if (Math.abs(step) > 5) {
      const dir = Math.sign(step);
      if (p.dir && dir !== p.dir) p.turns++;
      p.dir = dir; p.lastX = e.clientX;
      if (p.turns >= 5 && !p.tickled) { p.tickled = true; reaction = { ...REACTIONS.tickle, fresh: true }; render(); }
    }
    if (!p.moved) {
      p.moved = true;
      clearTimeout(p.hold);
      if (!p.tickled) { reaction = { face: 'wheee', anim: 'held', fresh: true }; render(); }
    }
    opts.onDrag('move', dx, dy);
  });

  const end = (e) => {
    const p = press;
    press = null;
    if (!p) return;
    clearTimeout(p.hold);
    if (p.moved) {
      const first = p.trail[0], last = p.trail[p.trail.length - 1];
      const speed = first && last && last[0] > first[0] ? Math.hypot(last[1] - first[1], last[2] - first[2]) / (last[0] - first[0]) : 0;
      reaction = null;
      opts.onDrag?.('end', e.clientX - p.x, e.clientY - p.y);
      react(p.tickled ? 'tickle' : speed > 1.1 ? 'fling' : 'boing');
      return;
    }
    if (p.petting || e.type === 'pointercancel') return;
    handleTap(e);
  };
  ball.addEventListener('pointerup', end);
  ball.addEventListener('pointercancel', end);
  ball.addEventListener('contextmenu', (e) => e.preventDefault());

  function handleTap(e) {
    const box = ball.getBoundingClientRect();
    // map tap into the 64x64 face, which is drawn inset inside the ball
    const fx = ((e.clientX - box.left) / box.width) * 80 - 8, fy = ((e.clientY - box.top) / box.height) * 80 - 8;
    const now = Date.now();
    while (pokes.length && now - pokes[0] > 2500) pokes.shift();
    pokes.push(now);
    if (pokes.length >= 5) { pokes.length = 0; clearTimeout(tapTimer); opts.onCancel?.(); react('dizzy'); return; }

    if (asleep) { asleep = false; react('wake'); }

    const noseY = kind === 'pig' ? 39 : 36.5;
    if (state !== 'listening' && Math.abs(fx - 32) < 5.5 && Math.abs(fy - noseY) < 4.5) {
      clearTimeout(tapTimer);
      react('achoo');
      setTimeout(() => react('sneeze'), REACTIONS.achoo.ms);
      return;
    }
    if (now - lastTapAt < 280) { // double tap
      clearTimeout(tapTimer); lastTapAt = 0;
      opts.onDoubleTap?.();
      return;
    }
    lastTapAt = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => opts.onTap?.(), opts.onDoubleTap ? 260 : 0);
  }

  render();
  return {
    react, say, setState,
    get state() { return state; },
    setKind(k) { kind = KINDS[k] ? k : 'robot'; render(); },
    setSound(on) { soundOn = on; },
    wake() { asleep = false; lastActive = Date.now(); render(); },
    play,
    element: root,
    ball,
  };
}

// ---------------------------------------------------------------- SVG faces (from Daymark)

function faceSVG(kind, face, look, shut) {
  const [lx, ly] = look;
  const blinks = face.eyes === 'open' || face.eyes === 'wide' || face.eyes === 'droop';
  const cheeks = face.cheeks
    ? '<ellipse cx="19" cy="40.5" rx="3.4" ry="2.1" class="f-cheek"/><ellipse cx="45" cy="40.5" rx="3.4" ry="2.1" class="f-cheek"/>' : '';
  const mouth = kind === 'pig' ? `<g transform="translate(0 7)">${mouthSVG(face.mouth)}</g>` : mouthSVG(face.mouth);
  return `<svg viewBox="0 0 64 64" class="buddy-svg k-${kind}" aria-hidden="true">
    ${headSVG(kind)}${cheeks}
    <g transform="translate(${lx.toFixed(2)} ${ly.toFixed(2)})">
      <g class="f-blink${blinks && shut ? ' is-shut' : ''}">${eyeSVG(face.eyes, 24, 'left')}${eyeSVG(face.eyes, 40, 'right')}</g>
    </g>
    ${face.brow ? '<path d="M36.5 23.2 L43.5 21.8" class="e-line thin"/>' : ''}
    ${noseSVG(kind)}${mouth}
    ${face.tear ? '<path d="M19.6 35.2c1.1 1.6 1.7 2.5 1.7 3.3a1.7 1.7 0 0 1-3.4 0c0-.8.6-1.7 1.7-3.3z" class="f-drop f-tear"/>' : ''}
  </svg>`;
}

function headSVG(kind) {
  switch (kind) {
    case 'cat': return `
      <path d="M11.5 23 L14 4.5 L27.5 14.5 Z" class="b-fur"/><path d="M15.4 17.5 L16.7 8.8 L23.6 14 Z" class="b-inner"/>
      <path d="M52.5 23 L50 4.5 L36.5 14.5 Z" class="b-fur"/><path d="M48.6 17.5 L47.3 8.8 L40.4 14 Z" class="b-inner"/>
      <ellipse cx="32" cy="34" rx="25" ry="21" class="b-fur"/><ellipse cx="32" cy="41.5" rx="11" ry="7.5" class="b-muzzle"/>
      <path d="M7.5 36.5 L18 38 M8 42 L18 40.8 M56.5 36.5 L46 38 M56 42 L46 40.8" class="b-whisker"/>`;
    case 'puppy': return `
      <ellipse cx="32" cy="33.5" rx="23.5" ry="21" class="b-fur"/><ellipse cx="41" cy="27.5" rx="7.5" ry="6.5" class="b-spot"/>
      <path d="M13 15 C4.5 16.5 2 33 7.5 40.5 C10.2 44 14.6 40.6 15 35.5 Z" class="b-ear"/>
      <path d="M51 15 C59.5 16.5 62 33 56.5 40.5 C53.8 44 49.4 40.6 49 35.5 Z" class="b-ear"/>
      <ellipse cx="32" cy="41.5" rx="11" ry="8" class="b-muzzle"/>`;
    case 'bunny': return `
      <ellipse cx="23.5" cy="12.5" rx="5.6" ry="12" transform="rotate(-8 23.5 12.5)" class="b-fur"/>
      <ellipse cx="23.5" cy="13" rx="2.6" ry="8.4" transform="rotate(-8 23.5 13)" class="b-inner"/>
      <ellipse cx="40.5" cy="12.5" rx="5.6" ry="12" transform="rotate(8 40.5 12.5)" class="b-fur"/>
      <ellipse cx="40.5" cy="13" rx="2.6" ry="8.4" transform="rotate(8 40.5 13)" class="b-inner"/>
      <ellipse cx="32" cy="36" rx="23" ry="19" class="b-fur"/>`;
    case 'pig': return `
      <path d="M12.5 23 L11.5 7 L26 13.5 Z" class="b-fur"/><path d="M15.2 18.6 L14.8 10.8 L22 14.2 Z" class="b-inner"/>
      <path d="M51.5 23 L52.5 7 L38 13.5 Z" class="b-fur"/><path d="M48.8 18.6 L49.2 10.8 L42 14.2 Z" class="b-inner"/>
      <ellipse cx="32" cy="34" rx="25" ry="21" class="b-fur"/>`;
    case 'panda': return `
      <circle cx="14" cy="16.5" r="7.5" class="b-patch"/><circle cx="50" cy="16.5" r="7.5" class="b-patch"/>
      <ellipse cx="32" cy="34" rx="25" ry="21" class="b-fur"/>
      <ellipse cx="23" cy="31.5" rx="6.8" ry="5.6" transform="rotate(-25 23 31.5)" class="b-patch"/>
      <ellipse cx="41" cy="31.5" rx="6.8" ry="5.6" transform="rotate(25 41 31.5)" class="b-patch"/>`;
    default: return `
      <line x1="32" y1="13" x2="32" y2="6.5" class="r-stalk"/><circle cx="32" cy="5" r="3.2" class="r-bulb"/>
      <rect x="3" y="27" width="6" height="12" rx="3" class="r-ear"/><rect x="55" y="27" width="6" height="12" rx="3" class="r-ear"/>
      <rect x="7.5" y="12.5" width="49" height="41" rx="14" class="r-head"/>
      <path d="M13.5 19 q3.5 -3 9 -3.4" class="r-shine"/>
      <rect x="13" y="19.5" width="38" height="28" rx="10" class="r-screen"/>`;
  }
}

function noseSVG(kind) {
  if (kind === 'cat' || kind === 'bunny') return '<path d="M30.3 35.4 h3.4 l-1.7 2 z" class="b-nose"/>';
  if (kind === 'puppy') return '<ellipse cx="32" cy="36.4" rx="2.6" ry="1.8" class="b-nose"/>';
  if (kind === 'panda') return '<ellipse cx="32" cy="36.6" rx="2.3" ry="1.5" class="b-nose"/>';
  if (kind === 'pig') return '<ellipse cx="32" cy="39" rx="8.5" ry="5.8" class="b-snout"/><ellipse cx="29" cy="39" rx="1.4" ry="2.1" class="b-nose"/><ellipse cx="35" cy="39" rx="1.4" ry="2.1" class="b-nose"/>';
  return '';
}

function eyeSVG(kind, cx, side) {
  const cy = 31;
  if (kind === 'wink') return eyeSVG(side === 'left' ? 'happy' : 'open', cx, side);
  if (kind === 'heart') return `<path d="M${cx} ${cy + 4} l-4.2 -4.1 a2.5 2.5 0 0 1 4.2 -3.3 a2.5 2.5 0 0 1 4.2 3.3 z" class="e-heart"/>`;
  if (kind === 'squeeze') {
    const d = side === 'left' ? 1 : -1;
    return `<path d="M${cx - 3.4 * d} ${cy - 3.2} L${cx + 3 * d} ${cy} L${cx - 3.4 * d} ${cy + 3.2}" class="e-line"/>`;
  }
  if (kind === 'happy') return `<path d="M${cx - 4.2} ${cy + 1.6} Q${cx} ${cy - 4} ${cx + 4.2} ${cy + 1.6}" class="e-line"/>`;
  if (kind === 'closed') return `<path d="M${cx - 4} ${cy} Q${cx} ${cy + 2.6} ${cx + 4} ${cy}" class="e-line"/>`;
  if (kind === 'dizzy') return `<g><circle cx="${cx}" cy="${cy}" r="4" class="e-ring"/><circle cx="${cx + 0.5}" cy="${cy - 0.4}" r="1.5" class="e-ring"/></g>`;
  const r = kind === 'wide' ? 5 : 4.2;
  let lid = '';
  if (kind === 'droop') {
    lid = side === 'left'
      ? `M${cx - 6} ${cy - 6} H${cx + 6} V${cy - 3.4} L${cx - 6} ${cy + 0.4} Z`
      : `M${cx - 6} ${cy - 6} H${cx + 6} V${cy + 0.4} L${cx - 6} ${cy - 3.4} Z`;
  }
  return `<g><circle cx="${cx}" cy="${cy}" r="${r}" class="e-fill"/><circle cx="${cx - 1.4}" cy="${cy - 1.5}" r="${kind === 'wide' ? 1.5 : 1.2}" class="e-glint"/>${lid ? `<path d="${lid}" class="e-lid"/>` : ''}</g>`;
}

function mouthSVG(kind) {
  switch (kind) {
    case 'grin': return '<path d="M24.5 38.5 Q32 48 39.5 38.5 Z" class="m-fill"/>';
    case 'smile': return '<path d="M25 39.5 Q32 45 39 39.5" class="m-line"/>';
    case 'small': return '<path d="M27.5 40.5 Q32 43.2 36.5 40.5" class="m-line"/>';
    case 'frown': return '<path d="M26 44 Q32 38.5 38 44" class="m-line"/>';
    case 'o': return '<ellipse cx="32" cy="41.5" rx="2.8" ry="3.3" class="m-ring"/>';
    case 'open': return '<ellipse cx="32" cy="41" rx="4.6" ry="3.7" class="m-fill"/>';
    case 'wavy': return '<path d="M25.5 41.5 q1.6 -2 3.25 0 t3.25 0 t3.25 0 t3.25 0" class="m-line"/>';
    case 'smirk': return '<path d="M27 42.5 Q33 42 38 39" class="m-line"/>';
    case 'laugh': return '<path d="M23.5 38.2 Q32 50 40.5 38.2 Z" class="m-fill"/><path d="M28.2 44.6 Q32 41.8 35.8 44.6 Q32 47.6 28.2 44.6 Z" class="m-tongue"/>';
    case 'yawn': return '<ellipse cx="32" cy="42" rx="3.8" ry="5.4" class="m-fill"/>';
    case 'tongue': return '<path d="M33.6 41.6 q0.4 5 3 4.6 q2.6 -0.4 1.8 -5.4 Z" class="m-tongue"/><path d="M25 39.5 Q32 45 39 39.5" class="m-line"/>';
    case 'blep': return '<path d="M30.2 41.4 q0 3.6 1.8 3.6 q1.8 0 1.8 -3.6 Z" class="m-tongue"/><path d="M27.5 41.5 h9" class="m-line"/>';
    default: return '<path d="M27 41.5 h10" class="m-line"/>';
  }
}
