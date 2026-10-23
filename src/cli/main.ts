import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadAgent, loadMachine } from "../config/load.ts";
import { validateManifest, type ProfileManifest } from "../config/schema.ts";
import { doctor } from "../identity/doctor.ts";
import { resolveProfile } from "../identity/profiles.ts";
function manifest(name:string):ProfileManifest { return validateManifest(JSON.parse(readFileSync(resolveProfile(name).manifestFile,"utf8"))); }
function usage(){console.log("durable doctor <id> [--json]\ndurable profile init|show|list|check <name>");}
const [cmd, sub, ...rest]=process.argv.slice(2);
if(cmd==="doctor"&&sub){const r=doctor(sub,loadAgent(sub),loadMachine()); if(rest.includes("--json")) console.log(JSON.stringify(r)); else {for(const c of r.checks) console.log(`${c.ok?"PASS":"FAIL"}\t${c.name}\t${c.detail}${c.fix?` (${c.fix})`:""}`);} process.exitCode=r.ok?0:1;}
else if(cmd==="profile"&&sub){const name=rest[0]; if(!name){usage();process.exitCode=1;} else {const p=resolveProfile(name); if(sub==="init"){ if(existsSync(p.manifestFile)) throw new Error("manifest already exists"); mkdirSync(dirname(p.manifestFile),{recursive:true}); writeFileSync(p.manifestFile,JSON.stringify({version:1,label:name,github:{host:"github.com",login:""},git:{name:"",email:"operator@example.invalid"},providers:[]},null,2)+"\n",{mode:0o644}); chmodSync(p.manifestFile,0o644); console.log(`created ${name}`);} else if(sub==="bind-github"){ const r=spawnSync("gh",["api","user","--jq",".login"],{encoding:"utf8",env:{PATH:process.env.PATH,...Object.fromEntries(readFileSync(p.secretsFile,"utf8").split(/\r?\n/).filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),x.slice(i+1)];}))}}); if(r.status!==0) throw new Error("gh api user failed"); const m=manifest(name); m.github.login=r.stdout.trim(); writeFileSync(p.manifestFile,JSON.stringify(m,null,2)+"\n"); console.log(`bound ${m.github.login}`); } else if(sub==="show"){console.log(JSON.stringify(manifest(name),null,2));} else if(sub==="check"){ console.log("PASS\tmanifest"); manifest(name);} else if(sub==="list"){console.log(name);} else {usage();process.exitCode=1;}}} else usage();
