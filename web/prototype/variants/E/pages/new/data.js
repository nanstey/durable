import { projects, agentsList } from '../../data.js';

export const agentChoices = agentsList.map(agent => ({
  ...agent,
  org: agent.id === 'beacon' ? 'acme-platform' : agent.id === 'forge' ? 'oss-maintenance' : 'side-projects',
  reason: agent.paused ? 'Paused by its operator' : agent.device === 'forge-linux' ? 'Device is offline' : null
}));
export const projectChoices = projects.map((repo, index) => ({
  repo,
  branch: index % 2 ? 'feat/retry-jitter' : 'main'
}));
