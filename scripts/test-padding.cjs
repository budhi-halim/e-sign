/* Resolution-invariance and source-edge padding regression tests. No npm dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'processor-worker.js'), 'utf8');
const self = { postMessage(message) { this.last = message; } };
vm.runInNewContext(source, { self, Uint8ClampedArray, Uint8Array, Int32Array, Int16Array, Float64Array, Math, Error, Number, Array });
const check = (test, message) => { if (!test) throw new Error(message); };
function caseAtScale(scale, padPercent) {
  const width = 300 * scale, height = 100 * scale;
  const image = new Uint8ClampedArray(width * height * 4);
  const left = 1 * scale, right = 299 * scale - 1;
  const top = 2 * scale, bottom = 98 * scale - 1;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * width + x) * 4;
      image[i] = image[i + 1] = image[i + 2] = 0;
      image[i + 3] = 255;
    }
  }
  self.onmessage({ data: { jobId: scale * 100 + padPercent, width, height, pixels: image.buffer, settings: { sensitivity:52, denoise:45, padding:padPercent, hardEdges:false } } });
  const answer = self.last;
  check(answer.ok, `Scale ${scale}: ${answer.error}`);
  const inkWidth = right - left + 1, inkHeight = bottom - top + 1;
  const padX = Math.ceil(inkWidth * padPercent / 100);
  const padY = Math.ceil(inkHeight * padPercent / 100);
  check(answer.width === inkWidth + 2 * padX, `Incorrect width at scale ${scale}`);
  check(answer.height === inkHeight + 2 * padY, `Incorrect height at scale ${scale}`);
  const pixels = new Uint8ClampedArray(answer.pixels);
  let minX = answer.width, minY = answer.height, maxX = -1, maxY = -1;
  for (let y=0;y<answer.height;y++)for(let x=0;x<answer.width;x++) {
    if (pixels[(y*answer.width+x)*4+3] <= 12) continue;
    minX=Math.min(minX,x);minY=Math.min(minY,y);
    maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
  }
  check(minX === padX && minY === padY, `Incorrect leading margins at scale ${scale}`);
  check(answer.width - maxX - 1 === padX && answer.height - maxY - 1 === padY, `Incorrect trailing margins at scale ${scale}`);
  return {scale, padPercent, inkWidth, inkHeight, outputWidth:answer.width, outputHeight:answer.height, padX, padY};
}
for(const scale of [1, 2, 3]) for(const percentage of [0, 2, 7.5]) {
  const r=caseAtScale(scale, percentage);
  console.log(`PASS ${scale}x @ ${percentage}%: ${r.outputWidth}x${r.outputHeight}, margins ${r.padX}x${r.padY}`);
}
