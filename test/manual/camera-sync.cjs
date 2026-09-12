'use strict'
// Real Chromium recording with a known simultaneous flash/tone and a delayed
// matte reply. Measures the encoded result, including crop and Opus, not mocks
// of browser timestamp behavior. No camera or microphone is opened.
const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'../..'),out=process.argv[2]||'/tmp/rs-camera-sync'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rs-sync-'));app.setPath('userData',temp)
const matte=async()=>{await new Promise(r=>setTimeout(r,90));return {alpha:new Uint8Array(288*512).fill(255),milliseconds:90}}
ipcMain.handle('matting-start',()=> 'sync-test');ipcMain.handle('matting-stop',()=>{})
ipcMain.handle('matting-frame',matte)
ipcMain.on('matting-connect',e=>{const port=e.ports[0];port.on('message',async({data})=>{
 if(!data || !(data.rgba instanceof Uint8Array) || data.rgba.length!==data.width*data.height*4) {
  port.postMessage({error:'Invalid camera pixel transport'});return
 }
 port.postMessage(await matte())
});port.start()})
const timeout=setTimeout(()=>app.exit(1),45000)
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'electron/preload.js'),backgroundThrottling:false}})
 await win.loadURL(process.argv[3] ? 'about:blank#baseline' : 'about:blank')
 await win.webContents.executeJavaScript(fs.readFileSync(process.argv[3]||path.join(root,'src/matanyone-campipe.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'src/camcrop.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'src/recording-audio-sync.js'),'utf8')+'\nvoid 0')
 const result=await win.webContents.executeJavaScript(`(${run.toString()})()`)
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'sync.webm'),Buffer.from(result.video.slice(result.video.indexOf(';base64,') + 8),'base64'));delete result.video
 fs.writeFileSync(path.join(out,'stats.json'),JSON.stringify(result,null,2));console.log(result)
 const alignment=execFileSync('python3',[path.join(__dirname,'check-camera-sync.py'),path.join(out,'sync.webm'),...(process.argv[3]?['--baseline']:[])],{encoding:'utf8'});console.log(alignment);fs.writeFileSync(path.join(out,'alignment.json'),alignment)
 if(!result.sourceAlive)throw Error('Effect stopped original camera')
 clearTimeout(timeout);win.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
async function run(){
 const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
 const audio=new AudioContext(),dest=audio.createMediaStreamDestination();await audio.resume();
 const start=audio.currentTime+.5;
 for(let i=0;i<10;i++){const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=1000;g.gain.value=.5;o.connect(g).connect(dest);o.start(start+i);o.stop(start+i+.25)}
 const raw=canvas.captureStream(0),track=raw.getVideoTracks()[0];raw.addTrack(dest.stream.getAudioTracks()[0]);
 const pump=setInterval(()=>{const t=audio.currentTime-start;ctx.fillStyle=t>=0&&t%1<.25?'white':'black';ctx.fillRect(0,0,640,360);track.requestFrame()},20)
 const pipe=new MatAnyoneCamPipe();const processed=await pipe.start(raw,{blur:true,blurAmount:.1});
 const crop=new CamCrop(),stream=crop.start(processed,{x:.1,y:.1,w:.8,h:.8});
 await new Promise(r=>setTimeout(r,500));
 const sync = new RecordingAudioSync();
 if (!window.location.hash.includes('baseline')) {
  const delayed = await sync.start(stream.getAudioTracks()[0], () => pipe.stats.latencyMs || 0);
  stream.removeTrack(stream.getAudioTracks()[0]); stream.addTrack(delayed);
 }
 const chunks=[],rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9,opus',videoBitsPerSecond:1000000});rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
 const begin=performance.now();rec.start(250);await new Promise(r=>setTimeout(r,8000));await new Promise(r=>{rec.onstop=r;rec.stop()});
 const elapsedMs=performance.now()-begin,frames=pipe.stats.frames;
 sync.stop();crop.stop();await pipe.stop();const sourceAlive=track.readyState==='live';clearInterval(pump);raw.getTracks().forEach(t=>t.stop());await audio.close();
 const video=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(new Blob(chunks,{type:rec.mimeType}))});return {video,sourceAlive,frames,elapsedMs,stats:pipe.stats,delaySeconds:sync.delay?.delayTime.value}
}
