import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as url from "url";
import { PostmanAutomationCore } from "../core/run-automation.ts";
import type { RunAutomationRequest } from "../core/index.ts";
import type { ExecutionLogger } from "../executor.ts";

type UploadedJsonFile = {
    name?: string;
    content: string;
};

type RunStatus =
    | "idle"
    | "running"
    | "stopping"
    | "awaiting-input"
    | "stopped"
    | "completed"
    | "failed";

type LogEntry = {
    id: number;
    timestamp: string;
    source: "console" | "file" | "event" | "system";
    level: string;
    message: string;
};

type PendingPrompt = {
    id: string;
    question: string;
};

type UiState = {
    status: RunStatus;
    startedAt?: string;
    endedAt?: string;
    lastRequest?: RunAutomationRequest;
    lastError?: string;
    lastResult?: {
        workflowPathUsed?: string;
        workflowPathGenerated?: string;
        stats: {
            total: number;
            success: number;
            failed: number;
            skipped: number;
            errors: number;
        };
        failedLogsDir: string;
        exportedCollectionPath?: string;
        updatedWorkflowPath?: string;
    };
    pendingPrompt?: PendingPrompt;
    logs: LogEntry[];
};

const state: UiState = {
    status: "idle",
    logs: [],
};

let logCounter = 0;
let promptResolver: ((value: string) => void) | undefined;
let promptRejecter: ((error: Error) => void) | undefined;
let currentRunAbortController: AbortController | undefined;
let stopRequested = false;

const MAX_LOGS = 1500;

const addLog = (
    source: LogEntry["source"],
    level: string,
    message: string,
) => {
    const line = {
        id: ++logCounter,
        timestamp: new Date().toISOString(),
        source,
        level,
        message,
    };

    state.logs.push(line);
    if (state.logs.length > MAX_LOGS) {
        state.logs = state.logs.slice(state.logs.length - MAX_LOGS);
    }
};

const makeLogger = (source: LogEntry["source"]): ExecutionLogger => {
    return {
        log: (message: string, type: string = "INFO") => {
            addLog(source, type, String(message));
            if (source === "console") {
                const stamp = new Date().toLocaleTimeString();
                // Keep terminal visibility for server operators.
                console.log(`[${stamp}] [${type}] ${message}`);
            }
        },
    };
};

const toAbsolutePath = (rawPath?: string) => {
    if (!rawPath) return undefined;
    return path.isAbsolute(rawPath)
        ? rawPath
        : path.join(process.cwd(), rawPath);
};

const uploadsDir = path.join(process.cwd(), ".gui_uploads");

const ensureUploadsDir = () => {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
};

const sanitizeFileStem = (input: string) => {
    const stem = input.replace(/\.json$/i, "");
    const sanitized = stem
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized || "uploaded";
};

const parseUploadedFile = (value: unknown): UploadedJsonFile | undefined => {
    if (!value || typeof value !== "object") return undefined;

    const maybe = value as UploadedJsonFile;
    if (typeof maybe.content !== "string" || !maybe.content.trim()) {
        return undefined;
    }

    return {
        name: typeof maybe.name === "string" ? maybe.name : undefined,
        content: maybe.content,
    };
};

const persistUploadedJsonFile = (
    file: UploadedJsonFile,
    prefix: string,
): string => {
    ensureUploadsDir();

    let parsed: any;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        throw new Error(`${prefix} is not valid JSON.`);
    }

    const now = new Date();
    const ts =
        now.toISOString().split("T")[0] +
        "_" +
        now.toTimeString().split(" ")[0].replace(/:/g, "-");

    const sourceName = file.name || `${prefix}.json`;
    const fileName = `${prefix}_${sanitizeFileStem(sourceName)}_${ts}.json`;
    const filePath = path.join(uploadsDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    return filePath;
};

const parseOptionalNumber = (
    value: unknown,
    fieldName: string,
): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string" && value.trim() === "") return undefined;

    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        throw new Error(`${fieldName} must be a number.`);
    }

    return parsed;
};

const parsePatternInput = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
        const list = value
            .map((v) => String(v).trim())
            .filter(Boolean);
        return list.length ? list : undefined;
    }

    if (typeof value === "string") {
        const list = value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        return list.length ? list : undefined;
    }

    return undefined;
};

