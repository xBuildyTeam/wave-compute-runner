const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH = process.env.RUNNER_AUTH_TOKEN || '';
const PORT = process.env.PORT || 8080;

function send(res, code, obj){ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }

http.createServer((req,res)=>{
  if(req.method!=='POST'){ return send(res,405,{error:'POST only'}); }
  const auth=(req.headers['authorization']||'').replace(/^Bearer\s+/i,'');
  if(!AUTH || auth!==AUTH){ return send(res,401,{error:'unauthorized'}); }
  let body=''; req.on('data',c=>body+=c);
  req.on('end',async()=>{
    let p; try{ p=JSON.parse(body); }catch{ return send(res,400,{error:'bad json'}); }
    const { files=[], command, args=[], timeoutSec=30, runtime='shell' } = p;
    const cap=Math.min(Math.max(Number(timeoutSec)||30,1),60);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-'));
    const start=Date.now();
    try{
      for(const f of files){
        const fp=path.join(dir,f.path);
        fs.mkdirSync(path.dirname(fp),{recursive:true});
        fs.writeFileSync(fp,f.content||'');
      }
      let exe, exeArgs;
      if(runtime==='solidity'){
        exe='solcjs';
        const sols=files.filter(f=>f.path.endsWith('.sol')).map(f=>f.path);
        exeArgs=['--abi','--bin','--optimize', ...sols];
      } else if(runtime==='node'){ exe='node'; exeArgs=args; }
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
