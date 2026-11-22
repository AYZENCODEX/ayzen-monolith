const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const fs=require("fs"),path=require("path");
(async()=>{const b=await chromium.launch();const c=await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1.5});const p=await c.newPage();const errs=[];p.on("pageerror",e=>errs.push(e.message));
fs.mkdirSync("shots",{recursive:true});
for(const f of fs.readdirSync("out").filter(x=>x.endsWith(".html"))){await p.setViewportSize({width:1440,height:900});await p.goto("file://"+path.resolve("out",f));await p.evaluate(()=>document.fonts.ready);const h=await p.evaluate(()=>document.documentElement.scrollHeight);await p.setViewportSize({width:1440,height:Math.max(900,h)});await p.screenshot({path:"shots/"+f.replace(".html",".png"),fullPage:false});}
console.log("errs",errs);await b.close();})();
