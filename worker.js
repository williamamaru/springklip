// Læser nummerskilte (ArUco 4x4) i et billede. Kører i baggrunden, så live-billedet ikke hakker.
importScripts('lib/cv.js', 'lib/aruco.js', 'lib/aruco_4x4_1000.js');

const detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000', maxHammingDistance: 0 });

let oc = null, ox = null;
onmessage = (e) => {
  const { w, h, buf, bmp, t, maxId } = e.data;
  let found = [];
  try {
    let data;
    if (bmp) {
      // billedet kommer som ImageBitmap: pixel-udlæsningen sker her i baggrunden i stedet for på siden
      if (!oc || oc.width !== w || oc.height !== h) { oc = new OffscreenCanvas(w, h); ox = oc.getContext('2d', { willReadFrequently: true }); }
      ox.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      data = ox.getImageData(0, 0, w, h).data;
    } else data = new Uint8ClampedArray(buf);
    const markers = detector.detect({ width: w, height: h, data });
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
  } catch (err) {
    found = [];
  }
  postMessage({ t, found });
};
