"use strict";

const $ = (id) => document.getElementById(id);
const statusNames = { uploading: "准备上传", ready: "待处理", queued: "排队中", running: "处理中", completed: "已完成", failed: "处理失败", interrupted: "已中断", cancelled: "已取消" };
const fileStatusNames = { pending: "等待上传", uploading: "上传中", uploaded: "已上传", failed: "上传失败", local: "待确认" };
const state = { config: null, batches: [], batch: null, selectedFiles: [], selectedId: null, filePage: 0, fileErrors: new Map(), verifiedFiles: new Set(), busy: null, pauseRequested: false, transientMessages: [], toolMessages: [], polling: false, lastUploadRender: 0, revision: 0, templates: [], ruleKey: null, mappingRows: [], sheetCheckboxes: [], preview: null, editingFile: null, draftRules: null };
const PAGE_SIZE = 15;
let pollTimer;
const replacementPaths = new WeakMap();
let rulesDirty = false, ruleBatchId = null, rulesSnapshot = '';
let taskRenderKey = '';
function markRulesDirty() { rulesDirty = true; renderControls(); }

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function formatBytes(bytes) {
  const number = Number(bytes) || 0;
  if (number < 1024) return `${number} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = number / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(value, includeDate = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", includeDate ? { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(date);
}

function showError(message) {
  $("error-text").textContent = message;
  $("error-banner").hidden = false;
}

function clearError() { $("error-banner").hidden = true; }

function setConnection(connected) {
  $("connection-dot").className = `connection-dot ${connected ? "online" : "offline"}`;
  $("connection-dot").title = connected ? "本地服务已连接" : "服务连接异常";
  $("connection-label").textContent = connected ? "本地服务已连接" : "服务连接异常";
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error("无法连接本地服务，请确认服务仍在运行。已上传文件可在重新连接后继续查看。"); }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`服务返回了无法读取的响应（${response.status}）。`); }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）。`);
  setConnection(true);
  return payload;
}

function jsonOptions(method, payload) { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }; }
function pathForBatch() { return `/api/batches/${encodeURIComponent(state.selectedId)}`; }
function fileKey(file) { return `${file.relativePath || file.name}\u0000${file.size}`; }
function localEntry(file) { return { name: file.name, relativePath: replacementPaths.get(file) || file.webkitRelativePath || file.name, size: file.size, lastModified: file.lastModified }; }
function isLocked() { return Boolean(state.busy); }
function canAddFiles() { return Boolean(state.batch && ["uploading", "ready", "failed", "interrupted", "cancelled"].includes(state.batch.status) && state.batch.checkState !== "checking" && !isLocked()); }
function processingFiles() { return (state.batch?.files || []).filter((file) => !file.excluded); }
function rememberBatch(id) { try { localStorage.setItem("work-agent:selected-batch", id); } catch { /* 本地存储不可用时不影响任务执行。 */ } }
function currentSelectionReady() { return !state.fileErrors.size && state.selectedFiles.every((file) => state.batch?.files?.some((entry) => entry.relativePath === localEntry(file).relativePath && entry.excluded) || state.verifiedFiles.has(fileKey(localEntry(file)))); }

function summaryText(summary) {
  if (typeof summary === "string") return summary;
  if (!summary || typeof summary !== "object") return "";
  const labels = { fileCount: "输入文件", sheetCount: "工作表", recordCount: "合并记录", outputCount: "结果文件", cachedCount: "复用输入" };
  const lines = [];
  for (const key of ["message", "description"]) if (typeof summary[key] === "string" && summary[key]) lines.push(summary[key]);
  const counts = Object.entries(labels).filter(([key]) => Number.isFinite(summary[key])).map(([key, label]) => `${label} ${summary[key].toLocaleString("zh-CN")}`);
  if (counts.length) lines.push(counts.join(" · "));
  if (Array.isArray(summary.excluded) && summary.excluded.length) lines.push(`已排除 ${summary.excluded.length} 份文件，原因见下载报告。`);
  if (summary.template?.name) lines.push(`使用模板：${summary.template.name} · v${summary.template.version}`);
  if (summary.rules?.columns?.length) lines.push(`结果字段：${summary.rules.columns.join("、")}`);
  const other = Object.fromEntries(Object.entries(summary).filter(([key]) => !(key in labels) && !["message", "description", "excluded", "duplicates", "rules", "ruleVersion", "template"].includes(key)));
  if (Object.keys(other).length) {
    const text = JSON.stringify(other, null, 2);
    lines.push(`其他统计：\n${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`);
  }
  return lines.join("\n");
}

function renderTasks() {
  const key = JSON.stringify([state.selectedId, isLocked(), state.batches.map((batch) => [batch.id, batch.name, batch.status, batch.createdAt])]);
  if (key === taskRenderKey) return;
  taskRenderKey = key;
  const list = $("task-list");
  list.replaceChildren();
  if (!state.batches.length) { list.append(node("div", "sidebar-empty", "暂无任务记录\n创建第一批订单合并任务。")); return; }
  for (const batch of state.batches) {
    const button = node("button", `task-item${batch.id === state.selectedId ? " active" : ""}`);
    button.type = "button";
    button.disabled = isLocked();
    if (batch.id === state.selectedId) button.setAttribute("aria-current", "true");
    button.append(node("span", "task-item-name", batch.name));
    const bottom = node("span", "task-item-bottom");
    bottom.append(node("span", `task-dot ${batch.status}`), node("span", "", statusNames[batch.status] || batch.status), node("span", "task-item-time", formatTime(batch.createdAt, true)));
    button.append(bottom);
    button.addEventListener("click", () => selectBatch(batch.id));
    list.append(button);
  }
}

