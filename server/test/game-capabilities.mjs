import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import express from 'express';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'outpost-capabilities-'));process.env.OUTPOST_DATA_DIR=root;
const {db,prep}=await import('../dist/db/db.js');
const catalog=await import('../dist/services/gameCapabilityService.js');
const {STEAM_GAME_PRESETS}=await import('../dist/services/steamGames.js');
const {GAME_PROFILES}=await import('../dist/services/gameControlProfiles.js');
const {instanceCapabilitiesRouter,gameCapabilityCatalogRouter}=await import('../dist/routes/gameCapabilities.routes.js');
const {gameControlsRouter}=await import('../dist/routes/gameControls.routes.js');
const {authRouter}=await import('../dist/routes/auth.routes.js');
const users=await import('../dist/services/userService.js');const servers=await import('../dist/services/serverService.js');
const {instanceDir}=await import('../dist/utils/paths.js');const {createToken}=await import('../dist/auth/tokens.js');
let http;
try{
 const games=catalog.gameCapabilityCatalog();assert.equal(new Set(games.map(g=>g.id)).size,games.length);assert.equal(games.length,STEAM_GAME_PRESETS.length+3);
 for(const p of STEAM_GAME_PRESETS){const g=games.find(g=>g.id===p.id);assert(g);assert(g.features.find(f=>f.id==='settings').support!=='unavailable');assert.equal(g.hosts.length,3);assert(g.hosts.every(h=>h.reason));assert.equal(g.features.length,10);assert(g.features.every(f=>f.reason&&Array.isArray(f.prerequisites)));}
 for(const profile of GAME_PROFILES){const g=games.find(g=>g.id===profile.id);if(profile.map?.upload)assert.notEqual(g.features.find(f=>f.id==='mapUpload').support,'unavailable');}
 const admin=users.createUser('capability-admin','fixture-password-123','admin'),viewer=users.createUser('capability-viewer','fixture-password-123','viewer'),stranger=users.createUser('capability-stranger','fixture-password-123','viewer');
 const make=(name,platform,loader,version,preset,app)=>{const s=servers.createServerRecord({name,platform,loader,version,minMemoryMb:128,maxMemoryMb:512,serverPort:27015,createdBy:admin.id,steamPreset:preset,steamAppId:app});servers.setServerStatus(s.id,'stopped');return servers.getServer(s.id);};
 const java=make('Unknown Java version','java','vanilla','99.9.9'),proxy=make('Proxy fixture','java','velocity','3.4.0'),bedrock=make('Bedrock fixture','bedrock','bedrock','1.21.100'),css=make('Native CSS','steam','vanilla','latest','css','232330'),ql=make('Linux-only Quake Live','steam','vanilla','latest','quakelive','349090'),bo3=make('Wine prerequisite','steam','vanilla','latest','bo3','545990'),custom=make('Custom workload','custom','custom','unknown');
 users.setUserServerAccess(viewer.id,[{serverId:java.id,permissions:['files.read']},{serverId:css.id,permissions:['files.read']}]);
 const action=(server,id,os='linux',perms=[],admin=false)=>catalog.instanceCapabilities(server,perms,admin,os).actions.find(a=>a.id===id);
 assert.equal(action(proxy,'gamerules').support,'unavailable');assert.equal(action(bedrock,'worldHealth').support,'unavailable');assert.equal(action(java,'profiler').available,false);assert(action(java,'profiler').blockers.some(b=>b.includes('console')));assert(action(java,'profiler','linux',['console'],false).blockers.some(b=>b.includes('running')));
 assert.equal(catalog.instanceCapabilities(ql,[],true,'win32').host.support,'unavailable');assert.equal(catalog.instanceCapabilities(bo3,[],true,'linux').host.support,'conditional');assert.equal(catalog.instanceCapabilities(bo3,[],true,'win32').host.support,'supported');assert.equal(catalog.instanceCapabilities(css,[],true,'darwin').host.support,'unavailable');assert.equal(catalog.instanceCapabilities(java,[],true,'darwin').host.support,'supported');assert.equal(catalog.instanceCapabilities(bedrock,[],true,'darwin').host.support,'unavailable');
 assert.equal(catalog.instanceCapabilities(java,[],true,'linux').validation.exactVersion.length,0);assert.equal(catalog.instanceCapabilities(java,[],true,'linux').validation.live.length,0);assert.equal(catalog.instanceCapabilities(custom,[],true).game,null);
 const recorded=catalog.capabilityMatrix().evidence.runs.find(r=>r.kind==='fixture'&&r.versions['minecraft-java']?.includes('vanilla@1.21.11'));
 if(recorded){const known={...java,version:'1.21.11'};assert(catalog.instanceCapabilities(known,[],true,recorded.hostOS).validation.exactVersion.some(r=>r.id===recorded.id));const untested=['linux','win32','darwin'].find(os=>!catalog.capabilityMatrix().evidence.runs.some(r=>r.hostOS===os&&r.versions['minecraft-java']?.includes('vanilla@1.21.11')));if(untested)assert.equal(catalog.instanceCapabilities(known,[],true,untested).validation.exactVersion.length,0,'Another OS does not inherit fixture evidence');}
 assert.equal(action({...css,status:'running'},'settings','linux',[],true).available,false);assert.equal(action(css,'settings','linux',[],true).available,true);assert.equal(action({...css,suspended:1},'settings','linux',[],true).available,false);
 assert.equal(games.find(g=>g.id==='rust').features.find(f=>f.id==='mapUpload').support,'unavailable');assert.equal(games.find(g=>g.id==='palworld').features.find(f=>f.id==='maps').support,'unavailable');assert.equal(games.find(g=>g.id==='cs2').features.find(f=>f.id==='fastdl').support,'unavailable');
 let nativeReads=0;const app=express();app.use(express.json());const token=u=>createToken(u.id,u.username,u.role);
 app.use((q,_r,next)=>{if(q.headers.authorization==='Bearer browser-fixture')q.headers.authorization='Bearer '+token(admin);if(q.path.endsWith('/game-controls'))nativeReads++;next();});
 app.use('/api/game-capabilities',gameCapabilityCatalogRouter);app.use('/api/servers/:serverId/capabilities',instanceCapabilitiesRouter);app.use('/api/servers/:serverId/game-controls',gameControlsRouter);app.use('/api/auth',authRouter);
 app.use((e,_q,r,_next)=>r.status(e.status??500).json({error:e.message}));http=app.listen(0,'127.0.0.1');await once(http,'listening');const origin='http://127.0.0.1:'+http.address().port;
 const request=(route,user=viewer)=>fetch(origin+'/api'+route,{headers:user?{Authorization:'Bearer '+token(user)}:{}});
 assert.equal((await request('/game-capabilities',null)).status,401);assert.equal((await request('/game-capabilities')).status,200);assert.equal((await request('/servers/'+java.id+'/capabilities')).status,200);assert.equal((await request('/servers/'+java.id+'/capabilities',stranger)).status,403);
 const staleAdminToken=token(admin);prep("UPDATE users SET role='viewer' WHERE id=?").run(admin.id);assert.equal((await fetch(origin+'/api/servers/'+bedrock.id+'/capabilities',{headers:{Authorization:'Bearer '+staleAdminToken}})).status,403);prep("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
 const details=await (await request('/servers/'+css.id+'/capabilities')).json();assert(details.actions.find(a=>a.id==='mapUpload').blockers.some(b=>b.includes('files.write')));assert(!JSON.stringify(details).includes(instanceDir(css.id)));
 if(process.env.OUTPOST_TEST_BROWSER_UI==='1'){
  const {runBrowser}=await import('./browserHarness.mjs');app.get('/api/servers',(_q,r)=>r.json({servers:servers.listServers(),metrics:{}}));app.get('/api/servers/:id',(q,r)=>r.json({server:servers.getServer(q.params.id),runtime:null,running:false,permissions:[...users.SERVER_PERMISSIONS]}));app.use('/api',(_q,r)=>r.status(503).json({error:'Outside fixture scope'}));app.use(express.static(path.resolve('web/dist')));app.get('*',(_q,r)=>r.sendFile(path.resolve('web/dist/index.html')));
  await runBrowser(origin,async({navigate,text,evaluate,until,viewport,captureScreenshot})=>{
   await navigate('/compatibility');await text('Game compatibility and validation');await text('No live game build validation recorded.');
   const input=async(label,value)=>evaluate(`(()=>{const i=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await input('Filter capability games','Quake Live');await until(()=>evaluate("document.querySelectorAll('tbody tr').length===1"),'game filter');
   await evaluate("(()=>{const s=document.querySelector('select[aria-label=\"Capability host OS\"]');s.value='win32';s.dispatchEvent(new Event('change',{bubbles:true}));})()");await text('This preset declares Linux hosts only.');await input('Filter capability versions','nonexistent-build');await text('No executed evidence for this OS / version filter.');
   await navigate('/instances/'+java.id+'/capabilities');await text('Instance capabilities');await text('99.9.9');await text('No exact version/loader execution evidence is recorded.');
   await navigate('/instances/'+proxy.id+'/gamerules');await text('Action unavailable');await text('Configure gamerules on the backend game server');
   const before=nativeReads;await navigate('/instances/'+custom.id+'/game-settings');await text('Action unavailable');assert.equal(nativeReads,before,'Unavailable controls never mount the native settings page');
   if(process.platform==='linux'||process.platform==='win32'){await navigate('/instances/'+css.id+'/game-settings');await text('Counter-Strike: Source settings');await text('Save game settings');}
   await viewport(390,844);await navigate('/compatibility');await text('Game compatibility and validation');await until(()=>evaluate('document.documentElement.scrollWidth<=innerWidth+2'),'matrix has contained horizontal scrolling');await fs.mkdir(path.resolve('artifacts/game-capabilities'),{recursive:true});await captureScreenshot(path.resolve('artifacts/game-capabilities/matrix-mobile.png'));
  });
 }
 const example=JSON.parse(await fs.readFile('sdk/examples/instance-overview.json','utf8'));assert(example.id);
 console.log('Game capabilities: all built-in profiles, OS rules, setup/permission/status blockers, unknown versions, current grants and '+(process.env.OUTPOST_TEST_BROWSER_UI==='1'?'Chromium filters / guarded tabs / mobile matrix':'API contracts')+' passed. No live games were started.');
}finally{if(http){http.closeAllConnections();await new Promise(r=>http.close(r));}db.close();await fs.rm(root,{recursive:true,force:true});}
