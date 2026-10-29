process.env.NODE_ENV="production"; import "express-async-errors"; import express from "express";
const cases=[["mine enrolled-entities", "/projects/mine/enrolled-entities", {"x-user":"7"}, null],["unauth","/projects/mine/enrolled-entities",{},null],["db failure","/projects/mine/enrolled-entities",{"x-user":"7"},"projects"]];
async function run(file){ const mod=await import(file); const app=express(); app.use(mod.default); const srv=await new Promise(r=>{const s=app.listen(0,()=>r(s));}); const port=srv.address().port; const out=[];
  for(const [n,url,h,fail] of cases){ const st=mod.state; st.rows={projects:[]}; st.sqlLog.length=0; st.failTable=fail; st.rawMode="camel"; const r=await fetch(`http://127.0.0.1:${port}${url}`,{headers:h}); out.push({n,status:r.status,body:await r.text(),sql:JSON.stringify(st.sqlLog)}); } srv.close(); return out; }
const a=await run(process.cwd()+"/sold.mjs"), b=await run(process.cwd()+"/snew.mjs"); let d=0;
a.forEach((x,i)=>{ if(JSON.stringify(x)!==JSON.stringify(b[i])){d++;console.log("DIFF",x.n,x.body.slice(0,200),"|",b[i].body.slice(0,200));} });
console.log(`mine/enrolled-entities (unshadowed): ${a.length} scenarios, ${a.length-d} identical, ${d} different`); console.log("sample body:", a[0].body.slice(0,260));
process.exit(d?1:0);
