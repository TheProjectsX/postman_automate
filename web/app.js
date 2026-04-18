const runForm = document.querySelector("#runForm");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const resetBtn = document.querySelector("#resetBtn");
const statusBadge = document.querySelector("#statusBadge");
const cwdText = document.querySelector("#cwdText");
const logsPre = document.querySelector("#logs");
const logCount = document.querySelector("#logCount");
const logsToggleBtn = document.querySelector("#logsToggleBtn");
const logsContent = document.querySelector("#logsContent");
const resultBox = document.querySelector("#resultBox");
const routeCount = document.querySelector("#routeCount");
const routeTimeline = document.querySelector("#routeTimeline");
const routeToggleBtn = document.querySelector("#routeToggleBtn");
const routeContent = document.querySelector("#routeContent");
const processCount = document.querySelector("#processCount");
const processTimeline = document.querySelector("#processTimeline");
const processToggleBtn = document.querySelector("#processToggleBtn");
const processContent = document.querySelector("#processContent");
const collectionFileInput = document.querySelector("#collectionFile");
const workflowFileInput = document.querySelector("#workflowFile");

const promptDialog = document.querySelector("#promptDialog");
const promptForm = document.querySelector("#promptForm");
const promptQuestion = document.querySelector("#promptQuestion");
const promptValue = document.querySelector("#promptValue");
const promptToggleBtn = document.querySelector("#promptToggleBtn");
const promptNoInputBtn = document.querySelector("#promptNoInputBtn");

let activePrompt = null;
let promptMinimized = false;
let promptShouldFocus = false;
let lastLogsCursor = "";
let lastRouteCursor = "";
let latestLogs = [];
let activeRouteId = null;
let logsCollapsed = false;
let routeTimelineCollapsed = false;
let processTimelineCollapsed = false;
let lastExportedCollectionPath = null;

const safe = (value) => (value === undefined || value === null ? "" : String(value));

const toUploadPayload = async (file) => {
  if (!file) return undefined;
  const content = await file.text();
  return {
    name: file.name,
    content,
  };
};

const toPayload = async (formData) => {
  const collectionFile = collectionFileInput?.files?.[0];
  const workflowFile = workflowFileInput?.files?.[0];

  if (!collectionFile) {
    throw new Error("Please choose a collection JSON file.");
  }

  const body = {
    collectionFile: await toUploadPayload(collectionFile),
    workflowFile: await toUploadPayload(workflowFile),
    context: safe(formData.get("context")).trim() || undefined,
    delay: safe(formData.get("delay")).trim() || undefined,
    timeout: safe(formData.get("timeout")).trim() || undefined,
    skip: safe(formData.get("skip")).trim() || undefined,
    only: safe(formData.get("only")).trim() || undefined,
    dry: formData.get("dry") === "on",
  };

  return body;
};

const api = {
  async getState() {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error("Failed to load state.");
    return res.json();
  },

  async startRun(payload) {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start run.");
    return data;
  },

  async answerPrompt(promptId, value) {
    const res = await fetch("/api/prompt/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptId, value }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to submit prompt answer.");
  },

  async resetState() {
    const res = await fetch("/api/reset", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to reset state.");
    return data;
  },

  async stopRun() {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to stop run.");
    return data;
  },

  async downloadCollection(filePath) {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to download collection.");
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filePath.split("/").pop() || "collection.json";
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  },
};

const escapeHtml = (input) => {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

const formatRunTimestamp = (iso) => {
  if (!iso) return "-";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return String(iso);
  }

  return date.toLocaleString();
};

const formatDuration = (startedAt, endedAt) => {
  if (!startedAt) return "-";

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "-";

  const diffMs = end - start;
  const totalSec = Math.floor(diffMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  if (min === 0) {
    return `${sec}s`;
  }

  return `${min}m ${sec}s`;
};

const formatStatCount = (value) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric < 0) {
    return "00";
  }

  return String(Math.floor(numeric)).padStart(2, "0");
};

