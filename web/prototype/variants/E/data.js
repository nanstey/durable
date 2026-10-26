import { NOW, transcript as retryTranscript } from "../../mock.js";
const m=n=>NOW-n*60000;
const specs=[
["steward-platform","steward",null,"idle","Platform stewardship","acme-platform","atlas","durable/web","main","atlas-mac",5,0],
["retry","worker","steward-platform","waiting-approval","Add jittered retry policy","acme-platform","atlas","durable/web","feat/retry-jitter","atlas-mac",11,2,412],
["a11y","reviewer","retry","running","Audit console keyboard paths","acme-platform","atlas","durable/web","feat/retry-jitter","atlas-mac",4,0,413],
["tokens","worker","steward-platform","running","Expose token budget in header","acme-platform","atlas","durable/web","feat/budget-header","atlas-mac",18,1],
["oauth","scout","steward-platform","done","Map OAuth scope migration","acme-platform","atlas","durable/api","main","atlas-mac",95,0],
["loader","worker","steward-platform","held","Replace config loader validation","acme-platform","atlas","durable/api","feat/typebox-loader","atlas-mac",54,0,409],
["release","chat",null,"waiting-followup","Release train checklist","acme-platform","atlas","durable/web","release/1.8","atlas-mac",36,3],
["steward-pay","steward",null,"idle","Payments stewardship","acme-platform","beacon","payments/service","main","build-east",24,0],
["ledger","worker","steward-pay","waiting-approval","Reconcile settlement ledger","acme-platform","beacon","payments/service","feat/ledger-reconcile","build-east",9,0,188],
["webhook","worker","steward-pay","error","Repair webhook signature fixture","acme-platform","beacon","payments/service","fix/webhook-fixture","build-east",31,1],
["pci","reviewer","ledger","done","Review PCI boundary notes","acme-platform","beacon","payments/service","feat/ledger-reconcile","build-east",62,0],
["steward-notes","steward",null,"idle","Notes stewardship","side-projects","moss","garden/notes","main","mossbook",45,0],
["sync","worker","steward-notes","running","Make sync conflicts explainable","side-projects","moss","garden/notes","feat/conflict-copy","mossbook",7,1,74],
["mobile","chat",null,"waiting-followup","Sketch offline mobile navigation","side-projects","moss","garden/mobile","prototype/nav","mossbook",42,2],
["search-index","worker","steward-notes","done","Shrink local search index","side-projects","moss","garden/notes","perf/search-index","mossbook",210,0,71],
["backup","scout","steward-notes","interrupted","Compare encrypted backup targets","side-projects","moss","garden/infra","main","mossbook",130,0],
["steward-oss","steward",null,"idle","OSS maintenance stewardship","oss-maintenance","forge","open-source/cli","main","forge-linux",20,0],
["parser","worker","steward-oss","waiting-approval","Fix parser diagnostic spans","oss-maintenance","forge","open-source/cli","fix/diagnostic-spans","forge-linux",6,1,928],
["deps","worker","steward-oss","error","Untangle workspace dependency bump","oss-maintenance","forge","open-source/cli","chore/deps","forge-linux",28,0],
["docs","reviewer","parser","done","Review public API examples","oss-maintenance","forge","open-source/docs","main","forge-linux",89,0],
["triage","chat",null,"waiting-followup","Triage contributor reports","oss-maintenance","forge","open-source/cli","main","forge-linux",48,4],
["bench","scout","steward-oss","done","Benchmark cold-start regression","oss-maintenance","forge","open-source/cli","perf/cold-start","forge-linux",176,0],
["themes","worker","steward-notes","done","Normalize editor theme tokens","side-projects","moss","garden/mobile","feat/theme-tokens","mossbook",320,0],
["cache","worker","steward-platform","done","Document cache invalidation contract","acme-platform","atlas","durable/api","docs/cache-contract","atlas-mac",400,0],
["lint","reviewer","steward-pay","done","Check merchant lint rollout","acme-platform","beacon","payments/dashboard","main","build-east",500,0],
["roadmap","chat",null,"done","Summarize platform roadmap","acme-platform","atlas","durable/web","main","atlas-mac",760,0],
["cleanup","worker","steward-oss","done","Remove obsolete release script","oss-maintenance","forge","open-source/docs","chore/release-script","forge-linux",980,0],
["status","scout","steward-notes","done","Survey hosted status providers","side-projects","moss","garden/infra","main","mossbook",1100,0]
];
export const conversations=specs.map(([id,kind,parentId,status,title,org,agent,repo,branch,device,mins,unread,pr])=>({id,kind,parentId,status,title,org,agent,repo,branch,device,lastActivityAt:m(mins),startedAt:m(mins+20),unread,pr,cost:+(0.14+mins/500).toFixed(2),ci:pr?(status==="error"?"failing":"passing"):null, gate:["retry","ledger","parser"].includes(id)?{sha:id==="retry"?"9f3c2ab":id==="ledger"?"a18d02c":"bd7fe10",review:"approved",reasons:["Protected branch policy applies","Change affects a reviewed work item"]}:null,paused:agent==="moss",offline:device==="forge-linux"}));
export const byId=id=>conversations.find(c=>c.id===id);
export const fmtAgo=t=>{const n=Math.round((NOW-t)/60000);return n<1?"now":n<60?`${n}m`:n<1440?`${Math.round(n/60)}h`:`${Math.round(n/1440)}d`;};
export const transcriptFor=c=>c.id==="retry"?retryTranscript:[{role:"user",at:c.startedAt,text:`Please take care of **${c.title}** and keep the change focused.`},{role:"agent",at:c.startedAt+60000,text:"I found the relevant boundary and will make the smallest safe change."},{role:"tool",name:"read",arg:`${c.repo}/src`,result:"complete",at:c.startedAt+120000},{role:"agent",at:c.lastActivityAt-60000,text:"The implementation is ready for review.\n\n```ts\nconst result = await validate(input);\nreturn result;\n```"}];
export const nav=[['conversations','Conversations','message-square'],['new','New','square-pen'],['approvals','Approvals','shield-check'],['queue','Queue','layers'],['metrics','Metrics','activity'],['fleet','Fleet','server'],['orgs','Orgs','building'],['agents','Agents','bot'],['projects','Projects','git-branch'],['profiles','Profiles','users'],['routines','Routines','clock'],['workflows','Workflows','git-merge'],['admin','Admin','settings']];

