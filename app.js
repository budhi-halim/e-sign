/* E-Sign browser test bench. No API calls upload file content. */
const REFERENCE = [
  {title:'Transparent PNG',description:'Clean source artwork, already transparent.',file:'assets/administrator-transparent.png',type:'PNG'},
  {title:'White-background JPG',description:'High-contrast signature on plain white.',file:'assets/administrator-white.jpg',type:'JPG'},
  {title:'Scanned paper',description:'Scanned ink, paper grain and light dust.',file:'assets/administrator-scan.jpg',type:'JPG'},
  {title:'Angled paper photograph',description:'Perspective, surface texture and uneven lighting.',file:'assets/administrator-photo.jpg',type:'JPG'}
];
const $ = (s,parent=document) => parent.querySelector(s);
const cards = [];
let jobSeq = 0;
const pending = new Map();
const worker = new Worker('./processor-worker.js');
worker.onmessage = e => { const task = pending.get(e.data.jobId); if(task){pending.delete(e.data.jobId); e.data.ok?task.resolve(e.data):task.reject(new Error(e.data.error));} };
worker.onerror = e => {console.error('Processing worker failed',e); for(const t of pending.values())t.reject(new Error('Processing worker stopped. Reload the page.'));pending.clear();};
let toastTimer;
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);}
const escapeHtml = str => String(str).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const extOf = name => (name.split('.').pop()||'').toLowerCase();
const bytes = n => n<1024?'1 KB':n<1048576?`${Math.ceil(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`;
function settingValues(){return {sensitivity:+$('#sensitivity').value,denoise:+$('#denoise').value,padding:+$('#padding').value,rotation:+$('#rotation').value,hardEdges:$('#hard-edges').checked};}
function updateOutputs(){for(const field of ['sensitivity','denoise','padding','rotation']){const v=$('#'+field).value;$('#'+field+'-output').textContent=field==='padding'?`${v}%`:field==='rotation'?`${v}°`:v;}}
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
    const pdf=await pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer())}).promise;
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
  const card={el:article,custom,filename:filename||title,sourceCanvas:null,sourceBlob:null,sourceObject:null,outputBlob:null,outputUrl:null,revision:0};
  $('.remove',article).addEventListener('click',()=>{card.removed=true; if(card.outputUrl)URL.revokeObjectURL(card.outputUrl);article.remove();const idx=cards.indexOf(card);if(idx>=0)cards.splice(idx,1);});
  $('.download',article).addEventListener('click',()=>{if(card.outputBlob)saveBlob(card.outputBlob,`${safeFileName(card.filename)}-transparent.png`);});
  $('.page-select select',article).addEventListener('change',async e=>{if(!card.sourceBlob)return;await decodeCard(card,card.sourceBlob,+e.target.value);});
  return card;
}
function safeFileName(name){return String(name).replace(/\.[^.]+$/,'').replace(/[^\w-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'signature';}
function setStatus(card,status,message){const el=$('.card-status',card.el);el.className='card-status '+(status==='working'?'running':status==='error'?'error':'');el.textContent=message||({working:'Processing',error:'Error',ready:'Ready'}[status]);}
function showError(card,error){setStatus(card,'error','Failed');const e=$('.card-error',card.el);e.textContent=error?.message||String(error);e.hidden=false;$('.card-meta',card.el).textContent='Processing failed';console.warn('Image processing:',card.filename,error);}
async function decodeCard(card,blob,page=1){
  const rev=++card.revision;setStatus(card,'working','Decoding');$('.card-error',card.el).hidden=true;
  try{
    const result=await loadDocument(blob,card.filename,blob.type,page);if(card.removed||rev!==card.revision)return;
    card.sourceCanvas=result.canvas;card.sourceBlob=blob;card.pageCount=result.pageCount;
    const selector=$('.page-select',card.el),sel=$('select',selector);selector.hidden=result.pageCount<=1;
    if(result.pageCount>1){sel.innerHTML='';for(let i=1;i<=Math.min(result.pageCount,250);i++){const opt=document.createElement('option');opt.value=i;opt.textContent=i;sel.appendChild(opt)}sel.value=String(page);}
    const original=$('.compare-pane:first-child img',card.el);original.hidden=false;original.src=result.canvas.toDataURL('image/png');$('.compare-pane:first-child .pane-placeholder',card.el).hidden=true;$('.original-dims',card.el).textContent=`${result.canvas.width}×${result.canvas.height}`;
    await processCard(card);
  }catch(e){if(rev===card.revision&&!card.removed)showError(card,e);}
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
async function processCard(card){
  if(!card.sourceCanvas||card.removed)return;
  const rev=++card.revision;setStatus(card,'working','Processing');$('.card-error',card.el).hidden=true;$('.download',card.el).disabled=true;
  const canvas=card.sourceCanvas,ctx=canvas.getContext('2d',{willReadFrequently:true});const img=ctx.getImageData(0,0,canvas.width,canvas.height);
  const jobId=++jobSeq;const promise=new Promise((resolve,reject)=>pending.set(jobId,{resolve,reject}));
  worker.postMessage({jobId,width:canvas.width,height:canvas.height,pixels:img.data.buffer,settings:settingValues()},[img.data.buffer]);
  try{
    const res=await promise;if(rev!==card.revision||card.removed)return;
    let out=canvasFromDimensions(res.width,res.height);out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.pixels),res.width,res.height),0,0);
    const degrees=+$('#rotation').value;
    if(degrees){const rad=degrees*Math.PI/180;const co=Math.abs(Math.cos(rad)),si=Math.abs(Math.sin(rad));const W=Math.ceil(out.width*co+out.height*si),H=Math.ceil(out.width*si+out.height*co);const dest=canvasFromDimensions(W,H);const dc=dest.getContext('2d');dc.translate(W/2,H/2);dc.rotate(rad);dc.drawImage(out,-out.width/2,-out.height/2);out=trimRotatedSignature(dest,+$('#padding').value);}
    const blob=await canvasToBlob(out);if(rev!==card.revision||card.removed)return;
    if(card.outputUrl)URL.revokeObjectURL(card.outputUrl);
    card.outputBlob=blob;card.outputUrl=URL.createObjectURL(blob);
    const img=$('.compare-pane:last-child img',card.el);img.src=card.outputUrl;img.hidden=false;$('.compare-pane:last-child .pane-placeholder',card.el).hidden=true;
    $('.output-dims',card.el).textContent=`${out.width}×${out.height}`;
    $('.card-meta',card.el).textContent=`${res.metadata.mode} · ${bytes(blob.size)} · ${res.metadata.retainedComponents} components`;
    $('.download',card.el).disabled=false;setStatus(card,'ready','Ready');
  }catch(e){if(rev===card.revision&&!card.removed)showError(card,e);}
}
function saveBlob(blob,name){const a=document.createElement('a');const u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);}
// ZIP STORE (uncompressed PNGs) so the page never needs an archive CDN.
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
async function makeZip(items){const enc=new TextEncoder(),chunks=[],entries=[];let offset=0;function section(size,fn){const b=new Uint8Array(size);fn(new DataView(b.buffer));chunks.push(b);offset+=size;return b;}
for(const {name,blob} of items){const nameBytes=enc.encode(name),data=new Uint8Array(await blob.arrayBuffer()),crc=crc32(data),localOffset=offset;section(30+nameBytes.length,v=>{v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(8,0,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,nameBytes.length,true);});chunks[chunks.length-1].set(nameBytes,30);chunks.push(data);offset+=data.length;entries.push({nameBytes,crc,size:data.length,localOffset});}
const cdStart=offset;for(const e of entries){const b=section(46+e.nameBytes.length,v=>{v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(16,e.crc,true);v.setUint32(20,e.size,true);v.setUint32(24,e.size,true);v.setUint16(28,e.nameBytes.length,true);v.setUint32(42,e.localOffset,true);});b.set(e.nameBytes,46);}
section(22,v=>{v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,offset-cdStart,true);v.setUint32(16,cdStart,true);});return new Blob(chunks,{type:'application/zip'});}
async function uploadFiles(files){const input=Array.from(files).slice(0,20);for(const file of input){if(file.size>25*1024*1024){toast(`${file.name}: exceeds 25 MB`);continue;}const type=extOf(file.name);if(!['png','jpg','jpeg','svg','pdf','heic','heif','tif','tiff','gif','bmp','webp','avif','ico'].includes(type)){toast(`${file.name}: unsupported format`);continue;}const card=makeCard({title:file.name,description:`Your local file · ${bytes(file.size)}`,number:String(cards.filter(c=>c.custom).length+1).padStart(2,'0'),custom:true,filename:file.name});cards.push(card);$('#custom-items').prepend(card.el);await decodeCard(card,file);}}
function initEvents(){const settings=['sensitivity','denoise','padding','rotation','hard-edges'];let timer;for(const id of settings){$('#'+id).addEventListener('input',()=>{updateOutputs();clearTimeout(timer);timer=setTimeout(()=>Promise.all(cards.map(processCard)),380);});}
$('#reset-settings').addEventListener('click',()=>{for(const [id,val] of Object.entries({sensitivity:52,denoise:45,padding:2,rotation:0}))$('#'+id).value=val;$('#hard-edges').checked=false;updateOutputs();Promise.all(cards.map(processCard));});
$('#rerun').addEventListener('click',()=>{Promise.all(cards.map(processCard));toast('Reprocessing loaded signatures.');});
$('#download-all').addEventListener('click',async()=>{const items=cards.filter(c=>c.outputBlob).map((c,i)=>({name:`${String(i+1).padStart(2,'0')}-${safeFileName(c.filename)}-transparent.png`,blob:c.outputBlob}));if(!items.length){toast('No completed images to download yet.');return;}try{saveBlob(await makeZip(items),'e-sign-processed-signatures.zip');toast(`Prepared ${items.length} PNG files.`);}catch(e){toast(`ZIP export failed: ${e.message}`);}});
const zone=$('#dropzone'),fileInput=$('#file-input');const browse=()=>fileInput.click();zone.addEventListener('click',browse);zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();browse();}});fileInput.addEventListener('change',()=>{uploadFiles(fileInput.files);fileInput.value='';});for(const ev of ['dragenter','dragover'])zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('dragging')});for(const ev of ['dragleave','dragend','drop'])zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('dragging')});zone.addEventListener('drop',e=>uploadFiles(e.dataTransfer.files));
}
async function initialize(){initEvents();updateOutputs();$('#samples').innerHTML='';for(let i=0;i<REFERENCE.length;i++){const ref=REFERENCE[i];const card=makeCard({...ref,number:String(i+1).padStart(2,'0'),filename:ref.file});cards.push(card);$('#samples').appendChild(card.el);}
await Promise.all(REFERENCE.map(async(ref,i)=>{try{const response=await fetch(ref.file);if(!response.ok)throw new Error(`Source sample unavailable (${response.status}).`);const blob=await response.blob();await decodeCard(cards[i],blob);}catch(e){showError(cards[i],e)}}));}
initialize().catch(e=>{console.error(e);toast(`Application error: ${e.message}`)});
