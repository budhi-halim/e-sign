/*
 * E-Sign signature extraction core, version 0.1.
 * Runs entirely in a Web Worker. No imports, network calls, or uploads.
 * Input: RGBA ImageData pixels; output: cropped black ink with transparency.
 * Algorithm: preserve source alpha if already transparent; otherwise use
 * local mean luminance (summed-area table) to suppress shadows/background;
 * remove weak isolated connected components; preserve anti-aliased edges.
 */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function processSignature(w, h, rgba, settings) {
  const N = w * h;
  if (!w || !h || N > 10000000) throw new Error('Image dimensions exceed the processing limit.');
  const input = new Uint8ClampedArray(rgba);
  if (input.length !== N * 4) throw new Error('Invalid image buffer.');
  const alpha = new Uint8Array(N);
  const lum = new Uint8Array(N);
  let nonOpaque = 0, nonClear = 0;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const a = input[j + 3];
    if (a < 235) nonOpaque++;
    if (a > 20) nonClear++;
    lum[i] = Math.round(input[j] * 0.2126 + input[j + 1] * 0.7152 + input[j + 2] * 0.0722);
  }
  const transparentSource = nonOpaque > N * 0.015 && nonClear > N * 0.0002;
  let score;
  let core = new Uint8Array(N);
  if (transparentSource) {
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      // The alpha channel is authoritative: don't mistake a transparent black background for ink.
      alpha[i] = input[j + 3];
      if (alpha[i] >= 45) core[i] = 1;
    }
  } else {
    score = new Int16Array(N);
    const W = w + 1;
    const summed = new Float64Array(W * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      for (let x = 1; x <= w; x++) {
        rowSum += lum[(y - 1) * w + x - 1];
        summed[y * W + x] = summed[(y - 1) * W + x] + rowSum;
      }
    }
    const r = Math.max(12, Math.min(100, Math.round(Math.min(w, h) * 0.092)));
    const threshold = 32 - (Number(settings.sensitivity ?? 52) - 52) * 0.42;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const local = (summed[y1 * W + x1] - summed[y0 * W + x1] - summed[y1 * W + x0] + summed[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
        const i = y * w + x;
        score[i] = Math.round(local - lum[i]);
        if (score[i] >= threshold) core[i] = 1;
      }
    }
  }

  // 8-connected components; reject border-attached regions and small dust.
  const labels = new Int32Array(N), queue = new Int32Array(N);
  const comps = [];
  let label = 0, maximum = 0;
  for (let i = 0; i < N; i++) {
    if (!core[i] || labels[i]) continue;
    label++;
    let head = 0, tail = 1, size = 0;
    let minx = w, miny = h, maxx = 0, maxy = 0;
    queue[0] = i; labels[i] = label;
    while (head < tail) {
      const p = queue[head++], yy = (p / w) | 0, xx = p - yy * w;
      size++;
      if (xx < minx) minx = xx;
      if (xx > maxx) maxx = xx;
      if (yy < miny) miny = yy;
      if (yy > maxy) maxy = yy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = yy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = xx + dx;
          if (nx < 0 || nx >= w || (!dx && !dy)) continue;
          const q = ny * w + nx;
          if (core[q] && !labels[q]) { labels[q] = label; queue[tail++] = q; }
        }
      }
    }
    const touchesBorder = minx === 0 || miny === 0 || maxx === w-1 || maxy === h-1;
    comps.push({label,size,minx,miny,maxx,maxy,touchesBorder});
    if (!touchesBorder && size > maximum) maximum = size;
  }
  if (!maximum) throw new Error('No separable signature strokes detected. Try a closer crop or another source image.');
  const noise = Number(settings.denoise ?? 45);
  const minArea = Math.max(3, Math.round(maximum * 0.013 * Math.pow(noise / 100, 2)));
  const keep = new Uint8Array(label + 1);
  for (const c of comps) if (!c.touchesBorder && c.size >= minArea) keep[c.label] = 1;
  // One-pixel expansion adds smooth edges around the accepted dark core, without adding distant dust.
  let accepted = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (labels[i] && keep[labels[i]]) accepted[i] = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (accepted[i] !== 1) continue;
      const neighbors = [i - w - 1,i - w,i - w + 1,i - 1,i + 1,i + w - 1,i + w,i + w + 1];
      for (let k = 0; k < 8; k++) {
        const nx = x + [-1,0,1,-1,1,-1,0,1][k];
        const ny = y + [-1,-1,-1,0,0,1,1,1][k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const p = neighbors[k];
        if (transparentSource ? alpha[p] > 0 : score[p] > (32 - (Number(settings.sensitivity ?? 52) - 52)*0.42) - 18) { if (!accepted[p]) accepted[p] = 2; }
      }
    }
  }
  // Fill output mask and bounding box.
  let xmin = w, xmax = -1, ymin = h, ymax = -1, inkCount = 0;
  const cutoff = 32 - (Number(settings.sensitivity ?? 52) - 52) * 0.42;
  for (let i = 0; i < N; i++) {
    if (!accepted[i]) { alpha[i] = 0; continue; }
    const raw = transparentSource ? alpha[i] : Math.round((score[i] - (cutoff - 18)) * 255 / 54);
    const a = settings.hardEdges ? (raw >= 90 ? 255 : 0) : clamp(raw,0,255);
    alpha[i] = a;
    if (a < 12) continue;
    const y = (i / w) | 0, x = i - y * w;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
    inkCount++;
  }
  if (xmax < xmin || inkCount < 10) throw new Error('The algorithm could not isolate enough signature ink. Increase sensitivity or try another image.');
  const margin = clamp(Number(settings.padding ?? 6),0,20) / 100;
  const mx = Math.max(8, Math.round((xmax - xmin + 1) * margin));
  const my = Math.max(8, Math.round((ymax - ymin + 1) * margin));
  const x0 = Math.max(0, xmin - mx), y0 = Math.max(0, ymin - my);
  const x1 = Math.min(w, xmax + mx + 1), y1 = Math.min(h, ymax + my + 1);
  const ow = x1 - x0, oh = y1 - y0;
  const result = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const p = (y * ow + x) * 4;
      result[p] = result[p + 1] = result[p + 2] = 0;
      result[p + 3] = alpha[(y + y0) * w + x + x0];
    }
  }
  return {width:ow,height:oh,pixels:result.buffer,metadata:{mode:transparentSource?'preserved alpha':'local contrast',inkPixels:inkCount,components:comps.length,retainedComponents:comps.filter(c=>keep[c.label]).length,sourceWidth:w,sourceHeight:h}};
}
self.onmessage = function(event) {
  const {jobId,width,height,pixels,settings} = event.data;
  try {
    const output = processSignature(width,height,pixels,settings);
    self.postMessage({jobId,ok:true,...output},[output.pixels]);
  } catch (error) {
    self.postMessage({jobId,ok:false,error:error?.message || String(error)});
  }
};