function renderPhase() {
  const batch = state.batch;
  if (!batch) return;
  let title = statusNames[batch.status] || batch.status;
  let message = batch.progress?.message || "";
  let count = "";
  let percent = 0;
  let indeterminate = false;
  if (batch.checkState === "checking") {
    title = "正在检查输入";
    if (batch.progress?.total > 0) { percent = batch.progress.current / batch.progress.total * 100; count = `${batch.progress.current} / ${batch.progress.total}`; }
    else indeterminate = true;
  } else if (state.busy === "upload") {
    title = state.pauseRequested ? "正在暂停上传" : "正在上传并核对文件";
    const files = batch.files || [];
    const uploadedBytes = files.reduce((sum, file) => sum + (file.bytesReceived || 0), 0);
    percent = batch.totalBytes ? Math.min(100, uploadedBytes / batch.totalBytes * 100) : 0;
    count = `${state.verifiedFiles.size} / ${state.selectedFiles.length} 已核对`;
    message = state.pauseRequested ? "当前分片结束后暂停；已上传部分会保留。" : `已传输 ${formatBytes(uploadedBytes)}。使用 SHA-256 核对完整内容，最多同时处理 ${state.config?.maxUploadConcurrency || 3} 份。`;
  } else if (["failed", "interrupted"].includes(batch.checkState) && !batch.preflight && !batch.error) {
    title = batch.checkState === "interrupted" ? "输入检查已中断" : "输入检查失败";
    message = batch.progress?.message || "请重试输入检查，已保存的成功检查点会保留。";
  } else if (batch.status === "uploading") {
    title = "准备输入文件";
    message = batch.fileCount ? `已登记 ${batch.fileCount} 份文件，重新选择原文件夹可继续上传。` : "选择文件夹后，检查清单并确认上传。";
    percent = batch.totalBytes ? Math.min(100, batch.uploadedBytes / batch.totalBytes * 100) : 0;
  } else if (batch.status === "ready") {
    title = "文件已就绪";
    message = state.config?.workflowConfigured ? batch.preflight?.ok ? "检查通过，可以按已确认字段规则开始合并。" : "输入已上传，请完成处理前检查并确认字段规则。" : state.config?.executorConfigured ? "输入文件已上传完成，可以开始合并。" : "输入文件已上传完成。接入现有 Python 合并脚本后，即可执行处理。";
  } else if (["running", "queued"].includes(batch.status)) {
    if (!["exporting", "validating"].includes(batch.progress?.phase) && Number.isFinite(batch.progress?.total) && batch.progress.total > 0 && Number.isFinite(batch.progress?.current)) {
      percent = Math.min(100, Math.max(0, batch.progress.current / batch.progress.total * 100));
      count = `${batch.progress.current} / ${batch.progress.total}`;
    } else indeterminate = true;
  } else if (batch.status === "completed") {
    percent = 100;
    const summaryMessage = summaryText(batch.summary);
    message = summaryMessage || message || "处理已结束，结果文件可在右侧下载。";
  } else if (batch.error) message = batch.error;
  $("phase-title").textContent = title;
  $("phase-message").textContent = message || "任务状态以执行器返回结果为准。";
  $("phase-count").textContent = count;
  $("phase-icon").textContent = batch.status === "completed" ? "✓" : ["failed", "interrupted"].includes(batch.status) ? "!" : "↗";
  $("progress-bar").style.width = `${percent}%`;
  $("progress-bar").parentElement.classList.toggle("indeterminate", indeterminate);
  $("executor-note").textContent = state.config?.workflowConfigured ? "已确认字段规则 · 保留来源，无业务去重" : state.config?.executorConfigured ? "Python 执行器已接入" : "待接入 Python 合并脚本";
}

