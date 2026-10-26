export const organizations=[
 {id:'acme-platform',name:'Acme Platform',initials:'AP',budget:800,budgetCap:1000,policy:'Two approvers for protected changes',approvers:['Avery Chen','Mira Shah'],members:18,connectors:['GitHub','Slack','Linear'],health:'Healthy',audit:'Policy updated by Avery · 18m ago'},
 {id:'side-projects',name:'Side Projects',initials:'SP',budget:236,budgetCap:300,policy:'Owner approval for releases',approvers:['Noor Patel'],members:4,connectors:['GitHub','Slack'],health:'Over budget',audit:'Budget cap reached · 42m ago'},
 {id:'oss-maintenance',name:'OSS Maintenance',initials:'OM',budget:120,budgetCap:500,policy:'Passkey approver for publish',approvers:['Drew Wilson','Kai Lin'],members:11,connectors:['GitHub','Slack','Sentry'],health:'Paused',audit:'Organization paused by Drew · 2h ago',paused:true}
];
export const auditEvents=['Budget cap changed from $750 to $1,000','Passkey verified for Mira Shah','GitHub connector scopes reviewed','Approval policy updated for protected branches'];