const renderResult = (state) => {
  const startedAt = formatRunTimestamp(state.startedAt);
  const endedAt = formatRunTimestamp(state.endedAt);
  const duration = formatDuration(state.startedAt, state.endedAt);

  // Reset download tracking
  lastExportedCollectionPath = null;

  if (state.lastError) {
    resultBox.innerHTML = `
      <div class="status-stats-grid">
        <article class="status-stat"><span>Total</span><strong>00</strong></article>
        <article class="status-stat success"><span>Success</span><strong>00</strong></article>
        <article class="status-stat failed"><span>Failed</span><strong>00</strong></article>
        <article class="status-stat muted"><span>Skipped</span><strong>00</strong></article>
        <article class="status-stat warning"><span>Errors</span><strong>00</strong></article>
      </div>
      <div class="status-alert error">${escapeHtml(state.lastError)}</div>
      <div class="status-meta-grid">
        <div><span>Started</span><strong>${escapeHtml(startedAt)}</strong></div>
        <div><span>Ended</span><strong>${escapeHtml(endedAt)}</strong></div>
        <div><span>Duration</span><strong>${escapeHtml(duration)}</strong></div>
      </div>
    `;
    return;
  }

  if (!state.lastResult) {
    resultBox.innerHTML = `
      <div class="status-stats-grid">
        <article class="status-stat"><span>Total</span><strong>00</strong></article>
        <article class="status-stat success"><span>Success</span><strong>00</strong></article>
        <article class="status-stat failed"><span>Failed</span><strong>00</strong></article>
        <article class="status-stat muted"><span>Skipped</span><strong>00</strong></article>
        <article class="status-stat warning"><span>Errors</span><strong>00</strong></article>
      </div>
      <div class="status-empty">No completed run yet. Start a run to see execution metrics.</div>
      <div class="status-meta-grid">
        <div><span>Started</span><strong>${escapeHtml(startedAt)}</strong></div>
        <div><span>Ended</span><strong>${escapeHtml(endedAt)}</strong></div>
        <div><span>Duration</span><strong>${escapeHtml(duration)}</strong></div>
      </div>
    `;
    return;
  }

  const r = state.lastResult;
  const pathRows = [
    ["Generated workflow", r.workflowPathGenerated],
    ["Used workflow", r.workflowPathUsed],
    ["Exported collection", r.exportedCollectionPath],
    ["Updated workflow", r.updatedWorkflowPath],
    ["Failed logs", r.failedLogsDir],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => {
      // Add download button for exported collection
      if (label === "Exported collection" && value) {
        lastExportedCollectionPath = value;
        return `
        <div class="status-row status-row-with-action">
          <div class="status-row-content">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
          </div>
          <button type="button" class="download-btn" data-file-path="${escapeHtml(String(value))}">Download</button>
        </div>`;
      }
      return `
      <div class="status-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
      </div>`;
    })
    .join("");

  resultBox.innerHTML = `
    <div class="status-stats-grid">
      <article class="status-stat"><span>Total</span><strong>${escapeHtml(formatStatCount(r.stats.total))}</strong></article>
      <article class="status-stat success"><span>Success</span><strong>${escapeHtml(formatStatCount(r.stats.success))}</strong></article>
      <article class="status-stat failed"><span>Failed</span><strong>${escapeHtml(formatStatCount(r.stats.failed))}</strong></article>
      <article class="status-stat muted"><span>Skipped</span><strong>${escapeHtml(formatStatCount(r.stats.skipped))}</strong></article>
      <article class="status-stat warning"><span>Errors</span><strong>${escapeHtml(formatStatCount(r.stats.errors))}</strong></article>
    </div>
    <div class="status-meta-grid">
      <div><span>Started</span><strong>${escapeHtml(startedAt)}</strong></div>
      <div><span>Ended</span><strong>${escapeHtml(endedAt)}</strong></div>
      <div><span>Duration</span><strong>${escapeHtml(duration)}</strong></div>
    </div>
    <div class="status-paths">
      ${pathRows}
    </div>
  `;

  // Attach click event to download button if it exists
  const downloadBtn = resultBox.querySelector(".download-btn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const filePath = downloadBtn.getAttribute("data-file-path");
      if (!filePath) {
        alert("No collection path available.");
        return;
      }

      try {
        await api.downloadCollection(filePath);
      } catch (error) {
        alert(String(error.message || error));
      }
    });
  }
};

