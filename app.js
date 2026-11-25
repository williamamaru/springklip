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
const TEAM = -1; // klip for hele holdet (holdomgang): alle gymnaster kan se dem
const gName = (n) => {
  if (!n) return 'Ukendt';
  if (n === TEAM) return 'Holdet';
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
  for (let i = 0; i < 4; i++) hpDrop(i);
  ENG = 'jpeg';
  if (S.engine === 'h264') {
    if (await h264Probe()) ENG = 'h264';
    else toast('Den nye motor understøttes ikke på denne enhed. Bruger standardmotoren.');
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
  if (hold.on) holdStop();
  if (active) { const st = active.start; active = null; if (lastAbove - st >= 0.25) newSpring(st, lastAbove); }
  springs.filter((s) => s.state === 'reading').forEach(finishSpring);
});

let capToken = 0;
function capLoop() {
  if (!running) return;
  const my = ++capToken;
  const step = (_n, meta) => {
    if (!running || my !== capToken) return;
    // kameraets eget tidsstempel giver jævne afstande mellem billederne (glattere afspilning)
    const mt = meta && (meta.captureTime || meta.expectedDisplayTime);
    const t = mt ? mt / 1000 : now();
    if (t - lastCap >= 1 / 31 && cam.readyState >= 2) {
      lastCap = t;
      onFrame(t);
    }
    if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  step();
}
// JPEG-komprimeringen sker i en baggrundstråd (enc.js), så den ikke stjæler tid fra visningen.
let encW = null, encPending = 0;
try { if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob && window.createImageBitmap) encW = new Worker('enc.js'); } catch { encW = null; }
if (encW) encW.onmessage = (e) => {
  encPending--;
  if (e.data.blob) addFrame(e.data.t, e.data.blob);
  else if (e.data.err) { encW = null; } // baggrundstråden kan ikke: brug den gamle metode
};
function addFrame(t, blob, extra) {
  const f = extra ? { t, blob, ...extra } : { t, blob };
  if (!ring.length || ring[ring.length - 1].t <= t) ring.push(f);
  else { let i = ring.length - 1; while (i > 0 && ring[i - 1].t > t) i--; ring.splice(i, 0, f); }
  const cut = now() - bufferSec();
  let i = 0;
  while (i < ring.length && ring[i].t < cut && !(lockFrom !== null && ring[i].t >= lockFrom)) i++;
  if (f.data) while (i > 0 && i < ring.length && !ring[i].key) i--; // H.264: bufferen skal altid starte med et nøglebillede
  if (i) { for (const old of ring.splice(0, i)) dropDecoded(old); }
}
function onFrame(t) {
  updCap();
  if (ENG === 'h264') h264Encode(t);
  else if (encW) {
    if (encPending < 4) {
      encPending++;
      const w = CAP_W, h = CAP_H, ww = encW;
      createImageBitmap(cam).then((bmp) => ww.postMessage({ bmp, t, w, h, q: 0.75 }, [bmp])).catch(() => { encPending--; });
    }
  } else if (pending < 3) {
    capX.drawImage(cam, 0, 0, CAP_W, CAP_H);
    pending++;
    capC.toBlob((b) => { pending--; if (b) addFrame(t, b); }, 'image/jpeg', 0.75);
  }
  motion(t);
  maybeReadTags(t);
}

