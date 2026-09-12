'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const output = process.argv[2] || '/tmp/rs-crop-encoding'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-crop-'))
app.setPath('userData', temp)
const timeout = setTimeout(() => app.exit(1), 30000)
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show:false,webPreferences:{backgroundThrottling:false} })
 await win.loadURL('about:blank')
 await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname,'../../src/camcrop.js'),'utf8')+'\nvoid 0')
 const result = await win.webContents.executeJavaScript(`(${run.toString()})()`)
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'crop.webm'),Buffer.from(result.video.split(',')[1],'base64'));delete result.video
 fs.writeFileSync(path.join(output,'stats.json'),JSON.stringify(result,null,2));console.log(result)
 assert.ok(result.samples.every(p=>p[1]>120&&p[0]<60), 'Encoded crop must retain source pixels, not black frames')
 assert.ok(result.originalLive,'Stopping crop must preserve source track');assert.equal(result.width,926);assert.equal(result.height,634)
 clearTimeout(timeout);win.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
async function run(){
 const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');
 const raw=canvas.captureStream(0),track=raw.getVideoTracks()[0];let n=0;
 const timer=setInterval(()=>{ctx.fillStyle='rgb(20,170,100)';ctx.fillRect(0,0,1280,720);ctx.fillStyle='white';ctx.fillRect(n++%100,0,20,720);track.requestFrame()},33)
 const crop=new CamCrop(),stream=crop.start(raw,{x:.11298331567796616,y:.11544087974172723,w:.7231859110169492,h:.8810364541296745});
 const chunks=[],rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4000000});rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};rec.start(250);
 await new Promise(r=>setTimeout(r,3000));await new Promise(r=>{rec.onstop=r;rec.stop()});crop.stop();const originalLive=track.readyState==='live';clearInterval(timer);track.stop();
 const blob=new Blob(chunks,{type:rec.mimeType}),url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.src=url;await video.play();
 const samples=[];for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,200));ctx.drawImage(video,0,0);samples.push([...ctx.getImageData(200,200,1,1).data])}
 video.pause();URL.revokeObjectURL(url);const data=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(blob)});
 return {video:data,samples,width:video.videoWidth,height:video.videoHeight,originalLive}
}
