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
// opstillinger: hver har sit navn (fx Trampet, Bane) og sine luftfelter
if (!Array.isArray(S.presets) || !S.presets.length) S.presets = [{ name: 'Trampet', zones: [S.zone || DEF.zone] }, { name: 'Bane', zones: [] }];
if (!(S.pi >= 0 && S.pi < S.presets.length)) S.pi = 0;
const preset = () => S.presets[S.pi];
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
// Billederne gemmes i kameraets egne proportioner (liggende 16:9 på iPad, stående på en iPhone holdt lodret),
// så intet bliver mast sammen. Længste side: 1280 px på iPad/computer, 960 px på telefon for at spare hukommelse.
let CAP_W = 1280, CAP_H = 720;
const CAP_LONG = Math.min(window.screen.width, window.screen.height) < 600 ? 960 : 1280;
const capC = document.createElement('canvas'); capC.width = CAP_W; capC.height = CAP_H;
function updCap() {
  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (!vw || !vh) return;
  const sc = Math.min(1, CAP_LONG / Math.max(vw, vh));
  const w = Math.round((vw * sc) / 2) * 2, h = Math.round((vh * sc) / 2) * 2;
  if (w !== CAP_W || h !== CAP_H) { CAP_W = w; CAP_H = h; capC.width = w; capC.height = h; }
}
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
    updCap();
    capX.drawImage(cam, 0, 0, CAP_W, CAP_H);
    pending++;
    capC.toBlob((b) => {
      pending--;
      if (b) ring.push({ t, blob: b });
      const cut = now() - bufferSec();
      let i = 0;
      while (i < ring.length && ring[i].t < cut && !(lockFrom !== null && ring[i].t >= lockFrom)) i++;
      if (i) ring.splice(0, i);
    }, 'image/jpeg', 0.75);
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
function fitRect(cw, ch, ox = 0, oy = 0, iw = CAP_W, ih = CAP_H) {
  const r = Math.min(cw / iw, ch / ih);
  const w = iw * r, h = ih * r;
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
    const behind = Math.max(0, now() - t);
    const filling = !paused && (idx < 0 || have + 0.5 < behind);
    const src = filling ? null : v.bmp;
    const R = fitRect(p.w, p.h, p.x, p.y, src ? src.width : CAP_W, src ? src.height : CAP_H);
    // mens forsinkelsen fyldes op, vises live-billedet, så man kan se at kameraet virker
    if (filling && cam.readyState >= 2) drawImg(cam, R);
    else if (v.bmp) drawImg(v.bmp, R);
    else { sx.fillStyle = '#9aa7b4'; sx.font = `${16 * dpr}px Arial`; sx.textAlign = 'center'; sx.fillText('Venter på kameraet …', p.x + p.w / 2, p.y + p.h / 2); sx.textAlign = 'start'; }
    const txt = (P.length > 1 ? LET[i] + '  ' : '') + (filling ? 'Live' : behind < 0.5 ? 'Live' : `${Math.round(behind)} s`);
    const sub = paused ? 'pause' : filling ? `forsinkelse om ${Math.max(1, Math.ceil(behind - have))} s` : (Math.abs(lags[i] - S.delays[i]) > 0.5 ? 'spolet' : '');
    label(R.x + 10 * dpr, R.y + 10 * dpr, txt, S.clipOn === false && i === 0 && !paused ? (sub ? sub + ' · klip fra' : 'klip fra') : sub, dpr, P.length > 1 && i === sel);
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
// Træk vandret på billedet for at spole: til venstre = tilbage i tid, til højre = frem mod live.
// Hele skærmens bredde svarer til 20 sekunder. Dobbelttryk = pause/afspil.
let drag = null, lastTap = 0;
function paneAt(e) {
  const r = screen.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  const x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
  return Math.max(0, panes(screen.width, screen.height).findIndex((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h));
}
function shiftView(i, sec) {
  const lo = oldest(), hi = now();
  if (paused) pausedAt[i] = Math.max(lo, Math.min(hi, pausedAt[i] + sec));
  else lags[i] = Math.max(0, Math.min(hi - lo, lags[i] - sec));
}
screen.addEventListener('pointerdown', (e) => {
  if (zoneMode || !running) return;
  const i = S.views === 1 ? 0 : paneAt(e);
  if (S.views > 1) { sel = i; syncDelayUI(); }
  drag = { i, x0: e.clientX, y0: e.clientY, moved: false, start: paused ? pausedAt[i] : lags[i], applied: 0, id: e.pointerId };
  screen.setPointerCapture(e.pointerId);
});
screen.addEventListener('pointermove', (e) => {
  if (!drag || zoneMode || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 10) return;
  drag.moved = true;
  const w = screen.getBoundingClientRect().width || 1;
  const sec = (dx / w) * 20;
  shiftView(drag.i, sec - drag.applied);
  drag.applied = sec;
  const box = $('dragBox'); box.hidden = false;
  const behind = Math.max(0, now() - viewT(drag.i));
  box.innerHTML = `${sec < 0 ? '−' : '+'}${Math.abs(sec).toFixed(1)} s<small>${behind < 0.5 ? 'live' : Math.round(behind) + ' s bagud'}</small>`;
});
const endDrag = (e) => {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  $('dragBox').hidden = true;
  if (!drag.moved) {
    const t = performance.now();
    if (t - lastTap < 320) { $('pause').click(); lastTap = 0; } else lastTap = t;
  }
  drag = null;
};
screen.addEventListener('pointerup', endDrag);
screen.addEventListener('pointercancel', endDrag);

// Tidslinje: viser hvor i optagelsen det valgte billede er, og kan trækkes
const scrub = $('scrub');
let scrubbing = false;
scrub.addEventListener('pointerdown', () => (scrubbing = true));
scrub.addEventListener('pointerup', () => (scrubbing = false));
scrub.addEventListener('input', () => {
  const lo = oldest(), hi = now(), t = lo + (scrub.value / 1000) * (hi - lo);
  if (paused) pausedAt[sel] = t; else lags[sel] = Math.max(0, hi - t);
});
setInterval(() => {
  if (!running && !ring.length) { $('scrubTxt').textContent = '—'; return; }
  const lo = oldest(), hi = now(), t = viewT(sel);
  if (!scrubbing && document.activeElement !== scrub) scrub.value = Math.round(((t - lo) / Math.max(1, hi - lo)) * 1000);
  const behind = Math.max(0, hi - t);
  $('scrubTxt').textContent = (S.views > 1 ? LET[sel] + ' ' : '') + (behind < 0.5 ? 'Live' : `−${Math.round(behind)} s`);
}, 200);
$('moreBtn').onclick = () => { const o = $('bar').classList.toggle('open'); $('moreBtn').setAttribute('aria-expanded', o); };
let calmT = null;
function wake() {
  document.body.classList.remove('calm');
  clearTimeout(calmT);
  calmT = setTimeout(() => { if (running && view === 'live' && !zoneMode && $('player').hidden) document.body.classList.add('calm'); }, 8000);
}
document.addEventListener('pointerdown', wake, true);
wake();

// ---------- Luftfelt og opstillinger ----------
// Et luftfelt er et område af billedet over redskabet, hvor gymnasterne er i luften.
// Bevægelse i et af den valgte opstillings felter = et spring. Andre baner i billedet tæller ikke.
function drawZone(R, editing) {
  const zs = (editing ? zoneEdit : preset().zones) || [];
  sx.save();
  sx.lineWidth = 3 * Math.min(2, devicePixelRatio || 1);
  zs.concat(dragZone ? [dragZone] : []).forEach((z) => {
    const x = R.x + z.x0 * R.w, y = R.y + z.y0 * R.h, w = (z.x1 - z.x0) * R.w, h = (z.y1 - z.y0) * R.h;
    sx.fillStyle = editing ? '#f29a1f33' : '#f29a1f18'; sx.fillRect(x, y, w, h);
    sx.strokeStyle = '#f29a1f'; sx.strokeRect(x, y, w, h);
  });
  sx.restore();
}
function syncPresetUI() {
  const sel = $('presetSel');
  sel.innerHTML = S.presets.map((p, i) => `<option value="${i}"${i === S.pi ? ' selected' : ''}>${esc(p.name)}${p.zones.length ? '' : ' (intet felt)'}</option>`).join('') + '<option value="new">＋ Ny opstilling</option>';
}
function openZoneEdit() {
  if (!running) { toast('Start kameraet først'); syncPresetUI(); return; }
  zoneMode = true; zoneEdit = preset().zones.map((z) => ({ ...z }));
  $('zoneName').value = preset().name;
  $('zoneDel').hidden = S.presets.length < 2;
  $('zoneHelp').hidden = false;
}
$('presetSel').onchange = (e) => {
  if (e.target.value === 'new') {
    S.presets.push({ name: `Opstilling ${S.presets.length + 1}`, zones: [] });
    S.pi = S.presets.length - 1;
  } else S.pi = +e.target.value;
  save(); syncPresetUI(); prevMot = null; active = null;
  if (!preset().zones.length) openZoneEdit(); else toast(`Springgenkendelse: ${preset().name}`);
};
syncPresetUI();
// Klip til/fra: under teknik eller opvarmning kan klip slås fra, så der ikke bruges plads.
// Den forsinkede visning kører videre som normalt.
function syncClipUI() {
  const on = S.clipOn !== false, b = $('clipBtn');
  b.textContent = on ? 'Klip: til' : 'Klip: fra';
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on);
  setRec();
}
$('clipBtn').onclick = () => { S.clipOn = S.clipOn === false; save(); syncClipUI(); toast(S.clipOn ? 'Klip slået til: spring gemmes' : 'Klip slået fra: intet bliver gemt'); };
$('zoneBtn').onclick = openZoneEdit;
$('zoneClear').onclick = () => { zoneEdit = []; };
$('zoneDel').onclick = (e) => {
  if (!e.target.dataset.sure) { e.target.dataset.sure = '1'; e.target.textContent = 'Tryk igen for at slette'; return; }
  delete e.target.dataset.sure; e.target.textContent = 'Slet opstilling';
  S.presets.splice(S.pi, 1); S.pi = 0; save();
  zoneMode = false; zoneEdit = null; $('zoneHelp').hidden = true; syncPresetUI();
};
$('zoneDone').onclick = () => {
  zoneMode = false; $('zoneHelp').hidden = true;
  const p = preset();
  if (zoneEdit) p.zones = zoneEdit;
  p.name = $('zoneName').value.trim() || p.name;
  save(); syncPresetUI();
  zoneEdit = null; prevMot = null; active = null;
  toast(p.zones.length ? `${p.name}: ${p.zones.length} felt${p.zones.length > 1 ? 'er' : ''} gemt` : `${p.name} har intet felt, så der findes ingen spring`);
};
let dragFrom = null, dragZone = null;
screen.addEventListener('pointerdown', (e) => {
  if (!zoneMode) return;
  const p = toNorm(e); dragFrom = p; dragZone = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  screen.setPointerCapture(e.pointerId);
});
screen.addEventListener('pointermove', (e) => {
  if (!zoneMode || !dragFrom) return;
  const p = toNorm(e);
  dragZone = { x0: Math.min(dragFrom.x, p.x), y0: Math.min(dragFrom.y, p.y), x1: Math.max(dragFrom.x, p.x), y1: Math.max(dragFrom.y, p.y) };
});
screen.addEventListener('pointerup', () => {
  if (!zoneMode) return;
  if (dragZone && dragZone.x1 - dragZone.x0 >= 0.04 && dragZone.y1 - dragZone.y0 >= 0.04 && zoneEdit.length < 4) zoneEdit.push(dragZone);
  dragFrom = null; dragZone = null;
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
  const diff = new Uint8Array(g.length);
  let allCh = 0;
  for (let k = 0; k < g.length; k++) if (Math.abs(g[k] - prevMot[k]) > 26) { diff[k] = 1; allCh++; }
  prevMot = g;
  // højeste andel bevægelse i et af felterne (hvert felt måles for sig, så et lille felt ikke drukner)
  let frac = 0;
  for (const z of preset().zones) {
    const x0 = Math.floor(z.x0 * MOT_W), x1 = Math.ceil(z.x1 * MOT_W), y0 = Math.floor(z.y0 * MOT_H), y1 = Math.ceil(z.y1 * MOT_H);
    let ch = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; ch += diff[y * MOT_W + x]; }
    if (n) frac = Math.max(frac, (ch / n) * 100);
  }
  const global = (allCh / g.length) * 100;
  const th = S.sens;
  const m = $('meter');
  m.style.width = Math.min(100, (frac / (th * 3)) * 100) + '%';
  m.classList.toggle('hot', frac > th);
  if (global > 45) return; // kameraet justerer lys/fokus
  if (S.clipOn === false) { active = null; motAbove = 0; return; } // klip slået fra, fx under teknik
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
  const s = { id: `${Date.now()}-${springNo}`, d: preset().name, start, end, vt: Math.round((cam.currentTime - (now() - start)) * 10) / 10, votes: {}, state: 'reading', wall: Date.now() - (now() - start) * 1000 };
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
  const base = { id: s.id, d: s.d, at: s.wall, g: s.g || 0, dur: Math.round(dur * 10) / 10, thumb };
  const mime = pickMime();
  if (mime && recC.captureStream) {
    const first = await createImageBitmap(frames[0].blob);
    recC.width = first.width; recC.height = first.height;
    recX.drawImage(first, 0, 0, recC.width, recC.height); first.close && first.close();
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
      recX.drawImage(bmp, 0, 0, recC.width, recC.height);
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
  const r = Math.max(320 / bmp.width, 180 / bmp.height), w = bmp.width * r, h = bmp.height * r;
  c.getContext('2d').drawImage(bmp, (320 - w) / 2, (180 - h) / 2, w, h);
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
  const f0 = await createImageBitmap(fr[0].blob); plC.width = f0.width; plC.height = f0.height; f0.close && f0.close();
  let i = 0;
  const t0 = performance.now();
  const tick = async () => {
    if ($('player').hidden || i >= fr.length) return;
    const bmp = await createImageBitmap(fr[i].blob);
    x.drawImage(bmp, 0, 0, plC.width, plC.height); bmp.close && bmp.close();
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
  if (v !== 'setup') setupPulled = false;
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function refreshLists() {
  if (view === 'clips' && !assigning) renderClips();
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
    codeLock = false;
    if (h !== S.trainerHash) {
      S.pinFails = (S.pinFails || 0) + 1;
      if (S.pinFails >= 5) { S.pinLock = Date.now() + Math.min(60, 5 * 2 ** (S.pinFails - 5)) * 60000; }
      save();
      $('pinErr').textContent = S.pinFails >= 5 ? 'Forkert kode. Panelet er låst i et stykke tid.' : 'Forkert kode.';
      $('pinIn').value = '';
      return;
    }
    S.pinFails = 0; S.pinLock = 0; save();
    trainerOk = true; trainerPin = v;
    await rosterPull();
    onOk();
  };
  $('pinIn').focus();
}

// Trænerens liste: klip på denne enhed + klip i skyen (fx optaget på en anden enhed).
let remoteCache = new Map();
async function allClips() {
  const local = await listClips();
  if (!cloudTrainer) return local;
  const { data, error } = await sb.from('clips').select('id, g, at, dur, path, thumb, d').order('at', { ascending: false }).limit(500);
  if (error) return local;
  remoteCache = new Map();
  const byId = new Map(local.map((c) => [c.id, c]));
  const out = local.slice();
  for (const r of data || []) {
    const m = { id: r.id, g: r.g, at: Date.parse(r.at), dur: r.dur, path: r.path, thumb: r.thumb, d: r.d, cloud: true, remote: true };
    remoteCache.set(r.id, m);
    const l = byId.get(r.id);
    if (!l) out.push(m);
    else { l.cloud = true; if (l.g !== r.g) l.g = r.g; } // skyen vinder, hvis det er rettet på en anden enhed
  }
  return out.sort((a, b) => b.at - a.at);
}
async function getAny(id) {
  const c = await getClip(id);
  if (c) return c;
  const m = remoteCache.get(id);
  if (!m || !sb) return null;
  const { data } = await sb.storage.from('clips').createSignedUrl(m.path, 3600);
  return { ...m, url: data?.signedUrl || null };
}
async function delAny(id) {
  const c = await getClip(id);
  if (c) await delClip(id);
  const path = c?.path || remoteCache.get(id)?.path;
  if (cloudTrainer && (c?.cloud || remoteCache.has(id)) && path) { await sb.storage.from('clips').remove([path]); await sb.from('clips').delete().eq('id', id); }
}

async function renderClips() {
  assigning = false;
  const w = $('clipsWrap');
  if (!trainerOk) return pinScreen(w, 'Klip', renderClips);
  w.innerHTML = w.innerHTML || '<p class="muted">Henter klip …</p>';
  const list = await allClips();
  const onlyUnk = w.dataset.unk === '1';
  const shown = onlyUnk ? list.filter((c) => !c.g) : list;
  const opts = (sel) => `<option value="0"${!sel ? ' selected' : ''}>Ukendt</option>` + S.roster.map((g) => `<option value="${g.n}"${g.n === sel ? ' selected' : ''}>${esc(gName(g.n))}</option>`).join('');
  w.innerHTML = `<div class="row"><h2 style="flex:1">Klip</h2>
      <button id="assignBtn" class="acc"${list.some((c) => !c.g) ? '' : ' disabled'}>Tildel ukendte (${list.filter((c) => !c.g).length})</button>
      <button id="unkBtn" class="${onlyUnk ? 'on' : ''}">Kun ukendte</button>
      <button id="lockBtn" class="ghost">Lås</button></div>
    <p class="muted">${list.length} klip${cloudTrainer ? ` · ${list.filter((c) => !c.remote).length} på denne enhed · ${list.filter((c) => c.cloud).length} i skyen` : ' på denne enhed · log ind i skyen under Opsætning for at se klip fra andre enheder'}. Klip med orange kant mangler et nummer.</p>
    ${shown.length ? `<div class="grid">${shown.map((c) => `
      <div class="clip${c.g ? '' : ' unk'}">
        <button class="thumb" data-play="${c.id}" style="background-image:url('${c.thumb}')" aria-label="Afspil"><span>${c.dur} s</span></button>
        <div class="meta"><b>${esc(fmtTime(c.at))}${c.d ? ` · ${esc(c.d)}` : ''}</b>
          <select data-g="${c.id}" aria-label="Gymnast">${opts(c.g)}</select>
          <button class="bad ghost" data-del="${c.id}">Slet</button></div></div>`).join('')}</div>`
      : `<div class="empty">${onlyUnk ? 'Ingen ukendte klip.' : 'Ingen klip endnu. Start kameraet under Live, så kommer springene her af sig selv.'}</div>`}`;
  $('unkBtn').onclick = () => { w.dataset.unk = onlyUnk ? '0' : '1'; renderClips(); };
  if ($('assignBtn')) $('assignBtn').onclick = () => renderAssign(0);
  $('lockBtn').onclick = () => { trainerOk = false; renderClips(); };
  w.querySelectorAll('[data-play]').forEach((b) => (b.onclick = async () => { const c = await getAny(b.dataset.play); if (c) openClip(c); }));
  w.querySelectorAll('[data-g]').forEach((s) => (s.onchange = async () => {
    await setClipG(s.dataset.g, +s.value); renderClips();
  }));
  w.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.sure) { await delAny(b.dataset.del); renderClips(); }
    else { b.dataset.sure = '1'; b.textContent = 'Tryk igen for at slette'; }
  }));
}

