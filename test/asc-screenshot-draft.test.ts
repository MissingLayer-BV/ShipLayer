import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { draftScreenshots } from '../src/asc-screenshot-draft.js';
import { readyManifest, png } from './helpers.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'screenshot-draft-'));
  const manifest = readyManifest(); manifest.app.version='1.3'; manifest.sync.mode='apply';
  manifest.screenshots.finalOutputDir='final'; manifest.screenshots.scenarios[0].caption='Read comfortably';
  await mkdir(path.join(root,'final/iphone/en-US'),{recursive:true});
  await writeFile(path.join(root,'final/iphone/en-US/home.png'),png(1320,2868));
  let state='PREPARE_FOR_SUBMISSION'; let pictures: any[]=[]; let set: any;
  const writes: string[]=[];
  const client={
    async get(url:string) {
      if(url.startsWith('/apps?')) return {data:[{id:manifest.app.appStoreAppId}]};
      if(url.includes('/appStoreVersions?')) return {data:[{id:'v',attributes:{platform:'IOS',versionString:'1.3',appVersionState:state}}]};
      if(url==='/appStoreVersions/v') return {data:{id:'v',attributes:{appVersionState:state}}};
      if(url.includes('/appStoreVersionLocalizations?')) return {data:[{id:'loc',attributes:{locale:'en-US'}}]};
      if(url.includes('/appScreenshotSets?')) return {data:set?[set]:[]};
      if(url.includes('/relationships/appScreenshots?')) return {data:pictures.map(s => ({id:s.id,type:'appScreenshots'}))};
      if(url.includes('/appScreenshots?')) return {data:pictures};
      if(url==='/appScreenshots/image') return {data:pictures[0]};
      throw new Error('Unexpected read '+url);
    },
    async post(url:string,body:any) {
      writes.push(url);
      if(url==='/appScreenshotSets') {set={...body.data,id:'set'};return {data:set};}
      assert.equal(url,'/appScreenshots'); pictures=[{...body.data,id:'image',attributes:{...body.data.attributes,uploadOperations:[{}]}}];return {data:pictures[0]};
    },
    async patch(url:string,body:any) {
      writes.push(url);
      if(url==='/appScreenshots/image') Object.assign(pictures[0].attributes,body.data.attributes,{assetDeliveryState:{state:'COMPLETE'}});
      else assert.equal(url,'/appScreenshotSets/set/relationships/appScreenshots');
      return {data:pictures[0]};
    },
    async delete(url:string) {writes.push(url);pictures=pictures.filter(item=>`/appScreenshots/${item.id}`!==url);},
    async uploadAsset() {writes.push('asset-upload');},
  };
  return {root,manifest,client,writes,setState:(s:string)=>{state=s;},setRemotePictures:(items:any[])=>{set={id:'set',attributes:{screenshotDisplayType:'APP_IPHONE_67'}};pictures=items;}};
}

test('draft screenshot preview is read-only; apply uploads only screenshots and verifies an idempotent rerun',async()=>{
 const f=await fixture();try {
  const preview=await draftScreenshots(f.root,f.manifest,false,false,f.client);
  assert.equal(preview.mode,'preview');assert.equal(f.writes.length,0);
  const result=await draftScreenshots(f.root,f.manifest,true,true,f.client);
  assert.equal(result.verifiedScreenshots,1);assert.equal(result.submitted,false);
  const count=f.writes.length;await draftScreenshots(f.root,f.manifest,true,true,f.client);assert.equal(f.writes.length,count);
  assert.ok(f.writes.every(p=>p.startsWith('/appScreenshot')||p==='asset-upload'));
 } finally {await rm(f.root,{recursive:true,force:true});}
});

test('incomplete screenshot recovery requires an explicit flag and deletes only incomplete reservations',async()=>{
 const f=await fixture();try {
  f.setRemotePictures([{id:'stuck',attributes:{fileName:'home.png',assetDeliveryState:{state:'UPLOAD_COMPLETE'}}}]);
  await assert.rejects(()=>draftScreenshots(f.root,f.manifest,true,true,f.client),/Pending or failed Apple processing/);
  assert.equal(f.writes.length,0);
  const result=await draftScreenshots(f.root,f.manifest,true,true,f.client,undefined,true);
  assert.equal(result.verifiedScreenshots,1);
  assert.ok(f.writes.includes('/appScreenshots/stuck'));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('draft screenshot writes reject missing authorization, non-draft versions, and incomplete local decks',async()=>{
 const f=await fixture();try {
  await assert.rejects(()=>draftScreenshots(f.root,f.manifest,true,false,f.client),/confirmation/);
  f.setState('READY_FOR_DISTRIBUTION');
  await assert.rejects(()=>draftScreenshots(f.root,f.manifest,true,true,f.client),/editable draft/);
  f.setState('PREPARE_FOR_SUBMISSION');
  await rm(path.join(f.root,'final/iphone/en-US/home.png'));
  await assert.rejects(()=>draftScreenshots(f.root,f.manifest,true,true,f.client),/No screenshots|marketing decks/);
  assert.equal(f.writes.length,0);
 } finally {await rm(f.root,{recursive:true,force:true});}
});


test('preview follows the ordered relationship even when screenshot resources arrive reversed',async()=>{
 const f=await fixture();try {
  f.manifest.screenshots.scenarios.push({...f.manifest.screenshots.scenarios[0],id:'second'});
  const bytes=png(1320,2868);
  await writeFile(path.join(f.root,'final/iphone/en-US/second.png'),bytes);
  const checksum=createHash('md5').update(bytes).digest('hex');
  const images=['home.png','second.png'].map((fileName,i)=>({id:String(i),attributes:{fileName,sourceFileChecksum:checksum,assetDeliveryState:{state:'COMPLETE'}}}));
  const original=f.client.get;
  f.client.get=async(url:string)=>{
   if(url.includes('/appScreenshotSets?')) return {data:[{id:'set',attributes:{screenshotDisplayType:'APP_IPHONE_67'}}]};
   if(url.includes('/relationships/appScreenshots?')) return {data:images.map(s=>({id:s.id}))} as any;
   if(url.includes('/appScreenshots?')) return {data:[...images].reverse()} as any;
   return original(url);
  };
  const result=await draftScreenshots(f.root,f.manifest,false,false,f.client);
  assert.equal(result.sets?.[0].status,'already-matches');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