const normalizeRequest = (raw: any): RunAutomationRequest => {
    const collectionUpload = parseUploadedFile(raw?.collectionFile);
    const workflowUpload = parseUploadedFile(raw?.workflowFile);

    const collectionPathInput =
        typeof raw?.collectionPath === "string"
            ? toAbsolutePath(raw.collectionPath.trim())
            : undefined;
    const workflowPathInput =
        typeof raw?.workflowPath === "string"
            ? toAbsolutePath(raw.workflowPath.trim())
            : undefined;

    const collectionPath = collectionUpload
        ? persistUploadedJsonFile(collectionUpload, "collection")
        : collectionPathInput;

    const workflowPath = workflowUpload
        ? persistUploadedJsonFile(workflowUpload, "workflow")
        : workflowPathInput;

    if (!collectionPath) {
        throw new Error("Collection file is required.");
    }

    const delay = parseOptionalNumber(raw?.delay, "delay");
    const timeout = parseOptionalNumber(raw?.timeout, "timeout");

    return {
        collectionPath,
        workflowPath,
        context: typeof raw?.context === "string" ? raw.context : undefined,
        delay,
        timeout,
        skip: parsePatternInput(raw?.skip),
        only: parsePatternInput(raw?.only),
        dry: Boolean(raw?.dry),
    };
};

const resetStateForNewRun = (request: RunAutomationRequest) => {
    state.status = "running";
    state.startedAt = new Date().toISOString();
    state.endedAt = undefined;
    state.lastError = undefined;
    state.lastResult = undefined;
    state.pendingPrompt = undefined;
    state.lastRequest = request;
    state.logs = [];

    addLog("system", "INFO", "Run started.");
};

const startRun = async (request: RunAutomationRequest) => {
    if (
        state.status === "running" ||
        state.status === "awaiting-input" ||
        state.status === "stopping"
    ) {
        throw new Error("A run is already in progress.");
    }

    resetStateForNewRun(request);
    stopRequested = false;
    currentRunAbortController = new AbortController();

    const core = new PostmanAutomationCore({
        consoleLogger: makeLogger("console"),
        fileLogger: makeLogger("file"),
        onEvent: (event) => {
            addLog("event", "EVENT", JSON.stringify(event));
        },
        promptProvider: {
            prompt: (question: string) => {
                if (state.pendingPrompt) {
                    return Promise.reject(
                        new Error("Another prompt is already pending."),
                    );
                }

                const promptId = `prompt_${Date.now()}`;
                state.pendingPrompt = { id: promptId, question };
                state.status = "awaiting-input";
                addLog("system", "INPUT", `Prompt requested: ${question}`);

                return new Promise<string>((resolve, reject) => {
                    promptResolver = (value: string) => {
                        promptResolver = undefined;
                        promptRejecter = undefined;
                        state.pendingPrompt = undefined;
                        state.status = "running";
                        addLog("system", "INPUT", "Prompt answered.");
                        resolve(value);
                    };

                    promptRejecter = (error: Error) => {
                        promptResolver = undefined;
                        promptRejecter = undefined;
                        state.pendingPrompt = undefined;
                        reject(error);
                    };
                });
            },
        },
    });

    try {
        const result = await core.run({
            ...request,
            stopSignal: currentRunAbortController.signal,
        });
        state.status = "completed";
        state.endedAt = new Date().toISOString();
        state.lastResult = {
            workflowPathUsed: result.workflowPathUsed,
            workflowPathGenerated: result.workflowPathGenerated,
            stats: result.execution.stats,
            failedLogsDir: result.execution.failedLogsDir,
            exportedCollectionPath: result.execution.exportedCollectionPath,
            updatedWorkflowPath: result.execution.updatedWorkflowPath,
        };
        addLog("system", "SUCCESS", "Run completed successfully.");
    } catch (error: any) {
        if (stopRequested) {
            state.status = "stopped";
            state.endedAt = new Date().toISOString();
            state.lastError = undefined;
            addLog("system", "INFO", "Run stopped by user.");
            return;
        }

        state.status = "failed";
        state.endedAt = new Date().toISOString();
        state.lastError = String(error?.message || error || "Unknown error");
        addLog("system", "ERROR", `Run failed: ${state.lastError}`);
    } finally {
        promptResolver = undefined;
        promptRejecter = undefined;
        currentRunAbortController = undefined;
        stopRequested = false;
    }
};