function renderMessages() {
  const list = $("message-list");
  const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  list.replaceChildren();
  const messages = [...(state.batch?.messages || []), ...state.transientMessages];
  if (!messages.length) {
    const empty = node("div", "chat-empty");
    empty.append(node("span", "agent-avatar", "π"));
    const text = node("div");
    text.append(node("strong", "", "按已确认规则协作"), node("p", "", "先在检查面板确认字段映射，再让智能体查询状态、启动合并或解释结果。聊天中的新规则需要先保存到处理配置。"));
    empty.append(text); list.append(empty);
  }
  for (const message of messages) {
    const role = ["user", "assistant"].includes(message.role) ? message.role : "system";
    const item = node("article", `message ${role}`);
    item.append(node("span", "message-avatar", role === "assistant" ? "π" : role === "user" ? "我" : "!"));
    const body = node("div", "message-body");
    const label = node("div", "message-label");
    label.append(node("span", "", role === "assistant" ? "工作智能体" : role === "user" ? "你" : "服务提示"), node("time", "", formatTime(message.at)));
    body.append(label, node("div", `message-content${message.streaming ? " streaming-cursor" : ""}`, typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    item.append(body); list.append(item);
  }
  $("chat-tools").hidden = !state.toolMessages.length;
  $("chat-tools").textContent = state.toolMessages.join("\n");
  if (wasAtBottom || state.busy === "chat") list.scrollTop = list.scrollHeight;
}

function combinedFiles() {
  const remote = state.batch?.files || [];
  const byKey = new Map(remote.map((file) => [file.relativePath, file]));
  const localKeys = new Set(state.selectedFiles.map((file) => localEntry(file).relativePath));
  return [...state.selectedFiles.map((file) => {
    const entry = localEntry(file);
    const matched = byKey.get(entry.relativePath);
    if (matched && (matched.size !== file.size || (matched.lastModified && matched.lastModified !== file.lastModified))) return { ...entry, id: matched.id, status: "local", bytesReceived: 0, changed: true, excluded: matched.excluded };
    return matched || { ...entry, status: "local", bytesReceived: 0 };
  }), ...remote.filter((file) => !localKeys.has(file.relativePath))];
}

function renderFiles() {
  const files = combinedFiles();
  $("input-count").textContent = files.length.toLocaleString("zh-CN");
  const selectedSize = state.selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const summary = $("selection-summary");
  summary.replaceChildren();
  summary.hidden = !state.selectedFiles.length;
  if (state.selectedFiles.length) {
    summary.append(document.createTextNode("本次选择 "), node("strong", "", state.selectedFiles.length.toLocaleString("zh-CN")), document.createTextNode(` 份 · ${formatBytes(selectedSize)}`));
    summary.append(node("small", "", state.busy === "upload" ? "正在传输并核对本次选择，请保持页面打开。" : currentSelectionReady() ? "当前选择已完成内容核对，输入文件保留在本批次。" : "确认后开始上传。已有文件会通过完整内容核对匹配续传。"));
  }
  const search = $("file-search").value.trim().toLowerCase(), filter = $("file-filter").value;
  const failedIds = new Set((state.batch?.preflight?.issues || []).map((issue) => issue.fileId));
  const visibleFiles = files.filter((file) => (file.relativePath || file.name).toLowerCase().includes(search) && (filter === "all" || filter === "active" && !file.excluded || filter === "excluded" && file.excluded || filter === "failed" && (failedIds.has(file.id) || state.fileErrors.has(fileKey(file))) || filter === "pending" && file.status !== "uploaded" && !file.excluded));
  const pageCount = Math.ceil(visibleFiles.length / PAGE_SIZE);
  state.filePage = Math.max(0, Math.min(state.filePage, pageCount - 1));
  const list = $("file-list"); list.replaceChildren();
  for (const file of visibleFiles.slice(state.filePage * PAGE_SIZE, (state.filePage + 1) * PAGE_SIZE)) {
    const key = fileKey(file);
    const row = node("div", "file-row");
    row.append(node("span", "file-icon", "XLSX"));
    const info = node("div", "file-info");
    const name = node("span", "file-name", file.name); name.title = file.relativePath || file.name;
    const percent = file.size ? Math.min(100, Math.round((file.bytesReceived || 0) / file.size * 100)) : 0;
    info.append(name, node("span", "file-detail", `${file.relativePath || file.name} · ${file.status === "uploading" ? `${percent}%` : formatBytes(file.size)}`));
    if (file.excluded) info.append(node("small", "file-exclusion", file.exclusionReason || "已排除"));
    const status = state.fileErrors.has(key) ? "failed" : file.status;
    row.append(info, node("span", `file-state ${status}`, file.excluded ? "已排除" : failedIds.has(file.id) ? "检查异常" : file.changed ? "文件已变化" : fileStatusNames[status] || status));
    const actions = node("div", "file-row-actions");
    const addAction = (label, action) => { const button = node("button", "file-action", label); button.type = "button"; button.disabled = !canAddFiles(); button.addEventListener("click", () => editInput(file, action)); actions.append(button); };
    addAction("移除", "remove");
    if (file.id) { addAction(file.excluded ? "恢复" : "排除", file.excluded ? "include" : "exclude"); addAction(file.changed ? "确认替换" : "替换", "replace"); }
    row.append(actions);
    list.append(row);
  }
  $("file-pagination").hidden = pageCount <= 1;
  $("file-page-label").textContent = `${state.filePage + 1} / ${pageCount} · ${visibleFiles.length} 份`;
  $("file-prev").disabled = state.filePage === 0;
  $("file-next").disabled = state.filePage >= pageCount - 1;
  const errors = new Map(state.fileErrors);
  for (const file of files) if (file.status === "failed" && !errors.has(fileKey(file))) errors.set(fileKey(file), { name: file.relativePath || file.name, message: file.error || "上传失败，请重新选择原文件夹后继续上传。" });
  $("upload-errors").hidden = !errors.size;
  $("upload-error-summary").textContent = `${errors.size} 份文件上传失败`;
  $("upload-error-list").replaceChildren(...[...errors.values()].map((error) => node("li", "", `${error.name}：${error.message}`)));
  $("upload-actions").hidden = !state.selectedFiles.length;
  const uploadedSelection = state.selectedFiles.length && currentSelectionReady();
  $("upload-files").textContent = state.busy === "upload" ? "正在上传 / 核对…" : uploadedSelection ? "已核对完成" : "确认上传 / 核对续传";
  $("upload-files").disabled = !canAddFiles() || Boolean(uploadedSelection);
  $("pause-upload").hidden = state.busy !== "upload";
  $("pause-upload").disabled = state.pauseRequested;
  $("pause-upload").textContent = state.pauseRequested ? "正在暂停…" : "暂停上传";
  $("choose-folder").disabled = !canAddFiles();
  $("choose-files").disabled = !canAddFiles();
  $("file-help").textContent = !state.batch ? "先新建一个任务，再添加文件。" : state.busy === "upload" ? "上传期间请保持此页面打开。暂停后可继续上传。" : ["running", "queued"].includes(state.batch.status) || state.batch.checkState === "checking" ? "任务检查或执行中，输入文件已锁定。" : state.batch.status === "completed" ? "本批次已完成，新一批文件请新建任务。" : "可移除误选文件、填写原因排除，或替换同路径的新版本；修改后重新检查。";
}

function renderOutputs() {
  const outputs = state.batch?.outputs || [];
  $("output-count").textContent = outputs.length;
  const list = $("output-list"); list.replaceChildren();
  if (!outputs.length) {
    const empty = node("div", "empty-output");
    empty.append(node("span", "", "↙"), node("p", "", "处理完成后，结果会出现在这里。")); list.append(empty); return;
  }
  for (const output of outputs) {
    const item = node("div", "output-item");
    const info = node("div"); info.append(node("strong", "", output.name), node("small", "", formatBytes(output.size)));
    item.append(info);
    if (/\.xlsx$/i.test(output.name)) { const preview = node("button", "file-action", "预览"); preview.type = "button"; preview.addEventListener("click", () => openPreview(output)); item.append(preview); }
    try {
      const url = new URL(output.url, location.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== location.origin) throw new Error("无效的下载地址");
      const link = node("a", "output-download", "↓");
      link.href = url.href; link.download = output.name; link.title = `下载 ${output.name}`; link.setAttribute("aria-label", `下载 ${output.name}`);
      item.append(link);
    } catch { item.append(node("small", "", "下载地址不可用")); }
    list.append(item);
  }
  if (state.batch?.validation?.ok) list.prepend(node("p", "validation-note", `已验收 · ${state.batch.validation.recordCount.toLocaleString("zh-CN")} 条记录 · 工作簿可读`));
}

function resultColumns() { return $("result-columns").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean); }

function renderRuleEditor() {
  const report = state.batch?.preflight || state.batch?.lastPreflight;
  const rules = state.draftRules || state.batch?.rules || { columns: [], mappings: [], sheetNames: [] };
  const columns = resultColumns();
  const schemas = [...(report?.schemas || [])];
  for (const item of rules.mappings) if (!schemas.some((schema) => JSON.stringify([...schema.headers].sort()) === JSON.stringify([...item.headers].sort()))) schemas.push({ headers: item.headers, count: 0 });
  state.mappingRows = [];
  const list = $("schema-list"); list.replaceChildren();
  for (const schema of schemas) {
    const card = node("section", "schema-card");
    card.append(node("strong", "", `来源字段组合 · ${schema.count || 0} 张工作表`));
    const configured = rules.mappings.find((item) => JSON.stringify([...item.headers].sort()) === JSON.stringify([...schema.headers].sort()));
    const targets = [];
    for (const header of schema.headers) {
      const row = node("label", "mapping-row"); row.append(node("span", "", header), node("span", "mapping-arrow", "→"));
      const select = node("select"); select.setAttribute("aria-label", `${header} 的结果字段`);
      const placeholder = node("option", "", "请选择映射"); placeholder.value = "__unmapped__"; select.append(placeholder);
      const ignored = node("option", "", "忽略此列"); ignored.value = ""; select.append(ignored);
      for (const name of columns) { const option = node("option", "", name); option.value = name; select.append(option); }
      const configuredTarget = configured && Object.hasOwn(configured.targets, header) ? configured.targets[header] : columns.includes(header) ? header : "__unmapped__";
      select.value = configuredTarget === null ? "" : columns.includes(configuredTarget) ? configuredTarget : "__unmapped__";
      select.disabled = !canAddFiles(); row.append(select); card.append(row); targets.push({ header, select });
      select.addEventListener("change", markRulesDirty);
    }
    if (schema.sample?.length) card.append(node("p", "schema-sample", `示例：${schema.sample[0].map((value) => value ?? "空").join(" · ")}`));
    list.append(card); state.mappingRows.push({ headers: schema.headers, targets });
  }
  if (!schemas.length) list.append(node("p", "review-description", "先检查输入以发现字段组合，或应用已保存的模板。"));
  const names = new Set(report?.files?.flatMap((file) => file.sheets.map((sheet) => sheet.name)) || []);
  for (const name of rules.sheetNames) names.add(name);
  state.sheetCheckboxes = [];
  const sheets = $("sheet-list"); sheets.replaceChildren();
  for (const name of names) {
    const label = node("label", "sheet-choice"), input = node("input"); input.type = "checkbox"; input.checked = !rules.sheetNames.length || rules.sheetNames.includes(name); input.disabled = !canAddFiles();
    label.append(input, document.createTextNode(name)); sheets.append(label); state.sheetCheckboxes.push({ name, input });
    input.addEventListener("change", markRulesDirty);
  }
}

function collectRules() {
  const columns = resultColumns();
  if (new Set(columns).size !== columns.length) throw new Error("结果字段不能重复。");
  const mappings = state.mappingRows.map((row) => {
    if (row.targets.some((item) => item.select.value === "__unmapped__")) throw new Error("请为所有来源字段选择结果字段或明确忽略。");
    return { headers: row.headers, targets: Object.fromEntries(row.targets.map((item) => [item.header, item.select.value || null])) };
  });
  const selected = state.sheetCheckboxes.filter((item) => item.input.checked).map((item) => item.name);
  if (state.sheetCheckboxes.length && !selected.length) throw new Error("请至少选择一张工作表。");
  return { columns, mappings, sheetNames: selected.length === state.sheetCheckboxes.length ? [] : selected };
}

function renderReview() {
  const batch = state.batch, enabled = state.config?.workflowConfigured;
  $("review-panel").hidden = !batch;
  if (!batch) return;
  const report = batch.preflight || batch.lastPreflight, checking = batch.checkState === "checking", stale = !batch.preflight && Boolean(report);
  $("check-badge").textContent = checking ? "检查中" : stale ? "输入已更新 · 待检查" : report?.ok ? "检查通过" : batch.checkState === "failed" ? "存在异常" : "待检查";
  $("check-description").textContent = !enabled ? "当前自定义脚本提供合并与成果验收。字段模板和局部解析重试需接入本项目的检查点协议。" : checking ? "逐文件检查全部数据行，成功解析会保留。关闭页面后后台检查继续。" : report ? `${stale ? "上次检查：" : ""}成功 ${report.successCount} 份 · 异常 ${report.failedCount} 份 · 已排除 ${report.excluded.length} 份。复用 ${report.cachedCount} 份检查点。` : "上传后检查工作表、字段和全部数据行。修正异常后可复用已成功解析的文件。";
  $("check-batch").disabled = !enabled || !canAddFiles() || !currentSelectionReady() || !processingFiles().length || processingFiles().some((file) => file.status !== "uploaded");
  $("check-batch").textContent = checking ? "正在检查…" : report?.ok ? "重新检查" : "检查输入";
  $("retry-check").hidden = !report?.failedCount; $("retry-check").disabled = $("check-batch").disabled;
  $("download-check").hidden = !batch.preflight; $("download-check").href = `${pathForBatch()}/check-report`;
  $("check-metrics").hidden = !report;
  $("check-metrics").replaceChildren(...(report ? [`${report.fileCount} 份参与处理`, `${report.recordCount.toLocaleString("zh-CN")} 条有效记录`, `${report.sheetCount} 张工作表`].map((text) => node("span", "", text)) : []));
  $("check-warnings").hidden = !report?.duplicates?.length;
  $("check-warnings").textContent = report?.duplicates?.length ? `发现内容相同的文件组：${report.duplicates.map((group) => group.join("、")).join("；")}。请核对是否重复导出；当前不会自动去重。` : "";
  $("rule-caption").textContent = batch.template ? `${batch.template.name} · v${batch.template.version}` : "本批次配置";
  const key = `${batch.id}:${batch.inputRevision || 0}:${batch.checkState}`;
  if (key !== state.ruleKey) {
    const snapshot = JSON.stringify(batch.rules || { columns: [], mappings: [], sheetNames: [] });
    const preserveDraft = rulesDirty && ruleBatchId === batch.id && snapshot === rulesSnapshot;
    if (preserveDraft) {
      const selected = state.sheetCheckboxes.filter((item) => item.input.checked).map((item) => item.name);
      state.draftRules = { columns: resultColumns(), mappings: state.mappingRows.map((row) => ({ headers: row.headers, targets: Object.fromEntries(row.targets.map((item) => [item.header, item.select.value || null])) })), sheetNames: selected.length === state.sheetCheckboxes.length ? [] : selected };
    } else {
      state.draftRules = structuredClone(batch.rules || { columns: [], mappings: [], sheetNames: [] });
      $("result-columns").value = (state.draftRules.columns.length ? state.draftRules.columns : report?.columns || []).join("\n"); rulesDirty = false;
    }
    state.ruleKey = key; ruleBatchId = batch.id; rulesSnapshot = snapshot;
    renderRuleEditor();
  }
  for (const id of ["result-columns", "template-select", "template-name", "refresh-mapping", "save-rules", "save-template", "apply-template"]) $(id).disabled = !enabled || !canAddFiles();
  $("save-rules").disabled = $("check-batch").disabled;
  for (const row of state.mappingRows) for (const target of row.targets) target.select.disabled = !enabled || !canAddFiles();
  for (const item of state.sheetCheckboxes) item.input.disabled = !enabled || !canAddFiles();
  const issues = $("check-issues"); issues.replaceChildren(); issues.hidden = !report?.issues?.length;
  if (report?.issues?.length) {
    issues.append(node("strong", "", `${report.issues.length} 份异常输入`));
    for (const issue of report.issues) {
      const card = node("div", "issue-card"); card.append(node("strong", "", issue.relativePath), node("p", "", `${issue.sheet || "工作簿"}${issue.row ? ` · 第 ${issue.row} 行` : ""}：${issue.message}`));
      const locate = node("button", "file-action", "定位文件"); locate.addEventListener("click", () => { $("file-search").value = issue.relativePath; $("file-filter").value = "all"; state.filePage = 0; renderFiles(); $("file-search").focus(); }); card.append(locate); issues.append(card);
    }
  }
}

async function loadTemplates() {
  state.templates = (await api("/api/templates")).templates;
  const previous = $("template-select").value, select = $("template-select");
  select.replaceChildren(); const empty = node("option", "", "选择一个模板版本"); empty.value = ""; select.append(empty);
  for (const template of [...state.templates].reverse()) { const option = node("option", "", `${template.name} · v${template.version}`); option.value = template.id; select.append(option); }
  select.value = previous;
}

async function runCheck(saveRules = false) {
  if (!canAddFiles() || $("check-batch").disabled) return;
  if (rulesDirty && !saveRules) { showError("有尚未确认的规则更改，请点击“确认规则并检查”。"); return; }
  let rules;
  try { if (saveRules) rules = collectRules(); } catch (error) { showError(error.message); return; }
  state.revision += 1; state.busy = "check"; clearError(); renderBatch(); renderTasks();
  try {
    if (rules) { state.batch = (await api(`${pathForBatch()}/rules`, jsonOptions("PUT", { rules }))).batch; rulesDirty = false; }
    state.batch = (await api(`${pathForBatch()}/check`, { method: "POST" })).batch;
  } catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); renderTasks(); }
}

