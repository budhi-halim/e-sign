/* node scripts/test-worker.cjs — tests exactly the browser worker algorithm */
const fs=require('fs'),path=require('path'),vm=require('vm'),sharp=require('sharp');
const code=fs.readFileSync(path.join(__dirname,'../processor-worker.js'),'utf8');
const self={postMessage:(message)=>self.last=message};
vm.runInNewContext(code,{self,Uint8ClampedArray,Uint8Array,Int32Array,Int16Array,Float64Array,Math,Error,Number,Array});
(async()=>{
 const files=['administrator-transparent.png','administrator-white.jpg','administrator-scan.jpg','administrator-photo.jpg'];
 let good=0;
 for(const file of files){const filePath=path.join(__dirname,'../assets',file);const {data,info}=await sharp(filePath).ensureAlpha().raw().toBuffer({resolveWithObject:true});const src=new Uint8Array(data);self.onmessage({data:{jobId:1,width:info.width,height:info.height,pixels:src.buffer,settings:{sensitivity:52,denoise:45,padding:2,rotation:0,hardEdges:false}}});
 const result=self.last;if(!result.ok)throw Error(`${file}: ${result.error}`);const rgba=Buffer.from(result.pixels);const destination=path.join(__dirname,'../test-output-'+file+'.png');await sharp(rgba,{raw:{width:result.width,height:result.height,channels:4}}).png().toFile(destination); const nonzero=Array.from(rgba).filter((x,i)=>i%4===3&&x>0).length;console.log(JSON.stringify({file,output:`${result.width}x${result.height}`,alphaPixels:nonzero,metrics:result.metadata}));good++;
 }
 console.log(`PASS: ${good}/${files.length} reference sources`);
})().catch(e=>{console.error(e);process.exit(1)});
