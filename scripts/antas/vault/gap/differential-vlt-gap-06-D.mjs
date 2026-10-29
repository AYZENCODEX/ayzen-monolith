#!/usr/bin/env node
// VLT-GAP-06-D differential: the frozen pre-extraction routes/vault-reauth.ts (06-A baseline) vs the extracted
// thin route + vault/application/security/reauth.ts, both executed against the same mocked I/O (db, otp-store,
// email, WebAuthn, PEP). Every status code and JSON body, DB write, email and OTP side effect must be identical.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { ROOT, rejectBypass } from "./gap-common.mjs";
const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL — bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const SRC = ROOT + "/artifacts/api-server/src";
const BASE=fs.readFileSync(ROOT+"/reports/antas/vault/gap/VLT-GAP-06/baseline/sources/artifacts__api-server__src__routes__vault-reauth.ts","utf8");
Date.now=()=>1_700_000_000_000;
function makeRuntime(entryText, entryFile){
  const S={rows:{},updates:[],inserts:[],otps:{},sent:[],challenges:{},webauthnVerified:true,webauthnThrow:null,emailOk:true,opts:{}};
  const cache=new Map();
  const tbl=n=>new Proxy({__t:n},{get:(t,p)=>p==="__t"?n:{t:n,c:String(p)}});
  const T={usersTable:tbl("users"),vaultSecurityTable:tbl("vsec"),passkeyCredentialsTable:tbl("pk")};
  const q=()=>{let table=null;const o={from:t=>{table=t.__t;return o},where:()=>o,limit:()=>o,then:(r,j)=>Promise.resolve(S.rows[table]??[]).then(r,j)};return o};
  const mocks={
    "express":{Router:()=>{const r={routes:{}};for(const m of["get","post","put"])r[m]=(p,...h)=>{r.routes[m.toUpperCase()+" "+p]=h[h.length-1]};return r}},
    "@workspace/db":{...T,db:{select:()=>q(),update:t=>({set:v=>({where:()=>{S.updates.push([t.__t,v]);return Promise.resolve()}})}),insert:t=>({values:v=>{S.inserts.push([t.__t,v]);return Promise.resolve()}})}},
    "drizzle-orm":{eq:()=>null},
    "@simplewebauthn/server":{generateAuthenticationOptions:async o=>({challenge:"ch",allow:o.allowCredentials,rp:o.rpID}),verifyAuthenticationResponse:async()=>{if(S.webauthnThrow)throw new Error(S.webauthnThrow);return{verified:S.webauthnVerified,authenticationInfo:{newCounter:9}}}},
    "middlewares/auth":{requireAuth:1,getRequestUserId:r=>r.uid,pepDecisionObserver:()=>{}},
    "middlewares/security":{otpLimiter:1},
    "lib/password":{verifyPassword:async(v,h)=>h==="h:"+v},
    "lib/totp":{totpVerify:(c,s)=>c===s},
    "lib/passkey":{getWebAuthnConfig:()=>({rpID:"rp",origin:"o"}),newChallengeKey:()=>"ck",storeChallenge:(k,c)=>{S.challenges[k]={challenge:c}},consumeChallenge:k=>{const e=S.challenges[k];delete S.challenges[k];return e}},
    "zod/v4":(()=>{const z=new Proxy(function(){},{get:(t,p)=>p==="__esModule"?false:z,apply:()=>z});return z})(), // event-registry (now reachable through vault/ events) only needs a chainable schema builder
    "lib/otp-store":{generateOtp:()=>"123456",storeOtp:async(k,c)=>{S.otps[k]=c},verifyOtp:async(k,c)=>S.otps[k]===c},
    "lib/email":{sendEmail:async m=>{S.sent.push(m);return S.emailOk?{success:true}:{success:false,error:"smtp"}}},
    "lib/policy/policy-engine":{PolicyEngine:class{constructor(){}registerRule(){}}},
    "lib/policy/resource":{createResourceOwnershipRule:()=>({})},
    "lib/policy/pep":{authorize:async({req,resource})=>({decision:{effect:resource.ownerId===req.uid?"ALLOW":"DENY"}})},
  };
  const CHAIN=(()=>{const z=new Proxy(function(){},{get:(t,p)=>typeof p==="symbol"?(p===Symbol.toPrimitive?()=>"":undefined):p==="__esModule"?false:p==="then"?undefined:z,apply:()=>z,construct:()=>z});return z})();
  const find=(spec,from)=>{ if(!spec.startsWith(".")) return {mock:mocks[spec]??(/^(node:)?(path|fs|crypto|url|util|os|events|buffer|stream|zlib)$/.test(spec)?createRequire(import.meta.url)(spec):CHAIN)}; // bare third-party imports reached via vault/ event code (zod, pino, ...) are inert here
    const abs=path.resolve(path.dirname(from),spec); const rel=path.relative(SRC,abs);
    for(const k of Object.keys(mocks)) if(rel===k) return {mock:mocks[k]};
    for(const ext of[".ts","/index.ts"]) if(fs.existsSync(abs+ext)) return {file:abs+ext};
    throw new Error("unresolved "+spec+" from "+from)};
  function load(file,text){ if(cache.has(file))return cache.get(file).exports;
    const code=ts.transpileModule(text??fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const m={exports:{}};cache.set(file,m);
    const req=s=>{const r=find(s,file);if(r.mock){if(!r.mock)throw new Error("no mock "+s);return r.mock}return load(r.file)};
    new Function("require","module","exports","__filename",code)(req,m,m.exports,file);return m.exports}
  const router=load(entryFile,entryText).default; return {S,router};
}
const NEWFILE=SRC+"/routes/vault-reauth.ts";
const scenarios=[]; const add=(name,setup,calls)=>scenarios.push({name,setup,calls});
const SEC={vaultPinHash:"h:1234",vaultPasswordHash:null,vaultTwoFaEnabled:true,vaultTwoFaSecret:"654321",authStepPolicy:"step12"};
const U=[{id:1,email:"a@b.c"}];
const PK=[{id:5,userId:1,credentialId:"cid",publicKey:Buffer.from("k").toString("base64url"),counter:2,transports:"usb,nfc"}];
const call=(route,body,uid=1)=>({route,body,uid});
add("status none",S=>{S.rows={}},[call("GET /vault/reauth/status",{})]);
add("status full",S=>{S.rows={vsec:[SEC],pk:PK}},[call("GET /vault/reauth/status",{})]);
add("status pw only",S=>{S.rows={vsec:[{...SEC,vaultPinHash:null,vaultPasswordHash:"h:pw",authStepPolicy:null}]}},[call("GET /vault/reauth/status",{})]);
add("no session",S=>{},["GET /vault/reauth/status","POST /vault/reauth/verify","POST /vault/reauth/verify-step3","POST /vault/reauth/passkey/options","POST /vault/reauth/passkey/verify","POST /vault/reauth/email-code/send"].map(r=>call(r,{},0)));
add("email send ok",S=>{S.rows={users:U,vsec:[SEC]}},[call("POST /vault/reauth/email-code/send",{})]);
add("email send no pin",S=>{S.rows={users:U,vsec:[{...SEC,vaultPinHash:null}]}},[call("POST /vault/reauth/email-code/send",{})]);
add("email send no user",S=>{S.rows={users:[],vsec:[SEC]}},[call("POST /vault/reauth/email-code/send",{})]);
add("email send fail",S=>{S.rows={users:U,vsec:[SEC]};S.emailOk=false},[call("POST /vault/reauth/email-code/send",{})]);
add("step3 flow",S=>{S.rows={users:U,vsec:[SEC]}},[call("POST /vault/reauth/email-code/send",{}),call("POST /vault/reauth/verify-step3",{}),call("POST /vault/reauth/verify-step3",{pin:""}),call("POST /vault/reauth/verify-step3",{pin:"0000",emailCode:"123456"}),call("POST /vault/reauth/verify-step3",{pin:"1234"}),call("POST /vault/reauth/verify-step3",{pin:"1234",emailCode:"bad"}),call("POST /vault/reauth/verify-step3",{pin:"1234",emailCode:"123456"})]);
add("step3 no pin",S=>{S.rows={vsec:[]}},[call("POST /vault/reauth/verify-step3",{pin:"1"})]);
add("step3 lockout",S=>{S.rows={vsec:[SEC]}},[...Array(6)].map(()=>call("POST /vault/reauth/verify-step3",{pin:"x"})).concat([call("POST /vault/reauth/verify",{pin:"1234",totpCode:"654321"}),call("POST /vault/reauth/passkey/options",{}),call("POST /vault/reauth/passkey/verify",{})]));
add("verify matrix",S=>{S.rows={users:U,vsec:[SEC]}},[call("POST /vault/reauth/verify",undefined),call("POST /vault/reauth/verify",{}),call("POST /vault/reauth/verify",{pin:"9"}),call("POST /vault/reauth/verify",{pin:"1234"}),call("POST /vault/reauth/verify",{pin:"1234",totpCode:" "}),call("POST /vault/reauth/verify",{pin:"1234",totpCode:"000000"}),call("POST /vault/reauth/verify",{pin:"1234",totpCode:"654321"})]);
add("verify pw",S=>{S.rows={users:U,vsec:[{...SEC,vaultPinHash:null,vaultPasswordHash:"h:pw"}]}},[call("POST /vault/reauth/verify",{}),call("POST /vault/reauth/verify",{password:"no"}),call("POST /vault/reauth/verify",{password:"pw",totpCode:"654321"})]);
add("verify no cred",S=>{S.rows={users:U,vsec:[{...SEC,vaultPinHash:null}]}},[call("POST /vault/reauth/verify",{pin:"1"})]);
add("verify no 2fa",S=>{S.rows={users:U,vsec:[{...SEC,vaultTwoFaEnabled:false}]}},[call("POST /vault/reauth/verify",{pin:"1234"})]);
add("verify no user",S=>{S.rows={users:[],vsec:[SEC]}},[call("POST /vault/reauth/verify",{pin:"1234"})]);
add("verify lockout",S=>{S.rows={users:U,vsec:[SEC]}},[...Array(6)].map(()=>call("POST /vault/reauth/verify",{pin:"bad"})));
add("passkey options none",S=>{S.rows={pk:[]}},[call("POST /vault/reauth/passkey/options",{})]);
add("passkey options",S=>{S.rows={pk:PK}},[call("POST /vault/reauth/passkey/options",{})]);
const o=(extra)=>call("POST /vault/reauth/passkey/options",{}); 
add("passkey verify matrix",S=>{S.rows={pk:PK};S.challenges={ck:{challenge:"ch"}}},[call("POST /vault/reauth/passkey/verify",{}),call("POST /vault/reauth/passkey/verify",{challengeKey:"zz",response:{}}),call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{}}),]);
add("passkey verify ok",S=>{S.rows={pk:PK};S.challenges={ck:{challenge:"ch"}}},[call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{id:"cid"}})]);
add("passkey not verified",S=>{S.rows={pk:PK};S.challenges={ck:{challenge:"ch"}};S.webauthnVerified=false},[call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{id:"cid"}})]);
add("passkey throws",S=>{S.rows={pk:PK};S.challenges={ck:{challenge:"ch"}};S.webauthnThrow="boom"},[call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{id:"cid"}})]);
add("passkey other owner",S=>{S.rows={pk:[{...PK[0],userId:2}]};S.challenges={ck:{challenge:"ch"}}},[call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{id:"cid"}})]);
add("passkey missing",S=>{S.rows={pk:[]};S.challenges={ck:{challenge:"ch"}}},[call("POST /vault/reauth/passkey/verify",{challengeKey:"ck",response:{id:"cid"}})]);
async function run(entryText){ const out=[];
  for(const sc of scenarios){ const {S,router}=makeRuntime(entryText,NEWFILE); sc.setup(S); const log=[];
    for(const c of sc.calls){ const h=router.routes[c.route]; if(!h){log.push([c.route,"NO ROUTE"]);continue}
      let st=200,body; const res={status(n){st=n;return res},json(b){body=b;return res}};
      try{await h({uid:c.uid,body:c.body},res)}catch(e){body="THROW:"+e.message}
      log.push([c.route,st,JSON.parse(JSON.stringify(body??null))]); }
    log.push(["side",JSON.parse(JSON.stringify(S.updates).replace(/"lastUsedAt":"[^"]*"/g,"\"lastUsedAt\":\"T\"")),S.sent.map(m=>[m.to,m.subject,m.html,m.text]),S.otps,Object.keys(S.challenges)]); out.push([sc.name,log]); }
  return out; }
const _main=(async()=>{ const a=await run(BASE), b=await run(fs.readFileSync(NEWFILE,"utf8"));
  let bad=0,calls=0; for(let i=0;i<a.length;i++){ calls+=a[i][1].length-1; try{assert.deepStrictEqual(b[i],a[i])}catch(e){bad++;console.log("DIFF in",a[i][0]);console.log(JSON.stringify(a[i][1]).slice(0,600));console.log(JSON.stringify(b[i][1]).slice(0,600))}}
  console.log(`scenarios=${a.length} calls=${calls} diffs=${bad}`); process.exit(bad?1:0)})().catch(e=>{console.error(e);process.exit(1)});