// ---------- Forsinket visning (1, 2 eller 4 billeder, hver med sin forsinkelse) ----------
const screen = $('screen');
const sx = screen.getContext('2d');
const LET = ['A', 'B', 'C', 'D'];
let lags = S.delays.slice(), paused = false, pausedAt = [0, 0, 0, 0], sel = 0, zoneEdit = null, zoneMode = false;
const vs = [0, 1, 2, 3].map(() => ({ cur: null, idx: -1 }));
// Billeder afkodes et par billeder før de skal vises, så der altid ligger et klar. Afkodede billeder deles mellem visningerne.
const decoded = new Set();
const perf = { shown: 0, lastShown: null, fpsShown: 0, fpsCap: 0 };
setInterval(() => {
  if (view === 'live') perf.fpsShown = perf.shown / 2; // tallet fra sidst, Live var åben
  perf.shown = 0;
  const r = ring.filter((f) => f.t > now() - 2);
  perf.fpsCap = r.length / 2;
  const el = document.getElementById('perfTxt');
  if (el) el.textContent = perfText();
}, 2000);
function perfText() {
  return `Motor: ${ENG === 'h264' ? 'ny (H.264)' : 'standard (JPEG)'} · gemmer ${perf.fpsCap.toFixed(0)} billeder/sek. · viste ${perf.fpsShown.toFixed(0)} billeder/sek. under Live · komprimering: ${ENG === 'h264' ? 'videochippen' : encW ? 'i baggrunden' : 'på hovedtråden (langsommere)'} · tidsstempler: ${cam.requestVideoFrameCallback ? 'fra kameraet' : 'fra skærmen'} · billedstørrelse ${CAP_W}×${CAP_H}`;
}
function ensureDecoded(f) {
  if (!f || f.bmp || f.dec) return;
  const p = createImageBitmap(f.blob);
  f.dec = p.then((b) => { f.dec = null; if (f.gone) { b.close && b.close(); return; } f.bmp = b; decoded.add(f); }).catch(() => { f.dec = null; });
}
function dropDecoded(f) {
  f.gone = true;
  if (f.bmp) { if (!vs.some((v) => v.cur === f)) { f.bmp.close && f.bmp.close(); f.bmp = null; } decoded.delete(f); }
}
function pruneDecoded(ts) {
  for (const f of decoded) {
    if (vs.some((v) => v.cur === f)) continue;
    if (ts.some((t) => f.t > t - 0.25 && f.t < t + 0.4)) continue;
    f.bmp && f.bmp.close && f.bmp.close(); f.bmp = null; decoded.delete(f);
  }
}
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
  if (!running && !vs[0].cur) return;
  sx.fillStyle = '#000'; sx.fillRect(0, 0, cw, ch);
  if (zoneMode) {
    const R = fitRect(cw, ch);
    if (cam.readyState >= 2) sx.drawImage(cam, R.x, R.y, R.w, R.h);
    drawZone(R, true);
    label(12 * dpr, 12 * dpr, 'Live', 'felter', dpr, false);
    return;
  }
  const P = panes(cw, ch), have = ring.length ? now() - ring[0].t : 0;
  const viewTs = [];
  P.forEach((p, i) => {
    const v = vs[i], t = viewT(i), idx = findFrame(t);
    viewTs.push(t);
    const behind = Math.max(0, now() - t);
    const filling = !paused && (idx < 0 || have + 0.5 < behind);
    if (ENG === 'h264') { if (!filling) v.cur = h264Frame(i, t); }
    else if (idx >= 0) {
      for (let k = idx; k < Math.min(ring.length, idx + 4); k++) ensureDecoded(ring[k]);
      if (ring[idx].bmp) { v.cur = ring[idx]; v.idx = idx; }
    }
    const vb = ENG === 'h264' ? v.cur : v.cur && v.cur.bmp;
    const src = filling ? null : vb;
    const R = fitRect(p.w, p.h, p.x, p.y, src ? src.displayWidth || src.width : CAP_W, src ? src.displayHeight || src.height : CAP_H);
    // mens forsinkelsen fyldes op, vises live-billedet, så man kan se at kameraet virker
    if (filling && cam.readyState >= 2) drawImg(cam, R);
    else if (vb) drawImg(vb, R);
    else { sx.fillStyle = '#9aa7b4'; sx.font = `${16 * dpr}px Arial`; sx.textAlign = 'center'; sx.fillText('Venter på kameraet …', p.x + p.w / 2, p.y + p.h / 2); sx.textAlign = 'start'; }
    const txt = (P.length > 1 ? LET[i] + '  ' : '') + (filling ? 'Live' : behind < 0.5 ? 'Live' : `${Math.round(behind)} s`);
    const sub = paused ? 'pause' : filling ? `forsinkelse om ${Math.max(1, Math.ceil(behind - have))} s` : (Math.abs(lags[i] - S.delays[i]) > 0.5 ? 'spolet' : '');
    label(R.x + 10 * dpr, R.y + 10 * dpr, txt, S.clipOn === false && i === 0 && !paused ? (sub ? sub + ' · klip fra' : 'klip fra') : sub, dpr, P.length > 1 && i === sel);
    if (P.length > 1 && i === sel) { sx.strokeStyle = '#f29a1f'; sx.lineWidth = 3 * dpr; sx.strokeRect(R.x + 1.5 * dpr, R.y + 1.5 * dpr, R.w - 3 * dpr, R.h - 3 * dpr); }
  });
  for (let i = P.length; i < 4; i++) { if (ENG === 'h264' && HP[i].dec) hpDrop(i); vs[i].cur = null; }
  if (vs[0].cur && vs[0].cur !== perf.lastShown) { perf.lastShown = vs[0].cur; perf.shown++; }
  if (ENG !== 'h264') pruneDecoded(viewTs);
  if (S.showDet && running && cam.readyState >= 2) drawDet(cw, ch, dpr);
  if (hold.on) { // tydeligt mærke, så man kan se at holdomgangen optages, også når knapperne er skjult
    const sec = Math.floor((Date.now() - hold.t0) / 1000), txt = `● Holdomgang ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    sx.save(); sx.font = `800 ${18 * dpr}px -apple-system,Arial,sans-serif`;
    const w = sx.measureText(txt).width + 20 * dpr, x = (cw - w) / 2, y = 12 * dpr;
    sx.fillStyle = '#d63c2f'; sx.beginPath(); (sx.roundRect ? sx.roundRect(x, y, w, 34 * dpr, 8 * dpr) : sx.rect(x, y, w, 34 * dpr)); sx.fill();
    sx.fillStyle = '#fff'; sx.textBaseline = 'middle'; sx.fillText(txt, x + 10 * dpr, y + 17 * dpr); sx.restore();
  }
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
  const dpr = Math.min(2, devicePixelRatio || 1);
  const P = (q) => [R.x + q.x * R.w, R.y + q.y * R.h];
  let laneNo = 0;
  zs.concat(dragZone ? [dragZone] : []).forEach((z) => {
    if (z.type === 'lane') {
      laneNo++;
      const poly = lanePoly(z.pts).map(P);
      sx.beginPath(); poly.forEach(([x, y], i) => (i ? sx.lineTo(x, y) : sx.moveTo(x, y))); sx.closePath();
      sx.fillStyle = editing ? '#3fa9f533' : '#3fa9f518'; sx.fill();
      sx.strokeStyle = '#3fa9f5'; sx.stroke();
      // pil fra start mod slut, så man kan se løberetningen
      const [s1, s2, e1, e2] = z.pts.map(P);
      const a = [(s1[0] + s2[0]) / 2, (s1[1] + s2[1]) / 2], b = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = 16 * dpr;
      sx.beginPath(); sx.moveTo(a[0], a[1]); sx.lineTo(b[0], b[1]);
      sx.lineTo(b[0] - hl * Math.cos(ang - 0.5), b[1] - hl * Math.sin(ang - 0.5)); sx.moveTo(b[0], b[1]);
      sx.lineTo(b[0] - hl * Math.cos(ang + 0.5), b[1] - hl * Math.sin(ang + 0.5)); sx.stroke();
      sx.fillStyle = '#3fa9f5'; sx.font = `800 ${16 * dpr}px -apple-system,Arial,sans-serif`; sx.fillText(`Bane ${laneNo}`, a[0] + 6 * dpr, a[1] - 6 * dpr);
      return;
    }
    const x = R.x + z.x0 * R.w, y = R.y + z.y0 * R.h, w = (z.x1 - z.x0) * R.w, h = (z.y1 - z.y0) * R.h;
    sx.fillStyle = editing ? '#f29a1f33' : '#f29a1f18'; sx.fillRect(x, y, w, h);
    sx.strokeStyle = '#f29a1f'; sx.strokeRect(x, y, w, h);
  });
  // punkter til en bane, der er ved at blive tegnet
  if (editing && lanePts.length) {
    sx.fillStyle = '#3fa9f5';
    lanePts.forEach((q, i) => { const [x, y] = P(q); sx.beginPath(); sx.arc(x, y, 8 * dpr, 0, Math.PI * 2); sx.fill(); sx.fillText(String(i + 1), x + 10 * dpr, y - 10 * dpr); });
  }
  sx.restore();
}
// "Vis genkendelse": et lille live-billede i hjørnet, hvor felterne lyser op ved bevægelse og blinker grønt, når et spring gemmes.
// Live, fordi springgenkendelsen kører på live-billedet og ikke på det forsinkede.
const detS = new WeakMap();
function detSet(z, lvl) { const d = detS.get(z) || {}; d.lvl = lvl; detS.set(z, d); }
function detFlash(z) { const d = detS.get(z) || {}; d.flash = now(); detS.set(z, d); }
function drawDet(cw, ch, dpr) {
  const w = Math.round(cw * (cw > ch ? 0.3 : 0.45)), h = Math.round((w * CAP_H) / CAP_W);
  const R = { x: cw - w - 10 * dpr, y: ch - h - 10 * dpr, w, h };
  sx.save();
  sx.drawImage(cam, R.x, R.y, R.w, R.h);
  sx.strokeStyle = '#fff'; sx.lineWidth = 2 * dpr; sx.strokeRect(R.x, R.y, R.w, R.h);
  const P = (q) => [R.x + q.x * R.w, R.y + q.y * R.h];
  let lane = 0;
  for (const z of preset().zones) {
    const st = detS.get(z) || {}, on = Math.min(1, st.lvl || 0), hit = st.flash && now() - st.flash < 1.5;
    const col = hit ? '46,204,113' : z.type === 'lane' ? '63,169,245' : '242,154,31';
    sx.beginPath();
    if (z.type === 'lane') { lanePoly(z.pts).map(P).forEach(([x, y], i) => (i ? sx.lineTo(x, y) : sx.moveTo(x, y))); sx.closePath(); }
    else sx.rect(R.x + z.x0 * R.w, R.y + z.y0 * R.h, (z.x1 - z.x0) * R.w, (z.y1 - z.y0) * R.h);
    sx.fillStyle = `rgba(${col},${hit ? 0.55 : 0.08 + on * 0.5})`; sx.fill();
    sx.strokeStyle = `rgb(${col})`; sx.lineWidth = (on >= 1 || hit ? 3 : 1.5) * dpr; sx.stroke();
    if (z.type === 'lane') { lane++; const [x, y] = P(z.pts[0]); sx.fillStyle = `rgb(${col})`; sx.font = `800 ${12 * dpr}px -apple-system,Arial,sans-serif`; sx.fillText(String(lane), x + 4 * dpr, y - 4 * dpr); }
  }
  sx.fillStyle = '#000c'; sx.fillRect(R.x, R.y, 118 * dpr, 22 * dpr);
  sx.fillStyle = '#fff'; sx.font = `700 ${12 * dpr}px -apple-system,Arial,sans-serif`; sx.textBaseline = 'middle';
  sx.fillText(S.clipOn === false ? 'Genkendelse · klip fra' : 'Genkendelse · live', R.x + 6 * dpr, R.y + 11 * dpr);
  sx.restore();
}
function syncDetUI() { const b = $('detBtn'); b.classList.toggle('on', !!S.showDet); b.setAttribute('aria-pressed', !!S.showDet); }
$('detBtn').onclick = () => { S.showDet = !S.showDet; save(); syncDetUI(); };
syncDetUI();
function syncPresetUI() {
  const sel = $('presetSel');
  sel.innerHTML = S.presets.map((p, i) => `<option value="${i}"${i === S.pi ? ' selected' : ''}>${esc(p.name)}${p.zones.length ? '' : ' (intet felt)'}</option>`).join('') + '<option value="new">＋ Ny opstilling</option>';
}
function openZoneEdit() {
  if (!running) { toast('Start kameraet først'); syncPresetUI(); return; }
  zoneMode = true; zoneEdit = preset().zones.map((z) => ({ ...z })); lanePts = []; setZoneKind('air');
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
$('zoneClear').onclick = () => { zoneEdit = []; lanePts = []; };
// To slags felter: luftfelt (bevægelse i luften = spring) og bane (bevægelse der flytter sig hurtigt langs banen = spring).
let zoneKind = 'air', lanePts = [];
const ZONE_TXT = {
  air: 'Træk et felt hen over luften, hvor gymnasterne er i luften på det redskab, der skal tælle. Op til 4 felter.',
  lane: 'Tryk på banens to hjørner, hvor gymnasterne starter, og derefter de to hjørner i den ende, hvor de lander. Tag gerne lidt luft over banen med. Op til 4 felter.',
};
function setZoneKind(k) {
  zoneKind = k; lanePts = [];
  for (const b of $('zoneKind').children) b.classList.toggle('on', b.dataset.k === k);
  $('zoneTxt').textContent = ZONE_TXT[k];
  // baner ligger typisk nederst i billedet: flyt hjælpeboksen op, så den ikke dækker
  const h = $('zoneHelp'); h.style.top = k === 'lane' ? '12px' : ''; h.style.bottom = k === 'lane' ? 'auto' : '';
}
$('zoneKind').onclick = (e) => { const b = e.target.closest('button'); if (b) setZoneKind(b.dataset.k); };
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
  if (zoneKind === 'lane') {
    if (zoneEdit.length >= 4) { toast('Der kan højst være 4 felter. Tryk på "Ryd felter" for at starte forfra.'); return; }
    lanePts.push(toNorm(e));
    if (lanePts.length === 2) toast('Godt. Tryk nu på de to hjørner i den ende, hvor de lander.');
    if (lanePts.length === 4) { zoneEdit.push({ type: 'lane', pts: lanePts }); lanePts = []; toast('Banen er tegnet. Pilen viser løberetningen.'); }
    return;
  }
  const p = toNorm(e); dragFrom = p; dragZone = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  screen.setPointerCapture(e.pointerId);
});
screen.addEventListener('pointermove', (e) => {
  if (!zoneMode || !dragFrom || zoneKind === 'lane') return;
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
let prevMot = null, motAbove = 0, active = null, lastAbove = 0, camCalmUntil = 0;
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
  let frac = 0, inCh = 0, inN = 0;
  for (const z of preset().zones) {
    if (z.type === 'lane') continue;
    const x0 = Math.floor(z.x0 * MOT_W), x1 = Math.ceil(z.x1 * MOT_W), y0 = Math.floor(z.y0 * MOT_H), y1 = Math.ceil(z.y1 * MOT_H);
    let ch = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; ch += diff[y * MOT_W + x]; }
    if (n) frac = Math.max(frac, (ch / n) * 100);
    if (n) detSet(z, ch / n * 100 / S.sens);
    inCh += ch; inN += n;
  }
  // baner tæller som "inde", så en der løber på banen ikke får et spring på trampetten smidt væk
  for (const z of preset().zones) {
    if (z.type !== 'lane') continue;
    const L = laneMask(z);
    for (let j = 0; j < L.idx.length; j++) inCh += diff[L.idx[j]];
    inN += L.idx.length;
  }
  const global = (allCh / g.length) * 100;
  // bevægelse uden for luftfelterne: en person tæt på kameraet (går forbi, bærer en måtte) fylder meget af billedet
  const outside = g.length - inN > 0 ? (Math.max(0, allCh - inCh) / (g.length - inN)) * 100 : 0;
  const th = S.sens;
  const m = $('meter');
  m.style.width = Math.min(100, (frac / (th * 3)) * 100) + '%';
  m.classList.toggle('hot', frac > th);
  // hele billedet ændrer sig: iPad'en bliver flyttet, eller kameraet justerer lys/fokus. Hold pause i 3 s bagefter,
  // så folk der står i felterne på det nye sted ikke bliver til spring
  if (global > 45) camCalmUntil = t + 3;
  if (t < camCalmUntil) { active = null; motAbove = 0; laneT = new WeakMap(); return; }
  if (S.clipOn === false) { active = null; motAbove = 0; laneT = new WeakMap(); return; } // klip slået fra, fx under teknik
  laneStep(t, diff);
  const above = frac > th;
  if (!active) {
    motAbove = above ? motAbove + 1 : 0;
    if (motAbove >= 2) { active = { start: t - 0.1, fg: 0 }; lastAbove = t; }
  } else {
    if (above) lastAbove = t;
    if (outside > FG_LIMIT) active.fg++;
    if (t - active.start > 8) { active = null; motAbove = 0; return; } // nogen står i feltet
    if (t - lastAbove > 0.7) {
      const dur = lastAbove - active.start;
      if (dur >= 0.25 && dur <= 6 && active.fg < 3) { newSpring(active.start, lastAbove); preset().zones.forEach((z) => z.type !== 'lane' && detFlash(z)); }
      active = null; motAbove = 0;
    }
  }
}
const FG_LIMIT = 12; // % af billedet uden for felterne, der bevæger sig samtidig

// ---------- Baner ----------
// En bane er en firkant på gulvet (to hjørner ved start, to ved landing). Et spring på banen er bevægelse,
// der flytter sig hurtigt fra start mod landing. At gå tilbage (modsat retning) eller stå og vente tæller ikke.
// Hver bane følges for sig, så flere baner kan køre samtidig.
const LANE = { minDist: 0.35, minSpeed: 0.12, maxDur: 10, sens: 0.4, settle: 1.0, keep: 15 };
let laneT = new WeakMap(); // bane -> { path: [{t,u,x,y}], lastPush }
const laneM = new WeakMap(); // bane -> forudberegnet maske på bevægelsesgitteret
function lanePoly(pts) {
  // to hjørner ved start og to ved slut, i den rækkefølge der ikke krydser sig selv
  const [s1, s2, e1, e2] = pts;
  if (!e1) return pts;
  const d = (a, b) => Math.hypot((a.x - b.x) * 16, (a.y - b.y) * 9);
  return d(s2, e2) + d(e1, s1) <= d(s2, e1) + d(e2, s1) ? [s1, s2, e2, e1] : [s1, s2, e1, e2];
}
function laneMask(z) {
  let m = laneM.get(z);
  if (m) return m;
  const poly = lanePoly(z.pts).map((q) => [q.x * 16, q.y * 9]);
  const [s1, s2, e1, e2] = z.pts.map((q) => [q.x * 16, q.y * 9]);
  const lineDist = (p, a, b) => Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
  const inside = (p) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const idx = [], u = [], xs = [], ys = [];
  for (let y = 0; y < MOT_H; y++) for (let x = 0; x < MOT_W; x++) {
    const nx = (x + 0.5) / MOT_W, ny = (y + 0.5) / MOT_H, p = [nx * 16, ny * 9];
    if (!inside(p)) continue;
    const ds = lineDist(p, s1, s2), de = lineDist(p, e1, e2);
    idx.push(y * MOT_W + x); u.push(ds / (ds + de || 1)); xs.push(nx); ys.push(ny);
  }
  m = { idx, u, xs, ys };
  laneM.set(z, m);
  return m;
}
function laneStep(t, diff) {
  const zs = preset().zones, lanes = zs.filter((z) => z.type === 'lane');
  lanes.forEach((z, k) => {
    const L = laneMask(z);
    if (!L.idx.length) return;
    let n = 0, su = 0, sx2 = 0, sy2 = 0;
    for (let j = 0; j < L.idx.length; j++) if (diff[L.idx[j]]) { n++; su += L.u[j]; sx2 += L.xs[j]; sy2 += L.ys[j]; }
    detSet(z, (n / L.idx.length) * 100 / LANE.sens);
    let T = laneT.get(z);
    if (!T) { T = { path: [], lastPush: 0, lastCheck: 0 }; laneT.set(z, T); }
    if ((n / L.idx.length) * 100 > LANE.sens && n >= 4 && t - T.lastPush >= 0.1) {
      T.path.push({ t, u: su / n, x: sx2 / n, y: sy2 / n }); T.lastPush = t;
    }
    while (T.path.length && t - T.path[0].t > LANE.keep) T.path.shift();
    if (T.path.length && t - T.lastCheck >= 0.25) { T.lastCheck = t; if (laneCheck(T, t, lanes.length > 1 ? `${preset().name} · bane ${k + 1}` : preset().name, k)) detFlash(z); }
  });
}
function laneCheck(T, t, d, k) {
  const P = T.path, n = P.length;
  if (n < 5) return;
  // udglat positionen lidt, så enkelte urolige billeder ikke tæller
  const us = P.map((_, i) => { let a = 0, c = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { a += P[j].u; c++; } return a / c; });
  let best = null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dt = P[j].t - P[i].t, du = us[j] - us[i];
    if (dt < 0.8 || dt > LANE.maxDur || du < LANE.minDist || du / dt < LANE.minSpeed) continue;
    if (!best || du > best.du || (du === best.du && j > best.j)) best = { i, j, du };
  }
  if (!best) return;
  // springet er færdigt, når bevægelsen ikke er kommet længere frem i et sekund
  const endT = P[best.j].t;
  const further = us.slice(best.j + 1).some((v) => v > us[best.j] + 0.03);
  if (t - endT < LANE.settle || further) return;
  const end = P[best.j];
  newSpring(P[best.i].t - 0.3, end.t + 0.3, { key: 'lane' + k, d, near: { x: end.x, y: end.y } });
  T.path = P.slice(best.j + 1);
  return true;
}
function newSpring(start, end, opt = {}) {
  const key = opt.key || 'air';
  // Starter der ny bevægelse kort efter den forrige (samme felt), er det samme spring (fx træneren før afsættet): forlæng det i stedet for at lave et klip mere
  const last = [...springs].reverse().find((x) => x.key === key);
  if (last && last.state === 'reading' && start - last.end < 2 && end - last.start <= 10) {
    last.end = Math.max(last.end, end);
    return;
  }
  springNo++;
  const s = { id: `${Date.now()}-${springNo}`, key, near: opt.near || null, d: opt.d || preset().name, start, end, vt: Math.round((cam.currentTime - (now() - start)) * 10) / 10, votes: {}, state: 'reading', wall: Date.now() - (now() - start) * 1000 };
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
      if (s.near && (Math.abs(f.x - s.near.x) > 0.15 || f.y > s.near.y + 0.08 || f.y < s.near.y - 0.45)) continue; // andre baner
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
  tagBusy = true;
  if (typeof OffscreenCanvas !== 'undefined' && window.createImageBitmap) {
    createImageBitmap(cam).then((bmp) => worker.postMessage({ w, h, bmp, t, maxId: S.roster.length }, [bmp])).catch(() => { tagBusy = false; });
    return;
  }
  if (tagC.width !== w) { tagC.width = w; tagC.height = h; }
  tagX.drawImage(cam, 0, 0, w, h);
  const img = tagX.getImageData(0, 0, w, h);
  worker.postMessage({ w, h, buf: img.data.buffer, t, maxId: S.roster.length }, [img.data.buffer]);
}
const recentTags = []; // {g, t}
const bgTags = []; // stillestående skilt-lignende mønstre i baggrunden
const log = [];
function finishSpring(s) {
  log.push({ vt: s.vt, dur: Math.round((s.end - s.start) * 10) / 10, votes: Object.fromEntries(Object.entries(s.votes).map(([k, v]) => [k, v.n])) });
    // Regler for at et nummer tæller:
  // 1) set mindst 3 gange i vinduet efter landingen og ikke spredt over hele billedet
  // 2) ikke en stillestående "skilt-lignende" ting i baggrunden: står den helt stille og er set samme sted
  //    ved et tidligere spring, er det baggrunden (en gymnast bevæger sig altid lidt)
  // 3) vinderen skal være tydeligt mere set end nummer to, ellers hellere "ukendt" end forkert
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const cand = [];
  for (const [id, v] of Object.entries(s.votes)) {
    const sx = spread(v.xs), sy = spread(v.ys), mx = mean(v.xs), my = mean(v.ys);
    const still = sx < 0.012 && sy < 0.012;
    let artifact = false;
    if (still) {
      const a = bgTags.find((b) => b.id === +id && Math.abs(b.x - mx) < 0.02 && Math.abs(b.y - my) < 0.02);
      if (a) { a.n++; artifact = true; } else bgTags.push({ id: +id, x: mx, y: my, n: 1 });
    }
    if (!artifact && sx < 0.5 && sy < 0.5) cand.push({ id: +id, w: v.w, n: v.n });
  }
  cand.sort((x, y) => y.w - x.w);
  const taken = new Set(recentTags.filter((r) => s.end - r.t < 8 && r.t !== s.end).map((r) => r.g));
  let ok = cand.filter((c) => c.n >= 3);
  if (ok.length && taken.has(ok[0].id)) { const alt = ok.find((c) => !taken.has(c.id) && c.w >= ok[0].w * 0.4); if (alt) ok = [alt, ...ok.filter((c) => c !== alt)]; }
  let pick = ok[0];
  const runner = cand.find((c) => pick && c.id !== pick.id);
  if (pick && runner && pick.w < runner.w * 1.5) pick = null;
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
    try {
      if (ring.length && ring[0].data) await makeClip264(s, a, b);
      else {
        const frames = ring.filter((f) => f.t >= a && f.t <= b && f.blob);
        if (frames.length > 5) await makeClip(s, frames);
      }
    } catch (e) { console.warn('klip fejlede', e); }
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

// ---------- Cache af klip (links og filer i hukommelsen) ----------
// Links: klip-id → { url, exp }. Et link genbruges, så længe der er mere end 5 min tilbage (så browserens egen cache rammer).
const urlCache = new Map(), URL_MARGIN = 5 * 60 * 1000;
function urlExp(u) {
  try { const p = JSON.parse(atob(new URL(u).searchParams.get('token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (p.exp) return p.exp * 1000; } catch {}
  return Date.now() + 30 * 60 * 1000;
}
function urlGet(id) { const e = urlCache.get(id); return e && e.exp - Date.now() > URL_MARGIN ? e.url : null; }
function urlPut(id, url, exp) {
  if (!id || !url) return url;
  const old = urlGet(id); if (old) return old; // behold det gamle link, så browserens cache rammer
  urlCache.set(id, { url, exp: exp || urlExp(url) });
  return url;
}
// Filer: fjern-klip hentes én gang som Blob → objectURL, så spoling sker lokalt. Loft ca. 60 MB, ældste ud først.
const blobC = new Map(), blobPend = new Map(), BLOB_MAX = 60 * 1024 * 1024;
function blobInUse(id) { return (cmp.a?.id === id || cmp.b?.id === id) || (!$('player').hidden && plClip?.id === id); }
function blobEvict(keep) {
  let tot = 0; blobC.forEach((e) => (tot += e.size));
  for (const [id, e] of blobC) {
    if (tot <= BLOB_MAX) break;
    if (id === keep || blobInUse(id)) continue;
    URL.revokeObjectURL(e.obj); blobC.delete(id); tot -= e.size;
  }
}
async function remoteBlobUrl(c) {
  if (!c.url) return null;
  const hit = blobC.get(c.id);
  if (hit) { blobC.delete(c.id); blobC.set(c.id, hit); return hit.obj; }
  if (!blobPend.has(c.id)) {
    blobPend.set(c.id, (async () => {
      try {
        const r = await fetch(c.url);
        if (!r.ok) throw 0;
        const blob = await r.blob();
        if (blob.size < 1000) throw 0;
        const e = { blob, obj: URL.createObjectURL(blob), size: blob.size };
        blobC.set(c.id, e); blobEvict(c.id);
        return e.obj;
      } catch { return null; }
      finally { blobPend.delete(c.id); }
    })());
  }
  return (await blobPend.get(c.id)) || c.url; // fejler hentning, brug linket direkte
}
let clipPool = []; // klippene i den liste, afspilleren er åbnet fra (til "Sammenlign med forrige")

// ---------- Afspiller ----------
const plV = $('plVideo'), plC = $('plCanvas');
let plUrl = null, plTimer = null, plRate = 1, plClip = null;
async function openClip(id) {
  const c = typeof id === 'object' ? id : await getClip(id);
  if (!c) return;
  plClip = c; plRate = 1; $('plSlow').textContent = 'Slowmotion';
  $('plTitle').textContent = `${gName(c.g)} · ${fmtTime(c.at)}`;
  $('player').hidden = false; plV.dataset.blob = '';
  $('plPrev').hidden = !(c.g > 0 && (c.blob || c.url));
  if (plUrl) { URL.revokeObjectURL(plUrl); plUrl = null; }
  if (c.url) {
    plC.hidden = true; plV.hidden = false; plUrl = null;
    plV.src = c.url; plV.playbackRate = 1; plV.play().catch(() => {});
    $('plSave').hidden = true;
    remoteBlobUrl(c); // hent i baggrunden, så slowmotion kan spole lokalt
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
async function plSwap() { // skift fra link til lokal fil, så spoling er glat
  const c = plClip;
  if (!c?.url || plV.dataset.blob === c.id) return;
  const u = await remoteBlobUrl(c);
  if (!u || u === c.url || plClip !== c || plV.dataset.blob === c.id) return;
  const t = plV.currentTime, pa = plV.paused;
  plV.dataset.blob = c.id; plV.src = u;
  plV.addEventListener('loadedmetadata', () => { plV.currentTime = t; plV.playbackRate = plRate; if (!pa) plV.play().catch(() => {}); }, { once: true });
}
function prevClip(c) {
  const same = clipPool.filter((x) => x.id !== c.id && x.g === c.g && x.at < c.at).sort((a, b) => b.at - a.at);
  return same.find((x) => (x.d || '') === (c.d || '')) || same[0] || null;
}
$('plPrev').onclick = async () => {
  const c = plClip, p = c && c.g > 0 ? prevClip(c) : null;
  if (!p) { toast('Ingen tidligere spring fra samme gymnast'); return; }
  const full = p.url || p.blob ? p : await getAny(p.id);
  if (!full || !(full.url || full.blob)) { toast('Det forrige klip kan ikke sammenlignes'); return; }
  $('player').hidden = true; plV.pause(); clearTimeout(plTimer);
  openCompare(full, c);
};
$('plSlow').onclick = () => {
  plRate = plRate === 1 ? 0.4 : 1;
  $('plSlow').textContent = plRate === 1 ? 'Slowmotion' : 'Normal fart';
  if (plRate !== 1) plSwap();
  if (plClip?.blob || plClip?.url) plV.playbackRate = plRate; else playFrames(plClip.frames);
};
$('plReplay').onclick = () => {
  if (plClip?.blob || plClip?.url) { plV.currentTime = 0; plV.playbackRate = plRate; plV.play().catch(() => {}); } else playFrames(plClip.frames);
};

// ---------- Holdomgang ----------
// Et langt klip fra man trykker, til man trykker igen (spring i strøm). Det gives til hele holdet, så alle gymnaster kan se det.
// Optages med enhedens videochip i højst 720p og ca. 1,2 Mbit/s. Deles i stykker á 90 s, så hver fil kan sendes op (grænse 25 MB).
const HOLD_PART = 90, HOLD_BPS = 1_200_000, HOLD_LONG = 1280, HOLD_SHORT = 720; // 90 s × 1,2 Mbit/s ≈ 14 MB pr. fil
const hold = { out: null, cv: null, raf: 0, vfc: 0, iv: 0, on: false, rec: null, id0: 0, t0: 0, no: 0, cut: 0, timer: 0, mime: '', thumb: '' };
function camThumb() {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const vw = cam.videoWidth || 16, vh = cam.videoHeight || 9, r = Math.max(320 / vw, 180 / vh);
  try { c.getContext('2d').drawImage(cam, (320 - vw * r) / 2, (180 - vh * r) / 2, vw * r, vh * r); } catch {}
  return c.toDataURL('image/jpeg', 0.7);
}
function holdStream() {
  let st = null;
  if (stream && stream.active) st = stream;
  else { try { st = cam.captureStream ? cam.captureStream() : cam.mozCaptureStream ? cam.mozCaptureStream() : null; } catch { st = null; } }
  if (!st) return null;
  // Er billedet allerede højst ca. 720p, optages kameraet direkte (billigst). Ellers skaleres via et lærred.
  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (!vw || !vh || (Math.max(vw, vh) <= HOLD_LONG && Math.min(vw, vh) <= HOLD_SHORT)) return st;
  const k = Math.min(HOLD_LONG / Math.max(vw, vh), HOLD_SHORT / Math.min(vw, vh));
  const cv = document.createElement('canvas');
  cv.width = Math.round((vw * k) / 2) * 2; cv.height = Math.round((vh * k) / 2) * 2;
  let x, out;
  try { x = cv.getContext('2d', { alpha: false }); out = cv.captureStream(30); } catch { return st; }
  if (!out || !out.getVideoTracks().length) return st;
  const draw = () => { try { x.drawImage(cam, 0, 0, cv.width, cv.height); } catch {} };
  draw();
  hold.cv = cv;
  if (cam.requestVideoFrameCallback) { const loop = () => { draw(); hold.vfc = cam.requestVideoFrameCallback(loop); }; hold.vfc = cam.requestVideoFrameCallback(loop); }
  else hold.iv = setInterval(draw, 33);
  return out;
}
function holdFree() {
  if (hold.vfc && cam.cancelVideoFrameCallback) try { cam.cancelVideoFrameCallback(hold.vfc); } catch {}
  clearInterval(hold.iv); hold.vfc = 0; hold.iv = 0;
  if (hold.cv) { hold.cv = null; if (hold.out) hold.out.getTracks().forEach((t) => t.stop()); }
  hold.out = null;
}
function holdStart() {
  const mime = pickMime();
  if (!running || !(stream?.active || cam.videoWidth)) { toast('Start kameraet først'); return; }
  if (!mime) { toast('Holdomgang kan ikke optages i denne browser'); return; }
  const st = holdStream();
  if (!st) { toast('Start kameraet først'); return; }
  hold.out = hold.cv ? st : null;
  hold.on = true; hold.id0 = Date.now(); hold.t0 = Date.now(); hold.no = 0; hold.mime = mime; hold.thumb = camThumb();
  holdPart(st);
  clearInterval(hold.timer); hold.timer = setInterval(holdUI, 1000); holdUI();
  toast('Holdomgang optages. Tryk igen for at stoppe.');
}
function holdPart(st) {
  const no = ++hold.no, at = Date.now(), parts = [];
  let rec;
  try { rec = new MediaRecorder(st, { mimeType: hold.mime, videoBitsPerSecond: HOLD_BPS }); }
  catch (e) { hold.on = false; holdFree(); holdUI(); toast('Holdomgang kunne ikke startes'); return; }
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => holdSave(no, at, Date.now(), parts, no === 1 ? hold.thumb : camThumb());
  rec.start(1000);
  hold.rec = rec;
  clearTimeout(hold.cut);
  hold.cut = setTimeout(() => { if (hold.on && hold.rec === rec) { rec.stop(); holdPart(st); } }, HOLD_PART * 1000);
}
function holdStop() {
  if (!hold.on) return;
  hold.on = false; clearTimeout(hold.cut); clearInterval(hold.timer);
  try { if (hold.rec && hold.rec.state !== 'inactive') hold.rec.stop(); } catch {}
  hold.rec = null; holdUI();
  setTimeout(() => { if (!hold.on) holdFree(); }, 500); // lad sidste stykke blive afsluttet
}
async function holdSave(no, at, end, parts, thumb) {
  const blob = new Blob(parts, { type: hold.mime.split(';')[0] });
  if (blob.size < 1000) return;
  const c = { id: `${hold.id0}-hold${no}`, d: no === 1 ? 'Holdomgang' : `Holdomgang · del ${no}`, at, g: TEAM, dur: Math.round((end - at) / 100) / 10, thumb, blob, mime: blob.type };
  await putClip(c); refreshLists(); setRec();
  toast(no === 1 && !hold.on ? 'Holdomgang gemt' : `Holdomgang del ${no} gemt`);
  cloudUpload(c);
}
function holdUI() {
  const b = $('holdBtn');
  const sec = Math.floor((Date.now() - hold.t0) / 1000);
  b.textContent = hold.on ? `■ Stop holdomgang ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : 'Holdomgang';
  b.classList.toggle('rec', hold.on);
  b.setAttribute('aria-pressed', hold.on);
}
$('holdBtn').onclick = () => (hold.on ? holdStop() : holdStart());

