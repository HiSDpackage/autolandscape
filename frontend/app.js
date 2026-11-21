"use strict";
const cfg = window.AUTOLANDSCAPE_CONFIG,
  $ = (id) => document.getElementById(id);
const T = {
  PREPARE_QUEUED: "等待校内复核",
  PREPARING: "校内正在复核",
  PREPARED: "等待你确认",
  QUEUED: "已确认，等待计算",
  RUNNING: "计算中",
  UPLOADING: "上传结果中",
  SUCCEEDED: "计算完成",
  NEEDS_REVIEW: "结果需检查",
  FAILED: "失败",
  BLOCKED: "被校验阻止",
  INTERRUPTED: "已中断，未重算",
  RESOURCE_EXCEEDED: "资源达到上限",
  TIMED_OUT: "超时",
  CANCELLED: "已取消",
};
const END = new Set([
  "SUCCEEDED",
  "NEEDS_REVIEW",
  "FAILED",
  "BLOCKED",
  "INTERRUPTED",
  "RESOURCE_EXCEEDED",
  "TIMED_OUT",
  "CANCELLED",
]);
let token = "",
  templates = {},
  selected = null,
  detail = null,
  timer = null,
  busy = false,
  jobs = [],
  draftKey = null,
  chat = [],
  images = [],
  imageTask = null,
  epoch = 0,
  restartKey = null,
  restartSignature = null,
  aiPending = false,
  aiJobContextEnabled = false;
