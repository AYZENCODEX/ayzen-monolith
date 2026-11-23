const { chromium } = require("/opt/npm-tools/node_modules/playwright");const fs=require("fs"),path=require("path");
(async()=>{const b=await chromium.launch();const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});const p=await c.newPage();fs.mkdirSync("shots/mobile",{recursive:true});
for(const n of process.argv.slice(2)){await p.goto("file://"+path.resolve("out",n+".html"));await p.evaluate(()=>document.fonts.ready);const ov=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);await p.screenshot({path:"shots/mobile/"+n+".png",fullPage:false});console.log(n,"hscroll",ov);}
await b.close();})();