// ---------- Sammenlign to klip ----------
// To klip afspilles samtidig med fælles knapper. Det andet klip kan rykkes, så afsættet sker samtidig.
let cmpPick = null; // null = ikke i gang, ellers de valgte klip
const cmp = { a: null, b: null, off: 0, rate: 1, urls: [], raf: 0, t0: 0, t1: 0 };
const cA = $('cmpA'), cB = $('cmpB');
function pickForCompare(c, btn, rerender) {
  if (!c.blob && !c.url) { toast('Det klip kan ikke sammenlignes (det er gemt som enkeltbilleder).'); return; }
  const i = cmpPick.findIndex((x) => x.id === c.id);
  if (i >= 0) { cmpPick.splice(i, 1); btn.closest('.clip').classList.remove('sel'); return; }
  cmpPick.push(c); btn.closest('.clip').classList.add('sel');
  if (cmpPick.length === 2) { const [a, b] = cmpPick; cmpPick = null; rerender(); openCompare(a, b); }
  else toast('Vælg ét klip mere');
}
async function cmpSrc(c) { if (c.url) return remoteBlobUrl(c); const u = URL.createObjectURL(c.blob); cmp.urls.push(u); return u; }
function cmpLabel(c) { return `${c.g ? gName(c.g) : 'Ukendt'} · ${fmtTime(c.at)}`; }
async function openCompare(a, b) {
  cmp.a = a; cmp.b = b; cmp.off = 0; cmp.rate = 1;
  $('cmpAt').textContent = cmpLabel(a); $('cmpBt').textContent = cmpLabel(b);
  $('cmpSlow').textContent = 'Slowmotion';
  $('cmpBox').classList.toggle('stack', innerHeight > innerWidth);
  if (a.url || b.url) toast('Henter klip …');
  const [sa, sb2] = await Promise.all([cmpSrc(a), cmpSrc(b)]);
  if (cmp.a !== a || cmp.b !== b) return;
  cA.src = sa; cB.src = sb2;
  $('cmp').hidden = false;
  await Promise.all([cA, cB].map((v) => (v.readyState >= 1 ? 0 : new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; }))));
  cmpRange(); cmpSeek(cmp.t0); cmpPlay(true);
}
function cmpDur(v, c) { return isFinite(v.duration) && v.duration > 0 ? v.duration : c.dur || 5; }
// fælles tid t: A viser t, B viser t + off. Tidslinjen dækker kun det stykke, hvor begge har billeder.
function cmpRange() {
  const dA = cmpDur(cA, cmp.a), dB = cmpDur(cB, cmp.b);
  cmp.t0 = Math.max(0, -cmp.off); cmp.t1 = Math.max(cmp.t0 + 0.1, Math.min(dA, dB - cmp.off));
  $('cmpOff').textContent = `${cmp.off > 0 ? '+' : ''}${cmp.off.toFixed(1).replace('.', ',')} s`;
}
function cmpSeek(t) {
  t = Math.max(cmp.t0, Math.min(cmp.t1, t));
  cA.currentTime = t; cB.currentTime = t + cmp.off;
  $('cmpScrub').value = Math.round(((t - cmp.t0) / (cmp.t1 - cmp.t0)) * 1000);
}
function cmpPlay(on) {
  cancelAnimationFrame(cmp.raf);
  if (!on) { cA.pause(); cB.pause(); $('cmpPlay').textContent = 'Afspil'; return; }
  cA.playbackRate = cB.playbackRate = cmp.rate;
  cA.play().catch(() => {}); cB.play().catch(() => {});
  $('cmpPlay').textContent = 'Pause';
  const tick = () => {
    if ($('cmp').hidden) return;
    const t = cA.currentTime;
    if (t >= cmp.t1 - 0.02 || cA.ended) { cmpSeek(cmp.t0); } // forfra igen, så man kan se det mange gange
    else {
      if (Math.abs(cB.currentTime - (t + cmp.off)) > 0.06) cB.currentTime = t + cmp.off; // hold dem i takt
      $('cmpScrub').value = Math.round(((t - cmp.t0) / (cmp.t1 - cmp.t0)) * 1000);
    }
    cmp.raf = requestAnimationFrame(tick);
  };
  cmp.raf = requestAnimationFrame(tick);
}
$('cmpPlay').onclick = () => cmpPlay(cA.paused);
$('cmpSlow').onclick = () => {
  cmp.rate = cmp.rate === 1 ? 0.4 : 1;
  $('cmpSlow').textContent = cmp.rate === 1 ? 'Slowmotion' : 'Normal fart';
  cA.playbackRate = cB.playbackRate = cmp.rate;
};
const cmpStep = (d) => { cmpPlay(false); cmpSeek(cA.currentTime + d); };
$('cmpBack').onclick = () => cmpStep(-1 / 30);
$('cmpFwd').onclick = () => cmpStep(1 / 30);
$('cmpScrub').oninput = (e) => { cmpPlay(false); cmpSeek(cmp.t0 + (+e.target.value / 1000) * (cmp.t1 - cmp.t0)); };
const cmpShift = (d) => { const t = cA.currentTime; cmp.off = Math.round((cmp.off + d) * 10) / 10; cmpRange(); cmpSeek(t); };
$('cmpOffM').onclick = () => cmpShift(-0.1);
$('cmpOffP').onclick = () => cmpShift(0.1);
$('cmpLayout').onclick = () => $('cmpBox').classList.toggle('stack');
$('cmpClose').onclick = () => {
  cmpPlay(false); $('cmp').hidden = true; cmp.a = cmp.b = null;
  cA.removeAttribute('src'); cB.removeAttribute('src'); cA.load(); cB.load();
  cmp.urls.forEach((u) => URL.revokeObjectURL(u)); cmp.urls = [];
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
  const hit = urlGet(id);
  if (hit) return { ...m, url: hit };
  const { data } = await sb.storage.from('clips').createSignedUrl(m.path, 3600);
  return { ...m, url: data?.signedUrl ? urlPut(id, data.signedUrl, Date.now() + 3600 * 1000) : null };
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
  const list = await allClips(); clipPool = list;
  const onlyUnk = w.dataset.unk === '1';
  const shown = onlyUnk ? list.filter((c) => !c.g) : list;
  const opts = (sel) => `<option value="0"${!sel ? ' selected' : ''}>Ukendt</option><option value="${TEAM}"${sel === TEAM ? ' selected' : ''}>Holdet (alle kan se)</option>` + S.roster.map((g) => `<option value="${g.n}"${g.n === sel ? ' selected' : ''}>${esc(gName(g.n))}</option>`).join('');
  w.innerHTML = `<div class="row"><h2 style="flex:1">Klip</h2>
      <button id="assignBtn" class="acc"${list.some((c) => !c.g) ? '' : ' disabled'}>Tildel ukendte (${list.filter((c) => !c.g).length})</button>
      <button id="unkBtn" class="${onlyUnk ? 'on' : ''}">Kun ukendte</button>
      <button id="cmpBtn" class="${cmpPick ? 'on' : ''}">${cmpPick ? 'Vælg 2 klip …' : 'Sammenlign'}</button>
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
  $('cmpBtn').onclick = () => { cmpPick = cmpPick ? null : []; renderClips(); };
  w.querySelectorAll('[data-play]').forEach((b) => {
    if (cmpPick && cmpPick.some((x) => x.id === b.dataset.play)) b.closest('.clip').classList.add('sel');
    b.onclick = async () => {
      const c = await getAny(b.dataset.play);
      if (!c) return;
      if (cmpPick) return pickForCompare(c, b, renderClips);
      openClip(c);
    };
  });
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
  if (c.blob || c.url) { const v = $('asV'); if (c.blob) { asUrl = URL.createObjectURL(c.blob); v.src = asUrl; } else { v.src = c.url; remoteBlobUrl(c).then((u) => { if (u && u !== c.url && $('asV') === v) { const t = v.currentTime, r = v.playbackRate; v.src = u; v.addEventListener('loadedmetadata', () => { v.currentTime = t; v.playbackRate = r; v.play().catch(() => {}); }, { once: true }); } }); } v.play().catch(() => {}); $('asSlow').onclick = () => { v.playbackRate = v.playbackRate === 1 ? 0.4 : 1; $('asSlow').textContent = v.playbackRate === 1 ? 'Slowmotion' : 'Normal fart'; }; }
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
      <button class="acc" id="mineGo">Vis mine spring</button><p class="err" id="mineErr"></p>
      ${document.body.classList.contains('gymnast') ? '<p class="muted" style="font-size:14px;margin-top:18px">Træner? <a href="./" id="toTrainer" style="color:var(--acc)">Gå til trænersiden</a></p>' : ''}</form>`;
    if ($('toTrainer')) $('toTrainer').onclick = (e) => { e.preventDefault(); location.hash = ''; document.body.classList.remove('gymnast'); history.replaceState(null, '', location.pathname); show('live'); };
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
  const list = mineData && !mineData.local ? mineData.clips.map((c) => ({ ...c, at: Date.parse(c.at), url: urlPut(c.id, c.url) })) : (await listClips()).filter((c) => c.g === mineG || c.g === TEAM);
  clipPool = list.map((c) => ({ ...c, g: c.g ?? mineG }));
  const title = mineData?.name || S.roster.find((x) => x.n === mineG)?.name || 'Nr. ' + mineG;
  w.innerHTML = `<div class="row"><h2 style="flex:1">${esc(title)}: ${list.length} spring</h2>${list.length > 1 ? `<button id="cmpBtn" class="${cmpPick ? 'on' : ''}">${cmpPick ? 'Vælg 2 klip …' : 'Sammenlign'}</button>` : ''}<button class="acc" id="mineOut">Log ud</button></div>
    <p class="muted">Klippene bliver slettet efter ${S.keepDays} dage. Tryk på et klip for at se det, og brug Slowmotion for at se detaljerne.</p>
    ${list.length ? `<div class="grid">${list.map((c, i) => `<div class="clip"><button class="thumb" data-i="${i}" style="background-image:url('${c.thumb || ''}')" aria-label="Afspil"><span>${c.dur} s</span></button>
      <div class="meta"><b>${esc(fmtTime(c.at))}${c.d ? ` · ${esc(c.d)}` : ''}</b></div></div>`).join('')}</div>` : '<div class="empty">Ingen spring endnu.</div>'}`;
  $('mineOut').onclick = () => { mineG = null; mineData = null; renderMine(); };
  if ($('cmpBtn')) $('cmpBtn').onclick = () => { cmpPick = cmpPick ? null : []; clearTimeout(idleT); renderMine(); };
  w.querySelectorAll('[data-i]').forEach((b) => {
    const c0 = list[+b.dataset.i];
    if (cmpPick && cmpPick.some((x) => x.id === c0.id)) b.closest('.clip').classList.add('sel');
    b.onclick = async () => {
      const c = c0.url ? { ...c0, g: c0.g ?? mineG } : await getClip(c0.id);
      if (!c) return;
      if (cmpPick) { clearTimeout(idleT); return pickForCompare(c, b, renderMine); }
      openClip(c.url ? c : c.id);
    };
  });
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
    <div class="sec"><h3>Ydelse på denne enhed</h3>
      <p class="muted" id="perfTxt">${running ? perfText() : 'Start kameraet under Live for at se tallene.'}</p>
      <p class="muted" style="font-size:13px">Ved 30 billeder/sek. kører det helt glat. Står der "på hovedtråden", mangler browseren en funktion, og det kan hakke mere.</p>
      <label>Motor</label>
      <div class="grp seg" id="engSeg" role="group" aria-label="Motor"><button data-e="jpeg">Standard</button><button data-e="h264">Ny (H.264, prøve)</button></div>
      <p class="muted" style="font-size:13px">Den nye motor lader iPad'ens videochip komprimere og afspille billederne. Det burde hakke mindre og bruge mindre hukommelse. Siden genindlæses, når du skifter, og kameraet skal startes igen.</p>
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
  for (const b of $('engSeg').children) b.classList.toggle('on', b.dataset.e === (S.engine || 'jpeg'));
  $('engSeg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.e === (S.engine || 'jpeg')) return;
    S.engine = b.dataset.e; save();
    toast(S.engine === 'h264' ? 'Skifter til den nye motor …' : 'Skifter til standardmotoren …');
    setTimeout(() => location.reload(), 600);
  };
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
  const up = await sb.storage.from('clips').upload(path, c.blob, { contentType: c.blob.type, upsert: true, cacheControl: '31536000' });
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
const APP_VERSION = '20261123225711';
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

// Ny motor (tilvalg under Opsætning): billederne gemmes som H.264-video i stedet for enkelte JPEG-billeder.
// Komprimering og afkodning klares af enhedens videochip (WebCodecs), så hovedtråden har mindre at lave,
// og bufferen fylder ca. 1/4. Klip laves direkte af de gemte videostykker uden at blive optaget igen.
let ENG = 'jpeg'; // den motor, der kører lige nu
const H = { codec: '', enc: null, cfg: null, w: 0, h: 0, n: 0, seq: 0, dropped: 0 };
const H_BITRATE = 3_500_000, H_GOP = 30; // nøglebillede hvert sekund, så spoling og klip kan starte tæt på det ønskede sted
const HP = [0, 1, 2, 3].map(() => ({ dec: null, next: -1, cfg: null, q: [], cur: null, seekTs: -1 }));

function h264Possible() { return 'VideoEncoder' in window && 'VideoDecoder' in window && 'VideoFrame' in window && 'EncodedVideoChunk' in window; }
async function h264Probe() {
  if (!h264Possible()) return false;
  for (const codec of ['avc1.4d0028', 'avc1.42e028', 'avc1.640028', 'avc1.42001f']) {
    try {
      const e = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: H_BITRATE, framerate: 30, latencyMode: 'realtime', avc: { format: 'avc' } });
      const d = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 720 });
      if (e.supported && d.supported) { H.codec = codec; return true; }
    } catch {}
  }
  return false;
}
function h264Config() {
  try { if (H.enc && H.enc.state !== 'closed') H.enc.close(); } catch {}
  H.cfg = null; H.n = 0;
  H.enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig) H.cfg = { ...meta.decoderConfig, codedWidth: meta.decoderConfig.codedWidth || H.w, codedHeight: meta.decoderConfig.codedHeight || H.h };
      if (!H.cfg) return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      addFrame(chunk.timestamp / 1e6, null, { key: chunk.type === 'key', data, cfg: H.cfg, seq: H.seq++ });
    },
    error: (e) => h264Fail('Videochippen gav en fejl: ' + (e && e.message ? e.message : e)),
  });
  H.w = CAP_W; H.h = CAP_H;
  H.enc.configure({ codec: H.codec, width: H.w, height: H.h, bitrate: H_BITRATE, framerate: 30, latencyMode: 'realtime', avc: { format: 'avc' } });
}
function h264Encode(t) {
  if (!H.enc || H.enc.state === 'closed' || H.w !== CAP_W || H.h !== CAP_H) h264Config();
  if (H.enc.encodeQueueSize > 3) { H.dropped++; return; } // chippen er bagud: spring et billede over i stedet for at hobe op
  capX.drawImage(cam, 0, 0, CAP_W, CAP_H);
  let vf = null;
  try {
    vf = new VideoFrame(capC, { timestamp: Math.round(t * 1e6) });
    H.enc.encode(vf, { keyFrame: H.n++ % H_GOP === 0 });
  } catch (e) { h264Fail('Kunne ikke komprimere: ' + e.message); }
  finally { if (vf) vf.close(); }
}
function h264Fail(msg) {
  if (ENG !== 'h264') return;
  console.warn(msg);
  ENG = 'jpeg';
  try { H.enc && H.enc.close(); } catch {}
  H.enc = null;
  for (let i = 0; i < 4; i++) hpDrop(i);
  ring = []; lockFrom = null;
  toast('Den nye motor virker ikke på denne enhed. Skifter til standardmotoren.');
}