async function applyTemplate() {
  if (!canAddFiles() || !$("template-select").value) return;
  state.revision += 1; state.busy = "rules"; clearError(); renderBatch();
  try { state.batch = (await api(`${pathForBatch()}/rules`, jsonOptions("PUT", { templateId: $("template-select").value }))).batch; rulesDirty = false; }
  catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); }
}

async function saveTemplate() {
  if (!canAddFiles()) return;
  let rules;
  try { rules = collectRules(); } catch (error) { showError(error.message); return; }
  state.revision += 1; state.busy = "rules"; clearError(); renderBatch();
  try {
    const { template } = await api("/api/templates", jsonOptions("POST", { name: $("template-name").value.trim(), rules }));
    state.batch = (await api(`${pathForBatch()}/rules`, jsonOptions("PUT", { templateId: template.id }))).batch;
    rulesDirty = false;
    await loadTemplates(); $("template-select").value = template.id;
  } catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); }
}

async function changeInput(file, action, payload = {}) {
  if (!canAddFiles()) return;
  state.revision += 1; state.busy = "edit"; clearError(); renderBatch(); renderTasks();
  try {
    state.batch = (await api(`${pathForBatch()}/files/${file.id}`, action === "remove" ? { method: "DELETE" } : jsonOptions("PATCH", { action, ...payload }))).batch;
    state.fileErrors.delete(fileKey(file));
    if (action === 'remove' || action === 'replace') state.verifiedFiles.delete(fileKey(file));
    if (action === "remove") state.selectedFiles = state.selectedFiles.filter((local) => localEntry(local).relativePath !== file.relativePath);
    if (action === "replace") {
      state.selectedFiles = state.selectedFiles.filter((local) => localEntry(local).relativePath !== file.relativePath);
      replacementPaths.set(payload.localFile, file.relativePath); state.selectedFiles.push(payload.localFile);
    }
    $("exclude-dialog").close();
  } catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); renderTasks(); }
}

