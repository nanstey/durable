// Spike (throwaway): one API-key provider request (TypeSafe classifier; key from TYPESAFE_API_KEY env).
import { createModels } from "@earendil-works/pi-ai/models";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
const models = createModels();
models.setProvider(typesafeProvider());
const m = models.getModelOfType("classifier", "typesafe", "jev-latest")!;
console.log("auth:", JSON.stringify(await models.checkAuth("typesafe")));
const t0 = Date.now();
const r: any = await models.classify(m, { state: { message: "please rebase my branch onto main" }, questions: { creds: { type: "bool", instructions: "Does the message contain a credential or secret?", criteria: { true: "contains a token, key or password", false: "ordinary text" } } } } as any);
console.log(JSON.stringify({ ms: Date.now() - t0, result: r }).slice(0, 300));
