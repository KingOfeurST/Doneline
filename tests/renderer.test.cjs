/** Real Chromium/React renderer with in-memory APIs. Never opens a user database. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-renderer-test-'))
  const env = { ...process.env, TZ: 'Europe/Paris', DONELINE_RENDERER_TEST_DIR: fixtureDir }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env, windowsHide: true, timeout: 60000 })
  // Chromium releases its profile files when the child exits. Keep cleanup inside this named temp directory.
  const resolved = path.resolve(fixtureDir)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('doneline-renderer-test-')) throw new Error('Unexpected fixture cleanup path')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  const temporary = process.env.DONELINE_RENDERER_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-renderer-test-'))
  app.setPath('userData', path.join(temporary, 'profile'))
  const root = path.resolve(__dirname, '..')
  const mockSource = `
    localStorage.setItem('doneline.muted', '1');
    const dayKey = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
    const today = dayKey(new Date());
    const at = (day,h,m=0) => new Date(day+'T'+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':00').toISOString();
    const previous = new Date(); previous.setDate(previous.getDate()-1);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    const person = (id,name) => ({id,name,emoji:id==='self'?'🙂':'😎',color:'#2f7a4d',position:0,created_at:new Date().toISOString()});
    const todo = (id,title,due_at,shared=false) => ({id,title,due_at,person_id:'self',goal_id:shared?'shared-goal':null,goal_shared:shared?1:0,goal_title:shared?'Together':null,goal_color:'#2f7a4d',done_by:null,completed_at:null,position:0,archived:0,recurrence:null,recur_parent:null,notes:null,created_at:new Date().toISOString(),person_name:'Chris',person_emoji:'🙂'});
    const event = (id,title,start,end,all_day=0) => ({id,title,starts_at:start,ends_at:end,all_day,person_id:'self',shared:0,color:'#2f7a4d',recurrence:null,recur_parent:null,location:null,notes:null,attendees:null,caldav_uid:null,caldav_etag:null,caldav_url:null,source:'local',created_at:new Date().toISOString()});
    const fixture = window.__fixture = {
      today, selfId:'self', platform:${JSON.stringify(process.platform)}, updateStatus:{state:'idle',canAutoInstall:true}, updateListeners:[], pendingUpdateSnapshots:[], deferUpdateStatus:false, calls:[], listeners:[], pendingToggles:[], pendingCreates:[], pendingConfigs:[], pendingEvents:[], noteSaves:[], errors:[], deferCreates:false, deferEvents:false, nudgeReceiptAttempts:0,
      people:[person('self','Chris'),person('friend','Friend')],
      todos:[todo('slow','Slow task',at(today,9)),todo('mutual','Shared task',at(today,10),true),todo('midnight','Midnight task',at(today,0,15))],
      events:[event('alpha','Overlap alpha',at(today,9),at(today,11)),event('beta','Overlap beta',at(today,10),at(today,12)),event('overnight','Overnight fixture',at(dayKey(previous),23),at(today,2)),event('late','Late fixture',at(today,23,30),at(dayKey(tomorrow),0,30)),event('all-day','All-day fixture',at(today,0),at(dayKey(tomorrow),0),1)],
      templates:[event('rule','Thursday class',at('2026-10-01',9),at('2026-10-01',10))],
      removal:{events:[event('remove-event','Thursday class',at('2026-10-08',9),at('2026-10-08',10))],todos:[todo('remove-todo','Class prep',at('2026-10-08',8))]},
      notes:{self:'',friend:''}, deferNotes:false, noteLoadError:false,
      finishToggle(id,fail=false) {
        const pending=this.pendingToggles.find(p=>p.id===id); if(!pending) throw Error('No pending toggle '+id);
        this.pendingToggles=this.pendingToggles.filter(p=>p!==pending);
        if(fail){pending.reject(Error('Fixture save failed'));return;}
        const row=this.todos.find(t=>t.id===id);
        if(row.goal_shared===1) row.done_by=pending.done?'self':null;
        else row.completed_at=pending.done?new Date().toISOString():null;
        pending.resolve({...row});
      },
      finishNote(mismatch){const pending=this.noteSaves.shift();if(!pending)throw Error('No pending note');const receipt={day:pending.day,person_id:pending.personId,body:pending.body,updated_at:new Date().toISOString()};if(mismatch==='body')receipt.body='';if(mismatch==='day')receipt.day='1900-01-01';if(mismatch==='person')receipt.person_id='wrong-profile';if(!mismatch)this.notes[pending.personId]=pending.body;pending.resolve(receipt);},
      failNote(){const pending=this.noteSaves.shift();if(!pending)throw Error('No pending note');pending.reject(Error('Fixture note write failed'));},
      finishCreate(){const pending=this.pendingCreates.shift();if(!pending)throw Error('No pending create');const row=todo('quick-created',pending.input.title,pending.input.due_at);this.todos.push(row);pending.resolve(row);},
      finishConfig(personId){const pending=this.pendingConfigs.find(p=>p.personId===personId);if(!pending)throw Error('No pending config '+personId);this.pendingConfigs=this.pendingConfigs.filter(p=>p!==pending);pending.resolve({serverUrl:'https://caldav.icloud.com',username:personId+'@example.com',calendarName:personId+' calendar'});},
      finishEvents(personId){const pending=this.pendingEvents.find(p=>p.personId===personId);if(!pending)throw Error('No pending events '+personId);this.pendingEvents=this.pendingEvents.filter(p=>p!==pending);const row=event(personId+'-loaded',personId==='friend'?'Friend profile fixture':'Wrong profile fixture',at(today,9),at(today,10));row.person_id=personId;pending.resolve([row]);},
      triggerChange(){this.listeners.forEach(fn=>fn());}
    };
    fixture.templates[0].recurrence=JSON.stringify({freq:'weekly',days:[4],startDate:'2026-10-01',endDate:'2026-10-22',excludedDates:['2026-10-08']});
    const remote=event('remote','Remote occurrence',at(today,13),at(today,14));remote.source='caldav';remote.caldav_uid='icloud-rule';remote.caldav_recurrence_id=today+'T13:00:00';fixture.events.push(remote);
    window.addEventListener('error',e=>fixture.errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));
    const record=(method,input)=>fixture.calls.push({method,input});
    window.doneline={
      today:async()=>today,
      platform:async()=>fixture.platform,
      updates:{version:async()=> 'fixture',status:async()=>{if(fixture.deferUpdateStatus)return new Promise(resolve=>fixture.pendingUpdateSnapshots.push(resolve));return {...fixture.updateStatus};},check:async()=>{record('updates.check',null);return {...fixture.updateStatus};},install:async()=>{record('updates.install',{canAutoInstall:fixture.updateStatus.canAutoInstall});},onStatus:fn=>{fixture.updateListeners.push(fn);return()=>{fixture.updateListeners=fixture.updateListeners.filter(listener=>listener!==fn);};}},
      people:{list:async()=>fixture.people},
      presence:{getSelf:async()=>fixture.selfId,update:async()=>true,setSelf:async()=>{throw Error('Fixture identity save failed');},unseenNudges:async()=>[{id:'nudge-fixture',from_person:'friend',to_person:'self',kind:'nudge',message:'Fixture nudge message',from_name:'Friend',from_emoji:'F',created_at:new Date().toISOString(),seen_at:null}],markNudgeSeen:async id=>{record('presence.markNudgeSeen',id);fixture.nudgeReceiptAttempts++;if(fixture.nudgeReceiptAttempts===1)throw Error('Fixture receipt failed');}},
      workspace:{status:async()=>({cloud:false,syncUrl:null}),myCode:async()=>null,onChanged:fn=>{fixture.listeners.push(fn);return()=>{fixture.listeners=fixture.listeners.filter(x=>x!==fn);};}},
      notifications:{get:async()=>({enabled:true,eventsEnabled:true,eventLeadMin:15,todosEnabled:true,morningEnabled:false,morningTime:'09:00'})},
      caldav:{getConfig:personId=>new Promise(resolve=>fixture.pendingConfigs.push({personId,resolve}))},
      goals:{list:async()=>[]},
      reactions:{list:async()=>[],toggle:async()=>true},
      focus:{record:async input=>{record('focus.record',input);return true;},tray:()=>{},getTarget:async()=>4,stats:async()=>({streak:0,todaySessions:0,weekMinutes:0,weekSessions:0,target:4,targetMet:false}),sharedStreak:async()=>0},
      notes:{get:async(day,personId)=>{if(fixture.noteLoadError)throw Error('Fixture note read failed');return {day,person_id:personId,body:fixture.notes[personId]||'',updated_at:new Date().toISOString()};},set:(day,body,personId)=>{record('notes.set',{day,body,personId});return new Promise((resolve,reject)=>fixture.noteSaves.push({resolve,reject,day,body,personId}));}},
      todos:{
        today:async()=>fixture.todos.map(t=>({...t})),list:async()=>fixture.todos.map(t=>({...t})),
        toggle:(id,done)=>{record('todos.toggle',{id,done});return new Promise((resolve,reject)=>fixture.pendingToggles.push({id,done,resolve,reject}));},
        remove:async id=>{fixture.todos=fixture.todos.filter(t=>t.id!==id);},
        create:async input=>{record('todos.create',input);if(fixture.deferCreates)return new Promise(resolve=>fixture.pendingCreates.push({input,resolve}));return todo('created-todo',input.title,input.due_at);},
        update:async(id,input)=>{record('todos.update',{id,...input});return fixture.todos.find(t=>t.id===id);},
        templates:async()=>[],archived:async()=>[],reorder:async()=>{}
      },
      events:{
        list:async opts=>{if(fixture.deferEvents)return new Promise(resolve=>fixture.pendingEvents.push({personId:opts.personId,resolve}));return fixture.events;},day:async()=>fixture.events.filter(e=>new Date(e.starts_at).getTime()<new Date(at(dayKey(tomorrow),0)).getTime() && new Date(e.ends_at).getTime()>new Date(at(today,0)).getTime()),
        templates:async()=>fixture.templates,
        create:async input=>{record('events.create',input);return event('created-event',input.title,input.starts_at,input.ends_at,input.all_day?1:0);},
        update:async(id,input)=>{record('events.update',{id,...input});return {...fixture.templates.find(e=>e.id===id),...input};},
        remove:async id=>{record('events.remove',id);fixture.events=fixture.events.filter(e=>e.id!==id);},
        removeSeries:async id=>{record('events.removeSeries',id);fixture.templates=fixture.templates.filter(e=>e.id!==id);}
      },
      items:{previewRemoval:async input=>{record('items.previewRemoval',input);return fixture.removal;},removeRange:async input=>{record('items.removeRange',input);const result={events:fixture.removal.events.length,todos:fixture.removal.todos.length};fixture.removal={events:[],todos:[]};return result;}}
    };
  `
  const fixtureEntry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ProfileProvider} from './src/renderer/src/profile';
    import {useProfile} from './src/renderer/src/profile';
    import {FocusProvider,useFocus} from './src/renderer/src/focus';
    import CalendarView from './src/renderer/src/views/CalendarView';
    import TodayView from './src/renderer/src/views/TodayView';
    import SettingsView from './src/renderer/src/views/SettingsView';
    import NudgeToast from './src/renderer/src/components/NudgeToast';
    import {flushPendingNotes} from './src/renderer/src/lib/notePersistence';
    window.__flushNotes=flushPendingNotes;
    function ProfileProbe(){const profile=useProfile();return <div><button onClick={()=>profile.setActive('self')}>Fixture self filter</button><button onClick={()=>profile.setActive('friend')}>Fixture friend filter</button><button onClick={()=>profile.setActive('all')}>Fixture all filter</button></div>}
    function FocusProbe(){const focus=useFocus();const {self}=useProfile();return <div><button onClick={()=>focus.startAnchored(new Date(Date.now()).toISOString(),25,5)}>Fixture start focus</button><output data-focus={focus.started?'started':'stopped'} data-identity={self}/></div>}
    function Fixture(){const [view,setView]=useState('calendar');return <ProfileProvider><FocusProvider><div style={{maxWidth:1100,margin:'auto',padding:24}}><nav><button onClick={()=>setView('calendar')}>Fixture calendar</button><button onClick={()=>setView('today')}>Fixture today</button><button onClick={()=>setView('settings')}>Fixture settings</button><button onClick={()=>setView('nudges')}>Fixture nudges</button></nav><ProfileProbe/><FocusProbe/>{view==='calendar'?<CalendarView/>:view==='today'?<TodayView/>:view==='settings'?<SettingsView/>:<NudgeToast/>}</div></FocusProvider></ProfileProvider>}
    createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
  `

  async function run() {
    require('esbuild').buildSync({ stdin: { contents: fixtureEntry, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(temporary, 'renderer.js'), define: { 'process.env.NODE_ENV': '"production"' } })
    const cssPath = path.join(root, 'src/renderer/src/index.css')
    const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root }), require('autoprefixer')]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath, to: path.join(temporary, 'style.css') })
    fs.writeFileSync(path.join(temporary, 'style.css'), css.css)
    fs.writeFileSync(path.join(temporary, 'mock.js'), mockSource)
    fs.writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="mock.js"></script><script src="renderer.js"></script>')
    await app.whenReady()
    const win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
    // Chromium can use the macOS system zone despite Node's TZ environment.
    // Apply the fixture zone before its first Date/localStorage initialization.
    await win.loadURL('about:blank')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' })
    await win.loadFile(path.join(temporary, 'index.html'))
    const evaluate = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`)
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    async function until(fn, label, timeout = 5000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) { if (await evaluate(fn)) return; await wait(30) }
      throw new Error(`Timed out: ${label}`)
    }
    const click = text => evaluate(text => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text)
      if (!button) throw Error('Missing button '+text)
      button.click()
    }, text)
    const input = (selector, value) => evaluate(({ selector, value }) => {
      const field = document.querySelector(selector)
      if (!field) throw Error('Missing field '+selector)
      const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value)
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    }, { selector, value })
    assert.equal(await evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Europe/Paris')
    assert.equal(await evaluate(() => window.doneline.platform()), process.platform)
    await until(() => document.querySelector('h1')?.textContent.length && !document.querySelector('[role="status"]'), 'calendar initial load')

    await click('+ Add event')
    await input('input[placeholder="Event title"]', 'Bounded Thursday fixture')
    await input('[aria-label="Event start date"]', '2026-10-01')
    await input('[aria-label="Repeat schedule"]', 'weekly')
    await input('[aria-label="Repeat until"]', '2026-10-22')
    await wait(200)
    fs.writeFileSync(path.join(os.tmpdir(), 'doneline-renderer-repeat-modal.png'), (await win.webContents.capturePage()).toPNG())
    await click('Thu')
    await click('Add event')
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes('at least one weekday'), 'empty weekday validation')
    assert.equal(await evaluate(() => __fixture.calls.filter(call => call.method === 'events.create').length), 0)
    await click('Thu')
    await click('Add event')
    await until(() => !document.querySelector('[role="dialog"]'), 'bounded event save')
    const saved = await evaluate(() => __fixture.calls.find(call => call.method === 'events.create').input)
    assert.deepEqual(JSON.parse(saved.recurrence), { freq: 'weekly', days: [4], startDate: '2026-10-01', endDate: '2026-10-22' })
    assert.equal(new Date(saved.ends_at) - new Date(saved.starts_at), 3_600_000, 'repeat end is distinct from one-event duration')

    await click('+ Add event')
    await input('input[placeholder="Event title"]', 'Invalid hours fixture')
    await input('[aria-label="Event start time"]', '11:00')
    await input('[aria-label="Event end time"]', '10:00')
    await click('Add event')
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes('end after'), 'reversed time validation')
    await click('Cancel')

    await click('+ Add event')
    await input('input[placeholder="Event title"]', 'Missing DST time fixture')
    await input('[aria-label="Event start date"]', '2026-03-29')
    await input('[aria-label="Event start time"]', '02:30')
    await input('[aria-label="Event end time"]', '04:00')
    await click('Add event')
    await until(() => document.querySelector('[role="alert"]')?.textContent.includes('does not exist in your time zone'), 'nonexistent DST time remains visible for correction')
    assert.equal(await evaluate(() => __fixture.calls.filter(call => call.method === 'events.create').length), 1, 'nonexistent clock time is not silently moved and saved')
    await click('Cancel')

    await click('+ Add event')
    await input('input[placeholder="Event title"]', 'All-day span fixture')
    await input('[aria-label="Event start date"]', '2026-10-01')
    await input('[aria-label="Event end date"]', '2026-10-03')
    await evaluate(() => document.querySelector('[role="dialog"] input[type="checkbox"]').click())
    await click('Add event')
    await until(() => !document.querySelector('[role="dialog"]'), 'all-day event save')
    const allDay = await evaluate(() => __fixture.calls.filter(call => call.method === 'events.create').at(-1).input)
    const endDate = new Date(allDay.ends_at)
    assert.equal(endDate.getHours(), 0)
    assert.equal(endDate.getDate(), 4, 'all-day end is exclusive midnight after last included date')

    await click('Repeating events')
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Thursday class')), 'load repeating rules')
    await click('Remove')
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Remove series'), 'series removal confirmation')
    await evaluate(() => __fixture.triggerChange())
    await wait(100)
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Remove series')), true, 'background refresh keeps a valid removal confirmation')
    await click('Keep')
    await evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes('Thursday class')).click())
    await until(() => document.querySelector('input[aria-label="Repeat until"]')?.value === '2026-10-22', 'edit repeat rule')
    await input('[aria-label="Repeat until"]', '2026-10-29')
    await click('Save changes')
    await until(() => !document.querySelector('[role="dialog"]'), 'repeat rule save')
    const updated = await evaluate(() => __fixture.calls.find(call => call.method === 'events.update').input)
    assert.deepEqual(JSON.parse(updated.recurrence).excludedDates, ['2026-10-08'])
    assert.equal(JSON.parse(updated.recurrence).endDate, '2026-10-29')

    await click('Grid')
    await until(() => document.querySelector('button[title^="Overlap alpha"]'), 'timed grid')
    const grid = await evaluate(() => {
      const alpha = document.querySelector('button[title^="Overlap alpha"]')
      const beta = document.querySelector('button[title^="Overlap beta"]')
      const a = alpha.getBoundingClientRect(), b = beta.getBoundingClientRect()
      const overnight = alpha.parentElement.querySelector('button[title^="Overnight fixture"]')
      const late = document.querySelector('button[title^="Late fixture"]')
      return { alphaWidth: a.width, betaWidth: b.width, alphaRight: a.right, betaLeft: b.left, sameDay: alpha.parentElement === beta.parentElement, overnightTop: overnight.style.top, latePresent: !!late, allDayPresent: [...document.querySelectorAll('button')].some(button => button.textContent === 'All-day fixture') }
    })
    assert.equal(grid.sameDay, true)
    assert.ok(grid.alphaWidth > 0 && grid.betaWidth > 0 && grid.alphaRight <= grid.betaLeft, 'overlaps appear in separate columns')
    assert.equal(grid.overnightTop, '0px')
    assert.equal(grid.latePresent, true)
    assert.equal(grid.allDayPresent, true)
    const screenshot = path.join(os.tmpdir(), 'doneline-renderer-calendar.png')
    await wait(500) // Allow the new grid and its entrance animation to paint offscreen.
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())

    await evaluate(() => document.querySelector('button[title^="Remote occurrence"]').click())
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('Change the repeating schedule in Apple Calendar'), 'remote occurrence edit scope')
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="Repeat schedule"]')), false, 'remote occurrence cannot acquire a local repeat rule')
    await click('Cancel')

    await evaluate(() => document.querySelector('button[title^="Overlap alpha"]').parentElement.click())
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('Midnight task'), 'local-date day todo matching')
    await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await until(() => !document.querySelector('[role="dialog"]'), 'close day popup')

    await click('Remove items')
    await input('[aria-label="Item type"]', 'both')
    await click('Preview matching items')
    await until(() => document.querySelector('[role="dialog"]')?.textContent.includes('1 events and 1 todos match'), 'removal preview')
    await input('[aria-label="Title contains"]', 'Changed filter')
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Delete ')).disabled), true, 'changing filters invalidates preview')
    await input('[aria-label="Title contains"]', '')
    await click('Preview matching items')
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Delete 2 items' && !button.disabled), 'matching preview allows delete')
    await click('Delete 2 items')
    await until(() => document.querySelector('[role="status"]')?.textContent.includes('Removed 1 event and 1 todo'), 'range deletion result')
    const removed = await evaluate(() => __fixture.calls.find(call => call.method === 'items.removeRange').input)
    assert.deepEqual(removed.expectedIds, ['events:remove-event', 'todos:remove-todo'])
    await click('Close')

    await evaluate(() => { __fixture.deferEvents = true })
    await click('Fixture self filter')
    await until(() => __fixture.pendingEvents.some(pending => pending.personId === 'self'), 'calendar first profile request')
    await click('Fixture friend filter')
    await until(() => __fixture.pendingEvents.some(pending => pending.personId === 'friend'), 'calendar second profile request')
    await evaluate(() => __fixture.finishEvents('friend'))
    await until(() => document.querySelector('button[title^="Friend profile fixture"]'), 'calendar second profile response')
    await evaluate(() => __fixture.finishEvents('self'))
    await wait(100)
    assert.equal(await evaluate(() => !!document.querySelector('button[title^="Wrong profile fixture"]')), false, 'late first-profile calendar response cannot replace current profile')
    assert.equal(await evaluate(() => !!document.querySelector('button[title^="Friend profile fixture"]')), true)
    await evaluate(() => { __fixture.deferEvents = false })
    await click('Fixture all filter')
    await until(() => document.querySelector('button[title^="Overlap alpha"]'), 'calendar combined profile restored')

    await click('Fixture today')
    await until(() => document.querySelector('[aria-label="3 todos left"]'), 'today initial todo count')
    const clickedAt = Date.now()
    await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Slow task').closest('.group').querySelector('[aria-label="Mark done"]').click())
    await until(() => document.querySelector('[aria-label="2 todos left"]'), 'instant todo count', 1000)
    assert.ok(Date.now() - clickedAt < 1000, 'visible completion happens before write resolves')
    assert.equal(await evaluate(() => __fixture.pendingToggles.length), 1)
    assert.equal(await evaluate(() => [...document.querySelectorAll('.group button')].some(button => button.textContent === 'Slow task' && !button.closest('details'))), false, 'completed row leaves open list immediately')
    await evaluate(() => __fixture.finishToggle('slow'))
    await until(() => __fixture.pendingToggles.length === 0, 'finish delayed task write')

    await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Shared task').closest('.group').querySelector('[aria-label="Mark done"]').click())
    await until(() => document.querySelector('[aria-label="1 todos left"]'), 'shared task self completion')
    await evaluate(() => __fixture.finishToggle('mutual'))
    await wait(100)
    assert.equal(await evaluate(() => __fixture.todos.find(todo => todo.id === 'mutual').completed_at), null, 'friend completion still pending')
    assert.equal(await evaluate(() => !!document.querySelector('[aria-label="1 todos left"]')), true)

    await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Midnight task').closest('.group').querySelector('[aria-label="Mark done"]').click())
    await until(() => document.querySelector('[aria-label="0 todos left"]'), 'optimistic completion before failure')
    await evaluate(() => __fixture.finishToggle('midnight', true))
    await until(() => document.querySelector('[aria-label="1 todos left"]') && document.querySelector('[role="alert"]')?.textContent.includes('Fixture save failed'), 'failure rolls back todo and count')

    await until(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled, 'note initial load')
    await input('textarea', 'First note draft')
    await until(() => __fixture.noteSaves.length === 1, 'first debounced note write')
    await input('textarea', 'Newer note draft')
    await evaluate(() => __fixture.finishNote())
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('textarea').value), 'Newer note draft')
    assert.equal(await evaluate(() => document.querySelector('textarea').closest('section').textContent.includes('Saved')), false, 'old write cannot mark newer draft saved')
    await evaluate(() => __fixture.triggerChange())
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('textarea').value), 'Newer note draft', 'background refresh preserves typed note')
    await until(() => __fixture.noteSaves.length === 1, 'newer debounced note write')
    await evaluate(() => __fixture.finishNote())
    await until(() => document.querySelector('textarea').closest('section').textContent.includes('Saved'), 'newer note saved')

    await click('Fixture calendar')
    await click('Fixture today')
    await until(() => document.querySelector('textarea')?.value === 'Newer note draft' && !document.querySelector('textarea').disabled, 'acknowledged saved note survives editor remount')

    await input('textarea', 'Close immediately draft')
    await evaluate(() => { __fixture.flushDone=false;__fixture.flushError='';window.__flushNotes().then(()=>__fixture.flushDone=true,error=>__fixture.flushError=error.message); })
    await until(() => __fixture.noteSaves.length === 1, 'quit flush starts before debounce')
    await input('textarea', 'Final draft while closing')
    await evaluate(() => __fixture.finishNote())
    await until(() => __fixture.noteSaves.length === 1 && __fixture.noteSaves[0].body === 'Final draft while closing', 'quit flush includes text typed while first write is pending')
    assert.equal(await evaluate(() => __fixture.flushDone), false, 'quit cannot complete before the latest draft acknowledgement')
    await evaluate(() => __fixture.finishNote())
    await until(() => __fixture.flushDone, 'latest draft acknowledged before quit')
    assert.equal(await evaluate(() => __fixture.flushError), '')
    await click('Fixture calendar')
    await click('Fixture today')
    await until(() => document.querySelector('textarea')?.value === 'Final draft while closing' && !document.querySelector('textarea').disabled, 'final quit-flushed note survives reopen')

    await input('textarea', 'Unmounted draft')
    await click('Fixture calendar')
    await until(() => __fixture.noteSaves.length === 1, 'unmount starts note save')
    await evaluate(() => __fixture.failNote())
    await wait(60)
    await evaluate(() => { __fixture.flushDone=false;__fixture.flushError='';window.__flushNotes().then(()=>__fixture.flushDone=true,error=>__fixture.flushError=error.message); })
    await until(() => __fixture.noteSaves.length === 1 && __fixture.noteSaves[0].body === 'Unmounted draft', 'quit retries failed draft from unmounted editor')
    await evaluate(() => __fixture.finishNote())
    await until(() => __fixture.flushDone, 'unmounted draft retry acknowledged')
    await click('Fixture today')
    await until(() => document.querySelector('textarea')?.value === 'Unmounted draft' && !document.querySelector('textarea').disabled, 'unmounted note draft remains after reopen')

    await input('textarea', 'Obsolete failed draft')
    await click('Fixture calendar')
    await until(() => __fixture.noteSaves.length === 1, 'obsolete editor starts save')
    await evaluate(() => __fixture.failNote())
    await wait(60)
    await click('Fixture today')
    await until(() => document.querySelector('textarea')?.value === 'Obsolete failed draft' && !document.querySelector('textarea').disabled && __fixture.noteSaves.length === 1, 'replacement editor adopts failed draft')
    await evaluate(() => __fixture.finishNote())
    await until(() => document.querySelector('textarea').closest('section').textContent.includes('Saved'), 'replacement saves recovered draft')
    await input('textarea', 'Newer acknowledged note')
    await evaluate(() => { __fixture.flushDone=false;window.__flushNotes().then(()=>__fixture.flushDone=true,error=>__fixture.flushError=error.message); })
    await until(() => __fixture.noteSaves.length === 1, 'replacement saves newer note')
    await evaluate(() => __fixture.finishNote())
    await until(() => __fixture.flushDone, 'replacement newer save acknowledged')
    await evaluate(() => window.__flushNotes())
    assert.equal(await evaluate(() => __fixture.noteSaves.length), 0, 'quit must never retry an obsolete inactive editor over a newer Saved note')
    assert.equal(await evaluate(() => __fixture.notes.self), 'Newer acknowledged note')

    for (const mismatch of ['body', 'day', 'person']) {
      await input('textarea', `Verified receipt ${mismatch}`)
      await evaluate(() => { __fixture.flushError='';window.__flushNotes().catch(error=>__fixture.flushError=error.message); })
      await until(() => __fixture.noteSaves.length === 1, 'receipt validation save begins')
      await evaluate(mismatch => __fixture.finishNote(mismatch), mismatch)
      await until(() => __fixture.flushError.includes('did not match') && document.querySelector('textarea').closest('section').textContent.includes('Not saved'), `wrong ${mismatch} receipt cannot mark note Saved`)
      assert.equal(await evaluate(() => localStorage.getItem('doneline.noteDraft:'+__fixture.today+':self')), `Verified receipt ${mismatch}`, 'unverified receipt retains the recovery draft')
      await click('Retry save')
      await until(() => __fixture.noteSaves.length === 1, 'retry after rejected receipt')
      await evaluate(() => __fixture.finishNote())
      await until(() => document.querySelector('textarea').closest('section').textContent.includes('Saved'), 'verified retry marks Saved')
    }

    await click('Fixture calendar')
    await evaluate(() => { __fixture.noteLoadError=true;localStorage.setItem('doneline.noteDraft:'+__fixture.today+':self','Recovered local draft'); })
    await click('Fixture today')
    await until(() => document.querySelector('textarea')?.value === 'Recovered local draft' && !document.querySelector('textarea').disabled && document.querySelector('textarea').closest('section').textContent.includes('local draft is shown'), 'failed startup read exposes recovered draft')
    assert.equal(await evaluate(() => __fixture.noteSaves.length), 0, 'failed read never blindly writes the recovery draft')
    await evaluate(() => { __fixture.noteLoadError=false })
    await click('Retry save')
    await until(() => __fixture.noteSaves.length === 1, 'explicit recovered draft save')
    await evaluate(() => __fixture.finishNote())
    await until(() => document.querySelector('textarea').closest('section').textContent.includes('Saved'), 'recovered draft saved')

    await evaluate(() => { __fixture.deferCreates = true })
    await input('input[placeholder^="Quick add"]', 'Task A')
    await evaluate(() => {
      const field = document.querySelector('input[placeholder^="Quick add"]')
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await until(() => __fixture.pendingCreates.length === 1, 'quick add starts one create')
    assert.equal(await evaluate(() => __fixture.calls.filter(call => call.method === 'todos.create').length), 1, 'repeated Enter cannot create duplicate tasks')
    await input('input[placeholder^="Quick add"]', 'Task B')
    await evaluate(() => __fixture.finishCreate())
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('input[placeholder^="Quick add"]').value), 'Task B', 'saving Task A keeps Task B being typed')

    await evaluate(() => { __fixture.updateStatus = {state:'downloaded',canAutoInstall:true,version:'99.0.0'} })
    await click('Fixture settings')
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Restart & update' && !button.disabled), 'downloaded update snapshot survives a missed startup event')
    await click('Restart & update')
    await until(() => __fixture.calls.some(call => call.method === 'updates.install' && call.input.canAutoInstall), 'downloaded update can be installed')
    await until(() => document.querySelector('[aria-label="Calendar profile"]')?.value === 'self' && __fixture.pendingConfigs.some(config => config.personId === 'self'), 'settings first calendar profile')
    await input('[aria-label="Calendar profile"]', 'friend')
    await until(() => __fixture.pendingConfigs.some(config => config.personId === 'friend'), 'settings second calendar profile')
    await evaluate(() => __fixture.finishConfig('friend'))
    await until(() => document.querySelector('input[placeholder="Apple ID email"]')?.value === 'friend@example.com', 'friend calendar credentials')
    await evaluate(() => __fixture.finishConfig('self'))
    await wait(100)
    assert.equal(await evaluate(() => document.querySelector('input[placeholder="Apple ID email"]').value), 'friend@example.com', 'late first-profile credentials cannot replace second profile')
    await input('[aria-label="This device\'s profile"]', 'friend')
    await until(() => document.querySelector('[aria-label="This device\'s profile"]')?.value === 'self' && [...document.querySelectorAll('[role="alert"]')].some(alert => alert.textContent.includes('Fixture identity save failed')), 'identity save failure restores selection')

    await click('Fixture today')
    await evaluate(() => { __fixture.platform = 'darwin'; __fixture.updateStatus = {state:'available',canAutoInstall:false,version:'99.0.0'} })
    await click('Fixture settings')
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Open downloads page' && !button.disabled), 'unsigned Mac update opens downloads without awaiting automatic installation')
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Check for updates').disabled), false, 'unsigned Mac availability is a completed check')
    await click('Check for updates')
    await until(() => __fixture.calls.some(call => call.method === 'updates.check') && [...document.querySelectorAll('button')].some(button => button.textContent === 'Check for updates' && !button.disabled), 'manual Mac update check clears its busy state')
    await click('Open downloads page')
    await until(() => __fixture.calls.some(call => call.method === 'updates.install' && !call.input.canAutoInstall), 'unsigned Mac download action is wired')
    await evaluate(platform => { __fixture.platform = platform; __fixture.updateStatus = {state:'idle',canAutoInstall:true} }, process.platform)

    await click('Fixture today')
    await evaluate(() => { __fixture.deferUpdateStatus = true })
    await click('Fixture settings')
    await until(() => __fixture.pendingUpdateSnapshots.length === 1, 'initial update snapshot waits for its IPC response')
    await evaluate(() => {
      __fixture.updateStatus = {state:'downloaded',canAutoInstall:true,version:'100.0.0'}
      __fixture.updateListeners.forEach(listener => listener({...__fixture.updateStatus}))
    })
    await until(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Restart & update' && !button.disabled), 'new downloaded event arrives before the old snapshot')
    await evaluate(() => { __fixture.pendingUpdateSnapshots.shift()({state:'idle',canAutoInstall:true}); __fixture.deferUpdateStatus = false })
    await wait(100)
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Restart & update' && !button.disabled)), true, 'a late old snapshot cannot hide the newer downloaded update')

    await click('Fixture nudges')
    await until(() => [...document.querySelectorAll('p')].some(p => p.textContent === 'Fixture nudge message') && __fixture.nudgeReceiptAttempts === 1, 'nudge displays before failed receipt')
    await evaluate(() => __fixture.triggerChange())
    await until(() => __fixture.nudgeReceiptAttempts === 2, 'failed nudge receipt retried')
    assert.equal(await evaluate(() => [...document.querySelectorAll('p')].filter(p => p.textContent === 'Fixture nudge message').length), 1, 'receipt retry shows only one toast')
    await evaluate(() => document.querySelector('[aria-label="Dismiss"]').click())
    await evaluate(() => __fixture.triggerChange())
    await until(() => __fixture.nudgeReceiptAttempts >= 3, 'dismissed delivery receipt may retry')
    assert.equal(await evaluate(() => [...document.querySelectorAll('p')].filter(p => p.textContent === 'Fixture nudge message').length), 0, 'polling cannot redisplay a dismissed nudge')
    await click('Fixture settings')

    await evaluate(() => {
      const OriginalDate = Date
      __fixture.now = Date.now()
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [__fixture.now])) }
        static now() { return __fixture.now }
      }
    })
    await click('Fixture start focus')
    await until(() => document.querySelector('[data-focus="started"][data-identity="self"]'), 'start focus with original owner')
    await evaluate(() => { __fixture.now += 90_000; __fixture.selfId = 'friend'; window.dispatchEvent(new Event('doneline:identity')) })
    await until(() => document.querySelector('[data-focus="stopped"][data-identity="friend"]') && __fixture.calls.some(call => call.method === 'focus.record'), 'identity switch records and resets focus')
    const focusRecord = await evaluate(() => __fixture.calls.find(call => call.method === 'focus.record').input)
    assert.equal(focusRecord.personId, 'self', 'running focus stays credited to its original owner')
    assert.equal(focusRecord.durationSeconds, 90)
    assert.deepEqual(await evaluate(() => __fixture.errors), [], 'no renderer errors or unhandled rejections')
    win.destroy()
    console.log(`Renderer checks passed: bounded weekdays, date/time validation, all-day ends, repeat/remote occurrence editing, repeat confirmation refresh, grid overlap, explicit browser timezone, range preview/delete, calendar data/profile race, instant count, shared completion, rollback, note race protection, quit flush with newer edits, unmounted failed save retry, replacement editor ownership, verified note receipts, failed read draft recovery, quick-add duplicates/drafts, calendar credentials/profile race, identity failure, downloaded update snapshot and unsigned Mac download action, nudge receipt retries/deduplication, focus owner attribution. Screenshot: ${screenshot}`)
  }
  run().then(() => app.quit()).catch(error => { console.error(error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); app.exit(1) })
}
