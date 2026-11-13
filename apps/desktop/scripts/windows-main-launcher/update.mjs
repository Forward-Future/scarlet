import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const remote = 'https://github.com/Forward-Future/scarlet.git';
// The repository moved from a personal account. Checkouts made before the move follow it here.
const movedFrom = 'https://github.com/mberman84/scarlet.git';
const triple = 'x86_64-pc-windows-msvc';
const appDir = path.join(process.env.LOCALAPPDATA, 'Scarlet');
const cache = path.join(root, 'cache'), src = path.join(cache, 'source');
const target = path.join(cache, 'target'), setup = path.join(cache, 'ready-setup.exe');
const installed = path.join(root, 'installed.json'), ready = path.join(cache, 'ready.json');
const tools = JSON.parse(fs.readFileSync(path.join(root, 'tools.json'), 'utf8').replace(/^\uFEFF/, ''));
const logFile = path.join(root, 'launch.log');
const env = { ...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never', CI:'true', CARGO_TARGET_DIR:target };
const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
env[pathKey] = [path.dirname(process.execPath),path.dirname(tools.git),path.dirname(tools.pnpm),path.join(homedir(),'.cargo','bin'),env[pathKey]].join(';');
if (tools.cmake && fs.existsSync(tools.cmake)) env.CMAKE_COMMAND = tools.cmake;
fs.mkdirSync(cache, {recursive:true});

function log(text) { fs.appendFileSync(logFile, new Date().toISOString()+' '+text+'\n'); }
function write(file, contents) {
  const tmp = file+'.'+randomUUID()+'.tmp';
  try { fs.writeFileSync(tmp, contents); fs.renameSync(tmp,file); } finally { fs.rmSync(tmp,{force:true}); }
}
function status(text) { write(path.join(root,'status.txt'),text); log(text); }
function manifest(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; }
}
function run(exe,args,cwd=root,output=false,timeout=3600000) {
  const fd = fs.openSync(logFile,'a');
  try {
    const p = spawnSync(exe,args,{cwd,env,windowsHide:true,shell:false,encoding:'utf8',timeout,stdio:['ignore',output?'pipe':fd,fd]});
    if (p.error || p.status !== 0) throw Error(path.basename(exe)+' failed: '+(p.error?.message || 'exit '+p.status));
    return output ? p.stdout.trim() : '';
  } finally { fs.closeSync(fd); }
}
function latest() {
  let ref;
  try { ref = run(tools.git,['ls-remote','--exit-code',remote,'refs/heads/main'],root,true,45000); }
  catch { throw Error('Could not check GitHub main. Check your connection and GitHub access, then open Scarlet again.'); }
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(ref);
  if (!match) throw Error('GitHub returned an unexpected main revision.');
  return match[1];
}
const digest = data => createHash('sha256').update(data).digest('hex');
function fileHash(file) {
  const fd = fs.openSync(file,'r');
  try {
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024*1024);
    let count;
    while ((count = fs.readSync(fd,chunk,0,chunk.length,null)) > 0) hash.update(chunk.subarray(0,count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function matches(m) {
  if (!m || !/^[a-f0-9]{40}$/.test(m.revision)) return false;
  try {
    return fileHash(path.join(appDir,'scarlet-desktop.exe'))===m.desktop &&
           fileHash(path.join(appDir,'scarlet-engine.exe'))===m.engine;
  } catch { return false; }
}
function validReady(m,rev) {
  return m?.revision===rev && fs.existsSync(setup) && m.installer===fileHash(setup);
}
function assertSource(checkout,rev) {
  const git = (...args)=>run(tools.git,args,checkout,true);
  if (git('remote','get-url','origin')!==remote || git('rev-parse','HEAD')!==rev ||
      git('status','--porcelain','--untracked-files=normal')) throw Error('The release checkout does not match the clean GitHub revision.');
}
export function stageVerifiedBuild(checkout,release,rev) {
  assertSource(checkout,rev);
  const cfg = JSON.parse(fs.readFileSync(path.join(checkout,'apps/desktop/src-tauri/tauri.conf.json'),'utf8'));
  const installer = path.join(release,'bundle','nsis',cfg.productName+'_'+cfg.version+'_x64-setup.exe');
  const desktop = fs.readFileSync(path.join(release,'deps','scarlet_desktop.exe'));
  const marker = '__TAURI_BUNDLE_TYPE_VAR_UNK';
  const off = desktop.indexOf(marker);
  if (off<0 || desktop.lastIndexOf(marker)!==off) throw Error('Cannot verify the native installer payload.');
  desktop.write('NSS',off+marker.length-3,'ascii');
  const next = {revision:rev,desktop:digest(desktop),engine:fileHash(path.join(release,'scarlet-engine.exe')),installer:fileHash(installer)};
  const tmp = setup+'.'+randomUUID()+'.tmp';
  try {
    fs.copyFileSync(installer,tmp);
    if (fileHash(tmp)!==next.installer) throw Error('Installer changed during staging.');
    fs.renameSync(tmp,setup);
  } finally { fs.rmSync(tmp,{force:true}); }
  write(ready,JSON.stringify(next,null,2)+'\n');
  log('Verified release staged at '+rev);
}
function checkoutMain(rev) {
  if (!fs.existsSync(path.join(src,'.git'))) {
    status('Fetching the private Scarlet build checkout…');
    run(tools.git,['clone','--no-checkout','--single-branch','--branch','main',remote,src]);
  }
  if (run(tools.git,['remote','get-url','origin'],src,true)===movedFrom) run(tools.git,['remote','set-url','origin',remote],src);
  if (run(tools.git,['remote','get-url','origin'],src,true)!==remote) throw Error('Unexpected origin in the private build checkout.');
  run(tools.git,['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main'],src);
  if (run(tools.git,['rev-parse','refs/remotes/origin/main'],src,true)!==rev) return false;
  run(tools.git,['checkout','--detach',rev],src);
  assertSource(src,rev);
  return true;
}
function build(rev) {
  if (!checkoutMain(rev)) return;
  status('Installing dependencies for Scarlet '+rev.slice(0,7)+'…');
  run(tools.pnpm,['install','--frozen-lockfile'],src);
  status('Building the Scarlet engine…');
  run(tools.pnpm,['--filter','@scarlet/server...','run','build'],src);
  const bins=path.join(src,'apps/desktop/src-tauri/binaries');
  run(tools.pnpm,['--filter','@scarlet/server','build:sea','--','--out',path.join(bins,'scarlet-engine-'+triple+'.exe')],src);
  run(process.execPath,['apps/desktop/scripts/fetch-ffmpeg.mjs','--target',triple],src);
  status('Building the Windows app and installer. This can take several minutes…');
  // This installer stays on the same disk. Avoid spending minutes compressing the sidecars.
  const localBundle = JSON.stringify({bundle:{windows:{nsis:{compression:'none'}}}});
  run(tools.pnpm,['--filter','@scarlet/desktop','exec','tauri','build','--target',triple,'--bundles','nsis','--config',localBundle],src);
  const release=path.join(target,triple,'release');
  status('Verifying the rebuilt engine…');
  run(process.execPath,['apps/desktop/scripts/smoke-engine.mjs',release],src);
  stageVerifiedBuild(src,release,rev);
}
function install(m) {
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const active=run(ps,['-NoProfile','-NonInteractive','-Command',
    "Get-Process -Name 'scarlet-desktop','scarlet-engine' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }; exit 0"],root,true,20000);
  if (active.split(/\r?\n/).some(p=>p.toLowerCase().startsWith(appDir.toLowerCase()+path.sep))) {
    status('The update is ready. Waiting for Scarlet to close.');
    return 4;
  }
  status('Installing verified Scarlet '+m.revision.slice(0,7)+'…');
  run(setup,['/S','/UPDATE','/NS','/D='+appDir],root,false,300000);
  if (!matches(m)) throw Error('Installed files did not match the verified GitHub build. Scarlet will stay closed.');
  write(installed,JSON.stringify({revision:m.revision,desktop:m.desktop,engine:m.engine},null,2)+'\n');
  return 0;
}
async function main(mode) {
  if (mode==='--verify-local') return matches(manifest(installed)) ? 0 : 1;
  if (mode==='--apply-ready') {
    const candidate=manifest(ready);
    if (!candidate || !/^[a-f0-9]{40}$/.test(candidate.revision) || !validReady(candidate,candidate.revision)) {
      throw Error('The staged installer could not be verified.');
    }
    return install(candidate);
  }
  if (!['--check-only','--prepare-only','--stage-only'].includes(mode)) throw Error('Unexpected launcher mode');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size>4000000) fs.renameSync(logFile,logFile+'.previous');
  status('Checking GitHub main…');
  for (;;) {
    const rev=latest(), current=manifest(installed);
    if (current?.revision===rev && matches(current)) { status('Verified GitHub main '+rev.slice(0,7)+'.'); return; }
    if (mode==='--check-only') throw Error('The installed copy needs an update.');
    const candidate=manifest(ready);
    if (validReady(candidate,rev)) {
      if (mode==='--stage-only') { status('Verified update ready for when Scarlet closes.'); return 3; }
      const result = install(candidate);
      if (result!==0) return result;
    }
    else build(rev);
    // Re-read main after a long build before offering the installer.
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try { process.exitCode=(await main(process.argv[2])) ?? 0; } catch (e) { status(e.message); process.exitCode=1; }
}