const renderLogs = (logs) => {
  const cursor = logs.length
    ? `${logs.length}:${logs[logs.length - 1].id}:${logs[logs.length - 1].timestamp}`
    : "0";

  if (cursor === lastLogsCursor) {
    return;
  }

  lastLogsCursor = cursor;
  logCount.textContent = `${logs.length} lines`;
  logsPre.textContent = logs
    .map((line) => `[${line.timestamp}] [${line.source}] [${line.level}] ${line.message}`)
    .join("\n");

  if (!logsCollapsed && logsContent) {
    logsContent.style.maxHeight = `${logsContent.scrollHeight}px`;
  }
};

const tryParseJson = (input) => {
  const text = String(input ?? "").trim();
  if (!text) return null;

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return null;
  }
};

const highlightJson = (input) => {
  const tokenPattern = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:])/g;
  const text = String(input ?? "");
  let output = "";
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index || 0;
    output += escapeHtml(text.slice(lastIndex, index));

    let className = "json-punctuation";
    if (token.startsWith('"')) {
      className = token.endsWith(":") ? "json-key" : "json-string";
    } else if (token === "true" || token === "false") {
      className = "json-boolean";
    } else if (token === "null") {
      className = "json-null";
    } else if (/^-?\d/.test(token)) {
      className = "json-number";
    }

    output += `<span class="${className}">${escapeHtml(token)}</span>`;
    lastIndex = index + token.length;
  }

  output += escapeHtml(text.slice(lastIndex));
  return output;
};

const renderJsonBlock = (value, fallback = "(no data)") => {
  const parsed = tryParseJson(value);

  if (parsed === null) {
    const text = String(value ?? "").trim();
    return escapeHtml(text || fallback).replaceAll("\n", "<br />");
  }

  const pretty = JSON.stringify(parsed.value, null, 2);
  return highlightJson(pretty);
};

const parseRouteFromUrl = (url) => {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    return parsed.pathname || "/";
  } catch {
    return url;
  }
};

const buildRouteTimeline = (logs) => {
  const entries = [];
  let current = null;

  const consoleLogs = logs.filter((line) => line.source === "console");
  for (const line of consoleLogs) {
    const msg = String(line.message || "");

    const executeMatch = msg.match(/^Executing \[([^\]]+)\] ->\s+(.+)$/);
    if (executeMatch) {
      const method = executeMatch[1].trim().toUpperCase();
      const fullUrl = executeMatch[2].trim();

      current = {
        id: `${line.id}`,
        startedAt: line.timestamp,
        method,
        fullUrl,
        routePath: parseRouteFromUrl(fullUrl),
        requestHeaders: "",
        requestBody: "",
        responseStatus: "pending",
        responseBody: "",
        state: "running",
      };
      entries.push(current);
      continue;
    }

    if (!current) continue;

    if (msg.startsWith("Headers: ")) {
      current.requestHeaders = msg.slice("Headers: ".length);
      continue;
    }

    if (msg.startsWith("Body: ")) {
      current.requestBody = msg.slice("Body: ".length);
      continue;
    }

    const responseMatch = msg.match(/^Response: \[(\d+)\]\s+(.+)$/);
    if (responseMatch) {
      const code = Number(responseMatch[1]);
      current.responseStatus = `${responseMatch[1]} ${responseMatch[2]}`;
      current.state = code >= 200 && code < 300 ? "success" : "failed";
      continue;
    }

    if (msg.startsWith("Full Response: ")) {
      current.responseBody = msg.slice("Full Response: ".length);
      continue;
    }

    if (msg.startsWith("Execution Failed:")) {
      current.responseStatus = msg;
      current.state = "failed";
      continue;
    }
  }

  return entries;
};