// ---------- Afspilning: én afkoder pr. billede (A-D) ----------
function hpDrop(i) {
  const p = HP[i];
  try { if (p.dec && p.dec.state !== 'closed') p.dec.close(); } catch {}
  p.dec = null; p.next = -1; p.cfg = null; p.seekTs = -1;
  for (const f of p.q) f.close();
  p.q = [];
  if (p.cur) { p.cur.close(); p.cur = null; }
  if (vs[i]) vs[i].cur = null;
}
function hpSeek(p, k) {
  const f = ring[k];
  try {
    if (!p.dec || p.dec.state === 'closed') {
      p.dec = new VideoDecoder({
        output: (fr) => { p.q.push(fr); while (p.q.length > 12) p.q.shift().close(); },
        error: (e) => { console.warn('afkoder', e); p.dec = null; p.next = -1; },
      });
      p.cfg = null;
    } else p.dec.reset();
    if (p.cfg !== f.cfg) { p.dec.configure(f.cfg); p.cfg = f.cfg; } else p.dec.configure(f.cfg);
  } catch (e) { console.warn(e); p.dec = null; p.next = -1; return; }
  for (const fr of p.q) fr.close();
  p.q = [];
  p.next = f.seq;
}
// Det billede, der skal vises i billede i ved tiden t (eller det seneste, hvis det rigtige ikke er klar endnu)
function h264Frame(i, t) {
  const p = HP[i];
  if (!ring.length || !ring[0].data) return p.cur;
  const idx = findFrame(t);
  if (idx < 0) return p.cur;
  const base = ring[0].seq, tgt = ring[idx].seq, tUs = Math.round(ring[idx].t * 1e6);
  const curTs = p.cur ? p.cur.timestamp : -1;
  const broken = !p.dec || p.dec.state === 'closed' || p.next < base || p.next - base > ring.length;
  const ahead = tgt >= p.next + 45; // langt foran: hop i stedet for at afkode alt imellem
  const behind = p.next >= 0 && tgt < p.next - 8 && tUs < curTs - 1000; // spolet tilbage
  if (broken || ahead || behind) {
    // mens en tilbagespoling stadig afkodes, ventes der, så hurtig træk ikke starter forfra hele tiden
    if (!broken && p.seekTs >= 0 && p.dec.decodeQueueSize > 0) return p.cur;
    let k = idx;
    while (k > 0 && !ring[k].key) k--;
    if (!ring[k].key) return p.cur;
    hpSeek(p, k);
    p.seekTs = tUs;
    if (!p.dec) return p.cur;
  }
  // fød afkoderen et par billeder foran det, der skal vises
  while (p.next <= tgt + 4 && p.next - base < ring.length && p.dec.decodeQueueSize < 10) {
    const f = ring[p.next - base];
    try { p.dec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.t * 1e6), data: f.data })); }
    catch (e) { console.warn(e); p.next = -1; return p.cur; }
    p.next++;
  }
  // vælg det nyeste afkodede billede, der ikke ligger efter t
  let pick = -1;
  for (let k = 0; k < p.q.length; k++) if (p.q[k].timestamp <= tUs + 2000) pick = k;
  if (pick >= 0) {
    const fr = p.q[pick];
    for (let k = 0; k < pick; k++) p.q[k].close();
    p.q.splice(0, pick + 1);
    if (p.seekTs >= 0 && fr.timestamp < p.seekTs - 2000) fr.close(); // mellembilleder efter et hop vises ikke
    else { if (p.cur) p.cur.close(); p.cur = fr; p.seekTs = -1; }
  }
  return p.cur;
}

