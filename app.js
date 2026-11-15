/* E-Sign browser test bench. No API calls upload file content. */
const REFERENCE = [
  {title:'Transparent PNG',description:'Clean source artwork, already transparent.',file:'assets/administrator-transparent.png',type:'PNG'},
  {title:'White-background JPG',description:'High-contrast signature on plain white.',file:'assets/administrator-white.jpg',type:'JPG'},
  {title:'Scanned paper',description:'Scanned ink, paper grain and light dust.',file:'assets/administrator-scan.jpg',type:'JPG'},
  {title:'Angled paper photograph',description:'Perspective, surface texture and uneven lighting.',file:'assets/administrator-photo.jpg',type:'JPG'}
];
const $ = (s,parent=document) => parent.querySelector(s);
const cards = [];
const DEFAULTS=Object.freeze({sensitivity:52,denoise:45,rotation:0});
const FIELDS=[['sensitivity','Ink sensitivity',0,100,'Higher captures faint strokes.'],['denoise','Noise removal',0,100,'Higher removes small isolated marks.'],['rotation','Rotation',-20,20,'Correct the angle in 1° steps.']];
const STORAGE_KEY='e-sign:settings:v1';
const WAIT_MS=100;
const queue=new Map(); // One pending request per card; one active job globally.
let draining=false,workerFailed=false,cardSeq=0;
let jobSeq = 0;
const pending = new Map();
const worker = new Worker('./processor-worker.js');
worker.onmessage = e => { const task = pending.get(e.data.jobId); if(task){pending.delete(e.data.jobId); e.data.ok?task.resolve(e.data):task.reject(new Error(e.data.error));} };
worker.onerror = e => {workerFailed=true;console.error('Processing worker failed',e); for(const t of pending.values())t.reject(new Error('Processing worker stopped. Reload the page.'));pending.clear();};
worker.onmessageerror=()=>{workerFailed=true;for(const t of pending.values())t.reject(new Error('Processing worker returned an invalid message. Reload the page.'));pending.clear();};
let toastTimer;
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);}
const escapeHtml = str => String(str).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const extOf = name => (name.split('.').pop()||'').toLowerCase();
const bytes = n => n<1024?'1 KB':n<1048576?`${Math.ceil(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
function sameSettings(a,b){return FIELDS.every(([id])=>a[id]===b[id]);}
function readSaved(){try{const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}}
function remembered(key){if(!key)return null;const saved=readSaved()[key];if(!saved||!FIELDS.every(([id,,min,max])=>Number.isInteger(saved[id])&&saved[id]>=min&&saved[id]<=max))return null;return Object.fromEntries(FIELDS.map(([id])=>[id,saved[id]]));}
function remember(key,settings){if(!key)return false;try{const data=readSaved();delete data[key];if(!sameSettings(settings,DEFAULTS))data[key]=Object.fromEntries(FIELDS.map(([id])=>[id,settings[id]]));localStorage.setItem(STORAGE_KEY,JSON.stringify(data));return true;}catch{return false;}}
async function fingerprint(blob){try{const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}catch{return null;}}
function updateControls(card){for(const [id] of FIELDS){const input=$(`[data-field="${id}"]`,card.el),v=card.settings[id];input.value=v;const row=input.closest('.adjust-field');$('output',row).textContent=id==='rotation'?`${v}°`:v;$('[data-step="-1"]',row).disabled=v<=+input.min;$('[data-step="1"]',row).disabled=v>=+input.max;}$('.reset-card',card.el).disabled=sameSettings(card.settings,DEFAULTS);}
function controlsMarkup(id){return `<section class="adjust-panel" aria-label="Adjust this signature" hidden><div class="adjust-head"><h4>Adjust result</h4><button type="button" class="button button-quiet reset-card">Reset defaults</button></div><div class="adjust-grid">${FIELDS.map(([field,label,min,max,hint])=>`<div class="adjust-field"><div class="adjust-label"><label for="${id}-${field}" title="${hint}">${label}</label><output for="${id}-${field}">${DEFAULTS[field]}${field==='rotation'?'°':''}</output></div><div class="adjust-range"><button type="button" class="step-button" data-step="-1" aria-label="Decrease ${label.toLowerCase()}" title="Decrease ${label.toLowerCase()}">−</button><input id="${id}-${field}" data-field="${field}" type="range" min="${min}" max="${max}" step="1" value="${DEFAULTS[field]}" title="${hint}"><button type="button" class="step-button" data-step="1" aria-label="Increase ${label.toLowerCase()}" title="Increase ${label.toLowerCase()}">+</button></div></div>`).join('')}</div><p class="remember-note" aria-live="polite"></p></section>`;}
function canvasFromDimensions(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
function canvasToBlob(canvas,type='image/png',quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not export canvas.')),type,quality));}
function loadImage(blob){return new Promise((resolve,reject)=>{const img=new Image();const u=URL.createObjectURL(blob);img.onload=()=>{URL.revokeObjectURL(u);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(u);reject(new Error('The browser could not decode this image.'))};img.src=u;});}
function paintScaled(source,w,h){const limit=3000000,scale=Math.min(1,2300/Math.max(w,h),Math.sqrt(limit/(w*h)));const W=Math.max(1,Math.round(w*scale)),H=Math.max(1,Math.round(h*scale));const canvas=canvasFromDimensions(W,H);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,W,H);return canvas;}
const scriptPromises=new Map();
function lazyScript(url,expected){if(expected())return Promise.resolve();if(!scriptPromises.has(url)){scriptPromises.set(url,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.async=true;s.onload=()=>expected()?resolve():reject(new Error('Decoder library did not initialize.'));s.onerror=()=>reject(new Error('Decoder library could not be downloaded. Check the network connection.'));document.head.appendChild(s);}));}return scriptPromises.get(url);}
async function preferLocalDecoder(local,cdn,ready){
  try { await lazyScript(local,ready); return true; }
  catch { await lazyScript(cdn,ready); return false; }
}
function cleanedSVG(source){if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('SVG files containing DTD or entity declarations are not accepted.');const xml=new DOMParser().parseFromString(source,'image/svg+xml');if(xml.querySelector('parsererror'))throw new Error('Invalid SVG markup.');const root=xml.documentElement;if(root.localName.toLowerCase()!=='svg')throw new Error('Not an SVG image.');const allowedTags=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','lineargradient','radialgradient','stop','text','tspan']);const allowedAttrs=new Set(['xmlns','width','height','viewbox','preserveaspectratio','fill','stroke','stroke-width','stroke-linejoin','stroke-linecap','stroke-dasharray','stroke-dashoffset','stroke-opacity','fill-opacity','fill-rule','opacity','d','points','transform','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','offset','stop-color','stop-opacity','font-family','font-size','font-style','font-weight','text-anchor','dominant-baseline','id']);function clean(node){for(const child of [...node.children]){const t=child.localName?.toLowerCase();if(!allowedTags.has(t)){child.remove();continue;}clean(child);}for(const attr of [...node.attributes]){const n=attr.name.toLowerCase();const value=attr.value;if(!allowedAttrs.has(n)||/url\s*\(|javascript:|data:|https?:|@import|expression\s*\(/i.test(value))node.removeAttribute(attr.name);}}
clean(root);return new XMLSerializer().serializeToString(xml);}
async function loadDocument(blob,name,type,page=1){
  const ext=extOf(name),mime=(type||'').toLowerCase();
  if(ext==='pdf'||mime==='application/pdf'){
    const local=await preferLocalDecoder('./vendor/pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',()=>Boolean(globalThis.pdfjsLib));
    const pdfjs=globalThis.pdfjsLib;pdfjs.GlobalWorkerOptions.workerSrc=local?new URL('./vendor/pdf.worker.min.js',document.baseURI).href:'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf=await pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false}).promise;
    const count=pdf.numPages;const n=Math.min(Math.max(page,1),count);const pdfPage=await pdf.getPage(n);const origin=pdfPage.getViewport({scale:1});const factor=Math.min(2.5,2300/Math.max(origin.width,origin.height),Math.sqrt(3000000/(origin.width*origin.height)));
    const view=pdfPage.getViewport({scale:Math.max(.2,factor)});const canvas=canvasFromDimensions(Math.ceil(view.width),Math.ceil(view.height));const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);await pdfPage.render({canvasContext:ctx,viewport:view}).promise;pdf.destroy();return {canvas,pageCount:count,format:'PDF'};
  }
  if(ext==='heic'||ext==='heif'||mime==='image/heic'||mime==='image/heif'){
    await preferLocalDecoder('./vendor/heic-to.js','https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/iife/heic-to.js',()=>Boolean(globalThis.HeicTo));
    const converted=await globalThis.HeicTo({blob,type:'image/png'});
    const image=await loadImage(converted);return {canvas:paintScaled(image,image.naturalWidth,image.naturalHeight),pageCount:1,format:'HEIC/HEIF'};
  }
  if(['tif','tiff'].includes(ext)||mime==='image/tiff'){
    await preferLocalDecoder('./vendor/pako.min.js','https://cdn.jsdelivr.net/npm/pako@1.0.11/dist/pako.min.js',()=>Boolean(globalThis.pako));
    await preferLocalDecoder('./vendor/UTIF.js','https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js',()=>Boolean(globalThis.UTIF));
    const buffer=await blob.arrayBuffer();const ifds=globalThis.UTIF.decode(buffer);if(!ifds.length)throw new Error('TIFF has no image frames.');const n=Math.min(Math.max(page,1),ifds.length);const frame=ifds[n-1];globalThis.UTIF.decodeImage(buffer,frame);const rgba=globalThis.UTIF.toRGBA8(frame);
    if(frame.width*frame.height>16000000)throw new Error('TIFF dimensions exceed the limit.');
    const c=canvasFromDimensions(frame.width,frame.height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),frame.width,frame.height),0,0);return {canvas:paintScaled(c,c.width,c.height),pageCount:ifds.length,format:'TIFF'};
  }
  if(ext==='svg'||mime==='image/svg+xml'){
    const xml=cleanedSVG(await blob.text());const img=await loadImage(new Blob([xml],{type:'image/svg+xml'}));return {canvas:paintScaled(img,img.naturalWidth||1000,img.naturalHeight||350),pageCount:1,format:'SVG'};
  }
  if(!['png','jpg','jpeg','gif','bmp','webp','avif','ico'].includes(ext)&&!mime.startsWith('image/'))throw new Error('Unsupported image format.');
  const image=await loadImage(blob);return {canvas:paintScaled(image,image.naturalWidth,image.naturalHeight),pageCount:1,format:ext.toUpperCase()||'IMAGE'};
}
function makeCard({title,description,number,custom=false,filename}){
  const article=document.createElement('article');article.className='signature-card';
  article.innerHTML=`<div class="card-head"><div class="card-heading"><span class="card-index">${escapeHtml(number)}</span><div><h3 title="${escapeHtml(filename||title)}">${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div></div><span class="card-status running">Loading</span></div><div class="comparison"><div class="compare-pane"><div class="pane-label"><span>Before</span><span class="original-dims"></span></div><div class="image-view"><span class="pane-placeholder">Reading source…</span><img alt="Original signature source" hidden></div></div><div class="compare-pane"><div class="pane-label"><span>After · PNG</span><span class="output-dims"></span></div><div class="image-view checker"><span class="pane-placeholder">Processing…</span><img alt="Extracted transparent signature" hidden></div></div></div><div class="card-bottom"><span class="card-meta">Preparing image…</span><div class="card-actions"><label class="page-select" hidden>Page <select aria-label="Choose PDF or TIFF page"></select></label><button class="button button-outline button-small remove" type="button" ${custom?'':'hidden'}>Remove</button><button class="button button-outline button-small download" type="button" disabled>PNG ↓</button></div></div><p class="card-error" hidden></p>`;
  article.insertAdjacentHTML('beforeend',controlsMarkup(`card-${++cardSeq}`));
  $('.adjust-head',article).insertAdjacentHTML('beforeend','<button type="button" class="button button-outline button-small remember-card" disabled>Remember settings</button>');
  const card={el:article,custom,filename:filename||title,sourceCanvas:null,sourceBlob:null,outputBlob:null,outputUrl:null,revision:0,settings:{...DEFAULTS},ready:false};
  $('.remove',article).addEventListener('click',()=>{card.removed=true; cancelRequest(card); clearPreviews(card);card.sourceCanvas=null;card.sourceBlob=null;article.remove();const idx=cards.indexOf(card);if(idx>=0)cards.splice(idx,1);});
  $('.download',article).addEventListener('click',()=>{if(card.ready&&card.outputBlob){acceptSettings(card);saveBlob(card.outputBlob,`${safeFileName(card.filename)}-transparent.png`);}});
  $('.page-select select',article).addEventListener('change',async e=>{if(!card.sourceBlob)return;await decodeCard(card,card.sourceBlob,+e.target.value);});
  for(const [field] of FIELDS){const input=$(`[data-field="${field}"]`,article),row=input.closest('.adjust-field');input.addEventListener('input',()=>{card.settings[field]=+input.value;updateControls(card);requestProcess(card);});input.addEventListener('change',()=>requestProcess(card,true));input.addEventListener('pointerup',()=>requestProcess(card,true));for(const button of row.querySelectorAll('[data-step]'))button.addEventListener('click',()=>{card.settings[field]=Math.max(+input.min,Math.min(+input.max,card.settings[field]+Number(button.dataset.step)));updateControls(card);requestProcess(card,true);});}
  $('.reset-card',article).addEventListener('click',()=>{card.settings={...DEFAULTS};updateControls(card);requestProcess(card,true);});
  $('.remember-card',article).addEventListener('click',()=>acceptSettings(card));
  updateControls(card);
  return card;
}
function safeFileName(name){return String(name).replace(/\.[^.]+$/,'').replace(/[^\w-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'signature';}
function setStatus(card,status,message){const el=$('.card-status',card.el);el.className='card-status '+(status==='working'?'running':status==='error'?'error':'');el.textContent=message||({working:'Processing',error:'Error',ready:'Ready'}[status]);}
function showError(card,error){card.ready=false;$('.download',card.el).disabled=true;$('.remember-card',card.el).disabled=true;setStatus(card,'error','Failed');const e=$('.card-error',card.el);e.textContent=error?.message||String(error);e.hidden=false;$('.card-meta',card.el).textContent=card.outputBlob?'Processing failed · showing previous result':'Processing failed';console.warn('Image processing:',error);}
function clearPreviews(card){if(card.outputUrl)URL.revokeObjectURL(card.outputUrl);card.outputUrl=null;card.outputBlob=null;card.ready=false;for(const img of card.el.querySelectorAll('.compare-pane img')){img.removeAttribute('src');img.hidden=true;}for(const placeholder of card.el.querySelectorAll('.pane-placeholder'))placeholder.hidden=false;$('.original-dims',card.el).textContent='';$('.output-dims',card.el).textContent='';$('.download',card.el).disabled=true;$('.remember-card',card.el).disabled=true;}
function updateRememberNote(card){const saved=remembered(card.storageKey)||DEFAULTS;const changed=!sameSettings(card.settings,saved);$('.remember-card',card.el).disabled=!card.ready||!card.storageKey||!changed;$('.remember-note',card.el).textContent=!card.storageKey?'Local settings recall is unavailable.':changed?'Download or remember to save these settings.':sameSettings(saved,DEFAULTS)?'Default settings · no saved override.':'Remembered settings · stored on this browser only.';}
function acceptSettings(card){if(!card.ready||!card.storageKey)return; if(!remember(card.storageKey,card.settings)){toast('Settings could not be saved in this browser.');return;}for(const other of cards)if(other.storageKey===card.storageKey)updateRememberNote(other);}
function cancelRequest(card){clearTimeout(card.timer);queue.delete(card);card.request=null;card.revision++;card.ready=false;}
async function decodeCard(card,blob,page=1){
  cancelRequest(card);const rev=card.revision;clearPreviews(card);card.sourceCanvas=null;card.storageKey=null;$('.adjust-panel',card.el).hidden=true;setStatus(card,'working','Decoding');$('.card-error',card.el).hidden=true;$('.card-meta',card.el).textContent='Preparing image…';$('.page-select select',card.el).disabled=true;
  try{
    const [result,hash]=await Promise.all([loadDocument(blob,card.filename,blob.type,page),card.hashPromise||(card.hashPromise=fingerprint(blob))]);if(card.removed||rev!==card.revision)return;
    card.sourceCanvas=result.canvas;card.sourceBlob=blob;card.pageCount=result.pageCount;card.storageKey=hash?`${hash}:${page}`:null;card.settings=remembered(card.storageKey)||{...DEFAULTS};updateControls(card);updateRememberNote(card);
    const selector=$('.page-select',card.el),sel=$('select',selector);selector.hidden=result.pageCount<=1;
    if(result.pageCount>1){sel.innerHTML='';for(let i=1;i<=Math.min(result.pageCount,250);i++){const opt=document.createElement('option');opt.value=i;opt.textContent=i;sel.appendChild(opt)}sel.value=String(page);}
    sel.disabled=false;
    const original=$('.compare-pane:first-child img',card.el);original.hidden=false;original.src=result.canvas.toDataURL('image/png');$('.compare-pane:first-child .pane-placeholder',card.el).hidden=true;$('.original-dims',card.el).textContent=`${result.canvas.width}×${result.canvas.height}`;
    requestProcess(card,true);
  }catch(e){if(rev===card.revision&&!card.removed){$('.page-select select',card.el).disabled=false;showError(card,e);}}
}
/** After rotation, trim transparent corners and apply equal padding on every side, based on the shorter ink dimension. */
function trimRotatedSignature(canvas, percent) {
  const w=canvas.width,h=canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const pixels=ctx.getImageData(0,0,w,h).data;
  let xmin=w,ymin=h,xmax=-1,ymax=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(pixels[(y*w+x)*4+3]<12)continue;
    xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);
    ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);
  }
  if(xmax<0)return canvas;
  const fraction=Math.max(0,Math.min(12,Number(percent)||0))/100;
  const pad=Math.ceil(Math.min(xmax-xmin+1,ymax-ymin+1)*fraction);
  const result=canvasFromDimensions(xmax-xmin+1+pad*2,ymax-ymin+1+pad*2);
  result.getContext('2d').drawImage(canvas,pad-xmin,pad-ymin);
  return result;
}
function requestProcess(card,immediate=false,force=false){
  if(!card.sourceCanvas||card.removed)return;
  let request=card.request;
  if(force||!request||!sameSettings(request.settings,card.settings)){
    cancelRequest(card);
    request={card,canvas:card.sourceCanvas,settings:{...card.settings,padding:2,hardEdges:false},revision:card.revision,state:'waiting'};
    card.request=request;
    setStatus(card,'working','Processing');$('.card-error',card.el).hidden=true;$('.download',card.el).disabled=true;$('.remember-card',card.el).disabled=true;
    $('.card-meta',card.el).textContent=card.outputBlob?'Updating preview…':'Processing image…';
  }
  if(request.state!=='waiting')return; // Release/change does not duplicate an already queued or running request.
  clearTimeout(card.timer);
  const enqueue=()=>{if(card.removed||card.request!==request)return;request.state='queued';queue.set(card,request);void drainQueue();};
  if(immediate)enqueue();else card.timer=setTimeout(enqueue,WAIT_MS);
}
async function drainQueue(){
  if(draining)return;draining=true;
  try{while(queue.size){const [card,request]=queue.entries().next().value;queue.delete(card);if(card.removed||card.request!==request)continue;request.state='active';await processCard(request);request.state='done';}}
  finally{draining=false;}
}
async function processCard({card,canvas,settings,revision:rev}){
  try{
    if(workerFailed)throw new Error('Processing worker stopped. Reload the page.');
    const pixels=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height);
    const jobId=++jobSeq;const promise=new Promise((resolve,reject)=>{pending.set(jobId,{resolve,reject});try{worker.postMessage({jobId,width:canvas.width,height:canvas.height,pixels:pixels.data.buffer,settings},[pixels.data.buffer]);}catch(e){pending.delete(jobId);reject(e);}});
    const res=await promise;if(rev!==card.revision||card.removed)return;
    let out=canvasFromDimensions(res.width,res.height);out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.pixels),res.width,res.height),0,0);
    const degrees=settings.rotation;
    if(degrees){const rad=degrees*Math.PI/180;const co=Math.abs(Math.cos(rad)),si=Math.abs(Math.sin(rad));const W=Math.ceil(out.width*co+out.height*si),H=Math.ceil(out.width*si+out.height*co);const dest=canvasFromDimensions(W,H);const dc=dest.getContext('2d');dc.translate(W/2,H/2);dc.rotate(rad);dc.drawImage(out,-out.width/2,-out.height/2);out=trimRotatedSignature(dest,settings.padding);}
    const blob=await canvasToBlob(out);if(rev!==card.revision||card.removed)return;
    if(card.outputUrl)URL.revokeObjectURL(card.outputUrl);
    card.outputBlob=blob;card.outputUrl=URL.createObjectURL(blob);
    const img=$('.compare-pane:last-child img',card.el);img.src=card.outputUrl;img.hidden=false;$('.compare-pane:last-child .pane-placeholder',card.el).hidden=true;
    $('.output-dims',card.el).textContent=`${out.width}×${out.height}`;
    $('.card-meta',card.el).textContent=`${res.metadata.mode} · ${bytes(blob.size)} · ${res.metadata.retainedComponents} components`;
    card.ready=true;$('.download',card.el).disabled=false;setStatus(card,'ready','Ready');updateRememberNote(card);
  }catch(e){if(rev===card.revision&&!card.removed)showError(card,e);}
  finally{if(rev===card.revision&&!card.removed)$('.adjust-panel',card.el).hidden=false;}
}
function saveBlob(blob,name){const a=document.createElement('a');const u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);}
// ZIP STORE (uncompressed PNGs) so the page never needs an archive CDN.
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
async function makeZip(items){const enc=new TextEncoder(),chunks=[],entries=[];let offset=0;function section(size,fn){const b=new Uint8Array(size);fn(new DataView(b.buffer));chunks.push(b);offset+=size;return b;}
for(const {name,blob} of items){const nameBytes=enc.encode(name),data=new Uint8Array(await blob.arrayBuffer()),crc=crc32(data),localOffset=offset;section(30+nameBytes.length,v=>{v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(8,0,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,nameBytes.length,true);});chunks[chunks.length-1].set(nameBytes,30);chunks.push(data);offset+=data.length;entries.push({nameBytes,crc,size:data.length,localOffset});}
const cdStart=offset;for(const e of entries){const b=section(46+e.nameBytes.length,v=>{v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(16,e.crc,true);v.setUint32(20,e.size,true);v.setUint32(24,e.size,true);v.setUint16(28,e.nameBytes.length,true);v.setUint32(42,e.localOffset,true);});b.set(e.nameBytes,46);}
section(22,v=>{v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,offset-cdStart,true);v.setUint32(16,cdStart,true);});return new Blob(chunks,{type:'application/zip'});}
const FILE_TYPES=['png','jpg','jpeg','svg','pdf','heic','heif','tif','tiff','gif','bmp','webp','avif','ico'];
const IMAGE_MIME_EXT={'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/svg+xml':'svg','image/heic':'heic','image/heif':'heif','image/tiff':'tiff','image/gif':'gif','image/bmp':'bmp','image/webp':'webp','image/avif':'avif','image/x-icon':'ico','image/vnd.microsoft.icon':'ico'};
const isImageFile=file=>file&&(file.type.toLowerCase().startsWith('image/')||(!file.type&&FILE_TYPES.includes(extOf(file.name))&&extOf(file.name)!=='pdf'));
async function uploadFiles(files,{fromClipboard=false}={}){const input=Array.from(files);if(input.length>20)toast('Only the first 20 files will be processed.');for(const file of input.slice(0,20)){if(file.size>25*1024*1024){toast(`${file.name}: exceeds 25 MB`);continue;}const type=extOf(file.name);if(!FILE_TYPES.includes(type)){toast(`${file.name}: unsupported format`);continue;}const card=makeCard({title:file.name,description:`${fromClipboard?'Clipboard image':'Local file'} · ${bytes(file.size)}`,number:String(cards.filter(c=>c.custom).length+1).padStart(2,'0'),custom:true,filename:file.name});cards.push(card);$('#custom-items').prepend(card.el);if(fromClipboard)card.el.scrollIntoView({block:'start',behavior:'instant'});await decodeCard(card,file);}}
function clipboardImage(blob){const extension=IMAGE_MIME_EXT[blob.type.toLowerCase()]||(blob.name&&FILE_TYPES.includes(extOf(blob.name))&&extOf(blob.name)!=='pdf'?extOf(blob.name):null);if(!extension){toast('The clipboard image format is unsupported. Save it as PNG or JPEG and try again.');return;}const file=new File([blob],`clipboard-image.${extension}`,{type:blob.type});void uploadFiles([file],{fromClipboard:true});}
function rejectMultiple(){toast('Multiple images found. Paste only one signature image at a time.');}
const MAX_IMAGE_BYTES=25*1024*1024,MAX_RICH_CHARS=60*1024*1024;
const RTF_TYPES=['text/rtf','application/rtf','text/richtext'];
function richImageSources(html){
  if(!html)return [];
  // A template is inert; never attach it to the document or load linked resources.
  const template=document.createElement('template');template.innerHTML=html;
  return Array.from(template.content.querySelectorAll('img'),img=>img.getAttribute('src')||'');
}
function embeddedImage(src){
  const match=/^data:(image\/[\w.+-]+)(?:;[^,;]+)*;base64,([\s\S]*)$/i.exec(src.trim());
  if(!match)return null;
  const mime=match[1].toLowerCase();if(!IMAGE_MIME_EXT[mime])return null;
  try{const data=match[2].replace(/\s/g,'');if(data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4)return null;const binary=atob(data);if(!binary.length||binary.length>MAX_IMAGE_BYTES)return null;return new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))],{type:mime});}catch{return null;}
}
// Read only RTF picture destinations; do not render RTF, interpret document text,
// or read Office's file:// temporary image references. Word may include a primary
// shppict and an immediately following nonshppict fallback for the same picture.
function rtfPictures(rtf){
  if(!rtf||!/^\s*\{\\rtf\d/i.test(rtf))return [];
  const stack=[],found=[];const word=/\\([a-z]+)(-?\d+)? ?/iy,plain=/[^{}\\]+/y;
  for(let i=0;i<rtf.length;){
    const c=rtf[i],g=stack[stack.length-1];
    if(c==='{'){if(stack.length>=256)throw new Error('Clipboard document is too deeply nested.');stack.push({parent:g,ordinal:g?++g.children:0,children:0,branch:g?.branch||null,picture:null,started:false,start:i});i++;continue;}
    if(c==='}'){if(g){stack.pop();if(g.picture)found.push(g.picture);if(g.branch?.start===g.start)g.branch.end=i+1;}i++;continue;}
    if(c==='\\'){
      word.lastIndex=i;const m=word.exec(rtf);
      if(!m){i+=rtf[i+1]==="'"?4:2;continue;}
      i=word.lastIndex;const cmd=m[1].toLowerCase(),first=g&&!g.started;if(g)g.started=true;
      if(first&&(cmd==='shppict'||cmd==='nonshppict')){g.branch={kind:cmd,parent:g.parent,ordinal:g.ordinal,start:g.start,end:null};}
      else if(first&&cmd==='pict'){g.picture={branch:g.branch,mime:null,hex:[],binary:[],size:0,invalid:false};}
      else if(cmd==='bin'){
        const n=Number(m[2]);if(!Number.isSafeInteger(n)||n<0||i+n>rtf.length)throw new Error('Invalid rich-text clipboard image.');
        if(g?.picture){const p=g.picture;p.size+=n*2;if(p.size>MAX_IMAGE_BYTES*2)p.invalid=true;else p.binary.push(rtf.slice(i,i+n));}i+=n;
      }else if(g?.picture){if(cmd==='pngblip')g.picture.mime='image/png';else if(cmd==='jpegblip')g.picture.mime='image/jpeg';}
      continue;
    }
    plain.lastIndex=i;const part=plain.exec(rtf);if(!part){i++;continue;}i=plain.lastIndex;
    if(g&&/\S/.test(part[0]))g.started=true;
    if(g?.picture){const p=g.picture,hex=part[0].replace(/\s/g,'');p.size+=hex.length;if(p.size>MAX_IMAGE_BYTES*2||/[^a-f\d]/i.test(hex))p.invalid=true;else p.hex.push(hex);}
  }
  const logical=[];
  for(const p of found){const last=logical[logical.length-1],a=last?.[0].branch,b=p.branch;
    if(a?.kind==='shppict'&&b?.kind==='nonshppict'&&a.parent===b.parent&&a.ordinal+1===b.ordinal&&last.length===1&&a.end!==null&&/^\s*$/.test(rtf.slice(a.end,b.start)))last.push(p);else logical.push([p]);}
  return logical;
}
function rtfImage(pictures){
  for(const p of pictures||[]){if(!p.mime||p.invalid||!p.size)continue;
    let bytes;if(p.binary.length){if(p.hex.some(Boolean))continue;const data=p.binary.join('');if(/[^\x00-\xff]/.test(data))continue;bytes=Uint8Array.from(data,c=>c.charCodeAt(0));}
    else{const hex=p.hex.join('');if(hex.length%2)continue;bytes=new Uint8Array(hex.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);}
    if(p.mime==='image/png'&&!(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)))continue;
    if(p.mime==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216))continue;
    return new Blob([bytes],{type:p.mime});
  }return null;
}
async function resolveClipboard({image=null,html='',rtf=''}){
  if(html.length>MAX_RICH_CHARS||rtf.length>MAX_RICH_CHARS){toast('Clipboard content is too large. Copy only the signature image.');return;}
  try{
    const sources=richImageSources(html),pictures=rtfPictures(rtf);
    if(sources.length>1||pictures.length>1){rejectMultiple();return;}
    // Rich Office selections may also offer a flattened bitmap of the entire selection.
    // Prefer the embedded picture, which excludes accompanying text.
    let extracted=embeddedImage(sources[0]||'')||rtfImage(pictures[0]);
    if(!extracted&&sources[0]?.startsWith('blob:')){
      // Safari can expose clipboard-local blob URLs. No HTTP/file URL is fetched.
      try{const url=new URL(sources[0]);if(url.protocol==='blob:'&&url.origin===location.origin){const response=await fetch(url.href);const blob=await response.blob();if(IMAGE_MIME_EXT[blob.type]&&blob.size<=MAX_IMAGE_BYTES)extracted=blob;}}catch{}
    }
    if(extracted||image){clipboardImage(extracted||image);return;}
    if(sources.length||pictures.length){toast('An image was found, but the browser did not provide usable image data. In Word, select and copy only the picture, then paste again.');return;}
    toast('No image found in the clipboard. Copy an image, not text or a link.');
  }catch{toast('Could not read the rich-text clipboard. Copy only the picture and try again.');}
}
function handlePaste(event){if(event.target instanceof Element&&event.target.closest('textarea,input:not([type="range"]):not([type="file"]),[contenteditable="true"]'))return;event.preventDefault();const transfer=event.clipboardData;if(!transfer){toast('Clipboard is unavailable. Browse for an image instead.');return;}const imageItems=Array.from(transfer.items||[]).filter(item=>item.kind==='file'&&item.type.toLowerCase().startsWith('image/'));const imageFiles=Array.from(transfer.files||[]).filter(isImageFile);if(imageItems.length>1||imageFiles.length>1){rejectMultiple();return;}const get=type=>transfer.getData?.(type)||'';void resolveClipboard({image:imageItems[0]?.getAsFile()||imageFiles[0],html:get('text/html'),rtf:RTF_TYPES.map(get).find(Boolean)||''});}
async function readClipboard(){try{if(!navigator.clipboard?.read)throw new Error('Clipboard API unavailable');const entries=await navigator.clipboard.read();const images=entries.map(item=>({item,types:item.types.filter(type=>type.toLowerCase().startsWith('image/'))})).filter(entry=>entry.types.length);if(images.length>1){rejectMultiple();return;}const {item,types}=images[0]||{};const type=types?.find(t=>t==='image/png')||types?.find(t=>IMAGE_MIME_EXT[t])||types?.[0];const image=type?await item.getType(type):null;const getRich=async formats=>{const rich=[];for(const entry of entries){const type=formats.find(t=>entry.types.includes(t));if(type)rich.push(await (await entry.getType(type)).text());}return rich.join('\n');};const [html,rtf]=await Promise.all([getRich(['text/html']),getRich(RTF_TYPES)]);await resolveClipboard({image,html,rtf});}catch{toast('Clipboard access unavailable. Use Ctrl+V / Cmd+V to paste an image.');$('#dropzone').focus();}}
function initEvents(){
document.addEventListener('paste',handlePaste);$('#paste-image').addEventListener('click',readClipboard);window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY||e.key===null)cards.filter(c=>c.storageKey).forEach(updateRememberNote);});
$('#rerun').addEventListener('click',()=>{cards.forEach(card=>requestProcess(card,true,true));toast('Reprocessing loaded signatures.');});
$('#download-all').addEventListener('click',async()=>{const ready=cards.filter(c=>c.ready&&c.outputBlob);const items=ready.map((c,i)=>({name:`${String(i+1).padStart(2,'0')}-${safeFileName(c.filename)}-transparent.png`,blob:c.outputBlob}));if(!items.length){toast('No completed images to download yet.');return;}try{const zip=await makeZip(items);ready.forEach((card,i)=>{if(card.ready&&card.outputBlob===items[i].blob)acceptSettings(card);});saveBlob(zip,'e-sign-processed-signatures.zip');toast(`Prepared ${items.length} PNG files.`);}catch(e){toast(`ZIP export failed: ${e.message}`);}});
const zone=$('#dropzone'),fileInput=$('#file-input');const browse=()=>fileInput.click();zone.addEventListener('click',browse);zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();browse();}});fileInput.addEventListener('change',()=>{uploadFiles(fileInput.files);fileInput.value='';});for(const ev of ['dragenter','dragover'])zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('dragging')});for(const ev of ['dragleave','dragend','drop'])zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('dragging')});zone.addEventListener('drop',e=>uploadFiles(e.dataTransfer.files));
}
async function initialize(){initEvents();$('#samples').innerHTML='';const sampleCards=REFERENCE.map((ref,i)=>{const card=makeCard({...ref,number:String(i+1).padStart(2,'0'),filename:ref.file});cards.push(card);$('#samples').appendChild(card.el);return card;});
await Promise.all(REFERENCE.map(async(ref,i)=>{try{const response=await fetch(ref.file);if(!response.ok)throw new Error(`Source sample unavailable (${response.status}).`);const blob=await response.blob();await decodeCard(sampleCards[i],blob);}catch(e){showError(sampleCards[i],e)}}));}
initialize().catch(e=>{console.error(e);toast(`Application error: ${e.message}`)});