let noticeTimer;
function notify(s, bad = false) {
  clearTimeout(noticeTimer);
  $("message").textContent = s;
  $("message").className = bad ? "bad" : "";
  $("message").hidden = false;
  noticeTimer = setTimeout(
    () => {
      $("message").hidden = true;
    },
    bad ? 14000 : 6500,
  );
}
function el(tag, text, cls) {
  const x = document.createElement(tag);
  if (text !== undefined) x.textContent = text;
  if (cls) x.className = cls;
  return x;
}
async function call(path, method = "GET", data = null, extra = {}) {
  if (sessionActive && Date.now() - lastActivity >= IDLE_MS) {
    expireSession();
    throw Error("登录已过期，请重新登录。");
  }
  const isAI = path === "/v1/ai/chat" || path === "/v1/ai/personal/chat";
  const aiSetup = path === "/v1/ai/personal/test" || path === "/v1/ai/personal/models";
  const requestTimeoutMs = isAI ? 330000 : aiSetup ? 25000 : cfg.requestTimeoutMs;
  const session = epoch,
    c = new AbortController(),
    timeout = setTimeout(() => c.abort(), requestTimeoutMs);
  try {
    const r = await fetch(cfg.apiBase + path, {
      method,
      signal: c.signal,
      cache: "no-store",
      credentials: "omit",
      headers: {
        Authorization: "Bearer " + token,
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!r.ok) {
      let b;
      try {
        b = await r.json();
      } catch {}
      if (r.status === 401 && sessionActive && session === epoch) {
        $("logout").click();
        notify("登录已失效，请重新登录。", true);
      }
      throw Error(b?.error?.message || `HTTP ${r.status}`);
    }
    const result = await r.json();
    if (session !== epoch) throw Error("SESSION_CHANGED");
    return result;
  } catch (e) {
    if (aiSetup && e.name === "AbortError") throw Error("请求服务商超时，请稍后再试。");
    if (isAI && e.name === "AbortError") {
      throw Error(
        "AI响应等待超过5分30秒，网页已停止等待；服务可能仍在处理，本次额度状态尚不确定。请勿立即重复发送，也不要据此认为额度已退回。",
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
async function guarded(button, fn) {
  const session = epoch;
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    if (session === epoch) {
      if (button.id === "chat-send")
        setAIActionStatus(e.message, true);
      notify(
        e.name === "AbortError"
          ? "请求超时。不要重复创建新任务；再次点击会使用同一请求编号。"
          : e.message,
        true,
      );
    }
  } finally {
    button.disabled = false;
    if (button.id === "chat-send")
      setAIControls();
  }
}
function writeSpec(s) {
  const project = s?.project;
  const objective = s?.objective;
  const resources = s?.resources;
  if (!project || !s.system || !objective || !s.solver || !resources)
    throw Error("JSON 需要 project、system、objective、solver 和 resources 字段。");
  $("spec").value = JSON.stringify(s, null, 2);
  $("project-name").value = project.name ?? "";
  $("description").value = project.description ?? "";
  $("timestep").value = s.solver.timestep ?? "";
  $("target-index").value = objective.target_index ?? "";
  $("initial-point").value = objective.initial_point == null ? "" : JSON.stringify(objective.initial_point);
  $("walltime").value = resources.walltime_seconds ?? "";
  $("memory").value = resources.memory_mb ?? "";
  $("cpu").value = resources.cpu_threads ?? "";
  $("template").value = Object.entries(templates).find(([, item]) =>
    item.spec.system.model_id === s.system.model_id && s.system.representation === "template"
  )?.[0] ?? "";
  $("load-template").disabled = !$("template").value;
  draftKey = null;
}
function readSpec() {
  if (!$("spec").value.trim()) throw Error("请先新建、导入或粘贴任务 JSON。");
  return JSON.parse($("spec").value);
}
$("sync-form").onclick = () => {
  try {
    const s = readSpec();
    s.project.name = $("project-name").value;
    s.project.description = $("description").value;
    s.solver.timestep = Number($("timestep").value);
    s.objective.target_index = Number($("target-index").value);
    s.objective.initial_point = JSON.parse($("initial-point").value);
    s.resources.walltime_seconds = Number($("walltime").value);
    s.resources.memory_mb = Number($("memory").value);
    s.resources.cpu_threads = Number($("cpu").value);
    writeSpec(s);
    notify("表单修改已写入 JSON。");
  } catch (e) {
    notify("参数格式错误：" + e.message, true);
  }
};
$("spec").oninput = () => (draftKey = null);
$("template").onchange = () => {
  $("load-template").disabled = !$("template").value;
};
$("load-template").onclick = () => {
  const template = templates[$("template").value];
  if (!template) return;
  writeSpec(structuredClone(template.spec));
  notify("模板已载入。请检查参数后发送复核。");
};
$("import").onchange = async (e) => {
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 30000) throw Error("仅允许30KB以内的任务 JSON");
    writeSpec(JSON.parse(await f.text()));
    notify("已导入草案，尚未提交。");
  } catch (x) {
    notify(x.message, true);
  }
  e.target.value = "";
};
let accountLoginInfo = null;
async function loginSession(saved = null) {
  return guarded($("login"), async () => {
    token = saved?.token || $("token").value.trim();
    const loginEpoch = epoch;
    const me = await call("/v1/me");
    templates = await call("/v1/templates");
    const optionalTemplate = el("option", "自定义 JSON");
    optionalTemplate.value = "";
    $("template").replaceChildren(optionalTemplate);
    $("load-template").disabled = true;
    for (const [k, v] of Object.entries(templates)) {
      const o = el("option", v.name);
      o.value = k;
      $("template").append(o);
    }
    if (loginEpoch !== epoch) return;
    if (saved && Date.now() - saved.lastActivity >= IDLE_MS)
      throw Error("登录已过期，请重新登录。");
    chat = saved?.chat || [];
    lastActivity = saved?.lastActivity || Date.now();
    sessionActive = true;
    accountLoginInfo={auth_mode:me.auth_mode||'legacy',is_admin:!!me.is_admin};
    document.dispatchEvent(new CustomEvent('autolandscape:login', {detail: accountLoginInfo}));
    saveSession();
    scheduleIdleLogout();
    $("token").value = "";
    $("login-panel").hidden = true;
    $("workspace").hidden = false;
    $("user-label").textContent = me.username || me.id;
    $("user-avatar").textContent = String(me.username || me.id).slice(0, 1).toUpperCase();
    aiEnabled = !!me.ai_enabled;
    aiPersonalCapabilities = me.ai_personal_capabilities ?? [];
    loadAIProfiles(me.id);
    $("connection").textContent = "已连接";
    $("ai-badge").textContent = me.ai_enabled ? "可用" : "暂不可用";
    $("chat-input").placeholder = me.ai_enabled
      ? "描述你的系统、计算目标，或询问参数含义。"
      : "AI 未启用时可手动编辑或导入 JSON。";
    $("chat-send").disabled = !me.ai_enabled;
    $("chat-input").disabled = !me.ai_enabled;
    aiJobContextEnabled = aiEnabled && me.ai_job_context_enabled === true;
    $("ai-job-context").disabled = !aiJobContextEnabled || !selected;
    showChat(true);
    renderChat();
    setAIControls();
    if (!me.files_enabled) notify("当前可以查看结果摘要，文件下载暂不可用。");
    await refresh();
  });
}
$("login").onclick = () => loginSession();
$("logout").onclick = () => {
  $("ai-model-dialog").close();
  $("ai-personal-key").value = "";
  aiProfileStorage = "";
  aiProfiles = [];
  renderAIProfiles();
  updateAISource();
  epoch++;
  sessionActive = false;
  accountLoginInfo = null;
  clearTimeout(idleTimer);
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  aiJobContextEnabled = false;
  $("ai-job-context").checked = false;
  $("ai-job-context").disabled = true;
  $("ai-job-status").textContent = "本轮未附带已提交任务。";
  aiPending = false;
  token = "";
  clearTimeout(timer);
  busy = false;
  selected = null;
  detail = null;
  jobs = [];
  templates = {};
  draftKey = null;
  restartKey = null;
  restartSignature = null;
  chat = [];
  setAIActionStatus("");
  imageTask = null;
  for (const u of images) URL.revokeObjectURL(u);
  images = [];
  for (const id of [
    "jobs",
    "figures",
    "files",
    "chat-log",
    "plan-json",
    "result-summary",
    "events",
    "log",
    "error",
  ])
    $(id).replaceChildren();
  $("spec").value = "";
  $("description").value = "";
  $("chat-input").value = "";
  $("reviewed").checked = false;
  $("ai-consent").checked = false;
  $("detail").hidden = true;
  $("detail-empty").hidden = false;
  aiEnabled = false;
  panelKind = null;
  chatVisible = true;
  detailNames.clear();
  setLayout();
  renderChat();
  $("user-menu").open = false;
  closeSidebar();
  $("workspace").hidden = true;
  $("login-panel").hidden = false;
  $("connection").textContent = "未连接";
  notify("已退出；令牌与本次页面数据已清除。");
};
$("prepare").onclick = () =>
  guarded($("prepare"), async () => {
    const requestEpoch = epoch;
    const s = readSpec();
    draftKey = draftKey || crypto.randomUUID();
    const j = await call(
      "/v1/jobs",
      "POST",
      { spec: s },
      { "Idempotency-Key": draftKey },
    );
    if (requestEpoch !== epoch) return;
    draftKey = null;
    selectTaskView(j.id);
    notify("方案已提交复核，可能等待约2分钟。复核后请确认是否计算。");
    await refresh();
  });
function renderJobs() {
  const box = $("jobs"),
    overview = $("task-overview");
  box.replaceChildren();
  overview.replaceChildren();
  $("job-count").textContent = jobs.length;
  if (!jobs.length) {
    box.append(el("p", "还没有提交的任务", "empty-small"));
    overview.append(el("p", "从“配置新任务”开始你的第一次计算。", "muted"));
    return;
  }
  for (const j of jobs) {
    const title =
      detailNames.get(j.id) ||
      j.spec?.project?.name ||
      j.name ||
      "任务 · " + j.id.replace(/^job_/, "").slice(0, 8);
    const date = new Date(j.created_at).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const b = el(
      "button",
      undefined,
      "job" + (selected === j.id ? " selected" : ""),
    );
    b.title = title + " · " + (T[j.status] || j.status);
    b.setAttribute("aria-pressed", String(selected === j.id));
    b.append(el("span", title, "job-title"));
    const meta = el("span", undefined, "job-meta");
    meta.append(
      el(
        "i",
        undefined,
        "status-dot " +
          (!END.has(j.status)
            ? "running"
            : ["FAILED", "BLOCKED"].includes(j.status)
              ? "failed"
              : ""),
      ),
      el("span", T[j.status] || j.status),
      el("span", date),
    );
    b.append(meta);
    b.onclick = () => {
      selectTaskView(selected === j.id ? null : j.id);
      refresh();
    };
    box.append(b);
    const card = el("button", undefined, "task-overview-row");
    card.append(
      el("strong", title),
      el("small", (T[j.status] || j.status) + " · " + date),
    );
    card.setAttribute("aria-pressed", String(selected === j.id));
    card.onclick = b.onclick;
    overview.append(card);
  }
}
function duration(s) {
  return s == null ? "—" : Math.round(s) + " s";
}
function renderDetail(j) {
  const changed = detail?.plan_hash !== j.plan_hash || detail?.id !== j.id;
  detail = j;
  detailNames.set(
    j.id,
    j.spec?.project?.name || j.plan?.spec?.project?.name || j.id,
  );
  renderJobs();
  $("detail").hidden = false;
  $("detail-empty").hidden = true;
  $("task-name").textContent = j.spec?.project?.name || j.id;
  $("task-id").textContent = j.id;
  $("task-status").textContent = T[j.status] || j.status;
  $("detail-sub").textContent =
    "最后更新：" + new Date(j.updated_at).toLocaleTimeString();
  const t = j.telemetry || {};
  $("metric-time").textContent = duration(t.elapsed_seconds);
  $("metric-memory").textContent =
    t.rss_mb == null ? "—" : Math.round(t.rss_mb) + " MB";
  $("metric-phase").textContent = END.has(j.status)
    ? ["SUCCEEDED", "NEEDS_REVIEW"].includes(j.status)
      ? "已完成"
      : "已停止"
    : {
        starting: "准备启动",
        preparing: "复核方案",
        prepared: "方案已就绪",
        running: "数值计算",
        uploading: "回传文件",
        finishing: "保存结论",
      }[t.phase] || "等待";
  $("live-detail").textContent = [
    t.search_index != null ? "当前目标指标 " + t.search_index : "",
    t.iteration != null ? "迭代 " + t.iteration : "",
    t.residual != null ? "日志残差 " + t.residual : "",
  ]
    .filter(Boolean)
    .join(" | ");
  $("freshness").textContent = END.has(j.status)
    ? j.status === "SUCCEEDED"
      ? "计算已完成。"
      : "本次任务已结束。"
    : t.observed_at
      ? "状态采样：" +
        new Date(t.observed_at).toLocaleTimeString() +
        "。页面与服务器各约5秒刷新，网络中断时状态可能滞后。"
      : "等待服务器回传状态。";
  $("log").textContent =
    t.log_tail ||
    "尚无计算日志。日志只反映求解器最近输出，不代表总体完成百分比。";
  $("error-details").hidden = !j.error;
  $("error").hidden = !j.error;
  $("error").textContent = j.error ? JSON.stringify(j.error, null, 2) : "";
  $("approval").hidden = j.status !== "PREPARED";
  if (changed) $("reviewed").checked = false;
  $("plan-json").textContent = JSON.stringify(j.plan, null, 2);
  $("plan-hash").textContent = j.plan_hash ? "方案标识：" + j.plan_hash : "";
  if (j.plan) {
    const s = j.plan.spec;
    $("plan-summary").replaceChildren(
      el(
        "p",
        `模型：${s.system.model_id}，维数 ${s.system.dimension}，目标指标 ${s.objective.target_index}`,
      ),
      el(
        "p",
        `资源上限：${s.resources.cpu_threads} CPU / ${s.resources.memory_mb} MB / ${s.resources.walltime_seconds}秒`,
      ),
      el("p", "请核对模型与资源预算，确认后开始计算。", "notice"),
    );
  }
  $("cancel").disabled = END.has(j.status) || !!j.cancel_requested;
  $("events").textContent = (j.events || [])
    .map(
      (e) =>
        new Date(e.at).toLocaleString() + " " + e.kind + " " + e.detail_json,
    )
    .join("\n");
  $("result-block").hidden = !j.result || !END.has(j.status);
  $("result-summary").textContent = JSON.stringify(
    j.result?.summary || j.result,
    null,
    2,
  );
  const summary = j.result?.summary || {};
  $("result-nodes").textContent =
    summary.node_count ?? j.result?.nodes?.length ?? "—";
  $("result-edges").textContent =
    summary.search_edge_count ?? summary.edge_count ?? "—";
  $("result-valid").textContent =
    summary.all_returned_nodes_valid === true
      ? "通过"
      : summary.all_returned_nodes_valid === false
        ? "需检查"
        : "未判定";
  const files = $("files");
  files.replaceChildren();
  for (const a of j.artifacts || []) {
    const b = el(
      "button",
      `${a.name} (${Math.ceil(a.size / 1024)} KB)`,
      "quiet",
    );
    b.onclick = () =>
      guarded(b, async () => saveBlob(await getFile(j.id, a), a.name));
    files.append(b);
  }
  $("download-bundle").hidden = !(j.artifacts || []).some(
    (a) => a.name === "bundle-manifest.json",
  );
  const nodes = $("restart-node");
  const oldvalue = nodes.value;
  nodes.replaceChildren();
  for (const n of j.result?.nodes || []) {
    if (n.quality?.accepted) {
      const o = el(
        "option",
        `节点 ${n.id} · 指标 ${n.quality.index} · ${JSON.stringify(n.x).slice(0, 70)}`,
      );
      o.value = n.id;
      nodes.append(o);
    }
  }
  if ([...nodes.options].some((o) => o.value === oldvalue))
    nodes.value = oldvalue;
  $("restart").disabled = !nodes.options.length;
  if (imageTask !== j.id || images.length === 0) {
    loadFigures(j).catch(() => {});
  }
}
async function loadFigures(j) {
  if (!END.has(j.status)) return;
  const list = (j.artifacts || [])
    .filter((a) => a.name.endsWith(".png"))
    .slice(0, 3);
  if (!list.length) return;
  imageTask = j.id;
  for (const url of images) URL.revokeObjectURL(url);
  images = [];
  $("figures").replaceChildren();
  for (const a of list) {
    const b = await getFile(j.id, a);
    if (selected !== j.id) return;
    const url = URL.createObjectURL(b);
    images.push(url);
    const img = el("img");
    img.src = url;
    img.alt = a.name;
    $("figures").append(img);
  }
}
async function getFile(id, a) {
  const session = epoch;
  const r = await fetch(cfg.apiBase + `/v1/jobs/${id}/files/${a.name}`, {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
    credentials: "omit",
  });
  if (!r.ok) throw Error("文件下载失败：HTTP " + r.status);
  const b = await r.blob();
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await b.arrayBuffer()),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== a.sha256) throw Error("文件校验失败：" + a.name);
  if (session !== epoch) throw Error("SESSION_CHANGED");
  return b;
}
function saveBlob(b, name) {
  const url = URL.createObjectURL(b),
    a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$("export-record").onclick = () => {
  if (detail)
    saveBlob(
      new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" }),
      detail.id + ".json",
    );
};
$("download-bundle").onclick = () =>
  guarded($("download-bundle"), async () => {
    const j = detail,
      entry = j.artifacts.find((a) => a.name === "bundle-manifest.json"),
      manifest = JSON.parse(await (await getFile(j.id, entry)).text());
    const parts = [];
    for (const p of manifest.parts) {
      const a = j.artifacts.find(
        (x) => x.name === p.name && x.sha256 === p.sha256,
      );
      if (!a) throw Error("结果包尚未上传完整");
      notify("正在校验下载：" + p.name);
      parts.push(await getFile(j.id, a));
    }
    const archive = new Blob(parts, { type: "application/zip" });
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await archive.arrayBuffer()),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (
      archive.size !== manifest.archive_size ||
      digest !== manifest.archive_sha256
    )
      throw Error("合并后的完整ZIP校验不匹配");
    saveBlob(archive, j.id + "-results.zip");
    notify("结果包已下载，文件完整性校验通过。");
  });
$("approve").onclick = () =>
  guarded($("approve"), async () => {
    if (!$("reviewed").checked) throw Error("请先阅读完整方案并勾选确认");
    await call(`/v1/jobs/${selected}/approve`, "POST", {
      reviewed: true,
      plan_hash: detail.plan_hash,
    });
    notify("已确认。任务会进入校内计算队列。");
    await refresh();
  });
$("cancel").onclick = () =>
  guarded($("cancel"), async () => {
    await call(`/v1/jobs/${selected}/cancel`, "POST", {});
    notify("取消请求已提交，请等待计算服务确认。");
    await refresh();
  });
$("copy").onclick = () => {
  if (detail?.plan?.spec || detail?.spec) {
    writeSpec(structuredClone(detail.plan?.spec || detail.spec));
    notify("参数已复制，尚未提交。修改后需要重新复核与确认。");
    showPanel("config");
  }
};
$("restart").onclick = () =>
  guarded($("restart"), async () => {
    const body = {
      node_id: Number($("restart-node").value),
      perturbation: JSON.parse($("restart-perturbation").value),
      target_index: Number($("restart-index").value),
    };
    const signature = selected + JSON.stringify(body);
    if (signature !== restartSignature) {
      restartSignature = signature;
      restartKey = crypto.randomUUID();
    }
    const j = await call(`/v1/jobs/${selected}/restart`, "POST", body, {
      "Idempotency-Key": restartKey,
    });
    restartSignature = null;
    restartKey = null;
    selectTaskView(j.id);
    notify("新任务已提交复核，确认方案后才会计算。");
    await refresh();
  });
function setAIActionStatus(message, bad = false) {
  const status = $("ai-action-status");
  status.textContent = message;
  status.className = bad ? "small bad" : "small";
  status.hidden = !message;
}
const AI_MODEL_SUGGESTIONS = {
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  gemini: ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"],
  gpt: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"],
  kimi: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
  qwen: ["qwen4-max", "qwen3.8-max", "qwen3.8-flash", "qwen3.8-2.4t-a95b", "qwen3.7-plus"],
};

const AI_EFFORT_LABELS = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
let aiPersonalCapabilities = [];
let aiProfiles = [];
let aiProfileStorage = "";
let aiProfileKey = "";
let aiSettingsRequest = 0;
let aiEditingId = "";

function loadAIProfiles(accountId) {
  aiProfileStorage = "autolandscape.model-services.v1:" + accountId;
  aiProfiles = [];
  try {
    const profiles = JSON.parse(localStorage.getItem(aiProfileStorage) || "[]");
    if (Array.isArray(profiles)) aiProfiles = profiles.filter((profile) =>
      typeof profile?.id === "string" && typeof profile.model === "string" &&
      Array.from($("ai-provider").options).some((option) => option.value === profile.provider)
    );
  } catch {}
  renderAIProfiles();
  updateAISource();
}

function persistAIProfiles() {
  try {
    localStorage.setItem(aiProfileStorage, JSON.stringify(aiProfiles));
  } catch {
    notify("浏览器无法保存模型配置。当前页面仍可使用。", true);
  }
}

function renderAIProfiles(active = "platform") {
  const order = Array.from($("ai-provider").options, (option) => option.value);
  const profiles = [...aiProfiles].sort((a, b) =>
    order.indexOf(a.provider) - order.indexOf(b.provider) ||
    (a.name || a.model).localeCompare(b.name || b.model)
  );
  const source = $("ai-source"), editor = $("ai-profile-editor");
  source.options.length = 1;
  editor.options.length = 1;
  for (const profile of profiles) {
    const provider = $("ai-provider").options[order.indexOf(profile.provider)].textContent.trim();
    const label = profile.name && profile.name !== profile.model
      ? profile.name + " (" + profile.model + ")" : profile.model;
    const option = el("option", provider + " · " + label);
    option.value = profile.id;
    source.append(option);
    editor.append(option.cloneNode(true));
  }
  source.value = active;
}

function updateAISource() {
  const source = $("ai-source");
  source.title = source.selectedOptions[0]?.textContent ?? "";
  aiProfileKey = "";
  $("ai-consent").checked = false;
}
$("ai-source").onchange = updateAISource;

function modelSettingsStatus(message = "", error = false) {
  const status = $("ai-model-status");
  status.textContent = message;
  status.hidden = !message;
  status.className = error ? "small bad" : "small";
}

function updateModelFields(selectedEffort = $("ai-model-reasoning").value) {
  const provider = $("ai-provider").value, model = $("ai-personal-model").value.trim();
  $("ai-personal-region-field").hidden = !$("ai-provider").selectedOptions[0].hasAttribute("data-regional");
  const cap = aiPersonalCapabilities.find((item) =>
    item.provider === provider && new RegExp(item.pattern, "i").test(model)
  ) ?? {};
  const thinking = $("ai-model-thinking");
  if (!cap.toggle) thinking.value = "";
  $("ai-model-thinking-row").hidden = !cap.toggle;
  const effort = $("ai-model-reasoning");
  const levels = cap.efforts ?? [];
  const defaults = cap.defaultEffort ? "供应商默认 · " + AI_EFFORT_LABELS[cap.defaultEffort] : "供应商默认";
  effort.replaceChildren(...["", ...levels].map((level) => {
    const option = el("option", level ? AI_EFFORT_LABELS[level] : defaults);
    option.value = level;
    return option;
  }));
  effort.value = levels.includes(selectedEffort) ? selectedEffort : "";
  $("ai-model-reasoning-row").hidden = !levels.length || thinking.value === "off";
  $("ai-model-thinking-note").textContent = cap.toggle
    ? "默认" + (cap.defaultThinking === "on" ? "开启" : cap.defaultThinking === "off" ? "关闭" : "由供应商决定") + "。"
    : cap.defaultThinking === "on" ? "此模型的深度思考始终开启。"
    : cap.defaultThinking === "off" ? "此模型不提供深度思考设置。"
    : "此型号暂无已核对的思考设置，使用供应商默认参数。";
  const sampling = cap.sampling === "any" || cap.sampling === "off" && thinking.value === "off";
  $("ai-model-sampling").hidden = !sampling;
  $("ai-model-temperature-row").hidden = !sampling;
  $("ai-model-temperature").disabled = !sampling;
  $("ai-model-top-p-row").hidden = !sampling || !cap.topP;
  $("ai-model-top-p").disabled = !sampling || !cap.topP;
}

$("ai-model-thinking").onchange = () => updateModelFields();

function renderAIModelSuggestions(accountModels = []) {
  const provider = $("ai-provider").value;
  const models = new Set([...(AI_MODEL_SUGGESTIONS[provider] || []), ...accountModels]);
  $("ai-model-list").replaceChildren(...Array.from(models, (model) => {
    const option = el("option");
    option.value = model;
    return option;
  }));
}

function editAIProfile(id) {
  aiEditingId = id;
  const profile = aiProfiles.find((item) => item.id === id);
  $("ai-profile-editor").value = id;
  $("ai-provider").value = profile?.provider || "deepseek";
  $("ai-profile-name").value = profile?.name || "";
  $("ai-personal-region").value = profile?.region || "cn";
  $("ai-personal-model").value = profile?.model || "";
  $("ai-personal-key").value = id === $("ai-source").value ? aiProfileKey : "";
  $("ai-model-max-tokens").value = profile?.generation?.max_tokens ?? "";
  $("ai-model-temperature").value = profile?.generation?.temperature ?? "";
  $("ai-model-top-p").value = profile?.generation?.top_p ?? "";
  const effort = profile?.generation?.reasoning_effort;
  $("ai-model-thinking").value = profile?.generation?.thinking_mode ?? (effort === "none" ? "off" : "");
  $("ai-model-remove").hidden = !profile;
  renderAIModelSuggestions();
  modelSettingsStatus();
  updateModelFields(effort ?? "");
}

function invalidateModelConnection() {
  $("ai-personal-key").value = "";
  $("ai-model-thinking").value = "";
  $("ai-model-reasoning").value = "";
  $("ai-model-temperature").value = "";
  $("ai-model-top-p").value = "";
  renderAIModelSuggestions();
  modelSettingsStatus();
  updateModelFields();
}
$("ai-provider").onchange = invalidateModelConnection;
$("ai-personal-region").onchange = invalidateModelConnection;
$("ai-personal-model").oninput = () => {
  updateModelFields();
  modelSettingsStatus();
};
$("ai-profile-editor").onchange = () => editAIProfile($("ai-profile-editor").value);
$("ai-model-settings").onclick = () => {
  const selected = $("ai-source").value;
  $("ai-model-fields").disabled = false;
  editAIProfile(selected === "platform" ? "" : selected);
  $("ai-model-dialog").showModal();
};
$("ai-model-close").onclick = () => $("ai-model-dialog").close();
$("ai-model-dialog").onclose = () => {
  if ($("ai-model-dialog").open) return;
  aiSettingsRequest++;
  $("ai-personal-key").value = "";
};
$("ai-personal-clear").onclick = () => {
  $("ai-personal-key").value = "";
  if (aiEditingId === $("ai-source").value) updateAISource();
  $("ai-personal-key").focus();
};

function readAIProfile() {
  return {
    provider: $("ai-provider").value,
    name: $("ai-profile-name").value.trim(),
    model: $("ai-personal-model").value.trim(),
    ...(!$("ai-personal-region-field").hidden ? { region: $("ai-personal-region").value } : {}),
    generation: {
      ...($("ai-model-max-tokens").value ? { max_tokens: $("ai-model-max-tokens").valueAsNumber } : {}),
      ...(!$("ai-model-thinking-row").hidden && $("ai-model-thinking").value
        ? { thinking_mode: $("ai-model-thinking").value } : {}),
      ...(!$("ai-model-top-p-row").hidden && $("ai-model-top-p").value
        ? { top_p: $("ai-model-top-p").valueAsNumber } : {}),
      ...(!$("ai-model-temperature-row").hidden && $("ai-model-temperature").value
        ? { temperature: $("ai-model-temperature").valueAsNumber } : {}),
      ...(!$("ai-model-reasoning-row").hidden && $("ai-model-reasoning").value
        ? { reasoning_effort: $("ai-model-reasoning").value } : {})
    }
  };
}

function personalAIRequest({ provider, region, model, generation }, apiKey) {
  return { provider, region, model, generation, api_key: apiKey };
}

function validModelForm(profile) {
  const { temperature, top_p: topP } = profile.generation;
  if (topP != null && (topP <= 0 || temperature != null)) {
    modelSettingsStatus("Top-p 须大于 0，且与温度任选一项设置。", true);
    return false;
  }
  if (profile.provider === "qwen" && temperature === 2) {
    modelSettingsStatus("Qwen 的温度须小于 2。", true);
    return false;
  }
  if ($("ai-model-form").reportValidity() && /^[a-zA-Z0-9._:/@-]{1,200}$/.test(profile.model))
    return true;
  modelSettingsStatus("请检查模型 ID 和高级参数。", true);
  return false;
}

$("ai-model-form").onsubmit = (event) => {
  event.preventDefault();
  const profile = readAIProfile();
  if (!validModelForm(profile)) return;
  profile.id = aiEditingId || crypto.randomUUID();
  aiProfiles = aiProfiles.filter((item) => item.id !== profile.id);
  aiProfiles.push(profile);
  persistAIProfiles();
  renderAIProfiles(profile.id);
  updateAISource();
  aiProfileKey = $("ai-personal-key").value.trim();
  $("ai-model-dialog").close();
};
$("ai-model-remove").onclick = () => {
  const active = $("ai-source").value;
  aiProfiles = aiProfiles.filter((profile) => profile.id !== aiEditingId);
  persistAIProfiles();
  if (active === aiEditingId) updateAISource();
  renderAIProfiles(active === aiEditingId ? "platform" : active);
  editAIProfile("");
};

async function checkAIProfile(listModels) {
  const profile = readAIProfile();
  if (!listModels && !validModelForm(profile)) return;
  const apiKey = $("ai-personal-key").value.trim();
  if (!apiKey) {
    modelSettingsStatus("请先填写 API Key。", true);
    $("ai-personal-key").focus();
    return;
  }
  const request = ++aiSettingsRequest;
  const current = () => request === aiSettingsRequest && $("ai-model-dialog").open;
  $("ai-model-fields").disabled = true;
  modelSettingsStatus(listModels ? "正在获取模型…" : "正在测试连接…");
  try {
    const response = await call("/v1/ai/personal/" + (listModels ? "models" : "test"), "POST", {
      ai_source: "personal",
      allow_external: true,
      personal_ai: personalAIRequest(profile, apiKey)
    });
    if (!current()) return;
    if (listModels && Array.isArray(response.models)) {
      renderAIModelSuggestions(response.models);
      modelSettingsStatus(response.models.length
        ? "已获取 " + response.models.length + " 个模型，可在模型 ID 输入框中选择。"
        : "接口未返回可选模型，可手动填写模型 ID。");
    } else if (!listModels && response.ok === true) {
      modelSettingsStatus("连接成功，所选模型已返回文本。");
    } else {
      modelSettingsStatus(response.message || "服务暂不可用。", true);
    }
  } catch (error) {
    if (current()) modelSettingsStatus(error.message, true);
  } finally {
    if (current()) $("ai-model-fields").disabled = false;
  }
}
$("ai-model-fetch").onclick = () => checkAIProfile(true);
$("ai-model-test").onclick = () => checkAIProfile(false);

async function sendAI() {
  const button = $("chat-send");
  const requestEpoch = epoch;
  return guarded(button, async () => {
    setAIActionStatus("");
    if (aiPending) throw Error("请等待当前AI请求完成");
    const msg = $("chat-input").value.trim();
    if (!msg) {
      $("chat-input").focus();
      throw Error("请先输入问题，再点击发送。");
    }
    if (!$("ai-consent").checked) throw Error("请先勾选允许发送给外部模型");
    const source = $("ai-source");
    const profile = aiProfiles.find((item) => item.id === source.value);
    if (source.value !== "platform" && !profile)
      throw Error("请选择可用的回答模型。");
    if (profile && !aiProfileKey)
      throw Error("请打开「模型服务」，填写所选模型的 API Key 并保存。");
    const personal = profile ? personalAIRequest(profile, aiProfileKey) : null;
    const aiSource = personal ? "personal" : "platform";
    const providerLabel = personal ? source.selectedOptions[0].textContent.trim() : "";
    let jobId;
    if ($("ai-job-context").checked) {
      if ($("ai-job-context").disabled)
        throw Error("当前暂不支持读取任务，请联系管理员");
      jobId = selected || undefined;
      if (!jobId) notify("没有选择任务，本轮继续普通对话。");
    }
    const pending = { role: "user", content: msg };
    $("ai-job-status").textContent = jobId
      ? "正在读取选中任务 " + jobId + "，等待确认。"
      : selected
        ? "本轮未附带已提交任务。"
        : "没有选择任务，本轮不读取任务信息。";
    aiPending = true;
    setAIActionStatus("正在等待回答…");
    setAIControls();
    renderChat(pending);
    try {
      const r = await call(personal ? "/v1/ai/personal/chat" : "/v1/ai/chat", "POST", {
        mode: "chat",
        ai_source: aiSource,
        ...(personal ? { personal_ai: personal } : {}),
        messages: [
          ...chat.map(({ role, content }) => ({ role, content })),
          {
            ...pending,
            content:
              msg +
              (!selected
                ? "\n\n[页面状态：本轮没有选择已提交任务。若需要读取任务信息，请说明尚未选择任务，不要引用之前任务作为当前任务。]"
                : !jobId
                  ? "\n\n[页面状态：本轮未附带已提交任务，请勿将历史任务信息视为本轮已读取的数据。]"
                  : ""),
          },
        ].slice(-8),
        allow_external: true,
        ...(jobId ? { job_id: jobId } : {}),
      });
      if (requestEpoch !== epoch) return;
      if (personal && r.ai_source !== "personal")
        throw Error("后端未确认使用个人 AI，请检查是否已部署新版 Worker");
      if (jobId) {
        if (r.job_receipt?.task_id !== jobId)
          throw Error("选中任务未成功读取，请重新选择任务后再试");
        if (selected === jobId) {
          $("ai-job-status").textContent =
            "本轮已附带任务：" +
            r.job_receipt.task_id +
            " · " +
            (T[r.job_receipt.status] || r.job_receipt.status) +
            " · 读取时间 " +
            r.job_receipt.captured_at;
        }
      }
      setAIActionStatus("");
      chat.push(pending, {
        role: "assistant", content: r.message, aiSource, providerLabel,
        ...(r.draft_spec ? { draftSpec: r.draft_spec } : {}),
        ...(personal && typeof r.ai_thinking === "string" ? { aiThinking: r.ai_thinking } : {})
      });
      saveSession();
      $("chat-input").value = "";
      renderChat();
    } catch (e) {
      if (requestEpoch === epoch)
        renderChat(null, "本次未收到回答。请查看提示，问题仍保留在输入框中。");
      throw e;
    } finally {
      if (requestEpoch === epoch) {
        aiPending = false;
        setAIControls();
      }
    }
  });
}
$("chat-send").onclick = sendAI;
async function refresh() {
  if (!token) return;
  clearTimeout(timer);
  if (busy) {
    refreshAgain = true;
    return;
  }
  const session = epoch,
    requested = selected;
  busy = true;
  try {
    const dashboard = await call(
      "/v1/dashboard" +
        (requested ? "?job=" + encodeURIComponent(requested) : ""),
    );
    jobs = dashboard.jobs || [];
    renderJobs();
    const w = dashboard.workers || [];
    $("worker-state").textContent = w.some((x) => x.online)
      ? "计算服务在线"
      : "计算服务暂未连接";
    if (requested && requested === selected && dashboard.detail?.id === requested)
      renderDetail(dashboard.detail);
    else if (requested === selected && requested) {
      const record = await call("/v1/jobs/" + encodeURIComponent(requested));
      if (selected === requested) renderDetail(record);
    }
    $("connection").textContent = "已连接";
  } catch (e) {
    if (session !== epoch) return;
    $("connection").textContent = "连接中断";
    notify("状态暂未更新：" + e.message, true);
  } finally {
    if (session !== epoch) return;
    busy = false;
    const active = jobs.some((j) => !END.has(j.status));
    const delay = refreshAgain
      ? 0
      : document.hidden
        ? 30000
        : active
          ? cfg.activeRefreshMs
          : cfg.idleRefreshMs;
    refreshAgain = false;
    timer = setTimeout(refresh, delay);
  }
}
$("refresh").onclick = refresh;
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

// Workspace navigation and presentation.
let aiEnabled = false,
  panelKind = null,
  chatVisible = true,
  refreshAgain = false;
const detailNames = new Map();
function closeSidebar() {
  $("sidebar").classList.remove("mobile-open");
  $("sidebar-backdrop").hidden = true;
}
function setLayout() {
  $("chat-panel").hidden = !chatVisible;
  $("side-panel").hidden = !panelKind;
  $("work-area").classList.toggle("has-panel", !!panelKind && chatVisible);
  $("work-area").classList.toggle("panel-only", !!panelKind && !chatVisible);
  for (const type of ["config", "tasks", "detail", "help"])
    $(type + "-panel").hidden = panelKind !== type;
  $("close-chat").hidden = !panelKind;
  const labels = {
    config: "配置新任务",
    tasks: "已提交任务",
    detail: "任务详情",
    help: "帮助与使用指南",
  };
  $("panel-title").textContent = labels[panelKind] || "";
  $("view-title").textContent = panelKind
    ? chatVisible
      ? "AI 对话 / " + labels[panelKind]
      : labels[panelKind]
    : "AI 对话";
  for (const type of ["chat", "config", "tasks", "help"]) {
    const active =
      type === "chat"
        ? !panelKind
        : type === "tasks"
          ? ["tasks", "detail"].includes(panelKind)
          : panelKind === type;
    $("nav-" + type).classList.toggle("active", active);
    $("nav-" + type).setAttribute("aria-current", active ? "page" : "false");
  }
}
function showChat(reset = false) {
  chatVisible = true;
  if (reset) panelKind = null;
  setLayout();
  closeSidebar();
}
function showPanel(kind) {
  panelKind = kind;
  if (kind === "help") chatVisible = false;
  setLayout();
  closeSidebar();
}
function selectTaskView(id) {
  const changed = selected !== id;
  selected = id;
  panelKind = id ? "detail" : "tasks";
  chatVisible = true;
  const attachment = $("ai-job-context");
  attachment.disabled = !aiJobContextEnabled || !id;
  if (changed) {
    detail = null;
    imageTask = null;
    for (const url of images) URL.revokeObjectURL(url);
    images = [];
    $("figures").replaceChildren();
    $("detail").hidden = true;
    $("detail-empty").hidden = false;
    $("detail-empty").textContent = id ? "正在读取任务…" : "尚未选择任务。";
    $("ai-job-status").textContent = id
      ? "已选择新任务，发送时将读取最新状态。"
      : "尚未选择已提交任务。";
    if (!id) attachment.checked = false;
  }
  setLayout();
  renderJobs();
  closeSidebar();
}
function setAIControls() {
  $("chat-send").disabled = !aiEnabled || aiPending;
  $("chat-send").title = "发送消息";
  $("chat-send").setAttribute("aria-label", $("chat-send").title);
  $("chat-input").disabled = !aiEnabled || aiPending;
  $("new-chat").disabled = aiPending;
  $("ai-source").disabled = aiPending;
  $("ai-model-settings").disabled = !aiEnabled || aiPending;
  $("chat-state").textContent = aiPending
    ? "正在思考…"
    : "Enter 发送 · Shift + Enter 换行";
}
function openAIModelDraft(spec) {
  try {
    const current = $("spec").value.trim();
    if (current && current !== JSON.stringify(spec, null, 2) &&
        !confirm("打开这份 AI 草案会替换当前编辑器中的内容。是否继续？"))
      return;
    writeSpec(spec);
    $("spec-editor").open = true;
    showPanel("config");
    notify("配置草案已打开，请检查后提交方案复核。");
  } catch (error) {
    notify(error.message, true);
  }
}
function renderChat(pending = null, error = null) {
  $("chat-welcome").hidden = chat.length > 0 || !!pending;
  const log = $("chat-log");
  log.replaceChildren();
  for (const m of [...chat, ...(pending ? [pending] : [])]) {
    const row = el("article", undefined, "chat-entry " + m.role),
      name = el("div", undefined, "message-author");
    if (m.role === "assistant") name.append(el("span", "◈", "mini-mark"));
    let author = "AutoLandscape";
    if (m.role === "user") author = "你";
    else if (m.aiSource === "platform") author = "平台 AI";
    else if (m.aiSource === "personal")
      author = m.providerLabel ? "个人 AI · " + m.providerLabel : "个人 AI";
    name.append(el("span", author));
    row.append(name);
    if (m.aiSource === "personal" && m.aiThinking)
      row.append(el("p", m.aiThinking, "small ai-reply-thinking"));
    const body = el("div", undefined, "message-body");
    if (m.role === "assistant") window.renderAssistant(body, m.content);
    else body.textContent = m.content;
    row.append(body);
    if (m.role === "assistant") {
      const copy = el("button", "复制回答", "message-copy");
      copy.onclick = () => window.copyText(m.content, copy);
      row.append(copy);
      if (m.draftSpec) {
        const create = el("button", "新建配置草案", "message-draft");
        create.type = "button";
        create.onclick = () => openAIModelDraft(m.draftSpec);
        row.append(create);
      }
    }
    log.append(row);
  }
  if (pending) log.append(el("div", "正在整理思路…", "pending-entry"));
  if (error) log.append(el("div", error, "failed-entry"));
  requestAnimationFrame(() => {
    $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
  });
}
$("nav-chat").onclick = () => showChat();
$("nav-config").onclick = () => {
  chatVisible = true;
  showPanel("config");
};
$("nav-tasks").onclick = () => {
  chatVisible = true;
  showPanel("tasks");
  refresh();
};
$("nav-help").onclick = () => showPanel("help");
$("close-chat").onclick = () => {
  chatVisible = false;
  setLayout();
};
$("close-panel").onclick = () => showChat(true);
$("new-chat").onclick = () => {
  if (aiPending) return;
  if (
    (chat.length || $("chat-input").value.trim()) &&
    !confirm(
      "当前仅保留一个临时对话。开始新对话将清空现有消息、未发送内容和配置建议，无法恢复。是否继续？",
    )
  )
    return;
  chat = [];
  setAIActionStatus("");
  saveSession();
  renderChat();
  $("chat-input").value = "";
};
$("context-info-toggle").onclick = () => {
  const open = $("context-info").hidden;
  $("context-info").hidden = !open;
  $("context-info-toggle").setAttribute("aria-expanded", String(open));
};
$("sidebar-toggle").onclick = () => {
  if (matchMedia("(max-width:800px)").matches) {
    $("sidebar").classList.toggle("mobile-open");
    $("sidebar-backdrop").hidden =
      !$("sidebar").classList.contains("mobile-open");
  } else $("workspace").classList.toggle("sidebar-collapsed");
};
$("sidebar-close").onclick = closeSidebar;
$("sidebar-backdrop").onclick = closeSidebar;
$("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("legacy-login").click();
});
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$("chat-send").disabled) $("chat-send").click();
  }
});
for (const b of document.querySelectorAll("[data-prompt]"))
  b.onclick = () => {
    $("chat-input").value = b.dataset.prompt;
    $("chat-input").focus();
  };