// ---------- Klip: videostykkerne lægges direkte i en mp4-fil ----------
async function makeClip264(s, a, b) {
  let i0 = ring.findIndex((f) => f.t >= a);
  if (i0 < 0) return false;
  while (i0 > 0 && !ring[i0].key) i0--;
  while (i0 < ring.length && !ring[i0].key) i0++;
  const i1 = findFrame(b);
  if (i0 >= ring.length || i1 - i0 < 5) return false;
  const ch = ring.slice(i0, i1 + 1).filter((f) => f.cfg === ring[i0].cfg); // samme opsætning hele vejen
  const cfg = ch[0].cfg, t0 = ch[0].t;
  const mux = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: cfg.codedWidth, height: cfg.codedHeight }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  ch.forEach((f, k) => {
    const ts = Math.round((f.t - t0) * 1e6);
    const nx = ch[k + 1] ? Math.round((ch[k + 1].t - t0) * 1e6) : ts + 33333;
    mux.addVideoChunkRaw(f.data, f.key ? 'key' : 'delta', ts, Math.max(1, nx - ts), k === 0 ? { decoderConfig: cfg } : undefined);
  });
  mux.finalize();
  const blob = new Blob([mux.target.buffer], { type: 'video/mp4' });
  const mid = ch.findIndex((f) => f.t >= (s.start + s.end) / 2);
  const thumb = await thumb264(ch, mid < 0 ? ch.length >> 1 : mid);
  const dur = ch[ch.length - 1].t - t0;
  const c = { id: s.id, d: s.d, at: s.wall, g: s.g || 0, dur: Math.round(dur * 10) / 10, thumb, blob, mime: 'video/mp4' };
  await putClip(c); refreshLists(); cloudUpload(c);
  return true;
}
async function thumb264(ch, upto) {
  let last = null;
  const dec = new VideoDecoder({ output: (fr) => { if (last) last.close(); last = fr; }, error: () => {} });
  try {
    dec.configure(ch[0].cfg);
    for (let k = 0; k <= upto; k++) dec.decode(new EncodedVideoChunk({ type: ch[k].key ? 'key' : 'delta', timestamp: Math.round(ch[k].t * 1e6), data: ch[k].data }));
    await dec.flush();
  } catch {}
  try { dec.close(); } catch {}
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  if (last) {
    const iw = last.displayWidth, ih = last.displayHeight, r = Math.max(320 / iw, 180 / ih);
    c.getContext('2d').drawImage(last, (320 - iw * r) / 2, (180 - ih * r) / 2, iw * r, ih * r);
    last.close();
  }
  return c.toDataURL('image/jpeg', 0.7);
}

// til test
window.__springklip = { openClip, prevClip, setPool: (p) => { clipPool = p; }, springs: () => springs, getClip, openCompare, holdStart, holdStop, hold, startCamera, newSpring, now, perfText, resetLags, st: () => ({ ENG, ring, vs, H, HP, lags, S, laneT, laneMask, preset: preset() }), listClips, S, log, shown: () => (vs[0].cur ? vs[0].cur.t : null), ringStats: () => { const d = ring.slice(-150).map((f, i, a) => (i ? f.t - a[i - 1].t : 0)).slice(1); const m = d.reduce((x, y) => x + y, 0) / d.length; return { fps: Math.round(10 / m) / 10, max_gap_ms: Math.round(Math.max(...d) * 1000) }; } };
}
