// Real shared React controls plus the production shell, with disposable API fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { build } from 'esbuild';
import { runBrowser } from './browserHarness.mjs';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-ui-consistency-'));
const artifacts = path.resolve('artifacts/ui-consistency'); await fs.mkdir(artifacts, { recursive: true });
for (const name of ['browser-failure.json', 'browser-failure.png']) await fs.rm(path.join(artifacts, name), { force: true });
let http;
try {
  const bundle = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MotionConfig} from 'framer-motion';
    import {Button,Input,Select,Field,Card,CardTitle,Modal,Notice,ErrorText} from './web/src/components/ui.tsx';
    import {ConfirmProvider,useConfirm} from './web/src/components/ConfirmDialog.tsx';
    import {applyTheme,saveColorMode} from './web/src/lib/theme.ts';
    window.setTheme=(id,mode)=>{saveColorMode(mode??'dark');applyTheme(id)};
    const word='UnbrokenLongInstanceAndFilename'.repeat(8);
    function Controls(){const[open,setOpen]=useState(false),[submits,setSubmits]=useState(0),[message,setMessage]=useState('');const confirm=useConfirm();
      return <main style={{padding:16,maxWidth:960,margin:'auto'}}>
        <Card className="p-4"><CardTitle action={<div className="flex gap-2"><Button>Refresh details</Button><Button>Manage configuration</Button></div>}>{word}</CardTitle>
          <form onSubmit={e=>{e.preventDefault();setSubmits(n=>n+1)}}>
            <div className="flex flex-wrap items-end gap-2" data-form-row><Field label="Instance name"><Input aria-label="Instance name" defaultValue="Example"/></Field><Button onClick={()=>setMessage('Action clicked')}>Action</Button><Button type="submit" variant="primary">Save</Button></div>
          </form><p id="submits">Submits: {submits}</p><p>{message}</p>
          <Field label="Theme options"><Select aria-label="Theme options"><option>Choose an option</option><option>Another option</option></Select></Field>
          <Notice>{word}</Notice><ErrorText>{word}</ErrorText>
          <div className="mt-4 flex flex-wrap gap-2"><Button onClick={()=>setOpen(true)}>Open long dialog</Button><Button onClick={()=>void confirm({title:'Review a destructive change',message:word,confirmLabel:'Confirm this explicitly reviewed destructive change',cancelLabel:'Keep existing configuration',tone:'danger'})}>Open confirmation</Button></div>
          <div style={{position:'relative',height:64}} data-position-parent><Button className="absolute right-3 top-3" data-positioned>Positioned action</Button></div>
        </Card>
        <Modal title={word} open={open} onClose={()=>setOpen(false)}><Field label="Dialog field"><Input aria-label="Dialog field"/></Field><p>{word}</p><div style={{height:400}}>Scrollable dialog content</div><Button onClick={()=>setOpen(false)}>Finish dialog</Button></Modal>
      </main>}
    createRoot(document.getElementById('root')).render(<MotionConfig reducedMotion="always"><ConfirmProvider><Controls/></ConfirmProvider></MotionConfig>);
  ` } });
  await fs.writeFile(path.join(temp, 'controls.js'), bundle.outputFiles[0].contents);
  const index = await fs.readFile('web/dist/index.html', 'utf8'), css = [...index.matchAll(/href="([^"]+\.css)"/g)].map(m => m[1]);
  const app = express();
  app.get('/controls', (_q, r) => r.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css.map(h => `<link rel="stylesheet" href="${h}">`).join('')}<div id="root"></div><script type="module" src="/controls.js"></script>`));
  app.get('/controls.js', (_q, r) => r.sendFile(path.join(temp, 'controls.js')));
  app.get('/api/auth/status', (_q,r)=>r.json({setupRequired:false}));
  app.get('/api/auth/me', (_q,r)=>r.json({user:{id:'reviewer',username:'UI review',role:'admin'},creation:{canCreate:true,allowedPlatforms:['java'],platforms:['java'],owned:0}}));
  app.get('/api/workspace/jobs',(_q,r)=>r.json({jobs:[]})); app.get('/api/servers',(_q,r)=>r.json({servers:[],metrics:{}}));
  app.use('/api', (_q,r)=>r.status(503).json({error:'Outside fixture scope'}));
  // Deliberately stall optional font CSS while testing that the real app still boots.
  app.get('/slow-fonts.css', (_q,r)=>{ r.on('close',()=>{}); });
  app.use(express.static(path.resolve('web/dist'),{index:false}));app.get('*',(_q,r)=>r.type('html').send(index.replace(/href="https:\/\/fonts\.googleapis\.com\/css2[^"]+"/, 'href="/slow-fonts.css"')));
  http=app.listen(0,'127.0.0.1');await once(http,'listening');
  await runBrowser(`http://127.0.0.1:${http.address().port}`,async({navigate,text,click,evaluate,until,viewport,pressKey,captureScreenshot})=>{
    await navigate('/controls');await text('Open long dialog');
    await click('Action');assert.equal(await evaluate("document.querySelector('#submits').textContent"),'Submits: 0','Ordinary buttons do not submit enclosing forms');await click('Save');await text('Submits: 1');
    for(const [theme,mode] of [['outpost','dark'],['outpost','light'],['classic'],['minecraft'],['xp'],['vista'],['aero']]){
      await evaluate(`setTheme(${JSON.stringify(theme)},${JSON.stringify(mode??'dark')})`);
      for(const width of [320,390,768,1440]){
        await viewport(width,900);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`Controls fit ${theme}/${mode}/${width}`);
        const dimensions=await evaluate(`(()=>{const i=document.querySelector('[aria-label="Instance name"]').getBoundingClientRect();const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Save').getBoundingClientRect();return {i:i.height,b:b.height}})()`);
        assert.equal(dimensions.i,dimensions.b,`Input and button baseline height ${theme}`);
        const pair=await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('select')),o=getComputedStyle(document.querySelector('option'));return {sf:s.color,sb:s.backgroundColor,of:o.color,ob:o.backgroundColor}})()`);
        assert.notEqual(pair.sf,pair.sb,`Select text visible ${theme}`);assert.notEqual(pair.of,pair.ob,`Option text visible ${theme}`);
        assert(await evaluate(`(()=>{const p=document.querySelector('[data-positioned]'),b=p.getBoundingClientRect(),c=p.parentElement.getBoundingClientRect();return getComputedStyle(p).position==='absolute'&&b.right<=c.right&&b.left>=c.left})()`),'Shared hover style preserves explicit positioning');
      }
      await viewport(320,560);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Open long dialog').focus()`);await click('Open long dialog');await text('Finish dialog');
      await until(()=>evaluate(`(()=>{const d=document.querySelector('[aria-modal=true]');if(!d)return false;const b=d.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1})()`),`Long dialog fits ${theme}`);
      await pressKey('Tab');assert(await evaluate(`document.querySelector('[aria-modal=true]').contains(document.activeElement)`));await pressKey('Escape');await until(()=>evaluate(`!document.querySelector('[aria-modal=true]')`),'Dialog closed');
      assert.equal(await evaluate('document.activeElement.textContent'),'Open long dialog','Dialog returns keyboard focus');
      await click('Open confirmation');await text('Confirm this explicitly');assert(await evaluate(`(()=>{const d=document.querySelector('[aria-modal=true]');return d.scrollWidth<=d.clientWidth+1})()`),'Confirmation actions wrap');await pressKey('Escape');await until(()=>evaluate(`!document.querySelector('[aria-modal=true]')`),'Confirmation closed');
    }
    await evaluate("setTheme('outpost','dark')");await captureScreenshot(path.join(artifacts,'controls-mobile.png'));
    await navigate('/jobs');await text('Job center');await viewport(320,844);
    assert(await evaluate(`[...document.querySelectorAll('.ui-topbar button,.ui-topbar a')].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})`),'All header controls visible at 320px');
    await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Main menu"]');b.focus();b.click()})()`);await until(()=>evaluate(`!!document.querySelector('[aria-label="Main navigation"][aria-modal=true]')`),'Mobile menu open');
    for(let i=0;i<12;i++){await pressKey('Tab');assert(await evaluate(`document.querySelector('[aria-label="Main navigation"]').contains(document.activeElement)`),'Mobile menu traps focus');}
    await pressKey('Escape');await until(()=>evaluate(`document.querySelector('[aria-label="Main navigation"]').parentElement.inert`),'Closed navigation is inert');assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Main menu');
    await evaluate(`document.querySelector('button[aria-label="Main menu"]').click()`);
    await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Outpost apps"]');b.focus();b.click()})()`);
    await until(()=>evaluate(`document.querySelector('.ui-popover')?.contains(document.activeElement)&&document.querySelector('[aria-label="Main navigation"]').parentElement.inert`),'Opening another header surface closes the drawer and moves focus');
    await pressKey('Escape');await until(()=>evaluate(`!document.querySelector('.ui-popover')`),'App launcher closes');assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Outpost apps');
    await evaluate(`document.querySelector('button[aria-label="Main menu"]').click()`);await viewport(1024,900);await until(()=>evaluate(`!document.querySelector('.ui-sheet').inert&&!document.querySelector('[aria-label="Main navigation"][aria-modal=true]')`),'Desktop resize releases mobile focus lock');
    await viewport(390,844);await captureScreenshot(path.join(artifacts,'navigation-mobile.png'));
  },{artifactDirectory:artifacts});
  console.log('UI consistency: seven theme/palette variants at four widths, control baselines, dropdown contrast pairs, long dialogs, confirmation wrapping, safe button defaults and mobile navigation focus/resize passed.');
}finally{if(http){http.closeAllConnections();await new Promise(r=>http.close(r));}await fs.rm(temp,{recursive:true,force:true});}
