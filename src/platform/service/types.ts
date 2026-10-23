export type ServiceStatus = { active: boolean; text: string };
export interface ServiceManager { install(agent:string): Promise<void>; enable(agent:string): Promise<void>; disable(agent:string): Promise<void>; start(agent:string): Promise<void>; stop(agent:string): Promise<void>; status(agent:string): Promise<ServiceStatus>; logs(agent:string): AsyncIterable<string>; }
