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
  aiProposal = null,
  aiPending = false,
  aiDraftEnabled = false;
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
  const isAI = path === "/v1/ai/chat";
  const requestTimeoutMs = isAI ? 90000 : cfg.requestTimeoutMs;
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
      throw Error(b?.error?.message || `HTTP ${r.status}`);
    }
    const result = await r.json();
    if (session !== epoch) throw Error("SESSION_CHANGED");
    return result;
  } catch (e) {
    if (isAI && e.name === "AbortError") {
      throw Error(
        "AI响应等待超过90秒，网页已停止等待；服务可能仍在处理，本次额度状态尚不确定。请勿立即重复发送，也不要据此认为额度已退回。",
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
    if (session === epoch)
      notify(
        e.name === "AbortError"
          ? "请求超时。不要重复创建新任务；再次点击会使用同一请求编号。"
          : e.message,
        true,
      );
  } finally {
    button.disabled = false;
    if (button.id === "chat-send" || button.id === "ai-generate")
      setAIControls();
  }
}
function writeSpec(s) {
  $("spec").value = JSON.stringify(s, null, 2);
  $("project-name").value = s.project.name;
  $("description").value = s.project.description || "";
  $("timestep").value = s.solver.timestep;
  $("target-index").value = s.objective.target_index;
  $("initial-point").value = JSON.stringify(s.objective.initial_point);
  $("walltime").value = s.resources.walltime_seconds;
  $("memory").value = s.resources.memory_mb;
  $("cpu").value = s.resources.cpu_threads;
  draftKey = null;
}
function readSpec() {
  const s = JSON.parse($("spec").value);
  s.project.description = $("description").value;
  return s;
}
$("sync-form").onclick = () => {
  try {
    const s = readSpec();
    s.project.name = $("project-name").value;
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
$("load-template").onclick = () => {
  writeSpec(structuredClone(templates[$("template").value].spec));
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
$("login").onclick = () =>
  guarded($("login"), async () => {
    token = $("token").value.trim();
    const me = await call("/v1/me");
    templates = await call("/v1/templates");
    $("template").replaceChildren();
    for (const [k, v] of Object.entries(templates)) {
      const o = el("option", v.name);
      o.value = k;
      $("template").append(o);
    }
    writeSpec(structuredClone(Object.values(templates)[0].spec));
    $("token").value = "";
    $("login-panel").hidden = true;
    $("workspace").hidden = false;
    $("user-label").textContent = me.id;
    $("user-avatar").textContent = String(me.id).slice(0, 1).toUpperCase();
    aiEnabled = !!me.ai_enabled;
    $("connection").textContent = "已连接";
    $("ai-badge").textContent = me.ai_enabled ? "可用" : "暂不可用";
    $("chat-input").placeholder = me.ai_enabled
      ? "描述你的系统、计算目标，或询问参数含义。"
      : "AI 未启用时可先用模板。";
    $("chat-send").disabled = !me.ai_enabled;
    $("chat-input").disabled = !me.ai_enabled;
    $("ai-context").disabled =
      !me.ai_enabled ||
      me.ai_context_enabled !== true ||
      me.ai_context_version !== 2;
    $("ai-job-context").disabled =
      !me.ai_enabled || me.ai_job_context_enabled !== true;
    aiDraftEnabled = me.ai_enabled && me.ai_draft_enabled === true;
    $("ai-generate").disabled = !aiDraftEnabled;
    $("ai-context-note").textContent =
      me.ai_context_enabled === true && me.ai_context_version === 2
        ? "勾选后附带发送时的模板选择和编辑框草案。表单修改请先写入 JSON。"
        : "当前暂不支持附带草案，请联系管理员。";
    showChat(true);
    renderChat();
    setAIControls();
    if (!me.files_enabled) notify("当前可以查看结果摘要，文件下载暂不可用。");
    await refresh();
  });
$("logout").onclick = () => {
  epoch++;
  $("ai-job-context").checked = false;
  $("ai-job-context").disabled = true;
  $("ai-job-status").textContent = "本轮未附带已提交任务。";
  clearAIProposal();
  aiPending = false;
  aiDraftEnabled = false;
  $("ai-generate").disabled = true;
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
  $("ai-context").checked = false;
  $("ai-context").disabled = true;
  $("ai-context-status").textContent = "尚未发送本轮草案。";
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
    const s = readSpec();
    draftKey = draftKey || crypto.randomUUID();
    const j = await call(
      "/v1/jobs",
      "POST",
      { spec: s },
      { "Idempotency-Key": draftKey },
    );
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
    b.setAttribute("aria-current", selected === j.id ? "true" : "false");
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
      selectTaskView(j.id);
      refresh();
    };
    box.append(b);
    const card = el("button", undefined, "task-overview-row");
    card.append(
      el("strong", title),
      el("small", (T[j.status] || j.status) + " · " + date),
    );
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
function buildAIContext() {
  if (!$("ai-context").checked) return undefined;
  if ($("ai-context").disabled)
    throw Error("当前暂不支持附带草案，请联系管理员");
  let draft;
  try {
    draft = readSpec();
  } catch {
    throw Error("任务 JSON 无效，请先修正，或取消附带任务 JSON 后提问");
  }
  if (!draft || typeof draft !== "object" || Array.isArray(draft))
    throw Error("任务 JSON 必须是对象");
  if (new TextEncoder().encode(JSON.stringify(draft)).length > 16000)
    throw Error("任务 JSON 超过16KB，请精简，或取消附带任务 JSON 后提问");
  return { template_id: $("template").value, draft };
}
function aiFormSnapshot() {
  return JSON.stringify(
    [
      "project-name",
      "description",
      "timestep",
      "target-index",
      "initial-point",
      "walltime",
      "memory",
      "cpu",
    ].map((id) => $(id).value),
  );
}
function clearAIProposal() {
  aiProposal = null;
  $("ai-proposal").hidden = true;
  $("ai-proposal-json").textContent = "";
  $("ai-proposal-changes").textContent = "";
  $("ai-apply").disabled = true;
}
async function sendAI(mode) {
  const button = mode === "draft" ? $("ai-generate") : $("chat-send");
  const requestEpoch = epoch;
  return guarded(button, async () => {
    if (aiPending) throw Error("请等待当前AI请求完成");
    const msg = $("chat-input").value.trim();
    if (!msg) return;
    if (!$("ai-consent").checked) throw Error("请先勾选允许发送给外部模型");
    if (mode === "draft" && !aiDraftEnabled)
      throw Error("当前暂不支持生成草案，请联系管理员");
    if (mode === "draft" && !$("ai-context").checked)
      throw Error("生成草案需要勾选附带当前模板与任务 JSON");
    let jobId;
    if ($("ai-job-context").checked) {
      if ($("ai-job-context").disabled)
        throw Error("当前暂不支持读取任务，请联系管理员");
      if (mode === "draft")
        throw Error("附带已提交任务仅用于普通对话，请取消勾选后生成草案");
      if (!selected) throw Error("请先在任务列表选择一个已提交任务");
      jobId = selected;
    }
    const context = buildAIContext();
    const baseSnapshot = context ? JSON.stringify(context.draft) : null,
      formSnapshot = aiFormSnapshot();
    if (mode === "draft") clearAIProposal();
    const pending = { role: "user", content: msg };
    $("ai-context-status").textContent = context
      ? "正在发送本轮草案，等待确认。"
      : "本轮未附带任务 JSON。";
    $("ai-job-status").textContent = jobId
      ? "正在读取选中任务 " + jobId + "，等待确认。"
      : "本轮未附带已提交任务。";
    aiPending = true;
    setAIControls();
    renderChat(pending);
    try {
      const r = await call("/v1/ai/chat", "POST", {
        mode,
        messages: [...chat, pending].slice(-8),
        allow_external: true,
        ...(context ? { context } : {}),
        ...(jobId ? { job_id: jobId } : {}),
      });
      if (context) {
        if (r.context_attached !== true || !r.context_receipt)
          throw Error("本轮草案未成功读取，请重新选择附带草案后再试");
        const v = r.context_receipt;
        $("ai-context-status").textContent =
          "本轮已附带草案：模型 " +
          JSON.stringify(v.model_id) +
          "，维数 " +
          JSON.stringify(v.dimension) +
          "，目标指标 " +
          JSON.stringify(v.target_index);
      }
      if (jobId) {
        if (r.job_receipt?.task_id !== jobId)
          throw Error("选中任务未成功读取，请重新选择任务后再试");
        $("ai-job-status").textContent =
          "本轮已附带任务：" +
          r.job_receipt.task_id +
          " · " +
          (T[r.job_receipt.status] || r.job_receipt.status) +
          " · 读取时间 " +
          r.job_receipt.captured_at;
      }
      if (mode === "draft") {
        if (!r.proposal?.spec || !Array.isArray(r.proposal.changes))
          throw Error("未收到有效配置草案，请稍后再试");
        if (r.proposal.changes.length) {
          aiProposal = { spec: r.proposal.spec, baseSnapshot, formSnapshot };
          $("ai-proposal-changes").textContent = r.proposal.changes
            .map(
              (c) =>
                c.path +
                "：" +
                JSON.stringify(c.before) +
                " → " +
                JSON.stringify(c.after),
            )
            .join("\n");
          $("ai-proposal-json").textContent = JSON.stringify(
            r.proposal.spec,
            null,
            2,
          );
          $("ai-proposal").hidden = false;
          $("ai-apply").disabled = false;
        } else notify("本次没有参数改动，请查看助手说明。");
      }
      chat.push(pending, { role: "assistant", content: r.message });
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
$("chat-send").onclick = () => sendAI("chat");
$("ai-generate").onclick = () => sendAI("draft");
$("ai-apply").onclick = () => {
  try {
    if (!aiProposal) return;
    if (
      JSON.stringify(readSpec()) !== aiProposal.baseSnapshot ||
      aiFormSnapshot() !== aiProposal.formSnapshot
    )
      throw Error("生成后当前配置已改变，请重新生成草案，避免覆盖你的新修改");
    writeSpec(structuredClone(aiProposal.spec));
    clearAIProposal();
    showPanel("config");
    notify("AI 草案已应用，请检查后提交方案复核。");
  } catch (e) {
    notify(e.message, true);
  }
};
$("ai-discard").onclick = clearAIProposal;
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
    if (requested === selected && dashboard.detail?.id === requested)
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

// Workspace navigation and presentation. Authentication remains in page memory.
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
  panelKind = "detail";
  chatVisible = true;
  if (changed) {
    detail = null;
    $("detail").hidden = true;
    $("detail-empty").hidden = false;
    $("detail-empty").textContent = "正在读取任务…";
    $("ai-job-status").textContent = "已选择新任务，发送时将读取最新状态。";
  }
  setLayout();
  renderJobs();
  closeSidebar();
}
function setAIControls() {
  $("chat-send").disabled = !aiEnabled || aiPending;
  $("ai-generate").disabled = !aiDraftEnabled || aiPending;
  $("chat-input").disabled = !aiEnabled || aiPending;
  $("new-chat").disabled = aiPending;
  $("chat-state").textContent = aiPending
    ? "正在思考…"
    : "Enter 发送 · Shift + Enter 换行";
}
function renderChat(pending = null, error = null) {
  $("chat-welcome").hidden = chat.length > 0 || !!pending;
  const log = $("chat-log");
  log.replaceChildren();
  for (const m of [...chat, ...(pending ? [pending] : [])]) {
    const row = el("article", undefined, "chat-entry " + m.role),
      name = el("div", undefined, "message-author");
    if (m.role === "assistant") name.append(el("span", "◈", "mini-mark"));
    name.append(el("span", m.role === "user" ? "你" : "AutoLandscape"));
    row.append(name);
    const body = el("div", undefined, "message-body");
    if (m.role === "assistant") window.renderAssistant(body, m.content);
    else body.textContent = m.content;
    row.append(body);
    if (m.role === "assistant") {
      const copy = el("button", "复制回答", "message-copy");
      copy.onclick = () => window.copyText(m.content, copy);
      row.append(copy);
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
  chat = [];
  clearAIProposal();
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
  if (e.key === "Enter") $("login").click();
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
