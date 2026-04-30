(function () {
    const $ = (id) => document.getElementById(id);

    const readFileAsText = (file) =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(file);
        });

    let lastState = {};
    let promptDismissed = false; // track if user manually closed the popup

    const setupFileDragDrop = () => {
        ["collectionZone", "workflowZone"].forEach((zoneId) => {
            const zone = $(zoneId);
            if (!zone) return;

            const input = zone.querySelector("input");
            if (!input) return;

            const preventDefault = (event) => {
                event.preventDefault();
                event.stopPropagation();
            };

            zone.addEventListener("dragover", preventDefault);
            zone.addEventListener("dragenter", () =>
                zone.classList.add("drag-over"),
            );
            zone.addEventListener("dragleave", () =>
                zone.classList.remove("drag-over"),
            );

            zone.addEventListener("drop", (event) => {
                preventDefault(event);
                zone.classList.remove("drag-over");
                const files = event.dataTransfer?.files;
                if (files && files[0]) {
                    input.files = files;
                    updateUploadedFiles();
                }
            });

            zone.addEventListener("click", () => input.click());
            input.addEventListener("change", updateUploadedFiles);
        });
    };

    const updateUploadedFiles = () => {
        const collection = $("collectionFile")?.files?.[0];
        const workflow = $("workflowFile")?.files?.[0];
        const container = $("uploadedFiles");
        if (!container) return;

        container.innerHTML = "";

        const addItem = (file, icon, inputId) => {
            if (!file) return;
            const row = document.createElement("div");
            row.className = "uploaded-file";
            row.innerHTML = `<span class="uploaded-file-name">${icon} ${file.name}</span><span class="uploaded-file-clear">×</span>`;
            const clear = row.querySelector(".uploaded-file-clear");
            clear?.addEventListener("click", (event) => {
                event.stopPropagation();
                const input = $(inputId);
                if (input) input.value = "";
                updateUploadedFiles();
            });
            container.appendChild(row);
        };

        addItem(collection, "📄", "collectionFile");
        addItem(workflow, "📋", "workflowFile");
    };

    const formatDateTime = (value) => {
        if (!value) return "—";
        return new Date(value).toLocaleString();
    };

    const formatDuration = (start, end) => {
        if (!start) return "—";
        const started = new Date(start);
        const ended = end ? new Date(end) : new Date();
        const totalSeconds = Math.max(0, Math.floor((ended - started) / 1000));

        if (totalSeconds < 60) return `${totalSeconds}s`;
        const minutes = Math.floor(totalSeconds / 60);
        if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    };

    const padStat = (value) =>
        String(Math.min(value || 0, 99)).padStart(2, "0");

    const escapeHtml = (text) =>
        String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const tryParseJson = (value) => {
        if (typeof value !== "string") return value;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    };

    const formatStructuredValue = (value) => {
        if (value === undefined || value === null || value === "") {
            return "(empty)";
        }

        if (typeof value === "string") {
            const parsed = tryParseJson(value);
            if (parsed !== value) {
                return JSON.stringify(parsed, null, 2);
            }
            return value;
        }

        return JSON.stringify(value, null, 2);
    };

    let lastProcessLogsKey = null;
    const renderProcessTimeline = (logs) => {
        const container = $("processTimeline");
        if (!container) return;

        const recent = logs.slice(-80);
        const key = recent.map((l) => l.timestamp + l.message).join("|");
        if (key === lastProcessLogsKey) return;
        lastProcessLogsKey = key;

        container.innerHTML = "";
        const reversed = recent.slice().reverse();

        if (!reversed.length) {
            container.innerHTML =
                '<div class="muted">No process entries yet.</div>';
            return;
        }

        reversed.forEach((log) => {
            const row = document.createElement("div");
            row.className = "timeline-item";
            row.title = log.message;
            row.textContent = `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.level} - ${log.message}`;
            container.appendChild(row);
        });
    };

    let lastRouteLogsKey = null;
    const renderRouteTimeline = (logs) => {
        const container = $("routeTimeline");
        if (!container) return;

        const executeEntries = [];
        let currentEntry = null;

        logs.forEach((entry) => {
            if (entry.source !== "console") return;

            const message = String(entry.message || "");
            const executeMatch = message.match(/^Executing \[([A-Z]+)\] -> (.+)$/);

            if (executeMatch) {
                currentEntry = {
                    timestamp: entry.timestamp,
                    level: entry.level,
                    method: executeMatch[1],
                    url: executeMatch[2],
                    headers: undefined,
                    requestBody: undefined,
                    responseStatus: undefined,
                    responseBody: undefined,
                };
                executeEntries.push(currentEntry);
                return;
            }

            if (!currentEntry) return;

            if (message.startsWith("Headers: ")) {
                currentEntry.headers = formatStructuredValue(
                    message.slice("Headers: ".length),
                );
                return;
            }

            if (message.startsWith("Body: ")) {
                currentEntry.requestBody = formatStructuredValue(
                    message.slice("Body: ".length),
                );
                return;
            }

            if (message.startsWith("Response: [")) {
                currentEntry.responseStatus = message.slice("Response: ".length);
                currentEntry.level = entry.level;
                return;
            }

            if (message.startsWith("Full Response: ")) {
                currentEntry.responseBody = formatStructuredValue(
                    message.slice("Full Response: ".length),
                );
            }
        });

        const key = executeEntries
            .map(
                (entry) =>
                    [
                        entry.timestamp,
                        entry.method,
                        entry.url,
                        entry.responseStatus,
                        entry.requestBody,
                        entry.responseBody,
                    ].join("|"),
            )
            .join("||");
        if (key === lastRouteLogsKey) return;
        lastRouteLogsKey = key;

        container.innerHTML = "";

        if (!executeEntries.length) {
            container.innerHTML =
                '<div class="muted">No workflow EXECUTE entries yet.</div>';
            return;
        }

        executeEntries.reverse().forEach((entry) => {
            const details = document.createElement("details");
            details.className = "route";

            const summary = document.createElement("summary");
            const left = document.createElement("span");
            left.textContent = `${new Date(entry.timestamp).toLocaleTimeString()} - ${entry.method} ${entry.url}`;

            const right = document.createElement("span");
            const badge = document.createElement("span");
            const isError =
                entry.level === "ERROR" ||
                entry.level === "FAIL" ||
                String(entry.responseStatus || "").includes("[4") ||
                String(entry.responseStatus || "").includes("[5");
            badge.className = `badge ${isError ? "err" : "ok"}`;
            badge.textContent = entry.responseStatus || entry.level || "INFO";
            right.appendChild(badge);

            summary.appendChild(left);
            summary.appendChild(right);
            details.appendChild(summary);

            const body = document.createElement("div");
            body.className = "route-body";
            body.innerHTML = `
                <div class="route-section">
                    <strong>Request Headers</strong>
                    <pre>${escapeHtml(
                        entry.headers || "(no headers)",
                    )}</pre>
                </div>
                <div class="route-section">
                    <strong>Request Body</strong>
                    <pre>${escapeHtml(
                        entry.requestBody || "(empty body)",
                    )}</pre>
                </div>
                <div class="route-section">
                    <strong>Response Body</strong>
                    <pre>${escapeHtml(
                        entry.responseBody || "(empty body)",
                    )}</pre>
                </div>
            `;
            details.appendChild(body);

            container.appendChild(details);
        });
    };

    let lastLiveLogsKey = null;
    const renderLiveLogs = (logs) => {
        const container = $("liveLogs");
        if (!container) return;

        const slice = logs.slice(-200);
        const key = slice.map((l) => l.timestamp + l.message).join("|");
        if (key === lastLiveLogsKey) return;
        lastLiveLogsKey = key;

        container.innerHTML = "";
        if (!logs.length) {
            container.innerHTML = '<div class="muted">No live logs yet.</div>';
            return;
        }

        slice.forEach((log) => {
            const line = document.createElement("div");
            line.className = "log-line";
            line.textContent = `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.level} ${log.source} - ${log.message}`;
            container.appendChild(line);
        });

        container.scrollTop = container.scrollHeight;
    };

    const renderDownloadButtons = (state) => {
        const container = $("downloadActions");
        if (!container) return;

        container.innerHTML = "";

        if (
            ["idle", "running", "stopping", "awaiting-input"].includes(
                state.status,
            )
        ) {
            return;
        }

        const result = state.lastResult;
        if (!result) return;

        const seenPaths = new Set();

        const appendButton = (label, filePath) => {
            if (!filePath) return;
            if (seenPaths.has(filePath)) return;
            seenPaths.add(filePath);
            const button = document.createElement("button");
            button.textContent = label;
            button.addEventListener("click", () => downloadFile(filePath));
            container.appendChild(button);
        };

        appendButton("Download Updated Workflow", result.updatedWorkflowPath);
        appendButton("Download Workflow", result.workflowPathGenerated);
        appendButton("Download Workflow", result.workflowPathUsed);
        appendButton(
            "Download Exported Collection",
            result.exportedCollectionPath,
        );
    };

    const setTextIfChanged = (id, value) => {
        const el = $(id);
        if (el && el.textContent !== value) el.textContent = value;
    };

    const renderState = (state) => {
        setTextIfChanged("statusText", state.status || "idle");
        setTextIfChanged("startedAt", formatDateTime(state.startedAt));
        setTextIfChanged("endedAt", formatDateTime(state.endedAt));
        setTextIfChanged(
            "duration",
            formatDuration(state.startedAt, state.endedAt),
        );

        const stats = state.lastResult?.stats || {
            total: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            errors: 0,
        };

        setTextIfChanged("statTotal", padStat(stats.total));
        setTextIfChanged("statSuccess", padStat(stats.success));
        setTextIfChanged("statFailed", padStat(stats.failed));
        setTextIfChanged("statSkipped", padStat(stats.skipped));
        setTextIfChanged("statErrors", padStat(stats.errors));

        renderDownloadButtons(state);
        renderProcessTimeline(state.logs || []);
        renderRouteTimeline(state.logs || []);
        renderLiveLogs(state.logs || []);
        handlePendingPrompt(state.pendingPrompt);
    };

    const fetchState = async () => {
        try {
            const response = await fetch("/api/state");
            if (!response.ok) return;
            const state = await response.json();
            renderState(state);
            lastState = state;
        } catch (error) {
            console.warn("state fetch error", error);
        }
    };

    const downloadFile = async (filePath) => {
        if (!filePath) {
            alert("No file available to download.");
            return;
        }

        try {
            const response = await fetch("/api/download", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ filePath }),
            });

            if (!response.ok) {
                const body = await response.json();
                alert(`Download failed: ${body?.error || response.status}`);
                return;
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filePath.split(/[\\/]/).pop();
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.warn(error);
            alert("Download error");
        }
    };

    const startRun = async () => {
        const collectionFile = $("collectionFile")?.files?.[0];
        const workflowFile = $("workflowFile")?.files?.[0];

        if (!collectionFile) {
            alert("Collection file is required.");
            return;
        }

        const payload = {
            delay: Number($("delay")?.value) || undefined,
            timeout: Number($("timeout")?.value) || undefined,
            skip: $("skip")?.value || undefined,
            only: $("only")?.value || undefined,
            context: $("context")?.value || undefined,
            dry: $("dry")?.checked || undefined,
            collectionFile: {
                name: collectionFile.name,
                content: await readFileAsText(collectionFile),
            },
        };

        if (workflowFile) {
            payload.workflowFile = {
                name: workflowFile.name,
                content: await readFileAsText(workflowFile),
            };
        }

        await fetch("/api/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });

        setTimeout(fetchState, 200);
    };

    const handlePendingPrompt = (pendingPrompt) => {
        const popup = $("promptPopup");
        if (!popup) return;

        if (!pendingPrompt) {
            popup.classList.add("hidden");
            popup.setAttribute("aria-hidden", "true");
            promptDismissed = false; // reset when there's no prompt
            return;
        }

        // If the prompt ID changed, it's a new prompt — reset dismissed flag
        const currentId = popup.dataset.currentPromptId;
        if (currentId !== String(pendingPrompt.id)) {
            popup.dataset.currentPromptId = pendingPrompt.id;
            promptDismissed = false;
        }

        // Don't re-show if user dismissed this prompt
        if (promptDismissed) return;

        popup.classList.remove("hidden");
        popup.setAttribute("aria-hidden", "false");

        $("promptQuestion").textContent =
            pendingPrompt.question || "Input required";
        $("submitPrompt").dataset.promptId = pendingPrompt.id;
        // Only reset the textarea if the prompt ID changed (new prompt)
        if (currentId !== String(pendingPrompt.id)) {
            $("submitPrompt").disabled = true;
            $("promptAnswer").value = "";
        }
    };

    const makePromptDraggable = () => {
        const popup = $("promptPopup");
        const bar = popup?.querySelector(".prompt-bar");
        if (!popup || !bar) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        bar.addEventListener("pointerdown", (event) => {
            if (
                event.target instanceof Element &&
                event.target.closest("button, input, textarea, select, a")
            ) {
                return;
            }

            dragging = true;
            // Get current rendered position, removing transform centering
            const rect = popup.getBoundingClientRect();
            popup.style.left = `${rect.left}px`;
            popup.style.top = `${rect.top}px`;
            popup.style.transform = "none";
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            bar.setPointerCapture(event.pointerId);
        });

        window.addEventListener("pointermove", (event) => {
            if (!dragging) return;
            popup.style.left = `${event.clientX - offsetX}px`;
            popup.style.top = `${event.clientY - offsetY}px`;
        });

        window.addEventListener("pointerup", () => {
            dragging = false;
        });

        window.addEventListener("pointercancel", () => {
            dragging = false;
        });
    };

    const wireEvents = () => {
        $("startBtn")?.addEventListener("click", startRun);
        $("stopBtn")?.addEventListener("click", () =>
            fetch("/api/stop", { method: "POST" }).then(fetchState),
        );
        $("resetBtn")?.addEventListener("click", () =>
            fetch("/api/reset", { method: "POST" }).then(fetchState),
        );

        $("promptAnswer")?.addEventListener("input", () => {
            $("submitPrompt").disabled = $("promptAnswer").value.trim() === "";
        });

        $("submitPrompt")?.addEventListener("click", async () => {
            const promptId = $("submitPrompt").dataset.promptId;
            const value = $("promptAnswer").value.trim();
            if (!promptId || !value) return;

            await fetch("/api/prompt/answer", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ promptId, value }),
            });

            $("promptPopup").classList.add("hidden");
        });

        $("minimizePrompt")?.addEventListener("click", () => {
            const popup = $("promptPopup");
            const body = popup?.querySelector(".prompt-body");
            if (!popup || !body) return;
            popup.style.height = "40px";
            body.style.display = "none";
        });

        $("closePrompt")?.addEventListener("click", () => {
            promptDismissed = true;
            $("promptPopup")?.classList.add("hidden");
        });
    };

    const setupDetailsAnimation = () => {
        document.querySelectorAll("details.card").forEach((details) => {
            const grid = details.querySelector(".collapse-grid");
            if (!grid) return;

            // Sync initial state without transitions
            grid.style.transition = "none";
            if (details.open) {
                grid.style.gridTemplateRows = "1fr";
                grid.style.opacity = "1";
                grid.style.paddingTop = "8px";
            } else {
                grid.style.gridTemplateRows = "0fr";
                grid.style.opacity = "0";
                grid.style.paddingTop = "0";
            }
            // Re-enable transitions after initial paint
            requestAnimationFrame(() => {
                grid.style.transition = "";
            });

            details.addEventListener("click", (event) => {
                const summary = details.querySelector("summary");
                if (!summary.contains(event.target) && event.target !== summary)
                    return;

                event.preventDefault(); // stop native instant toggle

                const isOpen = details.open;

                if (isOpen) {
                    // Animate closed, then remove [open]
                    grid.style.gridTemplateRows = "0fr";
                    grid.style.opacity = "0";
                    grid.style.paddingTop = "0";

                    const onEnd = (e) => {
                        if (e.propertyName !== "grid-template-rows") return;
                        details.removeAttribute("open");
                        grid.removeEventListener("transitionend", onEnd);
                    };
                    grid.addEventListener("transitionend", onEnd);
                } else {
                    // Set [open] first so content is in DOM, then animate open
                    details.setAttribute("open", "");
                    grid.getBoundingClientRect(); // force reflow
                    grid.style.gridTemplateRows = "1fr";
                    grid.style.opacity = "1";
                    grid.style.paddingTop = "8px";
                }
            });
        });
    };

    const poll = () => {
        fetchState();
        setTimeout(poll, 1000);
    };

    wireEvents();
    setupFileDragDrop();
    makePromptDraggable();
    setupDetailsAnimation();
    poll();
})();
