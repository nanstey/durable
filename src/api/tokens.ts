import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path"; import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { durableHome } from "../config/paths.ts";
export type Scope="read"|"chat"|"pause"; export type TokenRecord={hash:string;client:string;scopes:Scope[];createdAt:number;lastUsedAt?:number;expiresAt?:number};
const file=(agent:string)=>join(durableHome(),"agents",agent,"tokens.json"); const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function load(agent:string):TokenRecord[]{try{return JSON.parse(readFileSync(file(agent),"utf8")) as TokenRecord[]}catch{return [];}}
function save(agent:string,x:TokenRecord[]){mkdirSync(join(durableHome(),"agents",agent),{recursive:true,mode:0o700});writeFileSync(file(agent),JSON.stringify(x)+"\n",{mode:0o600});chmodSync(file(agent),0o600);}
export function createToken(agent:string,client:string,scopes:Scope[],expiresDays?:number){if(!client||scopes.length===0||scopes.some(s=>!(["read","chat","pause"] as string[]).includes(s)))throw new Error("invalid token client or scopes");const token=`dur_${randomBytes(32).toString("base64url")}`;const r:TokenRecord={hash:hash(token),client,scopes,createdAt:Date.now(),expiresAt:expiresDays?Date.now()+expiresDays*86400000:undefined};save(agent,[...load(agent),r]);return token;}
export function authorize(agent:string, token:string|undefined, scope:Scope):TokenRecord|undefined {if(!token)return;const h=hash(token);const now=Date.now();const records=load(agent);const r=records.find(x=>{const a=Buffer.from(x.hash),b=Buffer.from(h);return a.length===b.length&&timingSafeEqual(a,b);}); const valid=r&&(!r.expiresAt||r.expiresAt>now)&&r.scopes.includes(scope);if(valid){r.lastUsedAt=now;save(agent,records);return r;} }
export function revokeToken(agent:string, client:string){save(agent,load(agent).filter(x=>x.client!==client));}
export function tokenFileExists(agent:string){return existsSync(file(agent));}
