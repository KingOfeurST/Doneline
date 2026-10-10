/** Production App in isolated Chromium, with memory-only APIs and slow writes. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-planning-renderer-'))
  const env = { ...process.env, TZ: 'Europe/Paris', DONELINE_PLANNING_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('doneline-planning-renderer-'))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const temporary = process.env.DONELINE_PLANNING_TEST_DIR
  app.disableHardwareAcceleration()
  app.setPath('userData', path.join(temporary, 'profile'))
  async function run() {
    const fixtureSource = fs.readFileSync(path.join(root, 'tests/renderer.test.cjs'), 'utf8')
    const start = fixtureSource.indexOf('  const mockSource = `')
    const end = fixtureSource.indexOf('  const fixtureEntry = `')
    assert.ok(start >= 0 && end > start)
    const base = new Function('process', fixtureSource.slice(start, end) + '\nreturn mockSource;')(process)
    const supplement = `
      localStorage.setItem('doneline.activeProfile','self');
      fixture.todos=[todo('today-task','Needle today',at(today,9)),todo('overdue-task','Overdue task',at(dayKey(previous),14,30)),todo('upcoming-task','Needle upcoming',at(dayKey(tomorrow),10)),todo('undated-task','No date task',null),todo('mutual','Shared task',at(today,11),true),todo('finished-task','Finished task',at(today,12))];
      fixture.todos[5].completed_at=at(today,12);
      fixture.pendingReschedules=[];fixture.pendingSearches=[];fixture.deferSearch=false;fixture.deferReschedule=true;
      fixture.searchGoal={id:'needle-goal',title:'Needle goal',person_id:'friend',shared:1,archived:0,color:'#2f7a4d',todo_total:0,todo_done:0,created_at:at(today,8)};
      fixture.searchEvent=event('needle-event','Needle event',at('2026-11-11',15),at('2026-11-11',16));
      fixture.searchNote={day:'2026-07-04',person_id:'friend',body:'Needle note from the correct profile and day.',updated_at:at(today,8)};
      fixture.notesByKey={};fixture.notesByKey[fixture.searchNote.day+':friend']=fixture.searchNote.body;
      fixture.finishReschedule=(fail=false)=>{const pending=fixture.pendingReschedules.shift();if(!pending)throw Error('No pending reschedule');if(fail){pending.reject(Error('Fixture date save failed'));return;}const row=fixture.todos.find(t=>t.id===pending.id);Object.assign(row,pending.patch);pending.resolve({...row});};
      window.doneline.lifecycle={onPrepareQuit:()=>()=>{}};
      window.doneline.onTrayNewTodo=()=>()=>{};window.doneline.toggleFullscreen=async()=>true;
      Object.assign(window.doneline.presence,{list:async()=>[],pendingInvites:async()=>[],activeInvite:async()=>null,unseenNudges:async()=>[]});
      window.doneline.goals.list=async()=>[fixture.searchGoal];
      window.doneline.todos.forGoal=async()=>({open:[],done:[],templates:[]});
      window.doneline.todos.update=(id,patch)=>{record('todos.update',{id,...patch});if(fixture.deferReschedule && Object.keys(patch).length===1 && 'due_at' in patch)return new Promise((resolve,reject)=>fixture.pendingReschedules.push({id,patch,resolve,reject}));const row=fixture.todos.find(t=>t.id===id);Object.assign(row,patch);return Promise.resolve({...row});};
      window.doneline.events.update=async(id,patch)=>{record('events.update',{id,...patch});return {...fixture.searchEvent,...patch};};
      window.doneline.search={query:async input=>{record('search.query',input);if(fixture.deferSearch)return new Promise(resolve=>fixture.pendingSearches.push({input,resolve}));if(!input.query.includes('needle'))return {todos:[],events:[],goals:[],notes:[]};return {todos:[{...fixture.todos.find(t=>t.id==='upcoming-task')}],events:[fixture.searchEvent],goals:[fixture.searchGoal],notes:[fixture.searchNote]};}};
      window.doneline.notes.get=async(day,personId)=>{record('notes.get',{day,personId});return {day,person_id:personId,body:fixture.notesByKey[day+':'+personId]||'',updated_at:at(today,8)};};
      window.doneline.notes.set=async(day,body,personId)=>{record('notes.set',{day,body,personId});fixture.notesByKey[day+':'+personId]=body;return {day,person_id:personId,body,updated_at:at(today,8)};};
    `
    require('esbuild').buildSync({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/renderer/src/App';createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(temporary, 'renderer.js'), define: { 'process.env.NODE_ENV': '"production"' } })
    const cssPath = path.join(root, 'src/renderer/src/index.css')
    const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root }), require('autoprefixer')]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath })
    fs.writeFileSync(path.join(temporary, 'style.css'), css.css)
    fs.writeFileSync(path.join(temporary, 'mock.js'), base + supplement)
    fs.writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="mock.js"></script><script src="renderer.js"></script>')
    await app.whenReady()
    const win = new BrowserWindow({ show: false, width: 1400, height: 1080, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
    await win.loadURL('about:blank')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' })
    await win.loadFile(path.join(temporary, 'index.html'))
    const evaluate = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`).catch(error => { throw Error(error.message + '\nEvaluation: ' + fn.toString() + '\nInput: ' + JSON.stringify(value)) })
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    async function until(fn, description) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (await evaluate(fn)) return; await wait(30) } throw Error('Timed out: ' + description + ' ' + await evaluate(() => JSON.stringify({errors:__fixture.errors,body:document.body.textContent.slice(-2500)}))) }
    const click = selector => evaluate(selector => { const button = document.querySelector(selector);if(!button)throw Error('Missing '+selector);button.click(); }, selector)
    const input = (selector, value) => evaluate(({selector,value}) => { const element=document.querySelector(selector);if(!element)throw Error('Missing '+selector);const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true})); }, {selector,value})
    const clickText = text => evaluate(text => { const scope=document.querySelector('[role="dialog"]')||document;const button=[...scope.querySelectorAll('button')].find(button=>button.textContent.trim()===text);if(!button)throw Error('Missing button '+text);button.click(); }, text)
    await until(() => document.querySelector('[aria-label="5 todos left"]'), 'planning load')
    const initial = await evaluate(() => [...document.querySelectorAll('[data-task-group]')].map(group=>({id:group.dataset.taskGroup,expanded:group.querySelector('button').getAttribute('aria-expanded'),count:group.querySelector('button span').textContent})))
    assert.deepEqual(initial, [{id:'today',expanded:'true',count:'2'},{id:'overdue',expanded:'true',count:'1'},{id:'upcoming',expanded:'false',count:'1'},{id:'undated',expanded:'false',count:'1'}])
    assert.equal(await evaluate(() => !!document.querySelector('[data-task-group="upcoming"] [aria-label="Mark done"]')), false)
    await click('[aria-label="Reschedule Overdue task"]')
    await clickText('Tomorrow')
    await until(() => __fixture.pendingReschedules.length===1 && document.querySelector('[data-task-group="overdue"] button span').textContent==='0', 'date immediately moves group')
    assert.equal(await evaluate(() => document.querySelector('[data-task-group="upcoming"] button span').textContent), '2')
    await evaluate(() => __fixture.triggerChange())
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('[data-task-group="overdue"] button span').textContent), '0', 'background read cannot undo pending date')
    await evaluate(() => __fixture.finishReschedule(true))
    await until(() => document.querySelector('[data-task-group="overdue"] button span').textContent==='1' && document.querySelector('[role="alert"]')?.textContent.includes('date save failed'), 'date failure restores group')
    await click('[aria-label="Reschedule Overdue task"]')
    await clickText('Tomorrow')
    await evaluate(() => __fixture.finishReschedule())
    await until(() => __fixture.pendingReschedules.length===0 && document.querySelector('[data-task-group="upcoming"] button span').textContent==='2', 'date saved')
    assert.equal(await evaluate(() => new Date(__fixture.todos.find(t=>t.id==='overdue-task').due_at).getHours()), 14)
    assert.equal(await evaluate(() => new Date(__fixture.todos.find(t=>t.id==='overdue-task').due_at).getMinutes()), 30)
    await click('[data-task-group="undated"] > button')
    await click('[aria-label="Reschedule No date task"]')
    await clickText('Today')
    await evaluate(() => __fixture.finishReschedule())
    await until(() => document.querySelector('[data-task-group="today"] button span').textContent==='3', 'undated task scheduled today')
    await click('[aria-label="Reschedule No date task"]')
    await input('[aria-label="Due date for No date task"]','2026-12-15')
    await clickText('Apply date')
    await evaluate(() => __fixture.finishReschedule())
    await until(() => document.querySelector('[data-task-group="upcoming"] button span').textContent==='3', 'pick date moves task')
    await click('[data-task-group="upcoming"] > button')
    await click('[aria-label="Reschedule No date task"]')
    await clickText('No date')
    await evaluate(() => __fixture.finishReschedule())
    await until(() => document.querySelector('[data-task-group="undated"] button span').textContent==='1', 'date removed')
    await evaluate(() => { const row=[...document.querySelectorAll('[data-task-group="today"] button[title="Edit this todo"]')].find(button=>button.textContent==='Shared task').parentElement.parentElement;row.querySelector('[aria-label="Mark done"]').click(); })
    await until(() => document.querySelector('[aria-label="4 todos left"]'), 'shared completion is instant')
    await evaluate(() => __fixture.finishToggle('mutual',true))
    await until(() => document.querySelector('[aria-label="5 todos left"]'), 'shared completion failure rolls back count')

    async function search() { await click('[aria-label="Command palette"]');await input('[role="combobox"]','needle');await until(() => document.querySelector('[role="group"][aria-label="Notes"] [role="option"]'), 'all search groups') }
    await search()
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#search-results [role="group"]')].map(group=>group.getAttribute('aria-label'))), ['Tasks','Events','Goals','Notes'])
    await click('[role="group"][aria-label="Tasks"] [role="option"]')
    await until(() => document.querySelector('[role="dialog"] input[placeholder="What needs doing?"]')?.value==='Needle upcoming', 'exact future task editor')
    await input('[role="dialog"] input[placeholder="What needs doing?"]','Needle upcoming edited')
    await clickText('Save changes')
    await until(() => !document.querySelector('[role="dialog"]'), 'search task save')
    assert.equal(await evaluate(() => __fixture.calls.filter(c=>c.method==='todos.update').at(-1).input.id), 'upcoming-task')
    await search()
    await click('[role="group"][aria-label="Events"] [role="option"]')
    await until(() => document.querySelector('input[placeholder="Event title"]')?.value==='Needle event', 'exact event editor')
    assert.equal(await evaluate(() => document.querySelector('[aria-label="Event start date"]').value), '2026-11-11')
    assert.ok((await evaluate(() => document.querySelector('h1').textContent)).includes('November'))
    await clickText('Cancel')
    await search()
    await click('[role="group"][aria-label="Goals"] [role="option"]')
    await until(() => document.querySelector('h1')?.textContent.includes('Needle goal'), 'exact shared goal detail')
    await search()
    for (let index=1;index<=3;index++) {
      await evaluate(() => document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
      await wait(30)
    }
    assert.equal(await evaluate(() => document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')), 'search-option-3')
    await evaluate(() => document.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
    await until(() => document.querySelector('[role="dialog"] textarea')?.value==='Needle note from the correct profile and day.', 'exact historical note')
    assert.ok((await evaluate(() => document.querySelector('h1').textContent)).includes('July'))
    await input('[role="dialog"] textarea','Needle note updated safely')
    await until(() => __fixture.calls.some(c=>c.method==='notes.set' && c.input.day==='2026-07-04' && c.input.personId==='friend' && c.input.body==='Needle note updated safely'), 'note saves exact day and owner')
    await clickText('Close')
    await click('[aria-label="Command palette"]')
    await evaluate(() => { __fixture.deferSearch=true })
    await input('[role="combobox"]','old')
    await until(() => __fixture.pendingSearches.length===1, 'old search pending')
    await input('[role="combobox"]','new')
    await until(() => __fixture.pendingSearches.length===2, 'new search pending')
    await evaluate(() => __fixture.pendingSearches[1].resolve({todos:[{...__fixture.todos[0],title:'New result'}],events:[],goals:[],notes:[]}))
    await until(() => document.querySelector('#search-results')?.textContent.includes('New result'), 'new search wins')
    await evaluate(() => __fixture.pendingSearches[0].resolve({todos:[{...__fixture.todos[0],title:'Stale result'}],events:[],goals:[],notes:[]}))
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('#search-results').textContent.includes('Stale result')), false)
    assert.deepEqual(await evaluate(() => __fixture.errors), [], 'no renderer errors or unhandled rejections')
    console.log('Planning/search Chromium checks passed: groups, all date actions, slow-save rollback, shared completion, exact task/event/goal/note opening, stale search protection.')
    win.destroy()
    app.quit()
  }
  run().catch(error=>{console.error(error);app.exit(1)})
}
