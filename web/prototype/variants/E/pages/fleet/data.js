import { agentsList, devices, orgs } from '../../data.js';

export const fleetDevices=devices.map((device,index)=>({
 ...device,
 region:['us-east-1','eu-west-1','home-lab','ap-southeast-2'][index],
 cpu:[34,61,18,0][index], memory:[48,72,37,0][index],
 heartbeat:['now','18s ago','now','47m ago'][index],
 capabilities:[['GitHub','Shell','Passkey'],['GitHub','Docker','Browser'],['Shell','Files'],['GitHub']][index],
 alerts:index===1?1:index===3?2:0
}));
export const fleetAgents=agentsList.map((agent,index)=>({
 ...agent, device:fleetDevices[index]?.id||agent.device, version:`1.8.${4-index}`,
 budget:[42,76,18,0][index], work:index===0?'3 active runs':index===1?'Paused by policy':index===2?'1 active run':'Unavailable',
 daemon:index===3?'offline':'healthy', org:['acme-platform','acme-platform','side-projects','oss-maintenance'][index], lastLog:['heartbeat accepted','approval gate passed','sync checkpoint saved','connection timed out'][index]
}));
export const fleetOrgs=orgs.map((org,index)=>({...org, agents:index===0?2:1, spend:[18.4,6.2,2.1][index], limit:[40,12,8][index]}));
export const activity=[
 ['atlas','Update staged','Remote update 1.8.4 ready'],['build-east','Budget watch','76% daily agent budget'],['forge-linux','Heartbeat missed','No daemon response for 47m'],['mossbook','Capability changed','Browser access removed']
];
