import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import ssh2 from 'ssh2';
const {Server:SshServer,utils:sshUtils}=ssh2;
import AdmZip from 'adm-zip';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'outpost-fleet-'));
process.env.OUTPOST_DATA_DIR=root;
const {db,prep}=await import('../dist/db/db.js');
const users=await import('../dist/services/userService.js');
const servers=await import('../dist/services/serverService.js');
const capacity=await import('../dist/services/fleetCapacityService.js');
const fleet=await import('../dist/services/fleetService.js');
const recovery=await import('../dist/services/fleetRecoveryService.js');
const billing=await import('../dist/services/billingService.js');
const enrollment=await import('../dist/services/hostEnrollmentService.js');
const extensions=await import('../dist/services/extensionService.js');
const catalog=await import('../dist/services/communityCatalogService.js');
const templates=await import('../dist/services/templateService.js');
const allocations=await import('../dist/services/allocationService.js');
const jobs=await import('../dist/services/jobService.js');
const {instanceDir}=await import('../dist/utils/paths.js');
const {limitsOf}=await import('../dist/services/limitsService.js');
const {startServer}=await import('../dist/services/processManager.js');
const {allocatePortBundle}=await import('../dist/services/gameWorkflowService.js');
const {createToken}=await import('../dist/auth/tokens.js');
const {authRouter}=await import('../dist/routes/auth.routes.js');
const routers=await import('../dist/routes/fleetAdvanced.routes.js');
const {nodeLinkRouter}=await import('../dist/routes/nodeLink.routes.js');
const {operationsRouter}=await import('../dist/routes/operations.routes.js');
const {unseal,sha256}=await import('../dist/services/fleetSecurity.js');
const {STEAM_GAME_PRESETS}=await import('../dist/services/steamGames.js');
const {GAME_PROFILES}=await import('../dist/services/gameControlProfiles.js');
const originalFetch=globalThis.fetch,total=os.totalmem,free=os.freemem;
os.totalmem=()=>64*1024**3;os.freemem=()=>48*1024**3;
const upstream=new Map();
globalThis.fetch=async(url,init)=>{
 const u=new URL(String(url));
 if(u.hostname==='nodejs.org')return u.pathname.endsWith('index.json')?Response.json([{version:'v22.22.0'}]):new Response(['x64','arm64'].map(a=>'a'.repeat(64)+'  node-v22.22.0-linux-'+a+'.tar.xz').join('\n'));
 if(u.hostname==='127.0.0.1'||u.hostname==='localhost')return originalFetch(url,init);
 if(upstream.has(u.href)){const value=upstream.get(u.href);return typeof value==='function'?value(init):new Response(value);}
 return Response.json({error:'External downloads disabled in fixtures'},{status:503});
};
const wait=async(check,label)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+label);};
let http,ssh;
const results=[];
try{
 const admin=users.createUser('fleet-owner','fixture-password-123','admin'),viewer=users.createUser('fleet-viewer','fixture-password-123','viewer');
 const token=u=>createToken(u.id,u.username,u.role);let browserUser=admin;
 let browserSummaryCalls=0;const app=express();
 app.use((q,_r,next)=>{if(q.path.includes("/actions/summary"))browserSummaryCalls++;next();});
 app.use((q,_r,next)=>{if(q.headers.authorization==='Bearer browser-fixture')q.headers.authorization='Bearer '+token(browserUser);next();});
 app.use('/api/billing',routers.billingInboundRouter);app.use(express.json({limit:'3mb'}));
 app.use('/api/fleet',routers.fleetAdvancedRouter);app.use('/api/fleet-enrollment',routers.enrollmentPublicRouter);app.use('/api/fleet-recovery',routers.recoveryDownloadRouter);app.use('/api/extensions',routers.extensionUserRouter);app.use('/api/node-link',nodeLinkRouter);app.use('/api/operations',operationsRouter);app.use('/api/auth',authRouter);
 app.use((e,_q,r,_next)=>r.status(e.status??500).json({error:e.message}));
 http=app.listen(0,'127.0.0.1');await once(http,'listening');const origin='http://127.0.0.1:'+http.address().port;
 const request=(route,body,user=admin,method=body===undefined?'GET':'POST')=>fetch(origin+route,{method,headers:{Authorization:'Bearer '+token(user),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(route,body,user=admin,method)=>{const r=await request(route,body,user,method),value=await r.json();assert(r.ok,route+': '+JSON.stringify(value));return value;};
 const make=(name,port=25565)=>{const s=servers.createServerRecord({name,platform:'java',loader:'vanilla',version:'1.20.1',minMemoryMb:128,maxMemoryMb:512,serverPort:port,createdBy:admin.id});servers.setServerStatus(s.id,'stopped');return servers.getServer(s.id);};
 const source=make('Source world');await fs.mkdir(path.join(instanceDir(source.id),'world'),{recursive:true});await fs.writeFile(path.join(instanceDir(source.id),'world','level.dat'),'fixture-world-data');await fs.writeFile(path.join(instanceDir(source.id),'server.properties'),'motd=Fixture\nserver-port=25565\n');
 users.setUserServerAccess(viewer.id,[{serverId:source.id,permissions:['files.read']}]);
 const pool=allocations.createAllocationPool({name:'Fleet ports',address:'127.0.0.1',protocol:'both',firstPort:33000,lastPort:33200});
 fleet.saveNodePolicy('local',{enabled:true,reserveMemoryMb:0,maxInstances:0,tags:['ssd']});capacity.saveCapacityPolicy({reserveCpuPercent:0,reserveDiskMb:0});
 const budget={memoryMb:512,cpuPercent:10,diskMb:100,platform:'java',tags:['ssd'],poolId:pool.id,roles:[{role:'game',offset:0,protocol:'tcp'},{role:'rcon',offset:10,protocol:'tcp'}]};
 assert.equal((await request('/api/fleet/capacity',undefined,viewer)).status,403);
 const id=crypto.randomUUID(),lease=capacity.reserveLocalCapacity(id,budget);assert.equal(lease.ports.length,2);
 assert.equal(capacity.reserveLocalCapacity(id,budget).ports[0].port,lease.ports[0].port);
 assert.throws(()=>capacity.reserveLocalCapacity(id,{...budget,memoryMb:1024}),{status:409});
 assert.throws(()=>allocations.assertManualPort(lease.ports[1].port),{status:409});
 assert.throws(()=>allocatePortBundle(source.id,lease.ports[1].port,[{role:'game',offset:0,protocol:'tcp'}]),{status:409});
 assert.throws(()=>capacity.validateCapacity({...budget,memoryMb:512.5}),{status:400});assert.throws(()=>capacity.validateCapacity({...budget,roles:[...budget.roles,{role:'rcon',offset:11,protocol:'tcp'}]}),{status:400});assert.throws(()=>capacity.validateCapacity({...budget,cpuPercent:5}),{status:400});
 const explained=await capacity.explainFleetCapacity({...budget,memoryMb:1000000});assert.equal(explained.hosts[0].eligible,false);assert(explained.hosts[0].reasons.some(r=>r.includes('memoryMb')));
 const definition={name:'Reserved game',loader:'vanilla',version:'1.20.1',acceptEula:true};
 const created=await json('/api/fleet/capacity/provision',{nodeId:'local',id,definition});assert.equal(capacity.capacityLease(id).server_id,created.server.id);assert.equal(limitsOf(servers.getServer(created.server.id)).diskMb,100);
 assert.equal((await json('/api/fleet/capacity/provision',{nodeId:'local',id,definition})).server.id,created.server.id);
 assert.equal((await request('/api/fleet/capacity/provision',{nodeId:'local',id,definition:{...definition,name:'Changed'}})).status,409);
 const expireId=crypto.randomUUID();capacity.reserveLocalCapacity(expireId,budget);prep('UPDATE fleet_capacity_leases SET expires=0 WHERE id=?').run(expireId);assert.throws(()=>capacity.reserveLocalCapacity(expireId,budget),{status:409});
 results.push('Capacity explanations, bundle exclusion, expiry, limits and provisioning replay');

 const bridge=await fs.readFile(path.resolve('sdk/browser.js'),'utf8');
 const manifest={format:'outpost-extension',sdkVersion:1,id:'fixture-sdk',name:'Fixture SDK',version:'1.0.0',author:'Outpost test',description:'Fixture extension',minPanelVersion:'1.0.0',pages:[{id:'overview',title:'Fixture overview',permissions:['files.read'],html:'<h1>Fixture extension page</h1><pre id="result">Waiting</pre><script>'+bridge+'\nwindow.outpost.invoke("summary",{}).then(r=>document.querySelector("#result").textContent=r.name).catch(e=>document.querySelector("#result").textContent=e.message);</script>'},{id:'admin',title:'Admin only',permissions:[],html:'Admin'}],actions:[{id:'summary',title:'Summary',kind:'instance.summary',permissions:['files.read']},{id:'read',title:'Read',kind:'files.read',permissions:['files.read']},{id:'command',title:'Command',kind:'console.command',permissions:['console']}],gameAdapters:[]};
 let review=extensions.extensionReview(manifest);assert.throws(()=>extensions.installExtension(manifest,'incorrect',{}),{status:409});extensions.installExtension(manifest,review.digest,{test:true});
 assert.equal((await request('/api/extensions/fixture-sdk/pages/overview?serverId='+source.id,undefined,viewer)).status,404);extensions.toggleExtension(manifest.id,true);
 const summary=await json('/api/extensions/fixture-sdk/actions/summary?serverId='+source.id,{input:{}},viewer);assert.equal(summary.name,source.name);assert(!('created_by' in summary));
 assert.equal((await request('/api/extensions/fixture-sdk/actions/command?serverId='+source.id,{input:{command:'say test'}},viewer)).status,403);
 assert.equal((await request('/api/extensions/fixture-sdk/pages/admin?serverId='+source.id,undefined,viewer)).status,403);
 assert.equal((await request('/api/extensions/fixture-sdk/actions/read?serverId='+source.id,{input:{path:'../outside'}},viewer)).status,400);
 users.setUserServerAccess(viewer.id,[{serverId:source.id,permissions:[]}]);assert.equal((await request('/api/extensions/fixture-sdk/actions/summary?serverId='+source.id,{input:{}},viewer)).status,403);users.setUserServerAccess(viewer.id,[{serverId:source.id,permissions:['files.read']}]);
 assert.throws(()=>extensions.validateExtension({...manifest,id:undefined}),{status:400});
 assert.throws(()=>extensions.validateExtension({...manifest,minPanelVersion:'99.0.0'}),{status:409});assert.throws(()=>extensions.validateExtension({...manifest,pages:[null]}),{status:400});
 const backendUrl='https://fixture.invalid/action/echo';process.env.OUTPOST_EXTENSION_SECRET_FIXTURE_SDK='backend-fixture-secret';
 upstream.set(backendUrl,init=>{assert.equal(init.headers.Authorization,'Bearer backend-fixture-secret');const payload=JSON.parse(init.body);assert.deepEqual(Object.keys(payload.context).sort(),['serverId','userId']);assert(!init.body.includes(token(viewer)));return Response.json({echo:payload.input});});
 const backendManifest={...manifest,version:'1.1.0',backend:{url:'https://fixture.invalid/action'},actions:[...manifest.actions,{id:'echo',title:'Echo',kind:'backend.request',backendPath:'/echo',permissions:['files.read']}]};
 review=extensions.extensionReview(backendManifest);extensions.installExtension(backendManifest,review.digest,{test:true});extensions.toggleExtension(manifest.id,true);assert.deepEqual(await json('/api/extensions/fixture-sdk/actions/echo?serverId='+source.id,{input:{hello:true}},viewer),{echo:{hello:true}});
 extensions.rollbackExtension(manifest.id);assert.equal(extensions.extensionRows()[0].manifest.version,'1.0.0');assert.equal(extensions.extensionRows()[0].enabled,false);extensions.toggleExtension(manifest.id,true);
 const adapter={id:'x-fixture-sdk-native',label:'Fixture native game',appId:'123456',format:'ini',file:'server.ini',fields:[{key:'ServerName',label:'Name',type:'text',default:'@name'}],notes:['Fixture only'],executable:{linux:'server',win32:'server.exe'},launchArgs:['--port','{port}'],hosts:['linux','win32']};
 const adapterManifest={...manifest,version:'1.2.0',gameAdapters:[adapter]};review=extensions.extensionReview(adapterManifest);extensions.installExtension(adapterManifest,review.digest,{});extensions.toggleExtension(manifest.id,true);assert(GAME_PROFILES.some(g=>g.id===adapter.id));const preset=STEAM_GAME_PRESETS.find(p=>p.id===adapter.id);assert.deepEqual(preset.buildLaunchArgs(source),['--port','25565']);preset.prepareInstance({...source,game_settings:JSON.stringify({controls:{values:{ServerName:'Fixture'},rotation:[]}})});assert.match(await fs.readFile(path.join(instanceDir(source.id),'server.ini'),'utf8'),/ServerName/);
 const dependent=servers.createServerRecord({name:'Adapter dependency',platform:'steam',loader:'steam',version:'latest',minMemoryMb:128,maxMemoryMb:128,serverPort:33300,createdBy:admin.id,steamPreset:adapter.id,steamAppId:adapter.appId});assert.throws(()=>extensions.toggleExtension(manifest.id,false),{status:409});servers.deleteServerRecord(dependent.id);
 results.push('SDK compatibility, isolated actions, current permissions, backend context and native adapter registration');

 const template={format:'outpost-template',version:1,name:'Pinned Java',description:'Fixture template',author:'Fixture',exportedAt:new Date().toISOString(),instance:{platform:'java',loader:'vanilla',version:'1.20.1'},variables:[],files:[]};
 const keys=crypto.generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
 const templateBytes=JSON.stringify(template),extensionBytes=JSON.stringify(manifest);upstream.set('https://fixture.invalid/template.json',templateBytes);upstream.set('https://fixture.invalid/extension.json',extensionBytes);
 const catalogManifest={schemaVersion:1,publisher:'Fixture curator',generatedAt:new Date().toISOString(),entries:[{id:'java-starter',name:'Java starter',kind:'template',releases:[{version:'1.0.0',url:'https://fixture.invalid/template.json',sha256:sha256(templateBytes),summary:'First version'}]},{id:'fixture-sdk',name:'SDK',kind:'extension',releases:[{version:'1.0.0',url:'https://fixture.invalid/extension.json',sha256:sha256(extensionBytes),summary:'First SDK'}]}]};
 const publish=m=>{const text=JSON.stringify(m);upstream.set('https://fixture.invalid/catalog.json',JSON.stringify({manifest:text,signature:crypto.sign(null,Buffer.from(text),keys.privateKey).toString('base64')}));};publish(catalogManifest);
 const catalogSource=catalog.addCatalogSource({name:'Fixture curator',url:'https://fixture.invalid/catalog.json',publicKey});await catalog.syncCatalog(catalogSource.id);
 let pkg=await catalog.reviewCatalogRelease(catalogSource.id,'java-starter','1.0.0');const pin=await catalog.installCatalogRelease(admin.id,pkg);assert.equal(templates.getTemplate(pin.targetId).name,template.name);
 publish({...catalogManifest,entries:[]});await catalog.syncCatalog(catalogSource.id);publish({...catalogManifest,entries:[{...catalogManifest.entries[0],releases:[{...catalogManifest.entries[0].releases[0],sha256:'f'.repeat(64)}]}]});await assert.rejects(catalog.syncCatalog(catalogSource.id),{status:409});publish(catalogManifest);await catalog.syncCatalog(catalogSource.id);
 upstream.set('https://fixture.invalid/template.json','tampered');await assert.rejects(catalog.reviewCatalogRelease(catalogSource.id,'java-starter','1.0.0'),{status:422});upstream.set('https://fixture.invalid/template.json',templateBytes);
 upstream.set('https://fixture.invalid/catalog.json',JSON.stringify({manifest:JSON.stringify(catalogManifest),signature:'bad'}));await assert.rejects(catalog.syncCatalog(catalogSource.id),{status:422});catalog.toggleCatalogSource(catalogSource.id,false);await assert.rejects(catalog.installCatalogRelease(admin.id,pkg),{status:404});
 results.push('Ed25519 provenance, pinned imports, disabled sources, tampering and immutable removed versions');

 const connection=billing.saveBillingConnection({name:'Fixture billing'}),plan=billing.saveBillingPlan(admin.id,{name:'Starter',templateId:pin.targetId,memoryMb:512,cpuPercent:10,diskMb:100,portPoolId:pool.id,variables:{},acceptEula:true});
 const delivery=async(body,eventId=crypto.randomUUID(),signatureOverride)=>{const raw=JSON.stringify(body),stamp=String(Math.floor(Date.now()/1000)),signature=crypto.createHmac('sha256',connection.secret).update(stamp+':'+eventId+':'+raw).digest('hex');return fetch(origin+'/api/billing/events/'+connection.id,{method:'POST',headers:{'Content-Type':'application/json','X-Outpost-Event-Id':eventId,'X-Outpost-Timestamp':stamp,'X-Outpost-Signature':signatureOverride??signature},body:raw});};
 const event={action:'create',externalId:'order-42',customerId:'customer-1',planId:plan.id},eventId=crypto.randomUUID();let reply=await delivery(event,eventId);let service=await reply.json();assert(reply.ok,JSON.stringify(service));const billed=service.serverId;assert(billed);assert.equal(limitsOf(servers.getServer(billed)).cpuPercent,10);
 reply=await delivery(event,eventId);assert.equal((await reply.json()).serverId,billed);assert.equal((await delivery({...event,externalId:'changed'},eventId)).status,409);assert.equal((await delivery(event,undefined,'0'.repeat(64))).status,401);
 assert.equal((await delivery({...event,customerId:'customer-2',action:'renew'})).status,409);
 const owner=users.getUserById(servers.getServer(billed).created_by);assert.notEqual(owner.role,'admin');assert.equal(users.getEffectiveCreation(owner.id,owner.role).canCreate,false);
 await wait(()=>!['installing','updating'].includes(servers.getServer(billed).status),'fixture install settles');await fs.writeFile(path.join(instanceDir(billed),'world.txt'),'retained billing world');
 assert((await delivery({...event,action:'suspend'})).ok);assert(servers.getServer(billed).suspended);assert((await delivery({...event,action:'renew',expiresAt:new Date(Date.now()+86400000).toISOString()})).ok);assert(!servers.getServer(billed).suspended);
 const upgrade=billing.saveBillingPlan(admin.id,{name:'Larger',templateId:pin.targetId,memoryMb:768,cpuPercent:20,diskMb:150,portPoolId:pool.id,variables:{},acceptEula:true});assert((await delivery({...event,action:'changePlan',planId:upgrade.id})).ok);assert.equal(servers.getServer(billed).max_memory_mb,768);assert.equal(limitsOf(servers.getServer(billed)).diskMb,150);
 servers.setServerSuspension(billed,true,'Manual review',admin.id);assert((await delivery({...event,action:'unsuspend'})).ok);assert.equal(servers.getServer(billed).suspended_reason,'Manual review');servers.setServerSuspension(billed,false,null,admin.id);
 prep('UPDATE billing_services SET expires=0 WHERE server_id=?').run(billed);await billing.expireBillingServices();assert.equal(Boolean(servers.getServer(billed).suspended),true);assert(servers.getServer(billed));
 assert.equal((await delivery({...event,action:'terminate'})).status,403);billing.saveBillingConnection({id:connection.id,name:'Fixture billing',allowTermination:true});assert((await delivery({...event,action:'terminate'})).ok);assert(!servers.getServer(billed));
 const archiveRow=prep('SELECT data FROM billing_services WHERE external_id=?').get(event.externalId),archive=JSON.parse(archiveRow.data).terminationArchive;const retained=new AdmZip(await fs.readFile(path.join(root,'billing-archives',archive,'instance.zip')));assert.equal(retained.readAsText('world.txt'),'retained billing world');assert((await delivery({...event,action:'terminate'})).ok);
 results.push('Signed billing provisioning, customer binding, replay, suspension, expiry and retained termination archives');

 const malformed=new AdmZip();malformed.addFile('safe.txt',Buffer.from('blocked'));const malicious=Buffer.from(malformed.toBuffer().toString('latin1').replaceAll('safe.txt','../x.txt'),'latin1');upstream.set('https://fixture.invalid/unsafe.zip',malicious);
 const run=crypto.randomUUID(),snapshot=await recovery.prepareRecoverySnapshot(run,source.id,origin);assert(recovery.recoveryFence(source.id).active);await assert.rejects(startServer(source.id),{status:423});
 await assert.rejects(recovery.importRecoverySnapshot(crypto.randomUUID(),{...snapshot,url:'https://fixture.invalid/unsafe.zip',sha256:sha256(malicious),sizeBytes:malicious.length},{...budget,roles:[budget.roles[0]]}),{status:400});await assert.rejects(fs.access(path.join(root,'servers','x.txt')));
 assert.equal((await fetch(snapshot.url,{headers:{Authorization:'Bearer invalid'}})).status,401);
 const standby=await recovery.importRecoverySnapshot(run,snapshot,{...budget,roles:[budget.roles[0]]});assert.equal(await fs.readFile(path.join(instanceDir(standby.serverId),'world','level.dat'),'utf8'),'fixture-world-data');assert.equal(servers.getServer(standby.serverId).status,'stopped');assert(recovery.recoveryFence(standby.serverId).active);await assert.rejects(startServer(standby.serverId),{status:423});assert.equal((await recovery.importRecoverySnapshot(run,snapshot,{...budget,roles:[budget.roles[0]]})).serverId,standby.serverId);
 await assert.rejects(recovery.importRecoverySnapshot(crypto.randomUUID(),{...snapshot,sha256:'0'.repeat(64)},{...budget,roles:[budget.roles[0]]}),{status:422});
 // Exercise the cutover coordinator with both ends local. This verifies fences, not live cross-host games.
 const coordinator={id:run,owner:admin.id,sourceNodeId:'local',sourceServerId:source.id,destinationNodeId:'local',destinationServerId:standby.serverId,mode:'evacuate',state:'standby',request:budget,sourcePublicUrl:origin,snapshot:{...snapshot,ticketKey:'not-used'},logs:[],at:Date.now()};
 prep('INSERT INTO fleet_recovery_runs(id,owner,data,updated_at) VALUES (?,?,?,?)').run(run,admin.id,JSON.stringify(coordinator),Date.now());
 assert.equal((await recovery.activateRecovery(admin.id,run,{reviewedDependencies:true})).state,'activated-stopped');assert(recovery.recoveryFence(source.id).active);assert(!recovery.recoveryFence(standby.serverId).active);assert.equal(servers.getServer(standby.serverId).status,'stopped');
 assert.equal((await recovery.rollbackRecovery(admin.id,run)).state,'rolled-back');assert(!recovery.recoveryFence(source.id).active);assert(recovery.recoveryFence(standby.serverId).active);
 const conflict=crypto.randomUUID();recovery.setRecoveryFence(source.id,conflict,true,'Other operation');prep('UPDATE fleet_recovery_runs SET data=? WHERE id=?').run(JSON.stringify(coordinator),run);await assert.rejects(recovery.activateRecovery(admin.id,run,{reviewedDependencies:true,externallyFenced:true}),{status:409});assert(recovery.recoveryFence(standby.serverId).active);
 const restartCheck=await promisify(execFile)(process.execPath,['--input-type=module','-e',"const r=await import('./server/dist/services/fleetRecoveryService.js');r.assertRecoveryIdle(process.argv[1]);" ,standby.serverId],{cwd:path.resolve('.'),env:{...process.env},windowsHide:true}).then(()=>false,e=>String(e.stderr).includes('Recovery fence'));assert(restartCheck,'Fence survives a fresh process');
 results.push('Verified restore, scoped ticket, checksum rejection, stopped standbys, persistent fences and guarded cutover/rollback');

 const hostKeys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),hostPrivate=hostKeys.privateKey.export({type:'pkcs1',format:'pem'}),clientKeys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),clientPrivate=clientKeys.privateKey.export({type:'pkcs1',format:'pem'}),fingerprint=sha256(sshUtils.parseKey(hostPrivate).getPublicSSH());
 let scripts=0;
 ssh=new SshServer({hostKeys:[hostPrivate]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='publickey'?ctx.accept():ctx.reject());client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',(accept,_reject,info)=>{assert.equal(info.command,'bash -s');scripts++;const stream=accept();let input='';stream.on('data',data=>input+=data.toString());stream.on('end',()=>{void(async()=>{const encoded=input.match(/OUTPOST_ENROLLMENT_CONFIG='([^']+)'/)[1],config=JSON.parse(Buffer.from(encoded,'base64'));assert.equal(config.ownerPassword,'owner-password-fixture');stream.write('token '+config.secret.slice(0,8));await new Promise(r=>setTimeout(r,25));stream.write(config.secret.slice(8)+'\n');const complete=await enrollment.completeEnrollment(config.id,config.secret,'mcn_'+'n'.repeat(40));assert(complete.nodeId);stream.write('enrolled\n');stream.exit(0);stream.end();})().catch(e=>{stream.stderr.write(e.message);stream.exit(1);stream.end();});});});}));});ssh.on('error',()=>{});ssh.listen(0,'127.0.0.1');await once(ssh,'listening');
 // The transport stub returns a real response and requires the new node key.
 upstream.set('https://enrolled.fixture.invalid/api/node-link/info',init=>{assert.equal(init.headers['x-outpost-node-key'],'mcn_'+'n'.repeat(40));return Response.json({hostname:'fixture-node',platform:'linux',instances:0});});
 const enrollmentInput={name:'Fixture Linux host',nodeUrl:'https://enrolled.fixture.invalid',panelUrl:origin,ownerUsername:'fixtureowner',ownerPassword:'owner-password-fixture',reverseProxyReady:true};
 let planHost=await enrollment.createEnrollment(admin.id,enrollmentInput);assert(!JSON.stringify(planHost).includes(enrollmentInput.ownerPassword));assert(planHost.script.includes('sha256sum'));assert(planHost.script.includes('Environment=PORT=8642'));assert(!planHost.script.includes('rm -rf'));const stored=JSON.parse(prep('SELECT data FROM fleet_enrollments WHERE id=?').get(planHost.id).data);assert.notEqual(stored.ownerPassword,enrollmentInput.ownerPassword);const bundle=enrollment.enrollmentBundle(planHost.id,unseal(stored.secret));const listing=await promisify(execFile)('tar',['-tzf',bundle],{windowsHide:true,maxBuffer:2*1024*1024});assert(!listing.stdout.split('\n').some(p=>/(^|\/)(\.env|\.git|data)(\/|$)/.test(p)));
 await enrollment.executeEnrollment(admin.id,planHost.id,{bundleHash:planHost.bundleHash,host:'127.0.0.1',port:ssh.address().port,username:'root',privateKey:clientPrivate,fingerprint:'0'.repeat(64)});await wait(()=>enrollment.enrollmentRows().find(e=>e.id===planHost.id).state==='failed','wrong host key refused');assert.equal(scripts,0);
 planHost=await enrollment.createEnrollment(admin.id,enrollmentInput);const stored2=JSON.parse(prep('SELECT data FROM fleet_enrollments WHERE id=?').get(planHost.id).data),secret2=unseal(stored2.secret);await enrollment.executeEnrollment(admin.id,planHost.id,{bundleHash:planHost.bundleHash,host:'127.0.0.1',port:ssh.address().port,username:'root',privateKey:clientPrivate,fingerprint:'SHA256:'+Buffer.from(fingerprint,'hex').toString('base64').replace(/=+$/,'')});await wait(()=>enrollment.enrollmentRows().find(e=>e.id===planHost.id).state==='enrolled','enrollment callback');await wait(()=>!jobs.jobRows().some(j=>j.kind==='host-enrollment'&&j.status==='running'),'SSH job finished');assert.equal(scripts,1);assert(!JSON.stringify(enrollment.enrollmentRows()).includes(secret2));assert(!JSON.stringify(jobs.jobRows()).includes(secret2));assert.throws(()=>enrollment.enrollmentBundle(planHost.id,secret2),{status:401});
 results.push('Pinned SSH transport, reviewed bundle, split-chunk secret redaction and single-use enrollment callback (installer not executed)');

 if(process.env.OUTPOST_TEST_BROWSER_UI==='1'){
  const {runBrowser}=await import('./browserHarness.mjs');
  app.get('/api/servers',(_q,r)=>r.json({servers:servers.listServers(),metrics:{}}));app.get('/api/users',(_q,r)=>r.json({users:users.listUsers()}));app.use('/api',(_q,r)=>r.status(503).json({error:'Outside fixture scope'}));app.use(express.static(path.resolve('web/dist')));app.get('*',(_q,r)=>r.sendFile(path.resolve('web/dist/index.html')));
  await runBrowser(origin,async({navigate,text,evaluate,until,viewport,captureScreenshot})=>{
   for(const [section,title] of [['enrollment','Unattended host installation and enrollment'],['capacity','Capacity and placement explanations'],['recovery','Verified evacuation and failover'],['billing','Billing lifecycle connections'],['extensions','Versioned extension SDK'],['community','Curated community catalog']]){await navigate('/configuration/operations?section='+section);await text(title);assert(await evaluate('!!document.querySelector("main")'));}
   const summaryBefore=browserSummaryCalls;await navigate('/extensions/fixture-sdk/overview?serverId='+source.id);await text('Fixture overview');await until(()=>evaluate("!!document.querySelector('iframe')"),'sandbox frame');assert.equal(await evaluate("document.querySelector('iframe').getAttribute('sandbox')"),'allow-scripts');
   await until(()=>browserSummaryCalls>summaryBefore,'sandbox page invoked permission-checked summary');assert(await evaluate("document.querySelector('iframe').contentDocument===null"),'Iframe cannot expose its document to the panel origin');
   await viewport(390,844);await navigate('/configuration/operations?section=capacity');await text('Capacity and placement explanations');assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'),'No mobile overflow');
   await fs.mkdir(path.resolve('artifacts/fleet-integrations'),{recursive:true});await captureScreenshot(path.resolve('artifacts/fleet-integrations/capacity-mobile.png'));
  });
  results.push('Six administrator panels, extension iframe sandbox and mobile capacity layout in Chromium');
 }
 console.log(results.map((r,i)=>`${i+1}. PASS ${r}`).join('\n'));
}finally{
 globalThis.fetch=originalFetch;os.totalmem=total;os.freemem=free;delete process.env.OUTPOST_EXTENSION_SECRET_FIXTURE_SDK;
 if(ssh)await new Promise(resolve=>ssh.close(resolve));if(http)await new Promise(resolve=>http.close(resolve));
 db.close();await fs.rm(root,{recursive:true,force:true});
}
