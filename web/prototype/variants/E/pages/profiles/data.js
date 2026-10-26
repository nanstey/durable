export const profiles=[
 {id:'release-steward',name:'Release steward',role:'steward',model:'Claude Sonnet 4.5',thinking:'High',projects:['durable/web','durable/api'],org:'acme-platform',tools:['read','search','git status','github'],skills:['release-notes','risk-review'],budget:'$18 / run',approval:'Protected changes',version:'v12 · today',prompt:'Own release readiness. Coordinate workers, stop for protected changes, and report the smallest actionable next step.'},
 {id:'issue-scout',name:'Issue scout',role:'scout',model:'Claude Haiku 4.5',thinking:'Low',projects:['durable/web'],org:'acme-platform',tools:['read','search','github'],skills:['triage'],budget:'$4 / run',approval:'Never merge',version:'v7 · Oct 20',prompt:'Investigate incoming reports, reproduce when possible, and return scoped evidence without changing source.'},
 {id:'patch-worker',name:'Patch worker',role:'worker',model:'Claude Sonnet 4.5',thinking:'Medium',projects:['open-source/cli','open-source/docs'],org:'oss-maintenance',tools:['read','write','test','git diff'],skills:['build','verification'],budget:'$12 / run',approval:'PR required',version:'v19 · Oct 18',prompt:'Implement focused patches. Run relevant checks, explain risks, and never expand the requested scope.'}
];
export const presets=[
 {name:'Safe scout',role:'scout',copy:'Read-only investigation with a lean budget.',icon:'⌕'},
 {name:'PR worker',role:'worker',copy:'Focused implementation with review gates.',icon:'↗'},
 {name:'Policy reviewer',role:'reviewer',copy:'Change review with no write grant.',icon:'✓'}
];
export const versions=[['v12','Today, 09:42','Budget cap raised from $15'],['v11','Oct 21','Added protected-change approval'],['v10','Oct 18','Initial production template']];
