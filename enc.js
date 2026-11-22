// Komprimerer kamerabilleder til JPEG i baggrunden, så live-visningen ikke hakker.
let canvas = null, ctx = null;
onmessage = async (e) => {
  const { bmp, t, w, h, q, id } = e.data;
  try {
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d');
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    postMessage({ id, t, blob });
  } catch (err) {
    try { bmp.close(); } catch {}
    postMessage({ id, t, blob: null, err: String(err) });
  }
};
