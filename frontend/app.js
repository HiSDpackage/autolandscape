'use strict';
const cfg=window.AUTOLANDSCAPE_CONFIG,$=id=>document.getElementById(id);
const T={PREPARE_QUEUED:'等待校内复核',PREPARING:'校内正在复核',PREPARED:'等待你确认',QUEUED:'已确认，等待计算',RUNNING:'计算中',UPLOADING:'上传结果中',SUCCEEDED:'计算完成',NEEDS_REVIEW:'结果需检查',FAILED:'失败',BLOCKED:'被校验阻止',INTERRUPTED:'已中断，未重算',RESOURCE_EXCEEDED:'资源达到上限',TIMED_OUT:'超时',CANCELLED:'已取消'};
const END=new Set(['SUCCEEDED','NEEDS_REVIEW','FAILED','BLOCKED','INTERRUPTED','RESOURCE_EXCEEDED','TIMED_OUT','CANCELLED']);
let token='',templates={},selected=null,detail=null,timer=null,busy=false,jobs=[],draftKey=null,chat=[],images=[],imageTask=null,epoch=0,restartKey=null,restartSignature=null,aiProposal=null,aiPending=false,aiDraftEnabled=false;
function notify(s,bad=false){$('message').textContent=s;$('message').className=bad?'bad':'';}
function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
async function call(path,method='GET',data=null,extra={}) {
 const session=epoch,c=new AbortController(),timeout=setTimeout(()=>c.abort(),cfg.requestTimeoutMs);
 try{const r=await fetch(cfg.apiBase+path,{method,signal:c.signal,cache:'no-store',credentials:'omit',headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
 if(!r.ok){let b;try{b=await r.json();}catch{}throw Error(b?.error?.message||`HTTP ${r.status}`);}const result=await r.json();if(session!==epoch)throw Error('SESSION_CHANGED');return result;}
 finally{clearTimeout(timeout);}
}
async function guarded(button,fn){const session=epoch;button.disabled=true;try{await fn();}catch(e){if(session===epoch)notify(e.name==='AbortError'?'请求超时。不要重复创建新任务；再次点击会使用同一请求编号。':e.message,true);}finally{button.disabled=false;}}
function writeSpec(s){$('spec').value=JSON.stringify(s,null,2);$('project-name').value=s.project.name;$('description').value=s.project.description||'';$('timestep').value=s.solver.timestep;$('target-index').value=s.objective.target_index;$('initial-point').value=JSON.stringify(s.objective.initial_point);$('walltime').value=s.resources.walltime_seconds;$('memory').value=s.resources.memory_mb;$('cpu').value=s.resources.cpu_threads;draftKey=null;}
function readSpec(){const s=JSON.parse($('spec').value);s.project.description=$('description').value;return s;}
$('sync-form').onclick=()=>{try{const s=readSpec();s.project.name=$('project-name').value;s.solver.timestep=Number($('timestep').value);s.objective.target_index=Number($('target-index').value);s.objective.initial_point=JSON.parse($('initial-point').value);s.resources.walltime_seconds=Number($('walltime').value);s.resources.memory_mb=Number($('memory').value);s.resources.cpu_threads=Number($('cpu').value);writeSpec(s);notify('表单修改已写入 JSON。');}catch(e){notify('参数格式错误：'+e.message,true);}};
$('spec').oninput=()=>draftKey=null;
$('load-template').onclick=()=>{writeSpec(structuredClone(templates[$('template').value].spec));notify('模板已载入。请检查参数后发送复核。');};
$('import').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>30000)throw Error('仅允许30KB以内的任务 JSON');writeSpec(JSON.parse(await f.text()));notify('已导入草案，尚未提交。');}catch(x){notify(x.message,true);}e.target.value='';};
$('login').onclick=()=>guarded($('login'),async()=>{token=$('token').value.trim();const me=await call('/v1/me');templates=await call('/v1/templates');$('template').replaceChildren();for(const [k,v] of Object.entries(templates)){const o=el('option',v.name);o.value=k;$('template').append(o);}writeSpec(structuredClone(Object.values(templates)[0].spec));$('token').value='';$('login-panel').hidden=true;$('workspace').hidden=false;$('user-label').textContent='用户：'+me.id;$('connection').textContent='API 已连接';$('ai-badge').textContent=me.ai_enabled?'已配置':'未启用';$('chat-input').placeholder = me.ai_enabled
  ? '描述你的系统、计算目标，或询问参数含义。'
  : 'AI 未启用时可先用模板。';$('chat-send').disabled=!me.ai_enabled;$('chat-input').disabled=!me.ai_enabled;$('ai-context').disabled=!me.ai_enabled||me.ai_context_enabled!==true||me.ai_context_version!==2;$('ai-job-context').disabled=!me.ai_enabled||me.ai_job_context_enabled!==true;aiDraftEnabled=me.ai_enabled&&me.ai_draft_enabled===true;$('ai-generate').disabled=!aiDraftEnabled;$('ai-context-note').textContent=me.ai_context_enabled===true&&me.ai_context_version===2?'勾选后附带发送时的模板选择和编辑框草案。表单修改请先写入 JSON。':'任务上下文需更新，请先部署第010项修正版后端。';notify(me.files_enabled?'已连接。可以提交模板并在确认后计算。':'已连接。R2 未绑定：能看结果摘要，但暂不能在线下载文件。');await refresh();});