function editInput(file, action) {
  if (!canAddFiles()) return;
  if (!file.id) { state.selectedFiles = state.selectedFiles.filter((local) => localEntry(local).relativePath !== file.relativePath); state.fileErrors.delete(fileKey(file)); state.verifiedFiles.delete(fileKey(file)); renderBatch(); return; }
  if (action === "exclude") { state.editingFile = file; $("exclude-file-name").textContent = file.relativePath; $("exclude-reason").value = ""; $("exclude-dialog").showModal(); $("exclude-reason").focus(); }
  else if (action === "replace") {
    const local = state.selectedFiles.find((entry) => localEntry(entry).relativePath === file.relativePath);
    if (file.changed && local) replaceInput(file, local);
    else { state.editingFile = file; $("replacement-input").click(); }
  } else changeInput(file, action);
}

function replaceInput(file, local) {
  if (local.name !== file.name || !local.size || local.size > 256 * 1024 * 1024) { showError("请选择同名且大于 0、不超过 256MB 的 XLSX 文件。"); return; }
  changeInput(file, "replace", { name: local.name, relativePath: file.relativePath, size: local.size, lastModified: local.lastModified, localFile: local });
}

function openPreview(output) {
  state.preview = { output, offset: 0, sheet: null, revision: 0 };
  $("preview-title").textContent = output.name; $("preview-dialog").showModal(); fetchPreview();
}

async function fetchPreview() {
  const current = state.preview, revision = ++current.revision;
  $("preview-prev").disabled = true; $("preview-next").disabled = true; $("preview-sheet").disabled = true; $("preview-error").hidden = true;
  $("preview-table").replaceChildren(node("p", "review-description", "正在读取成果…"));
  try {
    const url = new URL(current.output.url + "/preview", location.origin); url.searchParams.set("offset", current.offset); if (current.sheet) url.searchParams.set("sheet", current.sheet);
    const { preview } = await api(url.pathname + url.search);
    if (state.preview !== current || current.revision !== revision) return;
    current.sheet = preview.sheet;
    const select = $("preview-sheet"); select.replaceChildren(...preview.sheetNames.map((name) => { const option = node("option", "", name); option.value = name; return option; })); select.value = preview.sheet; select.disabled = false;
    const table = node("table"), head = node("thead"), header = node("tr"), body = node("tbody");
    header.append(...preview.headers.map((name) => node("th", "", name))); head.append(header); table.append(head);
    for (const row of preview.rows) { const tr = node("tr"); tr.append(...row.map((value) => node("td", "", value ?? ""))); body.append(tr); } table.append(body);
    $("preview-table").replaceChildren(table);
    $("preview-range").textContent = preview.rows.length ? `第 ${current.offset + 1}–${current.offset + preview.rows.length} 条 · 每页 25 条` : "本页无记录";
    $("preview-prev").disabled = current.offset === 0; $("preview-next").disabled = !preview.hasMore || current.offset >= 1000000;
  } catch (error) { if (state.preview === current) { $("preview-error").textContent = error.message; $("preview-error").hidden = false; $("preview-table").replaceChildren(); } }
}