const readJsonBody = async (req: http.IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error("Invalid JSON body.");
    }
};

const sendJson = (
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
) => {
    const payload = JSON.stringify(body);
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(payload));
    res.end(payload);
};

const sendFile = (res: http.ServerResponse, filePath: string) => {
    if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "File not found." });
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
        ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".css"
                ? "text/css; charset=utf-8"
                : ext === ".js"
                    ? "text/javascript; charset=utf-8"
                    : "application/octet-stream";

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    fs.createReadStream(filePath).pipe(res);
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..", "..", "web");

const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const parsedUrl = new URL(req.url || "/", "http://localhost");
    const pathname = parsedUrl.pathname;

    try {
        if (method === "GET" && pathname === "/api/state") {
            sendJson(res, 200, {
                ...state,
                cwd: process.cwd(),
            });
            return;
        }

        if (method === "POST" && pathname === "/api/run") {
            const body = await readJsonBody(req);
            const runRequest = normalizeRequest(body);

            void startRun(runRequest);

            sendJson(res, 202, {
                ok: true,
                message: "Run started.",
            });
            return;
        }

        if (method === "POST" && pathname === "/api/prompt/answer") {
            const body = await readJsonBody(req);
            const promptId = String(body?.promptId || "").trim();
            const value = String(body?.value || "");

            if (!state.pendingPrompt) {
                sendJson(res, 409, { error: "No prompt is pending." });
                return;
            }

            if (promptId !== state.pendingPrompt.id) {
                sendJson(res, 409, { error: "Prompt ID mismatch." });
                return;
            }

            if (!promptResolver) {
                sendJson(res, 500, { error: "Prompt resolver is unavailable." });
                return;
            }

            promptResolver(value);
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/reset") {
            if (
                state.status === "running" ||
                state.status === "awaiting-input" ||
                state.status === "stopping"
            ) {
                sendJson(res, 409, {
                    error: "Cannot reset while a run is in progress.",
                });
                return;
            }

            state.status = "idle";
            state.startedAt = undefined;
            state.endedAt = undefined;
            state.lastRequest = undefined;
            state.lastError = undefined;
            state.lastResult = undefined;
            state.pendingPrompt = undefined;
            state.logs = [];
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/stop") {
            if (
                state.status !== "running" &&
                state.status !== "awaiting-input"
            ) {
                sendJson(res, 409, { error: "No active run to stop." });
                return;
            }

            stopRequested = true;
            state.status = "stopping";
            addLog("system", "WARN", "Stop requested by user.");

            currentRunAbortController?.abort();
            if (promptRejecter) {
                promptRejecter(new Error("Run stopped by user."));
            }

            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === "POST" && pathname === "/api/download") {
            const body = await readJsonBody(req);
            const filePath = String(body?.filePath || "").trim();

            if (!filePath) {
                sendJson(res, 400, { error: "filePath is required." });
                return;
            }

            const absolutePath = path.isAbsolute(filePath)
                ? filePath
                : path.join(process.cwd(), filePath);

            if (!fs.existsSync(absolutePath)) {
                sendJson(res, 404, { error: "File not found." });
                return;
            }

            if (!absolutePath.endsWith(".json")) {
                sendJson(res, 400, { error: "Only JSON files can be downloaded." });
                return;
            }

            const fileName = path.basename(absolutePath);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${fileName}"`
            );
            fs.createReadStream(absolutePath).pipe(res);
            return;
        }

        if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            sendFile(res, path.join(webRoot, "index.html"));
            return;
        }

        if (method === "GET" && pathname === "/app.js") {
            sendFile(res, path.join(webRoot, "app.js"));
            return;
        }

        if (method === "GET" && pathname === "/styles.css") {
            sendFile(res, path.join(webRoot, "styles.css"));
            return;
        }

        sendJson(res, 404, { error: "Not found." });
    } catch (error: any) {
        sendJson(res, 500, {
            error: String(error?.message || error || "Unknown error"),
        });
    }
});

const port = Number(process.env.GUI_PORT || 4173);
server.listen(port, () => {
    console.log(`GUI server started at http://localhost:${port}`);
});
