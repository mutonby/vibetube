// Checks production picker UI with real desktop sources, fallback images and selection races.
// No camera or microphone is accessed.
const {app,BrowserWindow,desktopCapturer}=require('electron'),fs=require('fs'),path=require('path'),os=require('os'),{pathToFileURL}=require('url'),assert=require('assert/strict');
const root=process.cwd(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rs-picker-'));
app.setPath('userData',tmp);let win;const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 const sources=[...await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:320,height:200}}), ...await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:320,height:200}})];
 const normalized=sources.map((s,i)=>({id:s.id,name:s.id.startsWith('screen')?'Pantalla '+(i+1):s.name,kind:s.id.startsWith('screen')?'screen':'window',detail:s.id.startsWith('screen')?'Pantalla completa':'Solo esta ventana',thumbnail:s.thumbnail.isEmpty()?null:s.thumbnail.toDataURL()}));
 let html=fs.readFileSync(path.join(root,'src/index.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace('<head>',`<head><base href="${pathToFileURL(root+'/src/').href}">`);
 fs.writeFileSync(path.join(tmp,'test.html'),html);
 win=new BrowserWindow({show:false,width:1320,height:880,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',(_e,l,m)=>console.log(m));await win.loadFile(path.join(tmp,'test.html')); 
 await win.webContents.executeJavaScript(`window.studio=new Proxy({}, {get:()=>()=>{}});window.installFloatPreview=()=>{};void 0;`);
 for(const file of ['renderer.js','recording.js'])await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'src',file),'utf8')+';void 0;');
 await win.webContents.executeJavaScript(`state.sources=${JSON.stringify(normalized)};document.querySelectorAll('main').forEach(e=>e.classList.add('hidden'));el('viewRecord').classList.remove('hidden');renderSources();`);
 await new Promise(r=>setTimeout(r,500));
 const report=await win.webContents.executeJavaScript(`(async()=>{
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const cards=[...document.querySelectorAll('.source-card')];assert(cards.length===state.sources.length,'source count');assert(cards.every(c=>c.offsetHeight>=88),'cards collapsed');assert(cards.every(c=>c.querySelector('.source-name').offsetHeight>0),'source names invisible');assert(!el('sourcesGrid').textContent.includes('GRABANDO'),'false recording badge');
 const sizes=cards.map(c=>c.getBoundingClientRect().height);
 state.sources.push({id:'broken',name:'Ventana sin miniatura',kind:'window',thumbnail:'data:image/png;base64,invalid'});renderSources();await new Promise(r=>setTimeout(r,100));assert(!document.querySelector('.source-card:last-child img'),'broken image not removed');
 const streams=[];const stream=()=>{let stopped=false;return {active:true,getTracks(){return [{stop(){stopped=true}}]},getVideoTracks(){return [{getSettings(){return {}},addEventListener(){}}]},get stopped(){return stopped}}};
 let resolveA,resolveB;startScreenPreview=id=>new Promise(r=>{if(id==='a')resolveA=r;else resolveB=r});
 const preview=el('screenPreview');preview.removeAttribute('id');const stub=document.createElement('div');stub.id='screenPreview';preview.after(stub);
 state.sources=[{id:'a',name:'Ventana A',kind:'window'},{id:'b',name:'Ventana B',kind:'window'}];const a=selectSource('a'),b=selectSource('b'),sa=stream(),sb=stream();resolveB(sb);await b;resolveA(sa);await a;assert(state.selectedSourceId==='b'&&sa.stopped&&!sb.stopped,'stale selection overwrote newer stream');
 startScreenPreview=async()=>{throw Error('expected unavailable')};await selectSource('a');assert(state.selectedSourceId==='b'&&!sb.stopped,'failed selection killed current stream');
 stub.remove();preview.id='screenPreview';state.sources=${JSON.stringify(normalized)};state.sources.push({id:'missing',name:'Ventana minimizada',kind:'window',detail:'Solo esta ventana',thumbnail:null});state.selectedSourceId=state.sources[0].id;renderSources();
 return {cards:cards.length,minHeight:Math.min(...sizes),images:[...document.querySelectorAll('.source-thumb img')].filter(i=>i.complete&&i.naturalWidth>0).length,selectionRaces:'passed',missingThumbnails:'passed'};
})()`);
 await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(tmp,'source-picker.png'),(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({...report,screenshot:path.join(tmp,'source-picker.png')}));clearTimeout(timeout);win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