function renderEvents() {
  const events = state.batch?.events || [];
  $("event-count").textContent = events.length;
  const list = $("event-list"); list.replaceChildren();
  for (const event of [...events].reverse()) {
    const item = node("li"); item.append(node("time", "", formatTime(event.at)), node("span", "", event.message)); list.append(item);
  }
  if (!events.length) list.append(node("li", "", "暂无活动记录。"));
}

function renderControls() {
  for (const id of ["new-batch", "new-batch-bottom", "welcome-create"]) $(id).disabled = isLocked();
  const batch = state.batch;
  const filesReady = processingFiles().length > 0 && processingFiles().every((file) => file.status === "uploaded");
  const selectionReady = currentSelectionReady() && !rulesDirty;
  const checkReady = !state.config?.workflowConfigured || batch?.preflight?.ok && batch.preflight.inputRevision === (batch.inputRevision || 0);
  const canStart = batch && ["ready", "failed", "interrupted", "cancelled"].includes(batch.status) && batch.checkState !== "checking" && checkReady && filesReady && selectionReady && state.config?.executorConfigured && !isLocked();
  $("start-batch").disabled = !canStart;
  $("start-batch").textContent = state.busy === "start" ? "正在启动…" : ["failed", "interrupted", "cancelled"].includes(batch?.status) ? "重新合并 ↗" : "开始合并 ↗";
  $("start-batch").title = !state.config?.executorConfigured ? "待接入 Python 合并脚本" : rulesDirty ? "请先确认规则更改并重新检查" : !selectionReady || state.fileErrors.size ? "请先确认本次选择并完成文件核对" : !filesReady ? "请先完成所有输入文件的上传" : !checkReady ? "请先检查输入并修正异常" : "";
  $("cancel-batch").hidden = !batch || !["running", "queued"].includes(batch.status);
  $("cancel-batch").disabled = isLocked();
  $("cancel-batch").textContent = state.busy === "cancel" ? "正在取消…" : "取消执行";
  const agentReady = state.config?.agentConfigured;
  $("chat-input").disabled = !batch || !agentReady || !selectionReady || isLocked();
  $("send-message").disabled = !batch || !agentReady || !selectionReady || isLocked() || !$("chat-input").value.trim();
  $("send-message").title = state.busy === "chat" ? "智能体正在响应" : "发送消息";
  $("agent-note").textContent = rulesDirty ? "先确认字段规则更改" : !selectionReady ? "先核对并上传当前选择" : !agentReady ? "尚未配置模型 · 订单执行器可独立运行" : state.busy === "chat" ? "智能体正在响应…" : "Enter 发送 · Shift + Enter 换行";
  $("chat-input").placeholder = rulesDirty ? "确认规则并重新检查后，再与智能体协作。" : !selectionReady ? "先核对并上传当前选择，再与智能体协作。" : agentReady ? "查询状态，或按已确认规则启动合并…" : "配置模型后，可查询状态、启动合并和解释结果。";
}

function renderBatch() {
  const batch = state.batch;
  const selecting = state.busy === "select";
  $("welcome").hidden = Boolean(batch) || selecting;
  $("active-work").hidden = !batch;
  $("batch-status").hidden = !batch;
  $("batch-metrics").hidden = !batch;
  $("batch-title").textContent = batch?.name || (selecting ? state.batches.find((item) => item.id === state.selectedId)?.name || "正在读取任务" : "把订单汇到一张表");
  $("batch-subtitle").textContent = selecting ? "正在读取任务详情…" : batch ? "订单合并 · 输入、执行和结果都保留在本批次。" : "创建任务，选择订单文件夹，再开始批量处理。";
  if (batch) {
    const index = state.batches.findIndex((item) => item.id === batch.id);
    if (index >= 0) state.batches[index] = batch;
    $("batch-status").className = `status-pill ${batch.status}`;
    $("batch-status").textContent = statusNames[batch.status] || batch.status;
    $("metric-files").textContent = (batch.fileCount || 0).toLocaleString("zh-CN");
    $("metric-size").textContent = formatBytes(batch.totalBytes);
    $("metric-time").textContent = `创建于 ${formatTime(batch.createdAt, true)}`;
    renderPhase(); renderMessages(); renderEvents();
  }
  renderFiles(); renderOutputs(); renderReview(); renderControls();
}

async function refreshBatch(expectedRevision, force = false) {
  if (!state.selectedId) return;
  const selectedId = state.selectedId;
  const payload = await api(`/api/batches/${encodeURIComponent(selectedId)}`);
  if (state.selectedId === selectedId && (expectedRevision === undefined || expectedRevision === state.revision)) {
    if (!force && state.batch?.updatedAt === payload.batch.updatedAt) return;
    state.batch = payload.batch;
    const index = state.batches.findIndex((batch) => batch.id === selectedId);
    if (index >= 0) state.batches[index] = payload.batch;
    renderBatch(); renderTasks();
  }
}

async function selectBatch(id) {
  if (isLocked() || id === state.selectedId) return;
  clearError();
  state.revision += 1;
  state.busy = "select";
  state.selectedId = id; state.batch = null; state.selectedFiles = []; state.fileErrors.clear(); state.verifiedFiles.clear(); state.transientMessages = []; state.toolMessages = []; state.filePage = 0;
  $("file-search").value = ""; $("file-filter").value = "all";
  $("chat-input").value = "";
  renderBatch(); renderTasks();
  try { await refreshBatch(); rememberBatch(id); }
  catch (error) { showError(error.message); setConnection(false); }
  finally { state.busy = null; renderBatch(); renderTasks(); }
}

function openCreateDialog() {
  if (isLocked()) return;
  const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date());
  $("batch-name").value = `${date}订单合并`;
  $("create-dialog").showModal(); $("batch-name").select();
}

async function createBatch(event) {
  event.preventDefault();
  const name = $("batch-name").value.trim();
  if (!name || isLocked()) return;
  state.revision += 1;
  state.busy = "create"; $("create-submit").disabled = true; $("create-submit").textContent = "正在创建…";
  $("close-dialog").disabled = true; $("cancel-dialog").disabled = true;
  renderControls(); clearError();
  try {
    const payload = await api("/api/batches", jsonOptions("POST", { name }));
    state.batch = payload.batch; state.selectedId = payload.batch.id;
    state.selectedFiles = []; state.fileErrors.clear(); state.verifiedFiles.clear(); state.filePage = 0; state.transientMessages = []; state.toolMessages = [];
    $("file-search").value = ""; $("file-filter").value = "all";
    $("chat-input").value = ""; state.batches.unshift(payload.batch);
    rememberBatch(payload.batch.id);
    $("create-dialog").close();
  } catch (error) { showError(error.message); }
  finally {
    state.busy = null; $("create-submit").disabled = false; $("create-submit").textContent = "创建任务";
    $("close-dialog").disabled = false; $("cancel-dialog").disabled = false; renderBatch(); renderTasks();
  }
}

