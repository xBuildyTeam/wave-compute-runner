const http = require('http');
const { execFile, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH = process.env.RUNNER_AUTH_TOKEN || '';
const PORT = process.env.PORT || 8080;

function send(res, code, obj){ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }

// The Dockerfile installs solc@0.8.14 globally (`npm install -g solc@0.8.14`).
// We do NOT shell out to the solcjs CLI binary — under Node 22 that binary throws
// "Cannot find module './common/helpers'" (a broken relative require inside the
// packaged CLI script). Instead we require the solc package as a library and use
// solc.loadRemoteVersion to fetch the real v0.8.14 compiler build, then compile via
// the standard JSON input/output interface. Output stays pinned to solc 0.8.14 /
// evmVersion istanbul per Theta mainnet rules (no PUSH0 support).
let solcLib = null;
function getSolcLib(){
  if (solcLib) return solcLib;
  const globalRoot = execSync('npm root -g').toString().trim();
  solcLib = require(path.join(globalRoot, 'solc'));
  return solcLib;
}

const SOLC_VERSION = 'v0.8.14+commit.80d49f37';
let cachedCompiler = null;
function loadCompiler(){
  return new Promise((resolve, reject) => {
    if (cachedCompiler) return resolve(cachedCompiler);
    let solc;
    try { solc = getSolcLib(); } catch (e) { return reject(e); }
    solc.loadRemoteVersion(SOLC_VERSION, (err, snapshot) => {
      if (err) return reject(err);
      cachedCompiler = snapshot;
      resolve(snapshot);
    });
  });
}

async function compileSolidity(files){
  const solc = await loadCompiler();
  const sources = {};
  for (const f of files) {
    if (f.path.endsWith('.sol')) sources[f.path] = { content: f.content || '' };
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'istanbul',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}

http.createServer((req,res)=>{
  if(req.method!=='POST'){ return send(res,405,{error:'POST only'}); }
  const auth=(req.headers['authorization']||'').replace(/^Bearer\s+/i,'');
  if(!AUTH || auth!==AUTH){ return send(res,401,{error:'unauthorized'}); }
  let body=''; req.on('data',c=>body+=c);
  req.on('end',async()=>{
    let p; try{ p=JSON.parse(body); }catch{ return send(res,400,{error:'bad json'}); }
    const { files=[], command, args=[], timeoutSec=30, runtime='shell' } = p;
    const cap=Math.min(Math.max(Number(timeoutSec)||30,1),60);
    const start=Date.now();

    if (runtime === 'solidity') {
      try {
        const output = await compileSolidity(files);
        const errors = (output.errors || []).filter(e => e.severity === 'error');
        const artifacts = [];
        if (output.contracts) {
          for (const srcPath of Object.keys(output.contracts)) {
            for (const contractName of Object.keys(output.contracts[srcPath])) {
              const c = output.contracts[srcPath][contractName];
              artifacts.push({ path: `${contractName}.abi`, content: JSON.stringify(c.abi) });
              artifacts.push({ path: `${contractName}.bin`, content: (c.evm && c.evm.bytecode && c.evm.bytecode.object) || '' });
            }
          }
        }
        return send(res, 200, {
          exitCode: errors.length ? 1 : 0,
          stdout: JSON.stringify({ warnings: (output.errors || []).filter(e => e.severity !== 'error') }),
          stderr: errors.map(e => e.formattedMessage || e.message).join('\n'),
          artifacts,
          durationMs: Date.now() - start
        });
      } catch (e) {
        return send(res, 200, {
          exitCode: 1, stdout: '', stderr: String((e && e.message) || e), artifacts: [], durationMs: Date.now() - start
        });
      }
    }

    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-'));
    try{
      for(const f of files){
        const fp=path.join(dir,f.path);
        fs.mkdirSync(path.dirname(fp),{recursive:true});
        fs.writeFileSync(fp,f.content||'');
      }
      let exe, exeArgs;
      if (runtime==='node'){ exe='node'; exeArgs=args; }
      else { exe='sh'; exeArgs=['-c', [command,...args].join(' ')]; }

      execFile(exe,exeArgs,{cwd:dir,timeout:cap*1000,maxBuffer:10*1024*1024},
        (err,stdout,stderr)=>{
          const inputs=new Set(files.map(f=>f.path));
          let artifacts=[];
          try{
            for(const name of fs.readdirSync(dir)){
              if(!inputs.has(name) && /\.(abi|bin|json)$/.test(name)){
                artifacts.push({path:name,content:fs.readFileSync(path.join(dir,name),'utf8')});
              }
            }
          }catch{}
          send(res,200,{
            exitCode: err? (err.killed?124:(err.code??1)) : 0,
            stdout: (stdout||'').slice(0,200000),
            stderr: (stderr||'').slice(0,200000),
            artifacts,
            durationMs: Date.now()-start
          });
          fs.rmSync(dir,{recursive:true,force:true});
        });
    }catch(e){
      send(res,500,{exitCode:1,stdout:'',stderr:String(e),artifacts:[],durationMs:Date.now()-start});
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
}).listen(PORT,()=>console.log('runner on',PORT));
