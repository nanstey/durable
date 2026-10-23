import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedProfile } from "./profiles.ts";
const dirs=["auth-profiles","secrets","profile-meta","extensions","skills","agents","prompts","npm","vendor"];
export function createDerivedPiDir(target: string, source: string, profile: ResolvedProfile): void { mkdirSync(target,{recursive:true}); writeFileSync(join(target,"settings.json"),"{}\n"); writeFileSync(join(target,"auth-profiles.json"),JSON.stringify({defaultProfile:profile.name})+"\n"); for(const d of dirs){const to=join(target,d); if(!existsSync(to)) symlinkSync(join(source,d),to,"dir");} }
export function derivedAuthSafe(dir: string): boolean { const path=join(dir,"auth.json"); if(!existsSync(path)) return true; if(lstatSync(path).isSymbolicLink()) return false; try { return JSON.stringify(JSON.parse(readFileSync(path,"utf8"))) === "{}"; } catch { return false; } }