function selectFiles(event) {
  if (!canAddFiles()) { event.target.value = ""; return; }
  const all = [...event.target.files];
  state.selectedFiles = all.filter((file) => /\.xlsx$/i.test(file.name) && !file.name.startsWith("~$"));
  state.fileErrors.clear(); state.verifiedFiles.clear(); state.filePage = 0; event.target.value = "";
  if (all.length > state.selectedFiles.length) showError(`已忽略 ${all.length - state.selectedFiles.length} 份其他格式或 Excel 临时文件。`);
  else clearError();
  if (!state.selectedFiles.length && !all.length) return;
  if (!state.selectedFiles.length) showError("所选文件中没有 .xlsx 文件，请选择订单导出文件所在的文件夹。");
  for (const file of state.selectedFiles) if (!file.size || file.size > 256 * 1024 * 1024) state.fileErrors.set(fileKey(localEntry(file)), { name: localEntry(file).relativePath, message: "文件需大于 0 且不超过 256MB，请移除此项或更换文件。" });
  renderFiles(); renderControls();
}

function updateUploadView(force = false) {
  if (!force && Date.now() - state.lastUploadRender < 160) return;
  state.lastUploadRender = Date.now();
  state.batch.fileCount = (state.batch.files || []).length;
  state.batch.totalBytes = (state.batch.files || []).reduce((sum, file) => sum + file.size, 0);
  state.batch.uploadedBytes = (state.batch.files || []).reduce((sum, file) => sum + (file.bytesReceived || 0), 0);
  renderPhase(); renderFiles();
  $("metric-files").textContent = state.batch.fileCount.toLocaleString("zh-CN");
  $("metric-size").textContent = formatBytes(state.batch.totalBytes);
}