$('logout').onclick=()=>{epoch++;$('ai-job-context').checked=false;$('ai-job-context').disabled=true;$('ai-job-status').textContent='本轮未附带已提交任务。';clearAIProposal();aiPending=false;aiDraftEnabled=false;$('ai-generate').disabled=true;token='';clearTimeout(timer);busy=false;selected=null;detail=null;jobs=[];templates={};draftKey=null;restartKey=null;restartSignature=null;chat=[];imageTask=null;for(const u of images)URL.revokeObjectURL(u);images=[];
 for(const id of ['jobs','figures','files','chat-log','plan-json','result-summary','events','log','error'])$(id).replaceChildren();
 $('spec').value='';$('description').value='';$('chat-input').value='';$('reviewed').checked=false;$('ai-consent').checked=false;$('ai-context').checked=false;$('ai-context').disabled=true;$('ai-context-status').textContent='尚未发送本轮草案。';$('detail').hidden=true;$('detail-empty').hidden=false;
 $('workspace').hidden=true;$('login-panel').hidden=false;$('connection').textContent='未连接';notify('已退出；令牌与本次页面数据已清除。');};
$('prepare').onclick=()=>guarded($('prepare'),async()=>{const s=readSpec();draftKey=draftKey||crypto.randomUUID();const j=await call('/v1/jobs','POST',{spec:s},{'Idempotency-Key':draftKey});draftKey=null;selected=j.id;notify('任务已发送复核。fat01 待机时最多约2分钟才会领取；复核后还需要你确认。');await refresh();});
function renderJobs(){const box=$('jobs');box.replaceChildren();if(!jobs.length){box.append(el('p','尚无任务'));return;}for(const j of jobs){const b=el('button',undefined,'job'+(selected===j.id?' selected':''));const a=el('span',T[j.status]||j.status);a.append(el('small',j.id.slice(0,16)+' · '+new Date(j.created_at).toLocaleString()));b.append(a,el('span',j.cancel_requested&&!END.has(j.status)?'正在取消…':'查看'));b.onclick=()=>{selected=j.id;refresh();};box.append(b);}}
function duration(s){return s==null?'—':Math.round(s)+' s';}
function renderDetail(j){const changed=detail?.plan_hash!==j.plan_hash||detail?.id!==j.id;detail=j;$('detail').hidden=false;$('detail-empty').hidden=true;$('task-name').textContent=j.spec?.project?.name||j.id;$('task-id').textContent=j.id;$('task-status').textContent=T[j.status]||j.status;$('detail-sub').textContent='最后更新：'+new Date(j.updated_at).toLocaleTimeString();
 const t=j.telemetry||{};$('metric-time').textContent=duration(t.elapsed_seconds);$('metric-memory').textContent=t.rss_mb==null?'—':Math.round(t.rss_mb)+' MB';$('metric-phase').textContent=END.has(j.status)?(['SUCCEEDED','NEEDS_REVIEW'].includes(j.status)?'已完成':'已停止'):({starting:'准备启动',preparing:'复核方案',prepared:'方案已就绪',running:'数值计算',uploading:'回传文件',finishing:'保存结论'}[t.phase]||'等待');$('live-detail').textContent=[t.search_index!=null?'当前目标指标 '+t.search_index:'',t.iteration!=null?'迭代 '+t.iteration:'',t.residual!=null?'日志残差 '+t.residual:''].filter(Boolean).join(' | ');
 $('freshness').textContent=END.has(j.status)?'任务已终止。不会自动重试。':t.observed_at?'状态采样：'+new Date(t.observed_at).toLocaleTimeString()+'。页面与服务器各约5秒刷新，网络中断时状态可能滞后。':'等待服务器回传状态。';
 $('log').textContent=t.log_tail||'尚无计算日志。日志只反映求解器最近输出，不代表总体完成百分比。';$('error').hidden=!j.error;$('error').textContent=j.error?JSON.stringify(j.error,null,2):'';
 $('approval').hidden=j.status!=='PREPARED';if(changed)$('reviewed').checked=false;
 $('plan-json').textContent=JSON.stringify(j.plan,null,2);$('plan-hash').textContent=j.plan_hash?'方案 SHA256：'+j.plan_hash:'';
 if(j.plan){const s=j.plan.spec;$('plan-summary').replaceChildren(el('p',`模型：${s.system.model_id}，维数 ${s.system.dimension}，目标指标 ${s.objective.target_index}`),el('p',`资源上限：${s.resources.cpu_threads} CPU / ${s.resources.memory_mb} MB / ${s.resources.walltime_seconds}秒`),el('p','计算版本：'+j.plan.implementation?.numerics_sha256),el('p',`隔离：${j.plan.execution?.sandbox}；不证明景观完整。`,'notice'));}
 $('cancel').disabled=END.has(j.status)||!!j.cancel_requested;
 $('events').textContent=(j.events||[]).map(e=>new Date(e.at).toLocaleString()+' '+e.kind+' '+e.detail_json).join('\n');
 $('result-block').hidden=!j.result||!END.has(j.status);$('result-summary').textContent=JSON.stringify(j.result?.summary||j.result,null,2);
 const files=$('files');files.replaceChildren();for(const a of j.artifacts||[]){const b=el('button',`${a.name} (${Math.ceil(a.size/1024)} KB)`,'quiet');b.onclick=()=>guarded(b,async()=>saveBlob(await getFile(j.id,a),a.name));files.append(b);}
 $('download-bundle').hidden=!(j.artifacts||[]).some(a=>a.name==='bundle-manifest.json');
 const nodes=$('restart-node');const oldvalue=nodes.value;nodes.replaceChildren();for(const n of j.result?.nodes||[]){if(n.quality?.accepted){const o=el('option',`节点 ${n.id} · 指标 ${n.quality.index} · ${JSON.stringify(n.x).slice(0,70)}`);o.value=n.id;nodes.append(o);}}if([...nodes.options].some(o=>o.value===oldvalue))nodes.value=oldvalue;$('restart').disabled=!nodes.options.length;
 if(imageTask!==j.id||images.length===0){loadFigures(j).catch(()=>{});}
}
async function loadFigures(j){if(!END.has(j.status))return;const list=(j.artifacts||[]).filter(a=>a.name.endsWith('.png')).slice(0,3);if(!list.length)return;imageTask=j.id;for(const url of images)URL.revokeObjectURL(url);images=[];$('figures').replaceChildren();for(const a of list){const b=await getFile(j.id,a);if(selected!==j.id)return;const url=URL.createObjectURL(b);images.push(url);const img=el('img');img.src=url;img.alt=a.name;$('figures').append(img);}}
async function getFile(id,a){const session=epoch;const r=await fetch(cfg.apiBase+`/v1/jobs/${id}/files/${a.name}`,{headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'omit'});if(!r.ok)throw Error('文件下载失败：HTTP '+r.status);const b=await r.blob();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==a.sha256)throw Error('文件校验失败：'+a.name);if(session!==epoch)throw Error('SESSION_CHANGED');return b;}
function saveBlob(b,name){const url=URL.createObjectURL(b),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('export-record').onclick=()=>{if(detail)saveBlob(new Blob([JSON.stringify(detail,null,2)],{type:'application/json'}),detail.id+'.json');};
$('download-bundle').onclick=()=>guarded($('download-bundle'),async()=>{const j=detail,entry=j.artifacts.find(a=>a.name==='bundle-manifest.json'),manifest=JSON.parse(await(await getFile(j.id,entry)).text());const parts=[];for(const p of manifest.parts){const a=j.artifacts.find(x=>x.name===p.name&&x.sha256===p.sha256);if(!a)throw Error('结果包尚未上传完整');notify('正在校验下载：'+p.name);parts.push(await getFile(j.id,a));}const archive=new Blob(parts,{type:'application/zip'});const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await archive.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');if(archive.size!==manifest.archive_size||digest!==manifest.archive_sha256)throw Error('合并后的完整ZIP校验不匹配');saveBlob(archive,j.id+'-results.zip');notify('结果包已下载，分片与完整 ZIP 的 SHA256 均已校验。');});
$('approve').onclick=()=>guarded($('approve'),async()=>{if(!$('reviewed').checked)throw Error('请先阅读完整方案并勾选确认');await call(`/v1/jobs/${selected}/approve`,'POST',{reviewed:true,plan_hash:detail.plan_hash});notify('已确认。任务会进入校内计算队列。');await refresh();});
$('cancel').onclick=()=>guarded($('cancel'),async()=>{await call(`/v1/jobs/${selected}/cancel`,'POST',{});notify('取消请求已提交；运行中的任务要等 fat01 确认后才显示“已取消”。');await refresh();});
$('copy').onclick=()=>{if(detail?.plan?.spec||detail?.spec){writeSpec(structuredClone(detail.plan?.spec||detail.spec));notify('参数已复制，尚未提交。修改后需要重新复核与确认。');window.scrollTo({top:0,behavior:'smooth'});}};
$('restart').onclick=()=>guarded($('restart'),async()=>{const body={node_id:Number($('restart-node').value),perturbation:JSON.parse($('restart-perturbation').value),target_index:Number($('restart-index').value)};const signature=selected+JSON.stringify(body);if(signature!==restartSignature){restartSignature=signature;restartKey=crypto.randomUUID();}const j=await call(`/v1/jobs/${selected}/restart`,'POST',body,{'Idempotency-Key':restartKey});restartSignature=null;restartKey=null;selected=j.id;notify('驻点起算草案已提交复核，尚未批准计算。');await refresh();});
function buildAIContext(){
 if (!$('ai-context').checked) return undefined;
 if ($('ai-context').disabled) throw Error('后端尚未启用任务上下文，请先部署第010项后端');
 let draft;
 try { draft = readSpec(); }
 catch { throw Error('任务 JSON 无效，请先修正，或取消附带任务 JSON 后提问'); }
 if (!draft || typeof draft !== 'object' || Array.isArray(draft))
   throw Error('任务 JSON 必须是对象');
 if (new TextEncoder().encode(JSON.stringify(draft)).length > 16000)
   throw Error('任务 JSON 超过16KB，请精简，或取消附带任务 JSON 后提问');
 return { template_id: $('template').value, draft };
}
function aiFormSnapshot(){return JSON.stringify(['project-name','description','timestep','target-index','initial-point','walltime','memory','cpu'].map(id=>$(id).value));}
function clearAIProposal(){aiProposal=null;$('ai-proposal').hidden=true;$('ai-proposal-json').textContent='';$('ai-proposal-changes').textContent='';$('ai-apply').disabled=true;}
async function sendAI(mode){
 const button=mode==='draft'?$('ai-generate'):$('chat-send');
 return guarded(button,async()=>{
  if(aiPending)throw Error('请等待当前AI请求完成');
  const msg=$('chat-input').value.trim();if(!msg)return;
  if(!$('ai-consent').checked)throw Error('请先勾选允许发送给外部模型');
  if(mode==='draft'&&!aiDraftEnabled)throw Error('请先部署第011项后端并重新连接');
  if(mode==='draft'&&!$('ai-context').checked)throw Error('生成草案需要勾选附带当前模板与任务 JSON');
  let jobId;
  if($('ai-job-context').checked){
   if($('ai-job-context').disabled)throw Error('请先部署第013项后端并重新连接');
   if(mode==='draft')throw Error('附带已提交任务仅用于普通对话，请取消勾选后生成草案');
   if(!selected)throw Error('请先在任务列表选择一个已提交任务');
   jobId=selected;
  }
  const context=buildAIContext();
  const baseSnapshot=context?JSON.stringify(context.draft):null,formSnapshot=aiFormSnapshot();
  if(mode==='draft')clearAIProposal();
  const pending={role:'user',content:msg};
  $('ai-context-status').textContent=context?'正在发送本轮草案，等待后端确认。':'本轮未附带任务 JSON。';
  $('ai-job-status').textContent=jobId?'正在读取选中任务 '+jobId+'，等待后端确认。':'本轮未附带已提交任务。';
  aiPending=true;
  try{
   const r=await call('/v1/ai/chat','POST',{mode,messages:[...chat,pending].slice(-8),allow_external:true,...(context?{context}:{}),...(jobId?{job_id:jobId}:{})});
   if(context){
    if(r.context_attached!==true||!r.context_receipt)throw Error('后端未确认本轮草案，请核对部署版本');
    const v=r.context_receipt;
    $('ai-context-status').textContent='后端收到本轮草案：model_id='+JSON.stringify(v.model_id)+'，dimension='+JSON.stringify(v.dimension)+'，target_index='+JSON.stringify(v.target_index);
   }
   if(jobId){
    if(r.job_receipt?.task_id!==jobId)throw Error('后端未确认本轮选中任务，请核对部署版本');
    $('ai-job-status').textContent='后端读取任务：'+r.job_receipt.task_id+' · '+(T[r.job_receipt.status]||r.job_receipt.status)+' · 快照时间 '+r.job_receipt.captured_at;
   }
   if(mode==='draft'){
    if(!r.proposal?.spec||!Array.isArray(r.proposal.changes))throw Error('后端未返回配置草案，请核对第011项部署版本');
    if(r.proposal.changes.length){
     aiProposal={spec:r.proposal.spec,baseSnapshot,formSnapshot};
     $('ai-proposal-changes').textContent=r.proposal.changes.map(c=>c.path+'：'+JSON.stringify(c.before)+' → '+JSON.stringify(c.after)).join('\n');
     $('ai-proposal-json').textContent=JSON.stringify(r.proposal.spec,null,2);
     $('ai-proposal').hidden=false;$('ai-apply').disabled=false;
    }else notify('本次没有参数改动，请查看助手说明。');
   }
   chat.push(pending,{role:'assistant',content:r.message});
   $('chat-input').value='';
   $('chat-log').replaceChildren(...chat.slice(-12).map(m=>el('div',(m.role==='user'?'你：':'助手：')+m.content,'chat-entry')));
  }finally{aiPending=false;}
 });
}
$('chat-send').onclick=()=>sendAI('chat');
$('ai-generate').onclick=()=>sendAI('draft');
$('ai-apply').onclick=()=>{
 try{
  if(!aiProposal)return;
  if(JSON.stringify(readSpec())!==aiProposal.baseSnapshot||aiFormSnapshot()!==aiProposal.formSnapshot)
   throw Error('生成后当前配置已改变，请重新生成草案，避免覆盖你的新修改');
  writeSpec(structuredClone(aiProposal.spec));clearAIProposal();
  notify('AI 草案已应用到编辑框，尚未提交。请检查后发送 fat01 复核。');
 }catch(e){notify(e.message,true);}
};
$('ai-discard').onclick=clearAIProposal;
async function refresh(){if(!token)return;clearTimeout(timer);if(busy)return;const session=epoch;busy=true;try{const dashboard=await call('/v1/dashboard'+(selected?'?job='+encodeURIComponent(selected):''));jobs=dashboard.jobs;renderJobs();const w=dashboard.workers;$('worker-state').textContent=w.length?w.map(x=>`${x.id}：${x.online?(x.mode==='STANDBY'?'待机':'工作'):'离线/状态过期'}，取件间隔${x.poll_seconds}秒`).join('；'):'fat01 尚未上线';if(selected&&dashboard.detail){renderDetail(dashboard.detail);}else if(jobs.length){selected=jobs[0].id;renderDetail(await call('/v1/jobs/'+selected));renderJobs();}$('connection').textContent='API 已连接';}catch(e){if(session!==epoch)return;$('connection').textContent='连接中断';notify('状态暂未更新：'+e.message,true);}finally{if(session!==epoch)return;busy=false;const active=jobs.some(j=>!END.has(j.status));timer=setTimeout(refresh,document.hidden?30000:(active?cfg.activeRefreshMs:cfg.idleRefreshMs));}}
$('refresh').onclick=refresh;document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
