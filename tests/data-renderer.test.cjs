/** Real React data/Trash/Undo flows in private Chromium, using memory-only APIs. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-data-renderer-'))
  const env = { ...process.env, DONELINE_DATA_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('doneline-data-renderer-'))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const directory = process.env.DONELINE_DATA_TEST_DIR
  app.disableHardwareAcceleration()
  app.setPath('userData', path.join(directory, 'profile'))
  const mockSource = `
    localStorage.setItem('doneline.activeProfile','self');
    const copy={id:'2026-10-10T10-00-00-000Z-12345678',createdAt:'2026-10-10T10:00:00Z',reason:'manual',sizeBytes:200};
    const removed=(id,person_id='self')=>({id,kind:'task',item_id:'original-'+id,person_id,title:id,deleted_at:'2026-10-10T10:00:00Z',item_count:1});
    const fixture=window.__fixture={calls:[],errors:[],listeners:[],backups:[],trash:[removed('Deleted task')],body:'Saved original note',pendingNotes:[],pendingCreates:[],pendingBackups:[],pendingTrash:[],pendingLists:[],pendingConnections:[],deferLists:false,cloud:false};
    const record=(method,input)=>fixture.calls.push({method,input});
    fixture.change=()=>fixture.listeners.forEach(fn=>fn());
    fixture.finishNote=()=>{const pending=fixture.pendingNotes.shift();fixture.body=pending.body;pending.resolve({day:pending.day,person_id:pending.personId,body:pending.body,updated_at:new Date().toISOString()});};
    fixture.finishCreate=()=>{fixture.backups.push(copy);fixture.pendingCreates.shift().resolve(copy);};
    fixture.finishBackup=fail=>{const pending=fixture.pendingBackups.shift();if(fail){pending.reject(Error('Fixture restore failed'));return;}fixture.body='Restored historical note';fixture.change();pending.resolve({safetyBackup:{...copy,reason:'before-restore'},restoredAt:new Date().toISOString()});};
    fixture.finishTrash=(id,fail=false)=>{const index=fixture.pendingTrash.findIndex(p=>p.id===id);if(index<0)throw Error('Missing pending restore '+id);const [pending]=fixture.pendingTrash.splice(index,1);if(fail){pending.reject(Error('Fixture Trash restore failed'));return;}fixture.trash=fixture.trash.filter(item=>item.id!==id);pending.resolve({kind:'task',itemIds:['original-'+id],personId:'self'});};
    fixture.remove=id=>window.dispatchEvent(new CustomEvent('doneline:deleted',{detail:{trashIds:[id],label:'Task moved to Trash'}}));
    window.addEventListener('error',event=>fixture.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>fixture.errors.push(String(event.reason)));
    window.doneline={
      people:{list:async()=>[{id:'self',name:'Me',emoji:'M',color:'#2f7a4d'},{id:'friend',name:'Friend',emoji:'F',color:'#7754ad'}]},
      presence:{getSelf:async()=> 'self'},
      workspace:{status:async()=>({cloud:fixture.cloud,syncUrl:null}),myCode:async()=>null,connect:input=>{record('workspace.connect',input);return new Promise((resolve,reject)=>fixture.pendingConnections.push({resolve,reject}));},disconnect:()=>{record('workspace.disconnect');return new Promise((resolve,reject)=>fixture.pendingConnections.push({resolve,reject}));},onChanged:fn=>{fixture.listeners.push(fn);return()=>fixture.listeners=fixture.listeners.filter(value=>value!==fn);}},
      notes:{get:async(day,personId)=>({day,person_id:personId,body:fixture.body,updated_at:new Date().toISOString()}),set:(day,body,personId)=>{record('notes.set',{day,body,personId});return new Promise(resolve=>fixture.pendingNotes.push({day,body,personId,resolve}));}},
      data:{listBackups:async()=>fixture.backups,createBackup:()=>{record('data.createBackup');return new Promise(resolve=>fixture.pendingCreates.push({resolve}));},restoreBackup:id=>{record('data.restoreBackup',id);return new Promise((resolve,reject)=>fixture.pendingBackups.push({id,resolve,reject}));}},
      trash:{list:personId=>{record('trash.list',personId);if(fixture.deferLists)return new Promise(resolve=>fixture.pendingLists.push({personId,resolve}));return Promise.resolve(fixture.trash.filter(item=>!personId || item.person_id===personId));},restore:id=>{record('trash.restore',id);return new Promise((resolve,reject)=>fixture.pendingTrash.push({id,resolve,reject}));}}
    };
  `
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ProfileProvider,useProfile} from './src/renderer/src/profile';
    import YourDataSection from './src/renderer/src/components/YourDataSection';
    import DeletionUndoToast from './src/renderer/src/components/DeletionUndoToast';
    import DailyNote from './src/renderer/src/components/DailyNote';
    import {WorkspaceSection} from './src/renderer/src/views/SettingsView';
    function Fixture(){const profile=useProfile();return <main className="mx-auto max-w-2xl space-y-6 p-6"><button onClick={()=>profile.setActive('self')}>Self filter</button><button onClick={()=>profile.setActive('friend')}>Friend filter</button><YourDataSection/><DailyNote day="2026-10-10" personId="self"/><WorkspaceSection/><DeletionUndoToast/></main>}
    createRoot(document.getElementById('root')).render(<React.StrictMode><ProfileProvider><Fixture/></ProfileProvider></React.StrictMode>);
  `
  async function run() {
    require('esbuild').buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(directory, 'renderer.js'), define: { 'process.env.NODE_ENV': '"production"' } })
    const cssPath = path.join(root, 'src/renderer/src/index.css')
    const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root }), require('autoprefixer')]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath })
    fs.writeFileSync(path.join(directory, 'style.css'), css.css)
    fs.writeFileSync(path.join(directory, 'mock.js'), mockSource)
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="mock.js"></script><script src="renderer.js"></script>')
    await app.whenReady()
    const win = new BrowserWindow({ show: false, width: 1100, height: 950, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
    await win.loadFile(path.join(directory, 'index.html'))
    const evaluate = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`)
    const wait = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds))
    async function until(fn, label) { const end=Date.now()+5000;while(Date.now()<end){if(await evaluate(fn))return;await wait(25)}throw Error('Timed out: '+label) }
    async function clickText(label) { await evaluate(value=>{const button=[...document.querySelectorAll('button')].find(element=>element.textContent===value);if(!button)throw Error('Missing button '+value);button.click();},label) }
    const input = (selector,value)=>evaluate(data=>{const element=document.querySelector(data.selector);Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,data.value);element.dispatchEvent(new Event('input',{bubbles:true}));}, {selector,value})

    await until(()=>document.querySelector('textarea')?.value==='Saved original note', 'note loaded')
    assert.equal(await evaluate(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='Restore backup').disabled),true)
    await input('textarea','Newest draft before backup')
    await clickText('Create backup')
    await until(()=>__fixture.pendingNotes.length===1, 'draft flush starts before backup')
    await clickText('Working…')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='data.createBackup').length),0)
    await evaluate(()=>__fixture.finishNote())
    await until(()=>__fixture.pendingCreates.length===1, 'backup waits for draft receipt')
    await clickText('Working…')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='data.createBackup').length),1)
    await evaluate(()=>__fixture.finishCreate())
    await until(()=>document.body.textContent.includes('Backup saved'), 'manual backup success')

    await clickText('Restore backup')
    assert.equal(await evaluate(()=>[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='Restore selected backup').disabled),true)
    await evaluate(()=>document.querySelector('[role="dialog"] input[type="checkbox"]').click())
    await clickText('Restore selected backup')
    await until(()=>__fixture.pendingBackups.length===1, 'restore submitted once')
    await clickText('Restoring…')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='data.restoreBackup').length),1)
    await evaluate(()=>__fixture.finishBackup(true))
    await until(()=>document.querySelector('[role="dialog"] [role="alert"]')?.textContent==='Fixture restore failed', 'restore failure visible without closing')
    assert.equal(await evaluate(()=>document.querySelector('textarea').value),'Newest draft before backup')
    await clickText('Restore selected backup')
    await evaluate(()=>__fixture.finishBackup(false))
    await until(()=>!document.querySelector('[role="dialog"]') && document.querySelector('textarea').value==='Restored historical note', 'restored note loads cleanly')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='notes.set').length),1,'clean restored note never rewrites previous text')

    await clickText('Trash (1)')
    await clickText('Restore')
    await until(()=>__fixture.pendingTrash.length===1, 'single item restoration pending')
    await clickText('Restore')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='trash.restore').length),1)
    await evaluate(()=>__fixture.finishTrash('Deleted task',true))
    await until(()=>document.querySelector('[role="dialog"] [role="alert"]')?.textContent==='Fixture Trash restore failed', 'failed item stays in Trash')
    assert.ok(await evaluate(()=>document.querySelector('[role="dialog"]').textContent.includes('Deleted task')))
    await clickText('Restore')
    await evaluate(()=>__fixture.finishTrash('Deleted task'))
    await until(()=>document.querySelector('[role="dialog"]').textContent.includes('Trash is empty'), 'item removed only after acknowledgement')
    await clickText('Close')

    await evaluate(()=>{__fixture.deferLists=true;__fixture.change()})
    await until(()=>__fixture.pendingLists.length===1, 'old profile request pending')
    await clickText('Friend filter')
    await until(()=>__fixture.pendingLists.length===2, 'new profile request pending')
    await evaluate(()=>__fixture.pendingLists[1].resolve([{id:'friend-item',kind:'event',item_id:'event',person_id:'friend',title:'Friend deleted event',deleted_at:'2026-10-10T10:00:00Z',item_count:1}]))
    await until(()=>document.body.textContent.includes('Trash (1)'), 'friend profile items loaded')
    await evaluate(()=>__fixture.pendingLists[0].resolve([]))
    await wait(80)
    assert.ok(await evaluate(()=>document.body.textContent.includes('Trash (1)')),'stale profile cannot clear current Trash')
    await evaluate(()=>{__fixture.deferLists=false;__fixture.trash=[]})

    await evaluate(()=>{__fixture.remove('undo-a');__fixture.remove('undo-b')})
    await until(()=>document.body.textContent.includes('2 items moved to Trash'), 'rapid deletions grouped')
    await clickText('Undo')
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='undo-a'), 'first undo pending')
    await evaluate(()=>__fixture.finishTrash('undo-a'))
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='undo-b'), 'second undo pending')
    await evaluate(()=>__fixture.finishTrash('undo-b',true))
    await until(()=>document.querySelector('[aria-label="Dismiss undo"]')?.parentElement.parentElement.textContent.includes('Fixture Trash restore failed'), 'failed remainder kept for retry')
    await clickText('Undo')
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='undo-b'), 'retry pending')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='trash.restore' && call.input==='undo-a').length),1,'acknowledged item is not restored twice')
    await evaluate(()=>{__fixture.remove('undo-c');__fixture.finishTrash('undo-b')})
    await until(()=>document.querySelector('[aria-label="Dismiss undo"]') && [...document.querySelectorAll('button')].some(button=>button.textContent==='Undo'), 'new deletion survives existing undo')
    await clickText('Undo')
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='undo-c'), 'new deletion restored next')
    await evaluate(()=>__fixture.finishTrash('undo-c'))
    await until(()=>!document.querySelector('[aria-label="Dismiss undo"]'), 'all undo receipts acknowledged')
    await evaluate(()=>{__fixture.remove('failed-first');__fixture.remove('healthy-second')})
    await clickText('Undo')
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='failed-first'), 'first failing undo pending')
    await evaluate(()=>__fixture.finishTrash('failed-first',true))
    await until(()=>__fixture.pendingTrash.some(item=>item.id==='healthy-second'), 'one failure does not block remaining undo')
    await evaluate(()=>__fixture.finishTrash('healthy-second'))
    await until(()=>document.querySelector('[aria-label="Dismiss undo"]')?.parentElement.parentElement.textContent.includes('Fixture Trash restore failed'), 'only failed undo remains')
    assert.equal(await evaluate(()=>document.querySelector('[aria-label="Dismiss undo"]').parentElement.textContent.includes('2 items')),false)
    await evaluate(()=>document.querySelector('[aria-label="Dismiss undo"]').click())
    await input('input[placeholder="libsql://your-db-name.turso.io"]','libsql://private-fixture.turso.io')
    await input('input[placeholder="Auth token"]','private-fixture-token')
    await input('textarea[placeholder^="Brain dump"]','Newest draft before workspace switch')
    await clickText('Connect workspace')
    await until(()=>__fixture.pendingNotes.length===1, 'workspace connect flushes draft first')
    await clickText('Connect workspace')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='workspace.connect').length),0)
    await evaluate(()=>__fixture.finishNote())
    await until(()=>__fixture.pendingConnections.length===1, 'connect begins after note acknowledgement')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='workspace.connect').length),1)
    await evaluate(()=>__fixture.pendingConnections.shift().reject(Error('Fixture connection failed')))
    await until(()=>document.body.textContent.includes('Fixture connection failed'), 'failed workspace connection stays on current data')
    await evaluate(()=>{__fixture.cloud=true;__fixture.change()})
    await until(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Disconnect'),'cloud workspace view')
    await input('textarea[placeholder^="Brain dump"]','Newest draft before disconnect')
    await clickText('Disconnect')
    await until(()=>__fixture.pendingNotes.length===1,'workspace disconnect flushes draft first')
    assert.equal(await evaluate(()=>__fixture.calls.filter(call=>call.method==='workspace.disconnect').length),0)
    await evaluate(()=>__fixture.finishNote())
    await until(()=>__fixture.pendingConnections.length===1,'disconnect begins after note acknowledgement')
    await evaluate(()=>__fixture.pendingConnections.shift().reject(Error('Fixture disconnect failed')))
    await until(()=>document.body.textContent.includes('Fixture disconnect failed'),'disconnect failure visible')
    assert.deepEqual(await evaluate(()=>__fixture.errors),[],'no renderer errors or unhandled rejections')
    console.log('Data Chromium checks passed: note flush before backup/connect/disconnect, duplicate save guards, restore confirmation/failure, restored notes, Trash restoration, profile race, grouped Undo and partial retry.')
    win.destroy()
    app.quit()
  }
  run().catch(error=>{console.error(error);app.exit(1)})
}