let mineData = null; // { n, name, clips:[{id,at,dur,thumb,url}] } fra skyen
// Hurtig tildeling: ét ukendt klip ad gangen, tryk på gymnastens nummer.
let asUrl = null, assigning = false;
async function setClipG(id, g) {
  const c = await getClip(id);
  if (c) { c.g = g; await putClip(c); }
  if (cloudTrainer && (c?.cloud || remoteCache.has(id))) {
    const { error } = await sb.from('clips').update({ g }).eq('id', id);
    if (error) toast('Kunne ikke rette i skyen'); else if (remoteCache.has(id)) remoteCache.get(id).g = g;
  }
}
async function renderAssign(skip) {
  assigning = true;
  const w = $('clipsWrap');
  if (!trainerOk) return pinScreen(w, 'Klip', renderClips);
  const unk = (await allClips()).filter((c) => !c.g).reverse(); // ældste først
  if (asUrl) { URL.revokeObjectURL(asUrl); asUrl = null; }
  if (!unk.length || skip >= unk.length) {
    w.innerHTML = `<div class="empty" style="margin-top:20px">${unk.length ? 'Du har sprunget de resterende over.' : 'Alle spring har fået et nummer. 👏'}</div><div class="row" style="justify-content:center;margin-top:12px"><button class="acc" id="asBack">Tilbage til klip</button></div>`;
    $('asBack').onclick = renderClips; return;
  }
  const c = await getAny(unk[skip].id);
  const named = S.roster.filter((g) => g.name);
  const list = named.length ? named : S.roster;
  w.innerHTML = `<div class="row"><h2 style="flex:1">Hvem springer? <span class="muted" style="font-size:16px;font-weight:500">${skip + 1} af ${unk.length}${c.d ? ' · ' + esc(c.d) : ''} · ${esc(fmtTime(c.at))}</span></h2>
      <button id="asDone">Færdig</button></div>
    <div style="background:#000;border-radius:12px;overflow:hidden;max-height:52vh;display:grid;place-items:center">
      ${c.blob || c.url ? '<video id="asV" playsinline muted autoplay loop style="width:100%;max-height:52vh;object-fit:contain"></video>' : `<img src="${c.thumb}" alt="" style="width:100%;max-height:52vh;object-fit:contain">`}
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(96px,1fr));margin-top:12px">
      ${list.map((g) => `<button data-as="${g.n}" style="min-height:64px;display:grid;gap:2px"><b style="font-size:24px">${g.n}</b>${g.name ? `<span style="font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</span>` : ''}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:12px"><button id="asSkip">Spring over</button><button id="asSlow" class="ghost">Slowmotion</button><button id="asDel" class="bad ghost">Slet klip (ikke et spring)</button></div>`;
  if (c.blob || c.url) { const v = $('asV'); if (c.blob) { asUrl = URL.createObjectURL(c.blob); v.src = asUrl; } else v.src = c.url; v.play().catch(() => {}); $('asSlow').onclick = () => { v.playbackRate = v.playbackRate === 1 ? 0.4 : 1; $('asSlow').textContent = v.playbackRate === 1 ? 'Slowmotion' : 'Normal fart'; }; }
  else $('asSlow').hidden = true;
  w.querySelectorAll('[data-as]').forEach((b) => (b.onclick = async () => { await setClipG(c.id, +b.dataset.as); toast(`Gemt: ${gName(+b.dataset.as)}`); renderAssign(skip); }));
  $('asSkip').onclick = () => renderAssign(skip + 1);
  $('asDone').onclick = () => { if (asUrl) { URL.revokeObjectURL(asUrl); asUrl = null; } renderClips(); };
  $('asDel').onclick = async (e) => {
    if (!e.target.dataset.sure) { e.target.dataset.sure = '1'; e.target.textContent = 'Tryk igen for at slette'; return; }
    await delAny(c.id);
    renderAssign(skip);
  };
}

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
      <div class="meta"><b>${esc(fmtTime(c.at))}${c.d ? ` · ${esc(c.d)}` : ''}</b></div></div>`).join('')}</div>` : '<div class="empty">Ingen spring endnu.</div>'}`;
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
  w.querySelectorAll('[data-name]').forEach((i) => (i.onchange = () => { const g = S.roster.find((x) => x.n === +i.dataset.name); g.name = i.value.trim(); save(); cloudName(g); }));
  // Ny kode kræver to tryk, fordi den gamle kode holder op med at virke
  w.querySelectorAll('[data-new]').forEach((b) => (b.onclick = async () => {
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Sikker? Tryk igen'; b.classList.add('bad'); setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'Ny kode'; b.classList.remove('bad'); } }, 4000); return; }
    const g = S.roster.find((x) => x.n === +b.dataset.new);
    if (cloudTrainer) { const c = await cloudNewCode(g.n); if (!c) return; g.code = c; } else g.code = newCode();
    save(); renderSetup(); toast(`Ny kode til ${gName(g.n)}. Den gamle virker ikke længere.`);
  }));
  $('addG').onclick = async () => {
    const n = S.roster.length + 1; if (n > 50) return;
    let code = newCode();
    if (cloudTrainer) { const c = await cloudNewCode(n); if (!c) return; code = c; }
    S.roster.push({ n, name: '', code }); save(); renderSetup();
  };
  renderCloud();
  if (cloudTrainer && !setupPulled) { setupPulled = true; rosterPull(); }
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
  $('newPin').onclick = () => { S.trainerHash = ''; save(); trainerOk = false; trainerPin = null; renderSetup(); };
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
  if (cloudTrainer) { cloudRetry(); cloudPrune(); rosterPull(); }
}
const codeHash = async (n, code) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`springklip:${n}:${code}`));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
// Pigernes koder bor i skyen og er låst: kun et bevidst tryk på "Ny kode" (funktionen new_gymnast_code i Supabase)
// kan ændre en kode. Enhederne henter bare listen. Trænere må kun rette navne direkte.
let trainerPin = null; // bruges ikke længere til koder, men nulstilles ved lås
let codeLock = false, setupPulled = false;
async function rosterPull() {
  if (!cloudTrainer) return false;
  const { data, error } = await sb.from('gymnasts').select('n, name, code').order('n');
  if (error || !data) return false;
  if (!data.length) {
    for (const g of S.roster) await sb.rpc('new_gymnast_code', { p_n: g.n });
    const again = await sb.from('gymnasts').select('n, name, code').order('n');
    if (again.error || !again.data) return false;
    data.push(...again.data);
  }
  const before = JSON.stringify(S.roster);
  S.roster = data.map((r) => ({ n: r.n, name: r.name || '', code: r.code || '' }));
  S.rosterLinked = true; save();
  if (JSON.stringify(S.roster) !== before && view === 'setup' && trainerOk) renderSetup();
  return true;
}
const rosterLink = () => rosterPull();
async function cloudName(g) {
  if (!cloudTrainer) return;
  const { error } = await sb.from('gymnasts').update({ name: g.name, updated_at: new Date().toISOString() }).eq('n', g.n);
  if (error) toast('Navnet kunne ikke gemmes i skyen');
}
async function cloudNewCode(n) {
  const { data, error } = await sb.rpc('new_gymnast_code', { p_n: n });
  if (error || !data) { toast('Kunne ikke lave ny kode i skyen'); return null; }
  return data;
}
async function cloudUpload(c) {
  if (!cloudTrainer || !c.blob || c.cloud) return false;
  const ext = c.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const path = `${c.id}.${ext}`;
  const up = await sb.storage.from('clips').upload(path, c.blob, { contentType: c.blob.type, upsert: true });
  if (up.error) return false;
  const ins = await sb.from('clips').upsert({ id: c.id, g: c.g || 0, at: new Date(c.at).toISOString(), dur: c.dur, path, thumb: c.thumb, d: c.d || null });
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
  const lockWarn = '';
  el.innerHTML = cloudTrainer
    ? `<h3>Skyen: forbundet</h3>${lockWarn}<p class="muted">Logget ind som ${esc(cloudUser.email)}. Nye klip bliver sendt op automatisk. Gymnasterne ser deres egne på <b>williamamaru.github.io/springklip/#mine</b>.</p>
       <div class="row"><button id="cSync">Hent navne og koder · send manglende klip</button><button class="ghost" id="cOut">Log ud af skyen</button></div><p class="muted" id="cMsg"></p>`
    : `<h3>Skyen: venter på godkendelse</h3><p class="muted">Logget ind som ${esc(cloudUser.email)}, men kontoen er ikke godkendt som træner endnu. Når den er godkendt, så tryk "Tjek igen".</p>
       <div class="row"><button id="cAgain">Tjek igen</button><button class="ghost" id="cOut">Log ud af skyen</button></div>`;
  $('cOut').onclick = async () => { await sb.auth.signOut(); cloudUser = null; cloudTrainer = false; renderCloud(); };
  if ($('cAgain')) $('cAgain').onclick = cloudCheck;
  if ($('cSync')) $('cSync').onclick = async () => { $('cMsg').textContent = 'Henter og sender …'; await rosterPull(); await cloudRetry(); $('cMsg').textContent = 'Færdig.'; };
}
if (sb) sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') setTimeout(cloudCheck, 0); });

let lockT = null;
document.addEventListener('pointerdown', () => { clearTimeout(lockT); lockT = setTimeout(() => { if (trainerOk) { trainerOk = false; trainerPin = null; if (view === 'clips' || view === 'setup') show(view); } }, 10 * 60 * 1000); }, true);

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
  const off = S.clipOn === false ? ' · klip slået fra' : '';
  $('recTxt').innerHTML = running ? `${off ? 'Live' : 'Optager'}${off} <span class="long">· ${todayCount} klip i dag</span>` : `Kamera slukket${off} <span class="long">· ${todayCount} klip i dag</span>`;
  $('recDot').classList.toggle('on', running && !off);
}
setInterval(setRec, 5000);

$('startCam').onclick = () => startCamera();
if (!navigator.mediaDevices?.getUserMedia) $('camErr').textContent = 'Denne browser kan ikke bruge kameraet. Brug Safari på iPad eller Chrome.';
pruneOld().catch(() => {});
setRec();
cloudCheck();
syncClipUI();
// gymnaster får linket .../#mine og ser kun "Mine spring"
if (location.hash === '#mine') {
  document.body.classList.add('gymnast');
  show('mine');
}

// Ny version: GitHub gemmer siden i op til 10 minutter. Siden tjekker selv og tilbyder at opdatere.
const APP_VERSION = '20261123000923';
async function checkVersion() {
  try {
    const r = await fetch('version.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const v = (await r.text()).trim();
    if (v && v !== APP_VERSION && !$('updBar')) {
      const b = document.createElement('button');
      b.id = 'updBar'; b.className = 'acc';
      b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:30;box-shadow:0 4px 18px #0008';
      b.textContent = 'Ny version af Springklip · tryk for at opdatere';
      b.onclick = async () => { b.textContent = 'Opdaterer …'; try { await fetch('index.html', { cache: 'reload' }); await fetch('app.js?v=' + v, { cache: 'reload' }); } catch {} location.reload(); };
      document.body.appendChild(b);
    }
  } catch {}
}
checkVersion(); setInterval(checkVersion, 5 * 60 * 1000);

// til test
window.__springklip = { springs: () => springs, listClips, S, log };
}
