// Læser nummerskilte (ArUco 4x4) i et billede. Kører i baggrunden, så live-billedet ikke hakker.
importScripts('lib/cv.js', 'lib/aruco.js?v=20261126233459', 'lib/aruco_4x4_1000.js');

const detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000', maxHammingDistance: 0 });

let oc = null, ox = null;
onmessage = (e) => {
  let { w, h } = e.data;
  const { buf, bmp, mw, t, maxId, ci } = e.data;
  let found = [], bw = 0, bh = 0;
  try {
    let data;
    if (bmp) {
      // brug billedets egne mål: iPhone i stående format kan melde videoens størrelse som liggende,
      // og så blev billedet mast sammen til en tredjedel af bredden
      if (mw && bmp.width && bmp.height) { const s = Math.min(1, mw / Math.max(bmp.width, bmp.height * 0.5625)); w = Math.round(bmp.width * s); h = Math.round(bmp.height * s); }
      // billedet kommer som ImageBitmap: pixel-udlæsningen sker her i baggrunden i stedet for på siden
      if (!oc || oc.width !== w || oc.height !== h) { oc = new OffscreenCanvas(w, h); ox = oc.getContext('2d', { willReadFrequently: true }); }
      ox.drawImage(bmp, 0, 0, w, h);
      bw = bmp.width; bh = bmp.height;
      bmp.close();
      data = ox.getImageData(0, 0, w, h).data;
    } else data = new Uint8ClampedArray(buf);
    let markers;
    if (ci) {
      // kun indtjekning: ingen "for tæt på"-sortering (smal hvid kant kasserede ellers selve skiltet), og spejlet reserve
      detector.notTooNear = (c) => c;
      // pas 1: som altid. Pas 2 (kun hvis intet er fundet): større tærskel-vindue, som klarer slørede og mørke billeder
      let f = null;
      const mirror = () => {
        if (!f) { f = new Uint8ClampedArray(data.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4; f[a] = data[b]; f[a + 1] = data[b + 1]; f[a + 2] = data[b + 2]; f[a + 3] = 255; } }
        const r = detector.detect({ width: w, height: h, data: f });
        r.forEach((m) => m.corners.forEach((c) => { c.x = w - 1 - c.x; }));
        return r;
      };
      markers = [];
      for (const [k, tt] of [[2, 7], [7, 5]]) {
        detector.atK = k; detector.atT = tt;
        markers = detector.detect({ width: w, height: h, data });
        if (!markers.length) markers = mirror();
        if (markers.some((m) => m.id >= 1 && m.id <= maxId)) break;
      }
      detector.atK = 2; detector.atT = 7;
    } else {
      detector.notTooNear = AR.Detector.prototype.notTooNear;
      detector.atK = 2; detector.atT = 7;
      markers = detector.detect({ width: w, height: h, data });
    }
    found = markers
      .filter((m) => m.id >= 1 && m.id <= maxId)
      .map((m) => {
        const c = m.corners;
        let per = 0;
        for (let i = 0; i < 4; i++) {
          const a = c[i], b = c[(i + 1) % 4];
          per += Math.hypot(a.x - b.x, a.y - b.y);
        }
        return { id: m.id, size: per / 4, x: (c[0].x + c[2].x) / 2 / w, y: (c[0].y + c[2].y) / 2 / h };
      });
    if (ci) {
      const best = {}; for (const m of found) if (!best[m.id] || m.size > best[m.id].size) best[m.id] = m;
      found = Object.values(best).filter((m) => m.size >= 0.04 * w).sort((a, b) => b.size - a.size); // mindre end 4 % af bredden: fejlfund
      // et "skilt" der ligger oven i det største skilt (fejlfund i mønstret) er ikke et skilt nummer to
      const B = found[0];
      if (B) found = found.filter((m) => m === B || Math.hypot((m.x - B.x) * w, (m.y - B.y) * h) > B.size * 0.6);
    }
  } catch (err) {
    found = [];
  }
  postMessage({ t, found, dim: `${w}x${h}` + (bw ? ` (billede ${bw}x${bh})` : '') });
};