const processKeywords = [
  { keyword: "collection loaded", label: "Collection Loaded" },
  { keyword: "collection parsed", label: "Collection Parsed" },
  { keyword: "workflow generated", label: "Workflow Generated" },
  { keyword: "workflow loaded", label: "Workflow Loaded" },
  { keyword: "ai process", label: "AI Processing" },
  { keyword: "routes execution", label: "Routes Execution" },
  { keyword: "routes executed", label: "Routes Executed" },
  { keyword: "collection exported", label: "Collection Exported" },
  { keyword: "processing complete", label: "Processing Complete" },
  { keyword: "execution complete", label: "Execution Complete" },
  { keyword: "migration generated", label: "Migration Generated" },
  { keyword: "started", label: "Started" },
  { keyword: "completed", label: "Completed" },
];

const buildProcessTimeline = (logs) => {
  const entries = [];
  const processedMessages = new Set();

  for (const log of logs) {
    const msg = String(log.message || "").toLowerCase();
    
    for (const { keyword, label } of processKeywords) {
      if (msg.includes(keyword) && !processedMessages.has(`${log.id}:${keyword}`)) {
        processedMessages.add(`${log.id}:${keyword}`);
        
        let icon = "⚙️";
        if (msg.includes("complete") || msg.includes("executed")) {
          icon = "✓";
        } else if (msg.includes("started")) {
          icon = "▶";
        } else if (msg.includes("loaded") || msg.includes("parsed")) {
          icon = "📦";
        } else if (msg.includes("exported")) {
          icon = "💾";
        } else if (msg.includes("ai")) {
          icon = "🤖";
        }

        entries.push({
          id: `${log.id}`,
          timestamp: log.timestamp,
          label,
          icon,
          message: log.message,
          level: log.level,
        });
        break;
      }
    }
  }

  return entries;
};

const renderProcessTimeline = (logs) => {
  const cursor = logs.length
    ? `${logs.length}:${logs[logs.length - 1].id}:${logs[logs.length - 1].timestamp}`
    : "0";

  const processes = buildProcessTimeline(logs);
  processCount.textContent = `${processes.length} steps`;

  if (!processes.length) {
    processTimeline.innerHTML = '<p class="timeline-empty">No process events yet.</p>';
    return;
  }

  processTimeline.innerHTML = processes
    .map((process) => {
      return `
        <div class="process-step">
          <div class="process-icon">${process.icon}</div>
          <div class="process-info">
            <div class="process-label">${escapeHtml(process.label)}</div>
            <div class="process-time">${escapeHtml(process.timestamp)}</div>
          </div>
        </div>
      `;
    })
    .join("");
};

