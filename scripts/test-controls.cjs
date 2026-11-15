/* Dependency-free regression tests for the actual app controller, without a browser. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').replace(/initialize\(\)\.catch\(e=>\{console\.error\(e\);toast\(`Application error: \$\{e\.message\}`\)\}\);\s*$/, '');
assert(!source.endsWith('initialize()'));
const entries=new Map(),calls=[],uploaded=[],notices=[],releases=[];
const context=vm.createContext({console,setTimeout,clearTimeout,File,Blob,Element:class{},TextEncoder,Uint8Array,Uint32Array,crypto:webcrypto,Worker:class{},localStorage:{getItem:key=>entries.get(key)||null,setItem:(key,value)=>entries.set(key,value)},calls,uploaded,notices,releases});
vm.runInContext(source+`
  processCard=async request=>{calls.push(request);await new Promise(resolve=>releases.push(resolve));};
  toast=message=>notices.push(message);
  uploadFiles=async files=>uploaded.push(...files);
  function fakeCard(){const nodes=new Map();return {sourceCanvas:{},settings:{...DEFAULTS},revision:0,el:{querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);}}};}
  globalThis.api={fakeCard,requestProcess,cancelRequest,remember,remembered,fingerprint,handlePaste,readClipboard,DEFAULTS};
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
})().catch(error=>{console.error(error);process.exitCode=1;});