// Shared page-worker fixtures, derived from the conversation list where possible.
export const projects=[...new Set(conversations.map(c=>c.repo))];
export const agentsList=[...new Set(conversations.map(c=>c.agent))].map(id=>({id,status:conversations.some(c=>c.agent===id&&c.status==='running')?'running':'idle',paused:id==='moss',device:conversations.find(c=>c.agent===id)?.device,budget:42}));
export const orgs=[...new Set(conversations.map(c=>c.org))].map(name=>({name,policy:'Protected changes',paused:false}));
export const devices=[...new Set(conversations.map(c=>c.device))].map((id,index)=>({id,status:index===3?'offline':'online',lastSeen:index===3?'47m':'now',version:'0.0.0'}));
export const approvals=conversations.filter(c=>c.gate).map(c=>({id:c.id,title:c.title,gate:c.gate,pr:c.pr}));
export const workItems=conversations.filter(c=>c.pr).map(c=>({id:c.id,title:c.title,outcome:c.status==='done'?'merged':c.status==='held'?'held':null,gate:c.gate?.review||'none',attempts:1,pr:c.pr,ci:c.ci}));
export const inbox=conversations.filter(c=>c.unread).map(c=>({id:c.id,text:`${c.title} needs attention`,read:false,at:c.lastActivityAt}));
export const metrics={merged:[0,1,2,1,3,2,3],spend:[2.1,3.4,1.2,5.6,4.4,3.9,4.82]};
export const connectors=[{id:'github',status:'ok'},{id:'linear',status:'ok'},{id:'slack',status:'degraded'}];
export const data={projects,agentsList,orgs,devices,approvals,workItems,inbox,metrics,connectors};
