// Springklip: forsinket live-billede, automatisk springgenkendelse, nummerskilte og klip pr. gymnast.
// Alt gemmes lokalt på enheden (localStorage til opsætning, IndexedDB til klip).
{
'use strict';
const $ = (id) => document.getElementById(id);
const now = () => performance.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Opsætning ----------
const KEY = 'springklip.v1';
const DEF = { delay: 30, views: 1, delays: [30, 33, 36, 39], flip: false, facing: 'environment', zone: { x0: 0.3, y0: 0.04, x1: 0.78, y1: 0.37 }, sens: 1.5, keepDays: 10, trainerHash: '', roster: [] };
let S;
try { S = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { S = { ...DEF }; }
if (!Array.isArray(S.delays) || S.delays.length < 4) S.delays = [S.delay ?? 30, 33, 36, 39];
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
if (!S.roster.length) {
  for (let n = 1; n <= 30; n++) S.roster.push({ n, name: '', code: '' });
}
S.roster.forEach((g) => { if (!g.code || g.code.length !== 6) g.code = newCode(); });
save();
function newCode() {
  const used = new Set((S?.roster || []).map((g) => g.code));
  let c;
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  do { const r = crypto.getRandomValues(new Uint32Array(6)); c = [...r].map((x) => A[x % A.length]).join(''); } while (used.has(c));
  return c;
}
const gName = (n) => {
  if (!n) return 'Ukendt';
  const g = S.roster.find((x) => x.n === n);
  return g && g.name ? `${n} · ${g.name}` : `Nr. ${n}`;
};
async function sha(s) {
  try {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('springklip:' + s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return 'p:' + s; }
}

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('springklip', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('clips', { keyPath: 'id' });
      s.createIndex('g', 'g');
      s.createIndex('at', 'at');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('clips', mode);
    const st = t.objectStore('clips');
    let out;
    Promise.resolve(fn(st)).then((v) => (out = v));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const putClip = (c) => tx('readwrite', (s) => s.put(c));
const delClip = (id) => tx('readwrite', (s) => s.delete(id));
const getClip = (id) => tx('readonly', (s) => reqP(s.get(id)));
async function listClips(filterG) {
  return tx('readonly', async (s) => {
    const all = await reqP(s.getAll());
    return all
      .filter((c) => filterG === undefined || c.g === filterG)
      .map(({ blob, frames, ...meta }) => meta)
      .sort((a, b) => b.at - a.at);
  });
}
async function pruneOld() {
  const lim = Date.now() - S.keepDays * 864e5;
  const old = (await listClips()).filter((c) => c.at < lim);
  for (const c of old) await delClip(c.id);
}

// ---------- Kamera og ringbuffer ----------
const cam = $('cam');
const CAP_W = 960, CAP_H = 540;
const capC = document.createElement('canvas'); capC.width = CAP_W; capC.height = CAP_H;
const capX = capC.getContext('2d');
const MOT_W = 192, MOT_H = 108;
const motC = document.createElement('canvas'); motC.width = MOT_W; motC.height = MOT_H;
const motX = motC.getContext('2d', { willReadFrequently: true });
const tagC = document.createElement('canvas');
const tagX = tagC.getContext('2d', { willReadFrequently: true });
let ring = []; // {t, blob}
let pending = 0, running = false, lastCap = 0, stream = null, wakeLock = null;
const bufferSec = () => Math.max(Math.max(...S.delays.slice(0, S.views)) + 25, 70);

async function startCamera(file) {
  $('camErr').textContent = '';
  try {
    if (file) {
      cam.srcObject = null;
      cam.src = URL.createObjectURL(file);
      cam.loop = false;
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: S.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
      cam.src = '';
      cam.srcObject = stream;
    }
    await cam.play();
  } catch (e) {
    $('camErr').textContent = file ? 'Videoen kunne ikke afspilles.' : 'Kameraet kunne ikke startes. Tjek at siden må bruge kameraet (Indstillinger → Safari → Kamera).';
    return;
  }
  ring = []; prevMot = null; resetSpringState();
  running = true;
  $('startBox').hidden = true;
  resetLags();
  setRec();
  setTimeout(() => { if (running && !cam.videoWidth) toast('Kameraet sender ingen billeder. Luk andre apps, der bruger kameraet, og genindlæs siden.'); }, 4000);
  keepAwake();
  capLoop();
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) keepAwake(); });
cam.addEventListener('ended', () => {
  running = false; setRec(); toast('Videoen er slut');
  if (active) { const st = active.start; active = null; if (lastAbove - st >= 0.25) newSpring(st, lastAbove); }
  springs.filter((s) => s.state === 'reading').forEach(finishSpring);
});

let capToken = 0;
function capLoop() {
  if (!running) return;
  const my = ++capToken;
  const step = () => {
    if (!running || my !== capToken) return;
    const t = now();
    if (t - lastCap >= 1 / 31 && cam.readyState >= 2) {
      lastCap = t;
      onFrame(t);
    }
    if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  step();
}
function onFrame(t) {
  // gem et komprimeret billede i ringbufferen
  if (pending < 3) {
    capX.drawImage(cam, 0, 0, CAP_W, CAP_H);
    pending++;
    capC.toBlob((b) => {
      pending--;
      if (b) ring.push({ t, blob: b });
      const cut = now() - bufferSec();
      let i = 0;
      while (i < ring.length && ring[i].t < cut && !(lockFrom !== null && ring[i].t >= lockFrom)) i++;
      if (i) ring.splice(0, i);
    }, 'image/jpeg', 0.72);
  }
  motion(t);
  maybeReadTags(t);
}

// ---------- Forsinket visning (1, 2 eller 4 billeder, hver med sin forsinkelse) ----------
const screen = $('screen');
const sx = screen.getContext('2d');
const LET = ['A', 'B', 'C', 'D'];
let lags = S.delays.slice(), paused = false, pausedAt = [0, 0, 0, 0], sel = 0, zoneEdit = null, zoneMode = false;
const vs = [0, 1, 2, 3].map(() => ({ bmp: null, idx: -1, dec: false }));
function resetLags() { lags = S.delays.slice(); paused = false; $('pause').textContent = 'Pause'; }
function viewT(i) { return paused ? pausedAt[i] : now() - lags[i]; }
function findFrame(t) {
  let lo = 0, hi = ring.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ring[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function fitRect(cw, ch, ox = 0, oy = 0) {
  const r = Math.min(cw / CAP_W, ch / CAP_H);
  const w = CAP_W * r, h = CAP_H * r;
  return { x: ox + (cw - w) / 2, y: oy + (ch - h) / 2, w, h };
}
function panes(cw, ch) {
  const n = S.views, g = 4 * (devicePixelRatio || 1);
  if (n === 1) return [{ x: 0, y: 0, w: cw, h: ch }];
  if (n === 2) {
    if (cw / ch > 1.2) return [{ x: 0, y: 0, w: cw / 2 - g / 2, h: ch }, { x: cw / 2 + g / 2, y: 0, w: cw / 2 - g / 2, h: ch }];
    return [{ x: 0, y: 0, w: cw, h: ch / 2 - g / 2 }, { x: 0, y: ch / 2 + g / 2, w: cw, h: ch / 2 - g / 2 }];
  }
  const w = cw / 2 - g / 2, h = ch / 2 - g / 2;
  return [{ x: 0, y: 0, w, h }, { x: cw / 2 + g / 2, y: 0, w, h }, { x: 0, y: ch / 2 + g / 2, w, h }, { x: cw / 2 + g / 2, y: ch / 2 + g / 2, w, h }];
}
function drawImg(img, R) {
  if (S.flip) { sx.save(); sx.translate(R.x + R.w, R.y); sx.scale(-1, 1); sx.drawImage(img, 0, 0, R.w, R.h); sx.restore(); }
  else sx.drawImage(img, R.x, R.y, R.w, R.h);
}
function label(x, y, text, sub, dpr, on) {
  sx.save();
  sx.font = `800 ${22 * dpr}px -apple-system,Arial,sans-serif`;
  const w1 = sx.measureText(text).width;
  sx.font = `500 ${13 * dpr}px -apple-system,Arial,sans-serif`;
  const w2 = sub ? sx.measureText(sub).width + 8 * dpr : 0;
  sx.fillStyle = on ? '#f29a1f' : '#000c';
  const bw = w1 + w2 + 20 * dpr, bh = 36 * dpr;
  sx.beginPath(); (sx.roundRect ? sx.roundRect(x, y, bw, bh, 8 * dpr) : sx.rect(x, y, bw, bh)); sx.fill();
  sx.fillStyle = on ? '#1d1203' : '#fff';
  sx.textBaseline = 'middle';
  sx.font = `800 ${22 * dpr}px -apple-system,Arial,sans-serif`; sx.fillText(text, x + 10 * dpr, y + bh / 2);
  if (sub) { sx.font = `500 ${13 * dpr}px -apple-system,Arial,sans-serif`; sx.fillStyle = on ? '#1d1203' : '#9aa7b4'; sx.fillText(sub, x + 18 * dpr + w1, y + bh / 2 + 1); }
  sx.restore();
}
function drawLoop() {
  requestAnimationFrame(drawLoop);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(screen.clientWidth * dpr), ch = Math.round(screen.clientHeight * dpr);
  if (!cw || !ch) return;
  if (screen.width !== cw || screen.height !== ch) { screen.width = cw; screen.height = ch; }
  if (!running && !vs[0].bmp) return;
  sx.fillStyle = '#000'; sx.fillRect(0, 0, cw, ch);
  if (zoneMode) {
    const R = fitRect(cw, ch);
    if (cam.readyState >= 2) sx.drawImage(cam, R.x, R.y, R.w, R.h);
    drawZone(R, true);
    label(12 * dpr, 12 * dpr, 'Live', 'luftfelt', dpr, false);
    return;
  }
  const P = panes(cw, ch), have = ring.length ? now() - ring[0].t : 0;
  P.forEach((p, i) => {
    const v = vs[i], t = viewT(i), idx = findFrame(t);
    if (idx >= 0 && idx !== v.idx && !v.dec) {
      v.dec = true;
      const f = ring[idx];
      createImageBitmap(f.blob).then((bmp) => { if (v.bmp && v.bmp.close) v.bmp.close(); v.bmp = bmp; v.idx = idx; v.dec = false; }).catch(() => { v.dec = false; });
    }
    const R = fitRect(p.w, p.h, p.x, p.y);
    const behind = Math.max(0, now() - t);
    const filling = !paused && (idx < 0 || have + 0.5 < behind);
    // mens forsinkelsen fyldes op, vises live-billedet, så man kan se at kameraet virker
    if (filling && cam.readyState >= 2) drawImg(cam, R);
    else if (v.bmp) drawImg(v.bmp, R);
    else { sx.fillStyle = '#9aa7b4'; sx.font = `${16 * dpr}px Arial`; sx.textAlign = 'center'; sx.fillText('Venter på kameraet …', p.x + p.w / 2, p.y + p.h / 2); sx.textAlign = 'start'; }
    const txt = (P.length > 1 ? LET[i] + '  ' : '') + (filling ? 'Live' : behind < 0.5 ? 'Live' : `${Math.round(behind)} s`);
    const sub = paused ? 'pause' : filling ? `forsinkelse om ${Math.max(1, Math.ceil(behind - have))} s` : (Math.abs(lags[i] - S.delays[i]) > 0.5 ? 'spolet' : '');
    label(R.x + 10 * dpr, R.y + 10 * dpr, txt, sub, dpr, P.length > 1 && i === sel);
    if (P.length > 1 && i === sel) { sx.strokeStyle = '#f29a1f'; sx.lineWidth = 3 * dpr; sx.strokeRect(R.x + 1.5 * dpr, R.y + 1.5 * dpr, R.w - 3 * dpr, R.h - 3 * dpr); }
  });
}
requestAnimationFrame(drawLoop);

function syncDelayUI() {
  $('delayIn').value = S.delays[sel];
  $('delayLbl').textContent = S.views > 1 ? `Forsinkelse ${LET[sel]}` : 'Forsinkelse';
  for (const b of $('layoutSeg').children) b.classList.toggle('on', +b.dataset.n === S.views);
}
function setDelay(v) {
  S.delays[sel] = Math.max(0, Math.min(120, Math.round(v)));
  lags[sel] = S.delays[sel];
  if (paused) pausedAt[sel] = now() - lags[sel];
  save(); syncDelayUI();
}
$('dMinus').onclick = () => setDelay(S.delays[sel] - 1);
$('dPlus').onclick = () => setDelay(S.delays[sel] + 1);
$('delayIn').onchange = (e) => setDelay(+e.target.value || 0);
$('layoutSeg').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.views = +b.dataset.n; if (sel >= S.views) sel = 0;
  save(); resetLags(); syncDelayUI();
};
syncDelayUI();
const oldest = () => (ring.length ? ring[0].t : now());
$('back5').onclick = () => {
  for (let i = 0; i < 4; i++) { if (paused) pausedAt[i] = Math.max(oldest(), pausedAt[i] - 5); else lags[i] = Math.min(now() - oldest(), lags[i] + 5); }
};
$('fwd5').onclick = () => {
  for (let i = 0; i < 4; i++) { if (paused) pausedAt[i] = Math.min(now(), pausedAt[i] + 5); else lags[i] = Math.max(0, lags[i] - 5); }
};
$('pause').onclick = () => {
  if (paused) { for (let i = 0; i < 4; i++) lags[i] = Math.max(0, now() - pausedAt[i]); paused = false; $('pause').textContent = 'Pause'; }
  else { for (let i = 0; i < 4; i++) pausedAt[i] = viewT(i); paused = true; $('pause').textContent = 'Afspil'; }
};
$('toDelay').onclick = () => resetLags();
$('flipBtn').onclick = () => { S.flip = !S.flip; save(); $('flipBtn').classList.toggle('on', S.flip); };
$('flipBtn').classList.toggle('on', S.flip);
$('camSwitch').onclick = async () => {
  S.facing = S.facing === 'environment' ? 'user' : 'environment'; save();
  if (!running || !stream) return;
  try {
    const ns = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: S.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
    stream.getTracks().forEach((t) => t.stop());
    stream = ns; cam.srcObject = ns; await cam.play(); prevMot = null; capLoop();
    toast(S.facing === 'user' ? 'Frontkamera' : 'Bagkamera');
  } catch { toast('Kunne ikke skifte kamera'); }
};
// vælg billede ved tryk, og skjul knapperne når der ikke bliver rørt ved skærmen
screen.addEventListener('pointerdown', (e) => {
  if (zoneMode || S.views === 1) return;
  const r = screen.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  const x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
  const i = panes(screen.width, screen.height).findIndex((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
  if (i >= 0) { sel = i; syncDelayUI(); }
});
let calmT = null;
function wake() {
  document.body.classList.remove('calm');
  clearTimeout(calmT);
  calmT = setTimeout(() => { if (running && view === 'live' && !zoneMode && $('player').hidden) document.body.classList.add('calm'); }, 8000);
}
document.addEventListener('pointerdown', wake, true);
wake();

// ---------- Luftfelt ----------
function drawZone(R, editing) {
  const z = zoneEdit || S.zone;
  const x = R.x + z.x0 * R.w, y = R.y + z.y0 * R.h, w = (z.x1 - z.x0) * R.w, h = (z.y1 - z.y0) * R.h;
  sx.save();
  sx.fillStyle = editing ? '#f29a1f33' : '#f29a1f18';
  sx.fillRect(x, y, w, h);
  sx.strokeStyle = '#f29a1f'; sx.lineWidth = 3 * Math.min(2, devicePixelRatio || 1);
  sx.strokeRect(x, y, w, h);
  sx.restore();
}
$('zoneBtn').onclick = () => {
  if (!running) { toast('Start kameraet først'); return; }
  zoneMode = true; zoneEdit = { ...S.zone }; $('zoneHelp').hidden = false;
};
$('zoneDone').onclick = () => {
  zoneMode = false; $('zoneHelp').hidden = true;
  if (zoneEdit) { S.zone = zoneEdit; save(); }
  zoneEdit = null; prevMot = null;
  toast('Luftfeltet er gemt');
};
let dragFrom = null;
screen.addEventListener('pointerdown', (e) => {
  if (!zoneMode) return;
  const p = toNorm(e); dragFrom = p; zoneEdit = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  screen.setPointerCapture(e.pointerId);
});
screen.addEventListener('pointermove', (e) => {
  if (!zoneMode || !dragFrom) return;
  const p = toNorm(e);
  zoneEdit = { x0: Math.min(dragFrom.x, p.x), y0: Math.min(dragFrom.y, p.y), x1: Math.max(dragFrom.x, p.x), y1: Math.max(dragFrom.y, p.y) };
});
screen.addEventListener('pointerup', () => {
  if (!zoneMode) return;
  dragFrom = null;
  if (zoneEdit && (zoneEdit.x1 - zoneEdit.x0 < 0.05 || zoneEdit.y1 - zoneEdit.y0 < 0.05)) zoneEdit = { ...S.zone };
});
function toNorm(e) {
  const r = screen.getBoundingClientRect();
  const R = fitRect(r.width, r.height);
  const cl = (v) => Math.max(0, Math.min(1, v));
  return { x: cl((e.clientX - r.left - R.x) / R.w), y: cl((e.clientY - r.top - R.y) / R.h) };
}

// ---------- Springgenkendelse ----------
let prevMot = null, motAbove = 0, active = null, lastAbove = 0;
let springs = []; // {id,start,end,votes,state}
let lockFrom = null; // ringbuffer må ikke slette billeder efter dette tidspunkt, før klip er lavet
let springNo = 0;
function resetSpringState() { active = null; springs = []; lockFrom = null; motAbove = 0; }
function motion(t) {
  motX.drawImage(cam, 0, 0, MOT_W, MOT_H);
  const d = motX.getImageData(0, 0, MOT_W, MOT_H).data;
  const g = new Uint8Array(MOT_W * MOT_H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  if (!prevMot) { prevMot = g; return; }
  const z = S.zone;
  const x0 = Math.floor(z.x0 * MOT_W), x1 = Math.ceil(z.x1 * MOT_W), y0 = Math.floor(z.y0 * MOT_H), y1 = Math.ceil(z.y1 * MOT_H);
  let ch = 0, n = 0, allCh = 0;
  for (let y = 0; y < MOT_H; y++) {
    for (let x = 0; x < MOT_W; x++) {
      const k = y * MOT_W + x;
      const diff = Math.abs(g[k] - prevMot[k]) > 26;
      if (diff) allCh++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) { n++; if (diff) ch++; }
    }
  }
  prevMot = g;
  const frac = n ? (ch / n) * 100 : 0;
  const global = (allCh / g.length) * 100;
  const th = S.sens;
  const m = $('meter');
  m.style.width = Math.min(100, (frac / (th * 3)) * 100) + '%';
  m.classList.toggle('hot', frac > th);
  if (global > 45) return; // kameraet justerer lys/fokus
  const above = frac > th;
  if (!active) {
    motAbove = above ? motAbove + 1 : 0;
    if (motAbove >= 2) { active = { start: t - 0.1 }; lastAbove = t; }
  } else {
    if (above) lastAbove = t;
    if (t - active.start > 8) { active = null; motAbove = 0; return; } // nogen står i feltet
    if (t - lastAbove > 0.7) {
      const dur = lastAbove - active.start;
      if (dur >= 0.25 && dur <= 6) newSpring(active.start, lastAbove);
      active = null; motAbove = 0;
    }
  }
}
function newSpring(start, end) {
  springNo++;
  const s = { id: `${Date.now()}-${springNo}`, start, end, vt: Math.round((cam.currentTime - (now() - start)) * 10) / 10, votes: {}, state: 'reading', wall: Date.now() - (now() - start) * 1000 };
  springs.push(s);
  if (lockFrom === null || start - 1.5 < lockFrom) lockFrom = start - 1.5;
  toast(`Spring fundet · læser nummer …`);
}

// ---------- Nummerskilte ----------
let worker = null, tagBusy = false, lastTag = 0;
try { worker = new Worker('worker.js'); } catch { worker = null; }
const TAG_WINDOW = 4.0;
if (worker) worker.onmessage = (e) => {
  tagBusy = false;
  const { t, found } = e.data;
  for (const s of springs) {
    if (s.state !== 'reading' || t < s.end - 0.2 || t > s.end + TAG_WINDOW) continue;
    for (const f of found) {
      const v = s.votes[f.id] || (s.votes[f.id] = { w: 0, n: 0, xs: [], ys: [] });
      v.w += f.size; v.n++; v.xs.push(f.x); v.ys.push(f.y);
    }
  }
};
function maybeReadTags(t) {
  const reading = springs.filter((s) => s.state === 'reading');
  for (const s of reading) if (t > s.end + TAG_WINDOW) finishSpring(s);
  if (!worker || tagBusy || t - lastTag < 0.22) return;
  if (!springs.some((s) => s.state === 'reading' && t >= s.end - 0.2)) return;
  lastTag = t;
  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (!vw) return;
  const sc = Math.min(1, 1920 / vw);
  const w = Math.round(vw * sc), h = Math.round(vh * sc);
  if (tagC.width !== w) { tagC.width = w; tagC.height = h; }
  tagX.drawImage(cam, 0, 0, w, h);
  const img = tagX.getImageData(0, 0, w, h);
  tagBusy = true;
  worker.postMessage({ w, h, buf: img.data.buffer, t, maxId: S.roster.length }, [img.data.buffer]);
}
const recentTags = []; // {g, t}
const log = [];
function finishSpring(s) {
  log.push({ vt: s.vt, dur: Math.round((s.end - s.start) * 10) / 10, votes: Object.fromEntries(Object.entries(s.votes).map(([k, v]) => [k, v.n])) });
    // et rigtigt skilt ses i flere billeder i træk og flytter sig ikke vildt mellem dem
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const ranked = Object.entries(s.votes)
    .map(([id, v]) => ({ id: +id, w: v.w, n: v.n, ok: v.n >= 3 && spread(v.xs) < 0.5 && spread(v.ys) < 0.5 }))
    .filter((r) => r.ok).sort((a, b) => b.w - a.w);
  // hvis topnummeret lige har fået et spring, og et andet nummer også er set tydeligt, er det nok det andet
  const taken = new Set(recentTags.filter((r) => s.end - r.t < 8 && r.t !== s.end).map((r) => r.g));
  let pick = ranked[0];
  if (pick && taken.has(pick.id)) {
    const alt = ranked.find((r) => !taken.has(r.id) && r.w >= pick.w * 0.4 && r.n >= 3);
    if (alt) pick = alt;
  }
  s.g = pick ? pick.id : 0;
  if (s.g) recentTags.push({ g: s.g, t: s.end });
  while (recentTags.length > 20) recentTags.shift();
  s.state = 'clipping';
  toast(s.g ? `Spring gemt: ${gName(s.g)}` : 'Spring gemt: ukendt nummer');
  queueClip(s);
}

// ---------- Klip ----------
const clipQ = [];
let clipBusy = false;
function queueClip(s) {
  clipQ.push(s);
  runClips();
}
async function runClips() {
  if (clipBusy) return;
  clipBusy = true;
  while (clipQ.length) {
    const s = clipQ.shift();
    const wait = s.end + 2.0 - now();
    if (wait > 0) await sleep(wait * 1000);
    const a = s.start - 1.5, b = s.end + 2.0;
    const frames = ring.filter((f) => f.t >= a && f.t <= b);
    try { if (frames.length > 5) await makeClip(s, frames); } catch (e) { console.warn('klip fejlede', e); }
    s.state = 'done';
    const open = springs.filter((x) => x.state !== 'done');
    lockFrom = open.length ? Math.min(...open.map((x) => x.start - 1.5)) : null;
    springs = springs.filter((x) => x.state !== 'done');
  }
  clipBusy = false;
}
function pickMime() {
  if (!window.MediaRecorder) return '';
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}
const recC = document.createElement('canvas'); recC.width = CAP_W; recC.height = CAP_H;
const recX = recC.getContext('2d');
async function makeClip(s, frames) {
  const mid = frames[Math.floor(frames.length / 2)];
  const thumb = await thumbOf(mid.blob);
  const dur = frames[frames.length - 1].t - frames[0].t;
  const base = { id: s.id, at: s.wall, g: s.g || 0, dur: Math.round(dur * 10) / 10, thumb };
  const mime = pickMime();
  if (mime && recC.captureStream) {
    const first = await createImageBitmap(frames[0].blob);
    recX.drawImage(first, 0, 0, CAP_W, CAP_H); first.close && first.close();
    const st = recC.captureStream(30);
    const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    const t0 = performance.now();
    for (let i = 0; i < frames.length; i++) {
      const bmp = await createImageBitmap(frames[i].blob);
      const due = (frames[i].t - frames[0].t) * 1000 - (performance.now() - t0);
      if (due > 0) await sleep(due);
      recX.drawImage(bmp, 0, 0, CAP_W, CAP_H);
      bmp.close && bmp.close();
    }
    await sleep(120);
    rec.stop();
    await stopped;
    st.getTracks().forEach((tr) => tr.stop());
    const blob = new Blob(parts, { type: mime.split(';')[0] });
    if (blob.size > 1000) { const c = { ...base, blob, mime: blob.type }; await putClip(c); refreshLists(); cloudUpload(c); return; }
  }
  // reserve: gem billederne og afspil dem i et canvas
  await putClip({ ...base, frames: frames.map((f) => ({ t: f.t - frames[0].t, blob: f.blob })) });
  refreshLists();
}
async function thumbOf(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  c.getContext('2d').drawImage(bmp, 0, 0, 320, 180);
  bmp.close && bmp.close();
  return c.toDataURL('image/jpeg', 0.7);
}

// ---------- Afspiller ----------
const plV = $('plVideo'), plC = $('plCanvas');
let plUrl = null, plTimer = null, plRate = 1, plClip = null;
async function openClip(id) {
  const c = typeof id === 'object' ? id : await getClip(id);
  if (!c) return;
  plClip = c; plRate = 1; $('plSlow').textContent = 'Slowmotion';
  $('plTitle').textContent = `${gName(c.g)} · ${fmtTime(c.at)}`;
  $('player').hidden = false;
  if (plUrl) { URL.revokeObjectURL(plUrl); plUrl = null; }
  if (c.url) {
    plC.hidden = true; plV.hidden = false; plUrl = null;
    plV.src = c.url; plV.playbackRate = 1; plV.play().catch(() => {});
    $('plSave').hidden = true;
  } else if (c.blob) {
    plC.hidden = true; plV.hidden = false;
    plUrl = URL.createObjectURL(c.blob);
    plV.src = plUrl; plV.playbackRate = 1; plV.play().catch(() => {});
    const a = $('plSave'); a.hidden = false; a.href = plUrl;
    a.download = `spring-${c.g || 'ukendt'}-${new Date(c.at).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${c.blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
  } else {
    plV.hidden = true; plC.hidden = false; $('plSave').hidden = true;
    playFrames(c.frames);
  }
}
async function playFrames(fr) {
  clearTimeout(plTimer);
  const x = plC.getContext('2d');
  plC.width = CAP_W; plC.height = CAP_H;
  let i = 0;
  const t0 = performance.now();
  const tick = async () => {
    if ($('player').hidden || i >= fr.length) return;
    const bmp = await createImageBitmap(fr[i].blob);
    x.drawImage(bmp, 0, 0, CAP_W, CAP_H); bmp.close && bmp.close();
    i++;
    if (i < fr.length) {
      const due = (fr[i].t * 1000) / plRate - (performance.now() - t0);
      plTimer = setTimeout(tick, Math.max(0, due));
    }
  };
  tick();
}
$('plClose').onclick = () => { $('player').hidden = true; plV.pause(); clearTimeout(plTimer); };
$('plSlow').onclick = () => {
  plRate = plRate === 1 ? 0.4 : 1;
  $('plSlow').textContent = plRate === 1 ? 'Slowmotion' : 'Normal fart';
  if (plClip?.blob || plClip?.url) plV.playbackRate = plRate; else playFrames(plClip.frames);
};
$('plReplay').onclick = () => {
  if (plClip?.blob || plClip?.url) { plV.currentTime = 0; plV.playbackRate = plRate; plV.play().catch(() => {}); } else playFrames(plClip.frames);
};

// ---------- Visninger ----------
let view = 'live', trainerOk = false, mineG = null, idleT = null;
$('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.v); };
function show(v) {
  if (document.body.classList.contains('gymnast')) v = 'mine';
  view = v;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.v === v);
  for (const id of ['live', 'clips', 'mine', 'setup']) $(id).hidden = id !== v;
  if (v === 'clips') renderClips();
  if (v === 'mine') renderMine();
  if (v === 'setup') renderSetup();
  if (v !== 'mine') mineG = null;
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function refreshLists() {
  if (view === 'clips') renderClips();
  if (view === 'mine' && mineG) renderMine();
}

// Trænerkode
function pinScreen(wrap, title, onOk) {
  const first = !S.trainerHash;
  // første gang på en enhed: kun en godkendt træner (logget ind i skyen) kan oprette trænerpanelet
  if (first && sb && !cloudTrainer) {
    wrap.innerHTML = `<div class="pin" style="max-width:560px"><h2>${esc(title)}</h2>
      <p class="muted">Kun for trænere. Log ind med trænerlogin for at sætte denne enhed op.</p>
      <div class="sec" id="cloudSec" style="text-align:left"></div></div>`;
    renderCloud();
    return;
  }
  const lockLeft = Math.ceil(((S.pinLock || 0) - Date.now()) / 1000);
  wrap.innerHTML = `<form class="pin" id="pinF">
    <h2>${esc(title)}</h2>
    <p class="muted">${first ? 'Vælg en trænerkode på mindst 6 cifre. Den beskytter klip, opsætning og pigernes koder på denne enhed.' : 'Skriv trænerkoden.'}</p>
    <input id="pinIn" type="password" inputmode="numeric" autocomplete="off" aria-label="Trænerkode">
    <button class="acc">${first ? 'Gem kode' : 'Åbn'}</button>
    <p class="err" id="pinErr">${lockLeft > 0 ? `For mange forkerte forsøg. Vent ${Math.ceil(lockLeft / 60)} min.` : ''}</p></form>`;
  $('pinF').onsubmit = async (e) => {
    e.preventDefault();
    if ((S.pinLock || 0) > Date.now()) { $('pinErr').textContent = `For mange forkerte forsøg. Vent ${Math.ceil((S.pinLock - Date.now()) / 60000)} min.`; return; }
    const v = $('pinIn').value.trim();
    if (first && v.length < 6) { $('pinErr').textContent = 'Koden skal have mindst 6 tegn.'; return; }
    const h = await sha(v);
    if (first) { S.trainerHash = h; save(); }
    if (h !== S.trainerHash) {
      S.pinFails = (S.pinFails || 0) + 1;
      if (S.pinFails >= 5) { S.pinLock = Date.now() + Math.min(60, 5 * 2 ** (S.pinFails - 5)) * 60000; }
      save();
      $('pinErr').textContent = S.pinFails >= 5 ? 'Forkert kode. Panelet er låst i et stykke tid.' : 'Forkert kode.';
      $('pinIn').value = '';
      return;
    }
    S.pinFails = 0; S.pinLock = 0; save();
    trainerOk = true; onOk();
  };
  $('pinIn').focus();
}

async function renderClips() {
  const w = $('clipsWrap');
  if (!trainerOk) return pinScreen(w, 'Klip', renderClips);
  const list = await listClips();
  const onlyUnk = w.dataset.unk === '1';
  const shown = onlyUnk ? list.filter((c) => !c.g) : list;
  const opts = (sel) => `<option value="0"${!sel ? ' selected' : ''}>Ukendt</option>` + S.roster.map((g) => `<option value="${g.n}"${g.n === sel ? ' selected' : ''}>${esc(gName(g.n))}</option>`).join('');
  w.innerHTML = `<div class="row"><h2 style="flex:1">Klip</h2>
      <button id="unkBtn" class="${onlyUnk ? 'acc' : ''}">Kun ukendte (${list.filter((c) => !c.g).length})</button>
      <button id="lockBtn" class="ghost">Lås</button></div>
    <p class="muted">${list.length} klip på denne enhed${cloudTrainer ? ` · ${list.filter((c) => c.cloud).length} sendt til skyen` : ' · ikke logget ind i skyen (se Opsætning)'}. Klip med orange kant mangler et nummer: vælg gymnasten i listen.</p>
    ${shown.length ? `<div class="grid">${shown.map((c) => `
      <div class="clip${c.g ? '' : ' unk'}">
        <button class="thumb" data-play="${c.id}" style="background-image:url('${c.thumb}')" aria-label="Afspil"><span>${c.dur} s</span></button>
        <div class="meta"><b>${esc(fmtTime(c.at))}</b>
          <select data-g="${c.id}" aria-label="Gymnast">${opts(c.g)}</select>
          <button class="bad ghost" data-del="${c.id}">Slet</button></div></div>`).join('')}</div>`
      : `<div class="empty">${onlyUnk ? 'Ingen ukendte klip.' : 'Ingen klip endnu. Start kameraet under Live, så kommer springene her af sig selv.'}</div>`}`;
  $('unkBtn').onclick = () => { w.dataset.unk = onlyUnk ? '0' : '1'; renderClips(); };
  $('lockBtn').onclick = () => { trainerOk = false; renderClips(); };
  w.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => openClip(b.dataset.play)));
  w.querySelectorAll('[data-g]').forEach((s) => (s.onchange = async () => {
    const c = await getClip(s.dataset.g); c.g = +s.value; await putClip(c); renderClips();
    if (c.cloud && cloudTrainer) { const { error } = await sb.from('clips').update({ g: c.g }).eq('id', c.id); if (error) toast('Kunne ikke rette i skyen'); }
  }));
  w.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.sure) {
      const c = await getClip(b.dataset.del);
      await delClip(b.dataset.del); renderClips();
      if (c?.cloud && cloudTrainer) { await sb.storage.from('clips').remove([c.path]); await sb.from('clips').delete().eq('id', c.id); }
    }
    else { b.dataset.sure = '1'; b.textContent = 'Tryk igen for at slette'; }
  }));
}

let mineData = null; // { n, name, clips:[{id,at,dur,thumb,url}] } fra skyen
async function renderMine() {
  const w = $('mineWrap');
  clearTimeout(idleT);
  if (!mineG) {
    w.innerHTML = `<form class="pin" id="mineF"><h2>Mine spring</h2>
      <p class="muted">Skriv din personlige kode (6 tegn). Du kan kun se dine egne spring.</p>
      <input id="mineIn" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="6" aria-label="Personlig kode">
      <button class="acc" id="mineGo">Vis mine spring</button><p class="err" id="mineErr"></p></form>`;
    $('mineF').onsubmit = async (e) => {
      e.preventDefault();
      const code = $('mineIn').value.trim().toUpperCase();
      $('mineErr').textContent = '';
      if (code.length !== 6) { $('mineErr').textContent = 'Koden har 6 tegn.'; return; }
      $('mineGo').disabled = true; $('mineGo').textContent = 'Henter …';
      let res = null;
      if (sb) {
        try {
          const r = await fetch(`${SUPA_URL}/functions/v1/mine`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY }, body: JSON.stringify({ code }) });
          if (r.status === 429) { $('mineErr').textContent = 'For mange forkerte forsøg. Prøv igen om et kvarter.'; }
          else if (r.ok) res = await r.json();
        } catch {}
      }
      if (!res) {
        const g = S.roster.find((x) => x.code === code);
        if (g) res = { n: g.n, name: g.name, local: true };
      }
      $('mineGo').disabled = false; $('mineGo').textContent = 'Vis mine spring';
      if (!res) { if (!$('mineErr').textContent) $('mineErr').textContent = 'Koden passer ikke. Spørg din træner.'; return; }
      mineData = res; mineG = res.n; renderMine();
    };
    return;
  }
  const list = mineData && !mineData.local ? mineData.clips.map((c) => ({ ...c, at: Date.parse(c.at) })) : await listClips(mineG);
  const title = mineData?.name || S.roster.find((x) => x.n === mineG)?.name || 'Nr. ' + mineG;
  w.innerHTML = `<div class="row"><h2 style="flex:1">${esc(title)}: ${list.length} spring</h2><button class="acc" id="mineOut">Log ud</button></div>
    <p class="muted">Klippene bliver slettet efter ${S.keepDays} dage. Tryk på et klip for at se det, og brug Slowmotion for at se detaljerne.</p>
    ${list.length ? `<div class="grid">${list.map((c, i) => `<div class="clip"><button class="thumb" data-i="${i}" style="background-image:url('${c.thumb || ''}')" aria-label="Afspil"><span>${c.dur} s</span></button>
      <div class="meta"><b>${esc(fmtTime(c.at))}</b></div></div>`).join('')}</div>` : '<div class="empty">Ingen spring endnu.</div>'}`;
  $('mineOut').onclick = () => { mineG = null; mineData = null; renderMine(); };
  w.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
    const c = list[+b.dataset.i];
    openClip(c.url ? { ...c, g: mineG } : c.id);
  }));
  idleT = setTimeout(() => { mineG = null; mineData = null; if (view === 'mine') renderMine(); }, 3 * 60 * 1000);
}
document.addEventListener('pointerdown', () => { if (mineG && view === 'mine') { clearTimeout(idleT); idleT = setTimeout(() => { mineG = null; renderMine(); }, 3 * 60 * 1000); } });

function renderSetup() {
  const w = $('setupWrap');
  if (!trainerOk) return pinScreen(w, 'Opsætning', renderSetup);
  w.innerHTML = `<h2>Opsætning</h2>
    <div class="sec" id="cloudSec"></div>
    <div class="sec"><h3>Gymnaster</h3>
      <p class="muted">Nummeret passer til skiltet. Tryk på prikkerne for at se en gymnasts kode, og giv hende den personligt. Med koden kan hun se sine egne spring på williamamaru.github.io/springklip/#mine.</p>
      <table><thead><tr><th>Nr.</th><th>Navn</th><th>Kode</th><th></th></tr></thead><tbody>
      ${S.roster.map((g) => `<tr><td class="num">${g.n}</td><td><input type="text" data-name="${g.n}" value="${esc(g.name)}" placeholder="Navn" aria-label="Navn til nr. ${g.n}"></td>
        <td class="code"><button class="ghost" data-show="${g.n}" aria-label="Vis kode for nr. ${g.n}">••••••</button></td><td><button class="ghost" data-new="${g.n}">Ny kode</button></td></tr>`).join('')}
      </tbody></table>
      <div class="row"><button id="addG">Tilføj nummer</button>
      <a href="skilte/Nummerskilte_1-30.pdf" target="_blank" rel="noopener"><button>Nummerskilte 1–30 (PDF)</button></a></div>
    </div>
    <div class="sec"><h3>Springgenkendelse</h3>
      <label>Følsomhed: kræver at <b id="sensV">${S.sens}</b> % af luftfeltet bevæger sig
        <input id="sens" type="range" min="0.3" max="6" step="0.1" value="${S.sens}" style="width:100%"></label>
      <p class="muted">Kommer der spring med, som ikke er spring: hæv tallet. Bliver rigtige spring overset: sænk det. Luftfeltet indstilles under Live.</p>
    </div>
    <div class="sec"><h3>Opbevaring</h3>
      <label>Slet klip automatisk efter <input id="keep" type="number" min="1" max="365" value="${S.keepDays}" style="width:90px;display:inline-block"> dage</label>
      <button class="bad" id="wipe">Slet alle klip på denne enhed</button>
    </div>
    <div class="sec"><h3>Test med en video</h3>
      <p class="muted">Afspil en optaget video i stedet for kameraet. Den bliver behandlet som live-billede, så du kan prøve springgenkendelse og klip.</p>
      <input id="testFile" type="file" accept="video/*">
    </div>
    <div class="sec"><h3>Trænerkode</h3><button id="newPin">Skift trænerkode</button></div>`;
  w.querySelectorAll('[data-name]').forEach((i) => (i.onchange = () => { const g = S.roster.find((x) => x.n === +i.dataset.name); g.name = i.value.trim(); save(); cloudRoster([g]); }));
  w.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => { const g = S.roster.find((x) => x.n === +b.dataset.new); g.code = newCode(); save(); cloudRoster([g]); renderSetup(); }));
  $('addG').onclick = () => { const n = S.roster.length + 1; if (n > 50) return; const g = { n, name: '', code: newCode() }; S.roster.push(g); save(); cloudRoster([g]); renderSetup(); };
  renderCloud();
  w.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => {
    const g = S.roster.find((x) => x.n === +b.dataset.show);
    b.textContent = b.textContent.startsWith('•') ? g.code : '••••••';
  }));
  $('sens').oninput = (e) => { S.sens = +e.target.value; $('sensV').textContent = S.sens; save(); };
  $('keep').onchange = (e) => { S.keepDays = Math.max(1, +e.target.value || 10); save(); };
  $('wipe').onclick = async (e) => {
    const b = e.target;
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Tryk igen for at slette alle klip'; return; }
    for (const c of await listClips()) await delClip(c.id);
    b.textContent = 'Alle klip er slettet'; delete b.dataset.sure;
  };
  $('testFile').onchange = (e) => { const f = e.target.files[0]; if (f) { show('live'); startCamera(f); } };
  $('newPin').onclick = () => { S.trainerHash = ''; save(); trainerOk = false; renderSetup(); };
}

// ---------- Skyen (Supabase) ----------
// Klip sendes op, så gymnasterne kan se deres egne spring hjemme. Kun godkendte trænere kan uploade og se alt.
const SUPA_URL = 'https://njunnxxyidmycxgspybd.supabase.co';
const SUPA_KEY = 'sb_publishable_z_WF_jwdJPo0_G_gaenMvg_YcBs8GEx';
let sb = null, cloudUser = null, cloudTrainer = false, cloudBusy = false;
try { sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true } }); } catch { sb = null; }
async function cloudCheck() {
  if (!sb) return;
  try {
    const { data } = await sb.auth.getSession();
    cloudUser = data.session?.user || null;
    cloudTrainer = false;
    if (cloudUser) {
      const { data: t } = await sb.from('trainers').select('user_id').eq('user_id', cloudUser.id).maybeSingle();
      cloudTrainer = !!t;
    }
  } catch {}
  if (view === 'setup' && trainerOk) renderCloud();
  if ((view === 'setup' || view === 'clips') && !trainerOk && cloudTrainer) show(view);
  if (cloudTrainer) { cloudRoster(S.roster); cloudRetry(); cloudPrune(); }
}
const codeHash = async (n, code) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`springklip:${n}:${code}`));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
async function cloudRoster(list) {
  if (!cloudTrainer) return;
  const rows = await Promise.all(list.map(async (g) => ({ n: g.n, name: g.name, code_hash: await codeHash(g.n, g.code), updated_at: new Date().toISOString() })));
  const { error } = await sb.from('gymnasts').upsert(rows);
  if (error) toast('Navne og koder kunne ikke sendes til skyen');
}
async function cloudUpload(c) {
  if (!cloudTrainer || !c.blob || c.cloud) return false;
  const ext = c.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const path = `${c.id}.${ext}`;
  const up = await sb.storage.from('clips').upload(path, c.blob, { contentType: c.blob.type, upsert: true });
  if (up.error) return false;
  const ins = await sb.from('clips').upsert({ id: c.id, g: c.g || 0, at: new Date(c.at).toISOString(), dur: c.dur, path, thumb: c.thumb });
  if (ins.error) return false;
  const fresh = await getClip(c.id);
  if (fresh) { fresh.cloud = true; fresh.path = path; await putClip(fresh); }
  return true;
}
async function cloudRetry() {
  if (!cloudTrainer || cloudBusy) return;
  cloudBusy = true;
  try {
    const waiting = (await listClips()).filter((c) => !c.cloud);
    for (const m of waiting) { const c = await getClip(m.id); if (c?.blob) await cloudUpload(c); }
  } catch {}
  cloudBusy = false;
}
setInterval(cloudRetry, 60_000);
async function cloudPrune() {
  if (!cloudTrainer) return;
  const lim = new Date(Date.now() - S.keepDays * 864e5).toISOString();
  const { data } = await sb.from('clips').select('id, path').lt('at', lim).limit(500);
  if (!data?.length) return;
  await sb.storage.from('clips').remove(data.map((r) => r.path));
  await sb.from('clips').delete().in('id', data.map((r) => r.id));
}
function renderCloud() {
  const el = $('cloudSec');
  if (!el) return;
  if (!sb) { el.innerHTML = '<h3>Skyen</h3><p class="muted">Forbindelsen til skyen kunne ikke startes.</p>'; return; }
  if (!cloudUser) {
    el.innerHTML = `<h3>Skyen: så gymnasterne kan se deres spring hjemme</h3>
      <p class="muted">Log ind med trænerlogin. Så bliver hvert klip sendt op automatisk, og gymnasterne kan se deres egne på <b>williamamaru.github.io/springklip/#mine</b> med deres kode.</p>
      <form id="cloudF" class="row" style="align-items:stretch">
        <input id="cEmail" type="text" inputmode="email" autocomplete="username" placeholder="E-mail" aria-label="E-mail" style="flex:1 1 220px">
        <input id="cPass" type="password" autocomplete="current-password" placeholder="Adgangskode" aria-label="Adgangskode" style="flex:1 1 180px">
        <button class="acc" id="cIn">Log ind</button><button type="button" id="cUp">Opret trænerlogin</button>
      </form><p class="err" id="cErr"></p>`;
    const go = async (signup) => {
      const email = $('cEmail').value.trim(), password = $('cPass').value;
      if (!email || password.length < 8) { $('cErr').textContent = 'Skriv e-mail og en adgangskode på mindst 8 tegn.'; return; }
      $('cErr').textContent = 'Et øjeblik …';
      const r = signup ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }) : await sb.auth.signInWithPassword({ email, password });
      if (r.error) { $('cErr').textContent = signup ? 'Kunne ikke oprette: ' + r.error.message : 'Forkert e-mail eller adgangskode (eller e-mailen er ikke bekræftet endnu).'; return; }
      if (signup && !r.data.session) { $('cErr').textContent = 'Tjek din e-mail og tryk på linket for at bekræfte. Log derefter ind her.'; return; }
      cloudCheck();
    };
    $('cloudF').onsubmit = (e) => { e.preventDefault(); go(false); };
    $('cUp').onclick = () => go(true);
    return;
  }
  el.innerHTML = cloudTrainer
    ? `<h3>Skyen: forbundet</h3><p class="muted">Logget ind som ${esc(cloudUser.email)}. Nye klip bliver sendt op automatisk. Gymnasterne ser deres egne på <b>williamamaru.github.io/springklip/#mine</b>.</p>
       <div class="row"><button id="cSync">Send navne, koder og manglende klip</button><button class="ghost" id="cOut">Log ud af skyen</button></div><p class="muted" id="cMsg"></p>`
    : `<h3>Skyen: venter på godkendelse</h3><p class="muted">Logget ind som ${esc(cloudUser.email)}, men kontoen er ikke godkendt som træner endnu. Når den er godkendt, så tryk "Tjek igen".</p>
       <div class="row"><button id="cAgain">Tjek igen</button><button class="ghost" id="cOut">Log ud af skyen</button></div>`;
  $('cOut').onclick = async () => { await sb.auth.signOut(); cloudUser = null; cloudTrainer = false; renderCloud(); };
  if ($('cAgain')) $('cAgain').onclick = cloudCheck;
  if ($('cSync')) $('cSync').onclick = async () => { $('cMsg').textContent = 'Sender …'; await cloudRoster(S.roster); await cloudRetry(); $('cMsg').textContent = 'Færdig.'; };
}
if (sb) sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') setTimeout(cloudCheck, 0); });

let lockT = null;
document.addEventListener('pointerdown', () => { clearTimeout(lockT); lockT = setTimeout(() => { if (trainerOk) { trainerOk = false; if (view === 'clips' || view === 'setup') show(view); } }, 10 * 60 * 1000); }, true);

// ---------- Status ----------
let toastT = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3500);
}
let todayCount = 0;
async function setRec() {
  $('recDot').classList.toggle('on', running);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  try { todayCount = (await listClips()).filter((c) => c.at >= start.getTime()).length; } catch {}
  $('recTxt').innerHTML = running ? `Optager <span class="long">· ${todayCount} klip i dag</span>` : `Kamera slukket <span class="long">· ${todayCount} klip i dag</span>`;
}
setInterval(setRec, 5000);

$('startCam').onclick = () => startCamera();
if (!navigator.mediaDevices?.getUserMedia) $('camErr').textContent = 'Denne browser kan ikke bruge kameraet. Brug Safari på iPad eller Chrome.';
pruneOld().catch(() => {});
setRec();
cloudCheck();
// gymnaster får linket .../#mine og ser kun "Mine spring"
if (location.hash === '#mine') {
  document.body.classList.add('gymnast');
  show('mine');
}

// til test
window.__springklip = { springs: () => springs, listClips, S, log };
}