async function uploadOne(file) {
  const entry = localEntry(file);
  const key = fileKey(entry);
  const files = state.batch.files || (state.batch.files = []);
  let remote = files.find((item) => fileKey(item) === key);
  try {
    if (!remote) {
      remote = (await api(`${pathForBatch()}/files`, jsonOptions("POST", entry))).file;
      const existingIndex = files.findIndex((item) => item.id === remote.id);
      if (existingIndex >= 0) files[existingIndex] = remote; else files.push(remote);
    }
    let offset = remote.bytesReceived || 0;
    const chunkSize = state.config?.chunkSize || 4194304;
    if (remote.status !== "uploaded") remote.status = "uploading";
    while (offset < file.size && !state.pauseRequested) {
      const end = Math.min(file.size, offset + chunkSize);
      const payload = await api(`${pathForBatch()}/files/${encodeURIComponent(remote.id)}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, end) });
      if (!Number.isFinite(payload.bytesReceived) || payload.bytesReceived <= offset || payload.bytesReceived > file.size) throw new Error("服务返回的上传位置无效，请暂停后重新继续上传。");
      offset = payload.bytesReceived; remote.bytesReceived = offset; updateUploadView();
    }
    if (offset === file.size) {
      if (!window.crypto?.subtle) throw new Error("当前浏览器环境无法计算文件校验值。请通过 localhost 打开本地页面，再继续上传。");
      const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const completed = await api(`${pathForBatch()}/files/${encodeURIComponent(remote.id)}/complete`, jsonOptions("POST", { sha256 }));
      Object.assign(remote, completed.file); state.fileErrors.delete(key); state.verifiedFiles.add(key);
    }
  } catch (error) {
    state.verifiedFiles.delete(key);
    state.fileErrors.set(key, { name: entry.relativePath, message: error.message });
  }
  updateUploadView(true);
}

async function uploadFiles() {
  if (!canAddFiles() || !state.selectedFiles.length) return;
  if (state.selectedFiles.some((file) => !file.size || file.size > 256 * 1024 * 1024)) { showError("请先移除大小不符合要求的文件。"); return; }
  if (combinedFiles().some((file) => file.changed)) { showError("请先对变化的文件点击“确认替换”，再上传。"); return; }
  state.revision += 1;
  state.busy = "upload"; state.pauseRequested = false; state.fileErrors.clear(); clearError(); renderBatch(); renderTasks();
  try {
    await refreshBatch();
    const manifest = await api(`${pathForBatch()}/manifest`, jsonOptions("POST", { files: state.selectedFiles.map(localEntry) }));
    state.batch = manifest.batch;
    if (!state.batch.files) state.batch.files = manifest.files;
    updateUploadView(true);
    const files = state.selectedFiles.filter((file) => !state.batch.files.some((entry) => entry.relativePath === localEntry(file).relativePath && entry.excluded));
    let next = 0;
    const worker = async () => {
      while (next < files.length && !state.pauseRequested) {
        const file = files[next]; next += 1; await uploadOne(file);
      }
    };
    const concurrency = Math.max(1, Math.min(state.config?.maxUploadConcurrency || 3, 3));
    await Promise.all(Array.from({ length: concurrency }, worker));
    await refreshBatch();
    if (state.fileErrors.size) showError(`${state.fileErrors.size} 份文件未完成上传。请查看右侧失败明细，可保留当前选择并继续上传。`);
  } catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); renderTasks(); }
}

async function batchAction(action) {
  if (!state.batch || isLocked()) return;
  if (action === "start" && $("start-batch").disabled) return;
  state.revision += 1;
  state.busy = action; clearError(); renderControls(); renderTasks(); renderFiles(); renderReview();
  try {
    const payload = await api(`${pathForBatch()}/${action}`, { method: "POST" });
    state.batch = payload.batch;
    await refreshBatch();
  } catch (error) { showError(error.message); }
  finally { state.busy = null; renderBatch(); renderTasks(); }
}

async function sendMessage(event) {
  event.preventDefault();
  const message = $("chat-input").value.trim();
  if (!message || !state.batch || !state.config?.agentConfigured || !currentSelectionReady() || isLocked()) return;
  state.revision += 1;
  state.busy = "chat"; state.toolMessages = []; clearError();
  const answer = { role: "assistant", content: "", at: new Date().toISOString(), streaming: true };
  state.transientMessages = [{ role: "user", content: message, at: new Date().toISOString() }, answer];
  $("chat-input").value = ""; renderMessages(); renderControls(); renderTasks(); renderFiles();
  let streamError;
  let doneReceived = false;
  try {
    const response = await fetch(`${pathForBatch()}/chat`, jsonOptions("POST", { message }));
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
      const payload = await response.json(); throw new Error(payload.error || "智能体服务未返回有效的流式响应。");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line) => {
      if (!line.trim()) return;
      const item = JSON.parse(line);
      if (item.type === "text") answer.content += item.delta || "";
      else if (item.type === "tool") state.toolMessages.push(`${item.name || "工具"} · ${item.message || "正在执行"}`);
      else if (item.type === "done") { if (typeof item.text === "string") answer.content = item.text; doneReceived = true; }
      else if (item.type === "error") throw new Error(item.message || "智能体响应中断。");
      renderMessages();
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) consume(line);
        if (done) { if (buffer.trim()) consume(buffer); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!doneReceived) throw new Error("智能体连接已结束，但未收到完成确认。请查看任务记录后再重试。");
  } catch (error) {
    streamError = error.message || "智能体连接失败。"; showError(streamError);
    if (!answer.content) $("chat-input").value = message;
  } finally {
    answer.streaming = false;
    try { await refreshBatch(); state.transientMessages = []; }
    catch (error) { showError(`${streamError ? `${streamError} ` : ""}${error.message}`); }
    state.busy = null; renderMessages(); renderControls(); renderTasks(); renderFiles();
  }
}

async function poll() {
  clearTimeout(pollTimer);
  if (state.polling) return;
  state.polling = true;
  try {
    if (!state.busy) {
      const revision = state.revision;
      const [config, payload] = await Promise.all([api("/api/config"), api("/api/batches")]);
      if (revision !== state.revision || state.busy) return;
      const configChanged = JSON.stringify(state.config) !== JSON.stringify(config);
      state.config = config; state.batches = payload.batches; renderTasks();
      if (state.selectedId) await refreshBatch(revision, configChanged);
      else renderBatch();
    }
  } catch (error) { setConnection(false); showError(error.message); }
  finally { state.polling = false; pollTimer = setTimeout(poll, 3000); }
}

async function initialize() {
  renderBatch();
  try {
    const [config, batches] = await Promise.all([api("/api/config"), api("/api/batches")]);
    state.config = config; state.batches = batches.batches;
    await loadTemplates();
    let previousId;
    try { previousId = localStorage.getItem("work-agent:selected-batch"); } catch { /* 页面仍可在禁用本地存储时使用。 */ }
    const initialBatch = state.batches.find((batch) => batch.id === previousId) || state.batches[0];
    if (initialBatch) await selectBatch(initialBatch.id);
    else renderTasks();
    renderBatch();
  } catch (error) { setConnection(false); showError(error.message); $("task-list").replaceChildren(node("div", "sidebar-empty", "无法读取任务记录。请检查本地服务。")); }
  pollTimer = setTimeout(poll, 3000);
}

for (const id of ["new-batch", "new-batch-bottom", "welcome-create"]) $(id).addEventListener("click", openCreateDialog);
for (const id of ["close-dialog", "cancel-dialog"]) $(id).addEventListener("click", () => { if (!isLocked()) $("create-dialog").close(); });
$("create-dialog").addEventListener("cancel", (event) => { if (isLocked()) event.preventDefault(); });
$("create-form").addEventListener("submit", createBatch);
$("dismiss-error").addEventListener("click", clearError);
$("choose-folder").addEventListener("click", () => $("folder-input").click());
$("choose-files").addEventListener("click", () => $("files-input").click());
$("folder-input").addEventListener("change", selectFiles);
$("files-input").addEventListener("change", selectFiles);
$("upload-files").addEventListener("click", uploadFiles);
$("pause-upload").addEventListener("click", () => { state.pauseRequested = true; renderPhase(); renderFiles(); });
$("file-search").addEventListener("input", () => { state.filePage = 0; renderFiles(); });
$("file-filter").addEventListener("change", () => { state.filePage = 0; renderFiles(); });
$("result-columns").addEventListener("input", markRulesDirty);
$("check-batch").addEventListener("click", () => runCheck());
$("retry-check").addEventListener("click", () => runCheck());
$("save-rules").addEventListener("click", () => runCheck(true));
$("refresh-mapping").addEventListener("click", () => { state.draftRules = { ...state.draftRules, mappings: state.mappingRows.map((row) => ({ headers: row.headers, targets: Object.fromEntries(row.targets.filter((item) => item.select.value !== "__unmapped__").map((item) => [item.header, item.select.value || null])) })) }; renderRuleEditor(); markRulesDirty(); });
$("apply-template").addEventListener("click", applyTemplate);
$("save-template").addEventListener("click", saveTemplate);
$("exclude-cancel").addEventListener("click", () => $("exclude-dialog").close());
$("exclude-form").addEventListener("submit", (event) => { event.preventDefault(); changeInput(state.editingFile, "exclude", { reason: $("exclude-reason").value.trim() }); });
$("replacement-input").addEventListener("change", (event) => { const file = event.target.files[0]; event.target.value = ""; if (file) replaceInput(state.editingFile, file); });
$("preview-close").addEventListener("click", () => { state.preview = null; $("preview-dialog").close(); });
$("preview-dialog").addEventListener("cancel", () => { state.preview = null; });
$("preview-sheet").addEventListener("change", () => { state.preview.sheet = $("preview-sheet").value; state.preview.offset = 0; fetchPreview(); });
$("preview-prev").addEventListener("click", () => { state.preview.offset = Math.max(0, state.preview.offset - 25); fetchPreview(); });
$("preview-next").addEventListener("click", () => { state.preview.offset += 25; fetchPreview(); });
$("file-prev").addEventListener("click", () => { state.filePage -= 1; renderFiles(); });
$("file-next").addEventListener("click", () => { state.filePage += 1; renderFiles(); });
$("start-batch").addEventListener("click", () => batchAction("start"));
$("cancel-batch").addEventListener("click", () => batchAction("cancel"));
$("chat-form").addEventListener("submit", sendMessage);
$("chat-input").addEventListener("input", renderControls);
$("chat-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("send-message").disabled) $("chat-form").requestSubmit(); } });
window.addEventListener("beforeunload", (event) => { if (state.busy === "upload" || state.busy === "chat") { event.preventDefault(); event.returnValue = ""; } });
initialize();