const renderRouteTimeline = (logs) => {
  const cursor = logs.length
    ? `${logs.length}:${logs[logs.length - 1].id}:${logs[logs.length - 1].timestamp}`
    : "0";

  if (cursor === lastRouteCursor) {
    return;
  }

  lastRouteCursor = cursor;
  const routes = buildRouteTimeline(logs);
  routeCount.textContent = `${routes.length} routes`;

  if (!routes.length) {
    activeRouteId = null;
    routeTimeline.innerHTML = '<p class="route-empty">No route execution logs yet.</p>';
    return;
  }

  if (activeRouteId && !routes.some((route) => route.id === activeRouteId)) {
    activeRouteId = null;
  }

  routeTimeline.innerHTML = routes
    .map((route) => {
      const stateClass = route.state || "running";
      const bodyPreview = renderJsonBlock(route.responseBody, "(no response body captured)");
      const headerPreview = renderJsonBlock(route.requestHeaders, "(no headers logged)");
      const requestBody = renderJsonBlock(route.requestBody, "(no request body)");
      const openClass = activeRouteId === route.id ? "open" : "";

      return `
        <article class="route-card ${stateClass} ${openClass}" data-route-id="${escapeHtml(route.id)}">
          <button type="button" class="route-summary" data-route-id="${escapeHtml(route.id)}">
            <span class="route-left">
              <span class="method method-${escapeHtml(route.method.toLowerCase())}">${escapeHtml(route.method)}</span>
              <span class="route-path">${escapeHtml(route.routePath)}</span>
            </span>
            <span class="route-right">
              <span class="route-status">${escapeHtml(route.responseStatus)}</span>
            </span>
          </button>
          <div class="route-content ${openClass}">
            <div class="route-body">
              <p><strong>URL</strong> ${escapeHtml(route.fullUrl)}</p>
              <p><strong>Request Headers</strong></p>
              <pre class="json-block">${headerPreview}</pre>
              <p><strong>Request Body</strong></p>
              <pre class="json-block">${requestBody}</pre>
              <p><strong>Response Body</strong></p>
              <pre class="json-block">${bodyPreview}</pre>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  for (const section of routeTimeline.querySelectorAll(".route-content")) {
    section.style.maxHeight = section.classList.contains("open")
      ? `${section.scrollHeight}px`
      : "0px";
  }
};

const renderLogsCollapseState = () => {
  if (!logsContent || !logsToggleBtn) return;

  if (logsCollapsed) {
    logsContent.style.maxHeight = `${logsContent.scrollHeight}px`;
    window.requestAnimationFrame(() => {
      logsContent.classList.remove("open");
      logsContent.style.maxHeight = "0px";
    });
  } else {
    logsContent.classList.add("open");
    logsContent.style.maxHeight = "0px";
    window.requestAnimationFrame(() => {
      logsContent.style.maxHeight = `${logsContent.scrollHeight}px`;
    });
  }

  logsToggleBtn.textContent = logsCollapsed ? "Expand" : "Collapse";
};

const renderTimelineCollapseState = (contentElement, toggleButton, isCollapsed, type) => {
  if (!contentElement || !toggleButton) return;

  const panelElement = contentElement.closest(".panel");
  if (panelElement) {
    panelElement.classList.toggle("collapsed-panel", isCollapsed);
  }

  if (type === "logs") {
    if (logsContent) {
      logsContent.dataset.collapsed = isCollapsed ? "true" : "false";
    }
  } else {
    contentElement.dataset.collapsed = isCollapsed ? "true" : "false";
  }

  if (isCollapsed) {
    contentElement.style.maxHeight = `${contentElement.scrollHeight}px`;
    window.requestAnimationFrame(() => {
      contentElement.classList.remove("open");
      contentElement.style.maxHeight = "0px";
    });
  } else {
    contentElement.classList.add("open");
    contentElement.style.maxHeight = "0px";
    window.requestAnimationFrame(() => {
      contentElement.style.maxHeight = `${contentElement.scrollHeight}px`;
    });
  }

  toggleButton.textContent = isCollapsed ? "Expand" : "Collapse";
};

const closePromptDialog = () => {
  if (promptDialog.open) {
    promptDialog.close();
  }
  activePrompt = null;
  promptMinimized = false;
  promptValue.value = "";
};

const focusPromptInput = () => {
  window.requestAnimationFrame(() => {
    if (!promptDialog.open || promptMinimized) return;
    promptValue.focus();
  });
};

const renderPromptDialog = () => {
  if (!activePrompt) {
    closePromptDialog();
    return;
  }

  promptQuestion.textContent = activePrompt.question;
  promptToggleBtn.textContent = promptMinimized ? "Restore" : "Minimize";
  promptDialog.dataset.minimized = promptMinimized ? "true" : "false";

  if (!promptDialog.open) {
    promptDialog.show();
    promptShouldFocus = true;
  }

  if (promptShouldFocus && !promptMinimized) {
    focusPromptInput();
    promptShouldFocus = false;
  }
};

const openPromptDialog = (pendingPrompt) => {
  if (!pendingPrompt) {
    closePromptDialog();
    return;
  }

  activePrompt = pendingPrompt;
  if (!promptDialog.open) {
    promptMinimized = false;
  }

  if (!promptDialog.open) {
    promptShouldFocus = true;
  }

  renderPromptDialog();
};

const renderState = (state) => {
  latestLogs = state.logs || [];
  statusBadge.textContent = state.status;
  statusBadge.className = `badge ${state.status}`;
  cwdText.textContent = `Workspace: ${state.cwd}`;

  const runBusy =
    state.status === "running" ||
    state.status === "awaiting-input" ||
    state.status === "stopping";

  startBtn.disabled = runBusy;
  stopBtn.disabled = !runBusy;
  resetBtn.disabled = runBusy;

  renderResult(state);
  renderLogs(latestLogs);
  renderProcessTimeline(latestLogs);
  renderRouteTimeline(latestLogs);
  openPromptDialog(state.pendingPrompt);
};

runForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const payload = await toPayload(new FormData(runForm));
    await api.startRun(payload);
  } catch (error) {
    alert(String(error.message || error));
  }
});

resetBtn.addEventListener("click", async () => {
  try {
    await api.resetState();
    closePromptDialog();
  } catch (error) {
    alert(String(error.message || error));
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await api.stopRun();
  } catch (error) {
    alert(String(error.message || error));
  }
});

routeTimeline.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const trigger = event.target.closest(".route-summary");
  if (!trigger) return;

  const targetCard = trigger.closest(".route-card");
  if (!targetCard) return;

  const routeId = trigger.getAttribute("data-route-id");
  if (!routeId) return;

  const shouldOpen = !targetCard.classList.contains("open");

  for (const card of routeTimeline.querySelectorAll(".route-card.open")) {
    card.classList.remove("open");
    const content = card.querySelector(".route-content");
    if (content) {
      content.style.maxHeight = "0px";
      content.classList.remove("open");
    }
  }

  if (shouldOpen) {
    targetCard.classList.add("open");
    const targetContent = targetCard.querySelector(".route-content");
    if (targetContent) {
      targetContent.classList.add("open");
      targetContent.style.maxHeight = `${targetContent.scrollHeight}px`;
    }
    activeRouteId = routeId;
    return;
  }

  activeRouteId = null;
});

if (logsToggleBtn) {
  logsToggleBtn.addEventListener("click", () => {
    logsCollapsed = !logsCollapsed;
    renderLogsCollapseState();
  });
}

if (processToggleBtn) {
  processToggleBtn.addEventListener("click", () => {
    processTimelineCollapsed = !processTimelineCollapsed;
    renderTimelineCollapseState(processContent, processToggleBtn, processTimelineCollapsed, "process");
  });
}

if (routeToggleBtn) {
  routeToggleBtn.addEventListener("click", () => {
    routeTimelineCollapsed = !routeTimelineCollapsed;
    renderTimelineCollapseState(routeContent, routeToggleBtn, routeTimelineCollapsed, "route");
  });
}

renderLogsCollapseState();

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!activePrompt) return;

  try {
    await api.answerPrompt(activePrompt.id, promptValue.value || "");
    closePromptDialog();
  } catch (error) {
    alert(String(error.message || error));
  }
});

if (promptNoInputBtn) {
  promptNoInputBtn.addEventListener("click", async () => {
    if (!activePrompt) return;

    try {
      await api.answerPrompt(activePrompt.id, "");
      closePromptDialog();
    } catch (error) {
      alert(String(error.message || error));
    }
  });
}

promptToggleBtn.addEventListener("click", () => {
  if (!activePrompt) return;

  promptMinimized = !promptMinimized;
  if (!promptMinimized) {
    promptShouldFocus = true;
  }
  renderPromptDialog();
});

promptDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!activePrompt) return;

  promptMinimized = true;
  renderPromptDialog();
});

const tick = async () => {
  try {
    const state = await api.getState();
    renderState(state);
  } catch (error) {
    logsPre.textContent = `UI refresh failed: ${String(error.message || error)}`;
  }
};

setInterval(tick, 1000);
void tick();