$("message").onclick = () => {
  $("message").hidden = true;
  clearTimeout(noticeTimer);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSidebar();
    $("user-menu").open = false;
  }
});

// Per-tab session: reloads retain login; only real user activity extends expiry.
const SESSION_KEY = "autolandscape.session.v1";
const IDLE_MS = 30 * 60 * 1000;
let lastActivity = 0,
  idleTimer = null,
  sessionActive = false;
function saveSession() {
  if (!sessionActive || !token) return;
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ token, lastActivity, chat }),
    );
  } catch {
    notify("浏览器无法保存本次会话，刷新后可能需要重新登录。", true);
  }
}
function expireSession() {
  $("logout").click();
  notify("已连续30分钟无操作，请重新登录。", true);
}
function scheduleIdleLogout() {
  clearTimeout(idleTimer);
  if (!sessionActive) return;
  const remaining = IDLE_MS - (Date.now() - lastActivity);
  if (remaining <= 0) return expireSession();
  idleTimer = setTimeout(scheduleIdleLogout, remaining);
}
function recordActivity(e) {
  if (!e.isTrusted || !sessionActive) return;
  if (Date.now() - lastActivity >= IDLE_MS) return expireSession();
  // Throttle storage writes, while always measuring the latest interaction.
  const previous = lastActivity;
  lastActivity = Date.now();
  if (lastActivity - previous > 1000 || e.type !== "pointermove") saveSession();
  scheduleIdleLogout();
}
for (const event of [
  "pointerdown",
  "pointermove",
  "keydown",
  "input",
  "wheel",
  "touchstart",
])
  document.addEventListener(event, recordActivity, {
    capture: true,
    passive: true,
  });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleIdleLogout();
});
window.addEventListener("pagehide", saveSession);
async function restoreSession() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {}
  if (!saved) return;
  if (
    typeof saved.token !== "string" ||
    !Number.isFinite(saved.lastActivity) ||
    Date.now() - saved.lastActivity >= IDLE_MS ||
    saved.lastActivity > Date.now()
  ) {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {}
    notify("登录已过期，请重新登录。", true);
    return;
  }
  saved.chat = Array.isArray(saved.chat)
    ? saved.chat.filter(
        (m) =>
          ["user", "assistant"].includes(m.role) &&
          typeof m.content === "string",
      )
    : [];
  await loginSession(saved);
  // Failed validation must not leave a remembered login or credentials behind.
  if (!sessionActive) {
    token = "";
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {}
  }
}
const accountActionURL = new URLSearchParams(location.hash.slice(1));
const accountActionQuery = new URLSearchParams(location.search);
if (!['verify','reset'].some(k => accountActionURL.has(k)||accountActionQuery.has(k))) restoreSession();
