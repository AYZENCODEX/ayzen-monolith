/**
 * login-adapters.mjs — connects a DESIGNED module login page to the real module backend without touching the design file.
 *
 * The designs (landings/<id>/login.html) were drawn against the central AYZEN auth API (/api/auth/login, send-otp, register,
 * step-up/verify, forgot/reset-password). On a module host those calls must reach the module's own routes
 * (/api/auth/module/v2/*), which have different shapes. The adapter below is a small `fetch` wrapper, injected next to the
 * design's own prelude, that translates exactly those calls and nothing else. The design's screens, copy and flow stay as drawn.
 *
 * NODE ONLY (string builder). Exported source is plain ES5 so it runs in any browser the design runs in.
 */

const FYRA = String.raw`(function(){
var F=window.fetch,B="/api/auth/module/v2",st={ch:null,mode:null,email:""};
function J(status,body){return new Response(JSON.stringify(body),{status:status,headers:{"Content-Type":"application/json"}})}
function post(p,b){return F.call(window,B+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,status:r.status,d:d||{}}})})}
function msg(r){return r.d.solution||(r.d.code==="INVALID_CREDENTIALS"?"Invalid email or password.":r.d.error)||"Something went wrong. Try again."}
function user(d,email){var a=d.account||{};return{username:(email||"").split("@")[0],email:email,moduleUid:a.moduleUid,module:a.module}}
window.fetch=function(u,i){
 if(typeof u!=="string"||u.indexOf("/api/auth/")!==0||u.indexOf(B)===0||u.indexOf("/api/auth/module/")===0||!i||!i.body)return F.apply(this,arguments);
 var p=u.slice("/api/auth".length),b;try{b=JSON.parse(i.body)}catch(e){return F.apply(this,arguments)}
 if(p==="/login"){st.email=b.email;st.mode="login";
  return post("/login",{email:b.email,password:b.password,requireCode:true}).then(function(r){
   if(!r.ok)return J(r.status===0?0:401,{error:msg(r)});
   if(r.d.stepUp){st.ch=r.d.stepUp.challenge;var t=r.d.stepUp.methods.indexOf("totp")>=0;
    return J(200,{requiresStepUp:true,challengeToken:st.ch,requiredMethods:[t?"totp":"email_otp"],completedMethods:[]})}
   return J(200,{token:r.d.token,user:user(r.d,b.email)})})}
 if(p==="/login/step-up/verify"){
  return post("/login/verify",{challenge:b.challengeToken,code:b.code}).then(function(r){
   if(r.ok)return J(200,{verified:true,token:r.d.token,user:user(r.d,st.email)});
   return J(r.status===429?429:400,{error:msg(r)})})}
 if(p==="/send-otp"){
  if(st.mode==="login"&&st.ch)return post("/login/email-code",{challenge:st.ch}).then(function(r){return J(r.ok?200:r.status,r.ok?{sent:true}:{error:msg(r)})});
  st.mode="signup";st.email=b.email;
  return post("/signup/start",{email:b.email}).then(function(r){return J(r.ok?200:r.status,r.ok?{sent:true}:{error:msg(r)})})}
 if(p==="/register"){
  return post("/signup/complete",{email:b.email,code:b.emailOtp,password:b.password,username:b.username}).then(function(r){
   if(r.ok)return J(200,{token:r.d.token,user:{username:b.username,email:b.email,moduleUid:(r.d.account||{}).moduleUid}});
   return J(r.status,{error:msg(r)})})}
 if(p==="/forgot-password"){st.mode="reset";return post("/reset/request",{email:b.email}).then(function(){return J(200,{message:"ok"})})}
 if(p==="/reset-password"){
  return post("/reset/confirm",{email:b.email,code:b.code,password:b.newPassword}).then(function(r){return J(r.ok?200:r.status,r.ok?{message:"ok"}:{error:msg(r)})})}
 return F.apply(this,arguments)};
})();`;

const ADAPTERS = { fyra: FYRA };
export const hasLoginAdapter = (id) => Object.prototype.hasOwnProperty.call(ADAPTERS, id);
/** Script source for a design's adapter, or "" when the design talks to the module API natively. */
export const loginAdapterScript = (id) => (hasLoginAdapter(id) ? ADAPTERS[id] : "");
export const loginAdapterIds = () => Object.keys(ADAPTERS);
