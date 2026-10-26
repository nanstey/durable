const at=(n)=>Date.now()-n*60000;
const rich=(title)=>[
 {type:'date',label:'Today'},
 {type:'user',at:at(44),text:`Please take care of **${title}**. Keep the change focused and show me the verification.`},
 {type:'notice',kind:'pr',at:at(43),text:'Work item linked · branch protected'},
 {type:'agent',at:at(42),text:'## Plan\n\nI will inspect the boundary, make the smallest change, then verify it.\n\n- Read the existing policy\n- Update the retry calculation\n- Run the focused test\n\n| Scope | Result |\n| --- | --- |\n| API | unchanged |\n| Retry | jittered |\n\nSee [retry guidance](https://example.test/retries).'},
 {type:'thinking',at:at(41),text:'The policy already accepts a ceiling. The least invasive path is to randomize inside that ceiling and retain the existing validation.'},
 {type:'tools',at:at(39),items:[{name:'read',arg:'src/retry.ts',status:'ok',output:'export function backoff(delay, ceiling) { … }'},{name:'grep',arg:'backoff(',status:'ok',output:'test/retry.test.ts:24\nsrc/retry.ts:8'},{name:'web fetch',arg:'https://example.test/retries',status:'ok',output:'200 · Retry safety reference'}]},
 {type:'steer',at:at(36),text:'Please avoid changing the public configuration shape.'},
 {type:'agent',at:at(35),text:'Understood — the configuration contract remains unchanged.\n\n```ts\n// retry.ts\nreturn Math.random() * ceiling;\n```'},
 {type:'tools',at:at(32),items:[{name:'edit',arg:'src/retry.ts',status:'ok',output:'Applied 1 edit'},{name:'bash',arg:'node --test test/retry.test.ts',status:'ok',output:'✓ jitter stays within ceiling\n✓ zero ceiling remains zero'}]},
 {type:'diff',at:at(30),files:'src/retry.ts, test/retry.test.ts',plus:12,minus:3},
 {type:'tests',at:at(29),passed:18,failed:0},
 {type:'subagent',at:at(27),role:'scout',status:'finished',child:'conversation/a11y',text:'Scout finished an accessibility pass'},
 {type:'attachment',at:at(25),name:'retry-flow.png',text:'Attachment · 1280 × 720'},
 {type:'citation',at:at(24),text:'[1] Retry safety reference · example.test'},
 {type:'budget',at:at(20),text:'Budget watch: 82% of this conversation allocation used.'},
 {type:'approval',at:at(16),pr:412,sha:'9f3c2ab',ci:'passing',verdict:'approved'},
 {type:'notice',kind:'ci',at:at(12),text:'CI status changed: all required checks passed'},
 {type:'queued',at:at(8),text:'Queued follow-up: “Also update the changelog after approval.”'},
 {type:'agent',at:at(2),text:'## Ready for approval\n\nChanged the retry calculation without altering configuration. Focused tests pass.'},
 {type:'stream',at:at(0),text:'Preparing a concise handoff'}
];
export const transcripts={retry:rich('Add jittered retry policy'),tokens:rich('Expose token budget in header'),sync:rich('Make sync conflicts explainable')};
export function transcriptForConversation(c){return transcripts[c.id]||[{type:'user',at:c.startedAt,text:`Please take care of **${c.title}**.`},{type:'agent',at:c.lastActivityAt,text:'I found the relevant boundary and will make the smallest safe change.'},{type:'tools',at:c.lastActivityAt,items:[{name:'read',arg:`${c.repo}/src`,status:'running',output:'Reading…'}]}]}
