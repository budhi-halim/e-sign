/* Dependency-free regression tests for the actual app controller, without a browser. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/initialize\(\)\.catch\(e=>\{console\.error\(e\);toast\(`Application error: \$\{e\.message\}`\)\}\);\s*$/, '');
assert(!source.endsWith('initialize()'));
const entries=new Map(),calls=[],uploaded=[],notices=[],releases=[];
const context=vm.createContext({console,setTimeout,clearTimeout,File,Blob,atob,Element:class{},TextEncoder,Uint8Array,Uint32Array,crypto:webcrypto,Worker:class{},localStorage:{getItem:key=>entries.get(key)||null,setItem:(key,value)=>entries.set(key,value)},calls,uploaded,notices,releases});
vm.runInContext(source+`
  processCard=async request=>{calls.push(request);await new Promise(resolve=>releases.push(resolve));};
  toast=message=>notices.push(message);
  uploadFiles=async files=>uploaded.push(...files);
  function fakeCard(){const nodes=new Map();return {sourceCanvas:{},settings:{...DEFAULTS},revision:0,el:{querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);}}};}
  globalThis.api={fakeCard,requestProcess,cancelRequest,remember,remembered,fingerprint,handlePaste,readClipboard,resolveClipboard,rtfPictures,rtfImage,embeddedImage,DEFAULTS};
`,context);
const {api}=context;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=value=>JSON.parse(JSON.stringify(value));

(async()=>{
  const a=api.fakeCard(),b=api.fakeCard();
  api.requestProcess(a,true);assert.equal(calls.length,1);
  a.settings.sensitivity=53;api.requestProcess(a);
  a.settings.sensitivity=54;api.requestProcess(a);
  a.settings.sensitivity=80;api.requestProcess(a);api.requestProcess(a,true);api.requestProcess(a,true);
  b.settings.rotation=4;api.requestProcess(b,true);
  assert.equal(calls.length,1,'only one active request across cards');
  assert.equal(calls[0].settings.sensitivity,52,'active snapshot is immutable');
  assert.notEqual(a.revision,calls[0].revision,'stale result is invalidated');
  releases.shift()();await wait(0);assert.equal(calls.length,2);assert.equal(calls[1].settings.sensitivity,80);
  releases.shift()();await wait(0);assert.equal(calls.length,3);assert.equal(calls[2].settings.rotation,4);
  releases.shift()();await wait(0);
  a.settings.sensitivity=81;api.requestProcess(a);await wait(35);a.settings.sensitivity=82;api.requestProcess(a);
  await wait(60);assert.equal(calls.length,3,'debounce runs after latest input');
  await wait(65);assert.equal(calls.length,4);assert.equal(calls[3].settings.sensitivity,82);
  releases.shift()();await wait(0);
  a.settings.sensitivity=83;api.requestProcess(a);api.cancelRequest(a);await wait(130);assert.equal(calls.length,4);
  console.log('PASS: debounce, release, snapshot isolation, coalescing, global single flight, cancellation');

  const x=new File(['example image bytes'],'signature.png',{type:'image/png'}),y=new File(['example image bytes'],'renamed.png',{type:'image/png'}),z=new File(['different bytes'],'signature.png',{type:'image/png'});
  const key=(await api.fingerprint(x))+':1';assert.equal(await api.fingerprint(x),await api.fingerprint(y));assert.notEqual(await api.fingerprint(x),await api.fingerprint(z));
  assert.equal(api.remembered(key),null);assert(api.remember(key,{sensitivity:64,denoise:22,rotation:-3}));assert.deepEqual(json(api.remembered(key)),{sensitivity:64,denoise:22,rotation:-3});
  assert.equal(api.remembered(key.replace(':1',':2')),null);
  api.remember(key,{sensitivity:66,denoise:22,rotation:-3});assert.equal(api.remembered(key).sensitivity,66);assert.equal(Object.keys(JSON.parse(entries.get('e-sign:settings:v1'))).length,1);
  api.remember(key,api.DEFAULTS);assert.equal(api.remembered(key),null);
  entries.set('e-sign:settings:v1','not JSON');assert.equal(api.remembered(key),null);
  console.log('PASS: content fingerprint, page isolation, single latest config, defaults and malformed storage');

  const item=file=>({kind:'file',type:file.type,getAsFile:()=>file});
  const clipboard=(items,files)=>({target:null,preventDefault(){},clipboardData:{items,files}});
  api.handlePaste(clipboard([item(x),{kind:'string',type:'text/plain'}],[x]));assert.equal(uploaded.length,1);assert.equal(uploaded[0].type,'image/png');
  api.handlePaste(clipboard([item(x),item(y)],[x,y]));assert.equal(uploaded.length,1);assert.match(notices.at(-1),/Multiple images/);
  api.handlePaste(clipboard([{kind:'string',type:'text/html'}],[]));assert.equal(uploaded.length,1);assert.match(notices.at(-1),/No image/);
  // A ClipboardItem with multiple encodings is one image, not two images.
  context.navigator={clipboard:{read:async()=>[{types:['image/png','image/jpeg','text/plain'],getType:async()=>x}]}};
  await api.readClipboard();assert.equal(uploaded.length,2);
  context.navigator.clipboard.read=async()=>[{types:['image/png'],getType:async()=>x},{types:['image/jpeg'],getType:async()=>y}];await api.readClipboard();assert.equal(uploaded.length,2);assert.match(notices.at(-1),/Multiple images/);
  console.log('PASS: clipboard item filtering, alternate encodings, multiple rejection');
  // Real image bytes in a Word-style RTF picture with nested metadata. Word may
  // also include an immediately following nonshppict (WMF) compatibility copy.
  const png=fs.readFileSync(path.join(__dirname,'../assets/administrator-transparent.png'));
  const hex=png.toString('hex').match(/.{1,128}/g).join('\r\n');
  const picture=String.raw`{\pict\picscalex100\picscaley100\picw1440\pich480\bliptag42{\*\blipuid 123456789abcdef0}\pngblip `+hex+'}';
  const office=String.raw`{\rtf1\ansi prefix {\*\shppict`+picture+String.raw`}{\nonshppict{\pict\wmetafile8 01020304}} suffix}`;
  const plainRtf=String.raw`{\rtf1\ansi `+picture+'}';
  const twoRtf=String.raw`{\rtf1\ansi `+picture+' '+picture+'}';
  assert.equal(api.rtfPictures(office).length,1);assert.equal(api.rtfPictures(twoRtf).length,2);
  assert.deepEqual(Buffer.from(await api.rtfImage(api.rtfPictures(office)[0]).arrayBuffer()),png);
  assert.deepEqual(Buffer.from(await api.rtfImage(api.rtfPictures(plainRtf)[0]).arrayBuffer()),png);
  const binary=String.raw`{\rtf1{\pict\pngblip\bin`+png.length+' '+png.toString('latin1')+'}}';
  assert.deepEqual(Buffer.from(await api.rtfImage(api.rtfPictures(binary)[0]).arrayBuffer()),png);
  assert.equal(api.rtfImage(api.rtfPictures(String.raw`{\rtf1{\pict\pngblip 1234}}`)[0]),null);
  assert.equal(api.rtfPictures(String.raw`{\rtf1 escaped \{\pict literal\}}`).length,0);
  const dataUri='data:image/png;base64,'+png.toString('base64');
  assert.deepEqual(Buffer.from(await api.embeddedImage(dataUri).arrayBuffer()),png);
  assert.equal(api.embeddedImage('https://example.invalid/image.png'),null);
  // The DOM parser is exercised by the browser suite; mock the resulting inert
  // image-element list here to test resolution and ambiguity policy in Node.
  context.document={createElement:tag=>{assert.equal(tag,'template');return {set innerHTML(html){this.content={querySelectorAll:()=>[...html.matchAll(/<img src="([^"]*)"/g)].map(m=>({getAttribute:()=>m[1]}))};}};}};
  const fileHtml='<p>Text <img src="file:///C:/Temp/clip_image001.png"></p>';
  await api.resolveClipboard({html:fileHtml,rtf:office});assert.equal(uploaded.length,3);assert.deepEqual(Buffer.from(await uploaded.at(-1).arrayBuffer()),png);
  await api.resolveClipboard({html:fileHtml,rtf:twoRtf});assert.equal(uploaded.length,3);assert.match(notices.at(-1),/Multiple images/);
  await api.resolveClipboard({html:fileHtml+fileHtml,image:x});assert.equal(uploaded.length,3);assert.match(notices.at(-1),/Multiple images/);
  await api.resolveClipboard({html:fileHtml});assert.equal(uploaded.length,3);assert.match(notices.at(-1),/did not provide usable image data/);
  await api.resolveClipboard({html:'<p>Text<img src="'+dataUri+'"></p>'});assert.equal(uploaded.length,4);
  assert.deepEqual(Buffer.from(await uploaded.at(-1).arrayBuffer()),png);
  api.handlePaste({target:null,preventDefault(){},clipboardData:{items:[],files:[],getData:type=>type==='text/html'?fileHtml:type==='text/rtf'?office:''}});
  assert.equal(uploaded.length,5);
  context.navigator.clipboard.read=async()=>[{types:['text/html','text/rtf'],getType:async type=>new Blob([type==='text/html'?fileHtml:office],{type})}];
  await api.readClipboard();assert.equal(uploaded.length,6);
  console.log('PASS: rich HTML embedded images, Word RTF PNG, fallback duplicates, binary RTF, linked-image warning and multiple rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
