/* AutoLandscape account UI addon.  Scientific task, AI and R2 UI remain in app.js. */
"use strict";
const ACC = {
  mode: 'legacy', admin: false, widgets: {}, challenges: {}, reviewId: null,
  lastHeartbeat: 0, loadedTurnstile: false,
};
function accountError(err) { notify(err?.message || '操作失败，请稍后再试', true); }
function accountPanel(which) {
  const loginBox=document.querySelector('.login-box');
  if(loginBox)loginBox.hidden=which!=='login';
  for (const [key,id] of [
    ['login','account-login-form'],['register','account-register-panel'],
    ['forgot','account-forgot-panel'],['resend','account-resend-panel'],['link','account-link-panel']
  ]) $(id).hidden = key !== which;
  if(which==='login') $('account-username').focus();
  if(['login','register','forgot','resend'].includes(which)) accountRenderTS(which);
}
async function accountPublic(path,data) {
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),45000);
  try {
    const r=await fetch(cfg.apiBase+path,{method:'POST',cache:'no-store',credentials:'omit',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:ctl.signal});
    const b=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(b?.error?.message||`HTTP ${r.status}`);
    return b;
  }finally{clearTimeout(timer);}
}
function accountTakeTS(name) {
  const t=ACC.challenges[name]||'';
  if(!t)throw Error('请完成人机验证。若组件没有显示，请检查 Turnstile Site Key。');
  return t;
}
function accountResetTS(name) {
  ACC.challenges[name]='';
  if(window.turnstile&&ACC.widgets[name]!==undefined){
    try{window.turnstile.reset(ACC.widgets[name]);}catch{}
  }
}
function accountRenderTS(name) {
  if(!window.turnstile||!cfg.turnstileSiteKey||cfg.turnstileSiteKey.startsWith('PASTE_'))return;
  if(ACC.widgets[name]!==undefined)return;
  const host=$('ts-'+name);
  if(!host)return;
  ACC.widgets[name]=window.turnstile.render(host,{
    sitekey:cfg.turnstileSiteKey,action:name,
    callback:(v)=>{ACC.challenges[name]=v;},
    'expired-callback':()=>{ACC.challenges[name]='';},
    'error-callback':()=>{ACC.challenges[name]='';}
  });
}
function accountLoadTS(){
  if(window.turnstile){ACC.loadedTurnstile=true;accountRenderTS('login');return;}
  if(ACC.loadedTurnstile)return;ACC.loadedTurnstile=true;
  const s=document.createElement('script');
  s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async=true;
  s.onload=()=>{for(const name of ['login','register','forgot','resend']) {
    const panel=$(name==='login'?'account-login-form':'account-'+name+'-panel');
    if(panel&&!panel.hidden)accountRenderTS(name);
  } if($('account-settings-dialog').open&&ACC.mode!=='session')accountRenderTS('claim');};
  s.onerror=()=>notify('Turnstile 加载失败，请检查网络或浏览器扩展',true);
  document.head.appendChild(s);
}
function accountFormData(form){return Object.fromEntries(new FormData(form).entries());}
function accountBusy(form,busy){
  const b=form.querySelector('button[type="submit"]');if(b)b.disabled=busy;
}
$('show-register').onclick=()=>accountPanel('register');
$('show-forgot').onclick=()=>accountPanel('forgot');
$('show-resend').onclick=()=>accountPanel('resend');
$('register-back').onclick=()=>accountPanel('login');
$('forgot-back').onclick=()=>accountPanel('login');
$('resend-back').onclick=()=>accountPanel('login');
$('account-link-back').onclick=()=>{history.replaceState(null,'',location.pathname);accountPanel('login');};
$('login').onclick=async()=>{
  const btn=$('login');if(btn.disabled)return;btn.disabled=true;
  try{
    const b=await accountPublic('/v1/auth/login',{
      username:$('account-username').value.trim(),password:$('account-password').value,
      turnstile_token:accountTakeTS('login')
    });
    $('account-password').value='';
    await loginSession({token:b.session_token,lastActivity:Date.now(),chat:[],draftMode:false});
  }catch(e){accountError(e);}finally{btn.disabled=false;accountResetTS('login');}
};
$('account-password').addEventListener('keydown',e=>{if(e.key==='Enter'){$('login').click();}});
$('legacy-login').onclick=()=>{
  const old=$('token').value.trim();
  if(!old)return notify('请输入旧个人访问令牌',true);
  loginSession({token:old,lastActivity:Date.now(),chat:[],draftMode:false});
};
$('account-register-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;accountBusy(form,true);
  try{
    const b=accountFormData(form);
    if(b.password!==b.confirm_password)throw Error('两次输入的密码不一致');
    if(b.consent!=='on')throw Error('请先同意申请信息使用说明');
    delete b.confirm_password;delete b.consent;
    b.turnstile_token=accountTakeTS('register');
    const r=await accountPublic('/v1/auth/register',b);
    form.reset();accountPanel('login');notify(r.message||'申请已提交，请查收邮箱。');
  }catch(err){accountError(err);}finally{accountBusy(form,false);accountResetTS('register');}
};
$('account-resend-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;accountBusy(form,true);
  try{
    const b=accountFormData(form);
    b.turnstile_token=accountTakeTS('resend');
    const r=await accountPublic('/v1/auth/verification/resend',b);
    form.reset();accountPanel('login');notify(r.message);
  }catch(err){accountError(err);}finally{accountBusy(form,false);accountResetTS('resend');}
};
$('account-forgot-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;accountBusy(form,true);
  try{
    const b=accountFormData(form);
    b.turnstile_token=accountTakeTS('forgot');
    const r=await accountPublic('/v1/auth/password/forgot',b);
    form.reset();accountPanel('login');notify(r.message);
  }catch(err){accountError(err);}finally{accountBusy(form,false);accountResetTS('forgot');}
};
const linkURL=new URL(location.href);
const linkParams=new URLSearchParams(linkURL.hash.slice(1));
for(const [k,v] of linkURL.searchParams)if(!linkParams.has(k))linkParams.set(k,v);
if(linkParams.has('verify')||linkParams.has('reset')){
  const isReset=linkParams.has('reset');
  $('account-link-title').textContent=isReset?'重置密码':'确认邮箱';
  $('account-link-note').textContent=isReset?'填写新密码后点击确认。':'验证邮箱后，注册申请仍需要管理员审核；旧账号认领则在验证后生效。';
  $('account-link-reset').hidden=!isReset;
  $('account-link-confirm').textContent=isReset?'确认重置密码':'确认验证邮箱';
  accountPanel('link');
}
$('account-link-confirm').onclick=async()=>{
  const button=$('account-link-confirm');button.disabled=true;
  try{
    const r=linkParams.has('reset')
      ? await (async()=>{
        const p=$('reset-new-password').value;
        if(p!==$('reset-confirm-password').value)throw Error('两次密码不一致');
        return accountPublic('/v1/auth/password/reset',{token:linkParams.get('reset'),new_password:p});
      })()
      : await accountPublic('/v1/auth/verify-email',{token:linkParams.get('verify')});
    history.replaceState(null,'',location.pathname);
    accountPanel('login');notify(r.message||'操作成功');
  }catch(e){accountError(e);}finally{button.disabled=false;}
};
$('account-manage').onclick=()=>{
  $('user-menu').open=false;
  $('account-change-wrap').hidden=ACC.mode!=='session';
  $('account-claim-wrap').hidden=ACC.mode==='session';
  $('account-settings-dialog').showModal();
  if(ACC.mode!=='session')accountRenderTS('claim');
};
$('account-settings-close').onclick=()=>$('account-settings-dialog').close();
$('account-change-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;accountBusy(form,true);
  try{
    const b=accountFormData(form);
    if(b.new_password!==b.confirm_password)throw Error('两次输入的新密码不一致');
    const r=await call('/v1/auth/password/change','POST',{
      current_password:b.current_password,new_password:b.new_password
    });
    form.reset();$('account-settings-dialog').close();
    notify(r.message||'密码修改成功，请重新登录');
    $('logout').click();
  }catch(err){accountError(err);}finally{accountBusy(form,false);}
};
$('account-claim-form').onsubmit=async e=>{
  e.preventDefault();const form=e.currentTarget;accountBusy(form,true);
  try{
    const b=accountFormData(form);
    b.turnstile_token=accountTakeTS('claim');
    const r=await call('/v1/auth/legacy-claim','POST',b);
    form.reset();$('account-settings-dialog').close();notify(r.message);
  }catch(err){accountError(err);}finally{accountBusy(form,false);accountResetTS('claim');}
};
let activeApplication=null;
async function accountShowReview(id,decision=''){
  if(!ACC.admin)throw Error('只有已验证的管理员账号能够审核申请');
  const r=await call('/v1/admin/applications/'+encodeURIComponent(id));
  const a=r.application;activeApplication=a;
  const dl=$('account-review-fields');dl.replaceChildren();
  for(const [label,value] of Object.entries({
    '申请编号':a.id,'状态':a.status,'用户名':a.username,'姓名':a.display_name,
    '邮箱':a.email,'单位':a.institution,'职务':a.position_title,
    '研究方向':a.research_area,'注册用途':a.use_case
  })){
    const dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=label;dd.textContent=String(value??'');dl.append(dt,dd);
  }
  $('account-review-detail').hidden=false;
  if(decision==='approve'||decision==='reject'){
    notify('请核对申请资料，然后在审批窗口内确认 '+(decision==='approve'?'批准':'拒绝')+'。');
  }
}
$('admin-applications').onclick=async()=>{
  $('user-menu').open=false;
  try{
    const r=await call('/v1/admin/applications');
    const list=$('account-review-list');list.replaceChildren();
    $('account-review-detail').hidden=true;
    if(!r.applications?.length)list.textContent='暂无待审核申请';
    else for(const a of r.applications){
      const b=document.createElement('button');b.type='button';
      b.textContent=`${a.username}｜${a.display_name}｜${a.institution}｜${a.email}`;
      b.onclick=()=>accountShowReview(a.id).catch(accountError);list.append(b);
    }
    $('account-review-dialog').showModal();
  }catch(e){accountError(e);}
};
async function accountDecision(decision){
  if(!activeApplication)return;
  const label=decision==='approve'?'批准':'拒绝';
  if(!confirm(`确认${label} ${activeApplication.username} 的注册申请？此操作将记入 D1 审计状态，不能撤回。`))return;
  try{
    const r=await call('/v1/admin/applications/'+encodeURIComponent(activeApplication.id),'POST',{
      decision,confirmed:true
    });
    $('account-review-dialog').close();
    notify(`申请已${label}。${r.mail_sent?'通知邮件已提交':'通知邮件发送失败，请检查 Resend'}`);
    activeApplication=null;
  }catch(e){accountError(e);}
}
$('account-review-approve').onclick=()=>accountDecision('approve');
$('account-review-reject').onclick=()=>accountDecision('reject');
$('account-review-close').onclick=()=>$('account-review-dialog').close();
function accountAfterLogin(info){
  ACC.mode=info.auth_mode;
  ACC.admin=!!info.is_admin;
  $('admin-applications').hidden=!ACC.admin;
  if(ACC.admin&&linkParams.has('review')){
    const id=linkParams.get('review'),d=linkParams.get('decision');
    accountShowReview(id,d).then(()=>{
      if(!$('account-review-dialog').open)$('account-review-dialog').showModal();
    }).catch(accountError);
    linkParams.delete('review');linkParams.delete('decision');
    history.replaceState(null,'',location.pathname);
  }
}
document.addEventListener('autolandscape:login',e=>accountAfterLogin(e.detail));
if(sessionActive&&accountLoginInfo)accountAfterLogin(accountLoginInfo);
// In app.js restoreSession() runs asynchronously. The event above handles F5 restoration.
function accountHeartbeat(e){
  if(!e.isTrusted||!sessionActive||ACC.mode!=='session')return;
  if(Date.now()-ACC.lastHeartbeat<60000)return;
  ACC.lastHeartbeat=Date.now();
  // A real user gesture extends the server inactivity timeout. Background refreshes do not.
  call('/v1/auth/activity','POST',{}).catch(()=>{});
}
for(const ev of ['pointerdown','pointermove','keydown','wheel','touchstart'])
  document.addEventListener(ev,accountHeartbeat,{passive:true});
const originalLogout=$('logout').onclick;
$('logout').onclick=async e=>{
  const credential=token,shouldRevoke=ACC.mode==='session'&&Boolean(credential);
  // Clear local credentials immediately, not after a network timeout. Late old
  // logout responses must never clear a newer login in the same tab.
  ACC.mode='legacy';ACC.admin=false;ACC.lastHeartbeat=0;
  for(const id of ['account-settings-dialog','account-review-dialog'])if($(id).open)$(id).close();
  activeApplication=null;
  originalLogout.call($('logout'),e);
  accountResetTS('login');
  const logoutEpoch=epoch;
  if(shouldRevoke){
    try{
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);
      try{
        const response=await fetch(cfg.apiBase+'/v1/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+credential},cache:'no-store',credentials:'omit',signal:ctl.signal});
        if(!response.ok)throw Error('SERVER_LOGOUT_FAILED');
      }finally{clearTimeout(timer);}
    }catch{
      if(epoch===logoutEpoch&&!sessionActive)notify('本地已退出，但服务器撤销未确认。请恢复网络后重新登录并修改密码撤销旧会话，或等待会话到期。',true);
    }
  }
};
accountLoadTS();
