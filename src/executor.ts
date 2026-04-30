import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import {
    getDeepValue,
    extractRoutePath,
    matchesAnyRoutePattern,
    resolveVariables,
    resolveObject,
    C,
} from "./utils.ts";

export type BaseAction = {
    action: "REGISTER" | "INPUT" | "LOG" | "EXECUTE";
};

export type RegisterAction = BaseAction & {
    action: "REGISTER";
    registers: Record<string, any>;
};

export type InputAction = BaseAction & {
    action: "INPUT";
    label: string;
    register: string;
};

export type LogAction = BaseAction & {
    action: "LOG";
    value: string;
};

export type ExecuteAction = BaseAction & {
    action: "EXECUTE";
    method: string;
    url: string;
    item_id?: string;
    headers?: Record<string, string>;
    body?: any;
    register?: Record<string, string>;
};

export type ExampleRequest = {
    url: string
    headers: Record<string, string>,
    method: string,
    body: any,
}

export type WorkflowAction =
    | RegisterAction
    | InputAction
    | LogAction
    | ExecuteAction;

export type ActionConfig = {
    delay?: number;
    timeout?: number;
    skip?: string[];
    only?: string[];
    dry?: boolean;
    workflowPath?: string;
    exportBaseName?: string;
    runtimeWorkflowPath?: string;
    stopSignal?: AbortSignal;
};

export type PromptProvider = {
    prompt(question: string): Promise<string>;
};

export type ExecutionLogger = {
    log(message: string, type?: string, colorOverride?: string): void;
};

export type ExecutionOutcome = {
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

export class ActionExecutor {
    private registers: Record<string, any> = {};
    private console: ExecutionLogger;
    private file: ExecutionLogger;
    private config: ActionConfig;
    private stats = { total: 0, success: 0, failed: 0, skipped: 0, errors: 0 };
    private failedLogsDir: string;
    private workflowUpdated = false;
    private promptProvider?: PromptProvider;

    private collection: any;

    private isStopRequested() {
        return Boolean(this.config.stopSignal?.aborted);
    }

    constructor(
        console: ExecutionLogger,
        file: ExecutionLogger,
        config: ActionConfig = {},
        collection?: any,
        promptProvider?: PromptProvider,
    ) {
        this.console = console;
        this.file = file;
        this.config = {
            delay: 0,
            timeout: 30000,
            ...config,
        };

        if (
            this.config.delay === undefined ||
            Number.isNaN(this.config.delay) ||
            this.config.delay < 0
        ) {
            this.config.delay = 0;
        }

        if (
            this.config.timeout === undefined ||
            Number.isNaN(this.config.timeout) ||
            this.config.timeout <= 0
        ) {
            this.config.timeout = 30000;
        }

        this.collection = collection;
        this.promptProvider = promptProvider;

        const now = new Date();
        const timestamp =
            now.toISOString().split("T")[0] +
            "_" +
            now.toTimeString().split(" ")[0].replace(/:/g, "-");
        this.failedLogsDir = path.join(
            process.cwd(),
            "logs",
            "failed_logs",
            timestamp,
        );
    }

    async execute(actions: WorkflowAction[]): Promise<ExecutionOutcome> {
        this.console.log("\n--- Starting Workflow Execution ---", "INFO");
        this.file.log("--- Starting Workflow Execution ---", "INFO");
        this.stats.total = actions.filter((a) => a.action === "EXECUTE").length;
        let consecutiveErrors = 0;
        const CONSECUTIVE_ERROR_LIMIT = 5;
        for (const action of actions) {
            if (this.isStopRequested()) {
                this.console.log("Execution stopped by user request.", "ERROR");
                this.file.log("Execution stopped by user request.", "ERROR");
                break;
            }

            const success = await this.runAction(action);

            if (this.isStopRequested()) {
                this.console.log("Execution stopped by user request.", "ERROR");
                this.file.log("Execution stopped by user request.", "ERROR");
                break;
            }

            if (!success && action.action === "EXECUTE") {
                consecutiveErrors++;
                if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
                    this.console.log(
                        `${CONSECUTIVE_ERROR_LIMIT} consecutive failures — stopping execution.`,
                        "ERROR",
                    );
                    this.file.log(
                        `${CONSECUTIVE_ERROR_LIMIT} consecutive failures — stopping execution.`,
                        "ERROR",
                    );
                    break;
                }
            } else if (action.action === "EXECUTE") {
                consecutiveErrors = 0;
            }
        }
        this.console.log("\n\n--- Completed Workflow Execution ---", "INFO");
        this.file.log("--- Completed Workflow Execution ---", "INFO");
        this.showSummary();

        const updatedWorkflowPath = this.persistWorkflowUpdates(actions);
        let exportedCollectionPath: string | undefined;

        if (this.collection) {
            exportedCollectionPath = this.finalizeExport();
        }

        return {
            stats: { ...this.stats },
            failedLogsDir: this.failedLogsDir,
            exportedCollectionPath,
            updatedWorkflowPath,
        };
    }

    private persistWorkflowUpdates(actions: WorkflowAction[]) {
        const workflowPath = this.config.runtimeWorkflowPath;
        if (!workflowPath || !this.workflowUpdated) return;

        fs.writeFileSync(workflowPath, JSON.stringify(actions, null, 2), "utf-8");
        const relativePath = path.relative(process.cwd(), workflowPath);
        this.console.log(
            `Updated workflow register paths saved to: ${relativePath}`,
            "INFO",
        );
        this.file.log(
            `Updated workflow register paths saved to: ${relativePath}`,
            "INFO",
        );

        return workflowPath;
    }

    private showSummary() {
        this.console.log(
            "\n------------------------------------------",
            "INFO",
        );
        this.console.log("   EXECUTION SUMMARY", "INFO");
        this.console.log("------------------------------------------", "INFO");
        this.console.log(`  Total Actions:   ${this.stats.total}`, "INFO");
        this.console.log(
            `${C.green}  Success:         ${this.stats.success.toString().padStart(2, "0")}${C.reset}`,
            "INFO",
        );
        if (this.stats.failed > 0)
            this.console.log(
                `${C.red}  Failed:          ${this.stats.failed.toString().padStart(2, "0")}${C.reset}`,
                "INFO",
            );
        if (this.stats.skipped > 0)
            this.console.log(
                `${C.yellow}  Skipped:         ${this.stats.skipped.toString().padStart(2, "0")}${C.reset}`,
                "INFO",
            );
        if (this.stats.errors > 0)
            this.console.log(
                `${C.red}  System Errors:   ${this.stats.errors.toString().padStart(2, "0")}${C.reset}`,
                "ERROR",
            );
        this.console.log(
            "------------------------------------------\n",
            "INFO",
        );
    }

    private finalizeExport() {
        const exportDir = path.join(process.cwd(), "exports");
        if (!fs.existsSync(exportDir))
            fs.mkdirSync(exportDir, { recursive: true });

        const now = new Date();
        const ts =
            now.toISOString().split("T")[0] +
            "_" +
            now.toTimeString().split(" ")[0].replace(/:/g, "-");
        const safeBaseName = (this.config.exportBaseName || "collection")
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "") || "collection";
        const filename = `${safeBaseName}_tested_${ts}.json`;
        const filePath = path.join(exportDir, filename);

        // Deep-clone and strip the synthetic _id fields we added during
        // simplification — they are not part of the Postman schema and would
        // appear as noise in the imported collection.
        const clean = JSON.parse(JSON.stringify(this.collection));
        const stripIds = (items: any[]) => {
            for (const item of items) {
                delete item._id;
                if (item.item) stripIds(item.item);
            }
        };
        if (clean.item) stripIds(clean.item);

        fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), "utf-8");
        this.console.log(
            `\nExported collection with responses to: exports/${filename}`,
            "INFO",
    
        );

        return filePath;
    }

    private defaultPrompt(question: string): Promise<string> {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    private askInput(question: string): Promise<string> {
        if (this.promptProvider) {
            return this.promptProvider.prompt(question);
        }

        return this.defaultPrompt(question);
    }
    

    private addExampleToItem(
        itemId: string,
        request: ExampleRequest,
        response: any,
        status: number,
        statusText: string,
        resHeaders: Headers,
        success: boolean,
    ) {
        if (!this.collection) return;

        const pushExample = (item: any) => {
            if (!item.response) item.response = [];

            const exampleName = success ? "Success" : "Failed";

            const requestHeaders = Object.entries(request.headers || {}).map(
                ([key, value]) => ({ key, value: String(value) }),
            );

            // Format response headers for Postman
            const postmanHeaders: any[] = [];
            resHeaders.forEach((value, key) => {
                postmanHeaders.push({ key, value });
            });

            const isJson = typeof response === "object" && response !== null;

            item.response.push({
                name: exampleName,
                originalRequest: {
                    method: request.method,
                    header: requestHeaders,
                    body: request.body
                        ? {
                            mode: "raw",
                            raw: JSON.stringify(JSON.parse(request.body), null, 2),
                            options: {
                                raw: {
                                    headerFamily: "json",
                                    language: "json",
                                },
                            },
                        }
                        : item.request.body || {},
                    url: item.request.url || {},
                },
                status: statusText,
                code: status,
                _postman_previewlanguage: isJson ? "json" : "text",
                header: postmanHeaders,
                cookie: [],
                body: isJson
                    ? JSON.stringify(response, null, 2)
                    : String(response),
            });
        };

        // Normalise a resolved URL down to its path portion for fuzzy matching
        // e.g. "https://api.example.com/auth/register" → "/auth/register"
        const urlPath = (u: string) => {
            try {
                return new URL(u).pathname;
            } catch {
                return u;
            }
        };

        const actionPath = urlPath(request.url);

        const findAndAdd = (items: any[]): boolean => {
            for (const item of items) {
                if (item.request) {
                    // Primary match: _id assigned by simplifyPostmanCollection
                    const idMatch = itemId && item._id === itemId;

                    // Fallback match: same HTTP method + URL path
                    const rawUrl: string =
                        item.request.url?.raw ||
                        (item.request.url?.host || []).join("") +
                        "/" +
                        (item.request.url?.path || []).join("/");
                    const itemPath = urlPath(
                        rawUrl.replace(/\{\{[^}]+\}\}/g, ""),
                    );
                    const actionPathClean = actionPath.replace(
                        /\{\{[^}]+\}\}/g,
                        "",
                    );
                    const urlMatch =
                        item.request.method === request.method &&
                        itemPath === actionPathClean;

                    if (idMatch || urlMatch) {
                        pushExample(item);
                        return true;
                    }
                }
                if (item.item && findAndAdd(item.item)) return true;
            }
            return false;
        };

        const matched = findAndAdd(this.collection.item);
        if (!matched) {
            this.file.log(
                `addExampleToItem: no matching item found for item_id="${itemId}" url="${request.url}" method="${request.method}"`,
                "ERROR",
            );
        }
    }

    registerInitialVariables(variables: Record<string, any>) {
        Object.assign(this.registers, variables);
        this.file.log(
            `Initial variables loaded: ${Object.keys(variables).join(", ")}`,
            "INFO",
        );
    }

    private logFailure(
        url: string,
        method: string,
        headers: any,
        body: any,
        response: any,
        errorMsg?: string,
    ) {
        if (!fs.existsSync(this.failedLogsDir)) {
            fs.mkdirSync(this.failedLogsDir, { recursive: true });
        }

        const buildFailureStem = (requestUrl: string, requestMethod: string) => {
            const routePath = extractRoutePath(requestUrl);
            const segments = routePath
                .split("/")
                .map((segment) => segment.trim())
                .filter(Boolean)
                .map((segment) => {
                    if (segment.startsWith(":")) {
                        const paramName = segment.slice(1).trim() || "param";
                        return `[${paramName.replace(/[^a-zA-Z0-9_-]/g, "_")}]`;
                    }

                    return segment.replace(/[^a-zA-Z0-9_-]/g, "_");
                });

            const stem = segments.length ? segments.join("_") : "root";
            return `${stem}_[${requestMethod.toUpperCase()}]`;
        };

        const baseName = buildFailureStem(url, method);
        let filePath = path.join(this.failedLogsDir, `${baseName}.md`);
        let suffix = 2;
        while (fs.existsSync(filePath)) {
            filePath = path.join(
                this.failedLogsDir,
                `${baseName}_${suffix++}.md`,
            );
        }

        let md = `# Failed API Request: ${method} ${url}\n\n`;
        md += `**Timestamp:** ${new Date().toISOString()}\n\n`;

        md += `## Request Details\n`;
        md += `- **URL:** \`${url}\`\n`;
        md += `- **Method:** \`${method}\`\n`;
        md += `- **Headers:**\n\`\`\`json\n${JSON.stringify(headers, null, 2)}\n\`\`\`\n`;
        if (body) {
            md += `- **Body:**\n\`\`\`json\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n\`\`\`\n`;
        }

        md += `\n## Response Details\n`;
        if (response) {
            md += `- **Status:** \`${response.status} ${response.statusText}\`\n`;
            md += `- **Headers:**\n\`\`\`json\n${JSON.stringify(response.headers, null, 2)}\n\`\`\`\n`;

            let responseBody = response.body;
            try {
                responseBody = JSON.stringify(
                    JSON.parse(response.body),
                    null,
                    2,
                );
            } catch { }

            md += `- **Body:**\n\`\`\`json\n${responseBody || "(empty body)"}\n\`\`\`\n`;
        } else if (errorMsg) {
            md += `- **System Error:** ${errorMsg}\n`;
        }

        fs.writeFileSync(filePath, md, "utf-8");
        this.file.log(
            `Detailed failure log saved to: ${path.relative(process.cwd(), filePath)}`,
            "INFO",
        );
    }

    private async runAction(action: WorkflowAction): Promise<boolean> {
        switch (action.action) {
            case "REGISTER":
                this.handleRegister(action as RegisterAction);
                return true;
            case "INPUT":
                await this.handleInput(action as InputAction);
                return true;
            case "LOG":
                this.handleLog(action as LogAction);
                return true;
            case "EXECUTE":
                return await this.handleExecute(action as ExecuteAction);
            default:
                this.console.log(
                    `Unknown action: ${(action as any).action}`,
                    "ERROR",
                );
                this.file.log(
                    `Unknown action: ${(action as any).action}`,
                    "ERROR",
                );
                return false;
        }
    }

    private handleRegister(action: RegisterAction) {
        Object.assign(this.registers, action.registers);
        this.file.log(
            `Registered: ${Object.keys(action.registers).join(", ")}`,
            "INFO",
        );
    }

    private resolveLogValue(action: LogAction) {
        return resolveVariables(action.value, this.registers);
    }

    private resolveExecuteAction(action: ExecuteAction) {
        return {
            ...action,
            url: resolveVariables(action.url, this.registers),
            headers: resolveObject(action.headers || {}, this.registers),
            body: resolveObject(action.body, this.registers),
        };
    }

    private getHeaderValue(headers: Record<string, string>, name: string) {
        const target = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === target) return value;
        }
        return undefined;
    }

    private deleteHeader(headers: Record<string, string>, name: string) {
        const target = name.toLowerCase();
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === target) {
                delete headers[key];
            }
        }
    }

    private prepareRequestPayload(
        method: string,
        headers: Record<string, string>,
        body: any,
    ): { headers: Record<string, string>; body?: BodyInit } {
        const preparedHeaders = { ...headers };
        const normalizedMethod = String(method || "GET").toUpperCase();

        if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
            return { headers: preparedHeaders, body: undefined };
        }

        if (body === undefined || body === null) {
            return { headers: preparedHeaders, body: undefined };
        }

        if (typeof body === "string") {
            return { headers: preparedHeaders, body };
        }

        const contentType =
            this.getHeaderValue(preparedHeaders, "Content-Type")?.toLowerCase() ||
            "";

        if (contentType.includes("multipart/form-data")) {
            const form = new FormData();
            if (typeof body === "object") {
                for (const [key, value] of Object.entries(body)) {
                    if (value === undefined || value === null) continue;
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            if (item === undefined || item === null) continue;
                            form.append(key, String(item));
                        }
                    } else if (typeof value === "object") {
                        form.append(key, JSON.stringify(value));
                    } else {
                        form.append(key, String(value));
                    }
                }
            }

            // Let fetch set the correct multipart boundary automatically.
            this.deleteHeader(preparedHeaders, "Content-Type");
            return { headers: preparedHeaders, body: form };
        }

        if (contentType.includes("application/x-www-form-urlencoded")) {
            const params = new URLSearchParams();
            if (typeof body === "object") {
                for (const [key, value] of Object.entries(body)) {
                    if (value === undefined || value === null) continue;
                    params.append(key, String(value));
                }
            }
            return { headers: preparedHeaders, body: params.toString() };
        }

        if (typeof body === "object") {
            return { headers: preparedHeaders, body: JSON.stringify(body) };
        }

        return { headers: preparedHeaders, body: String(body) };
    }

    private getRequestBodyForLogsAndExports(method: string, body: any) {
        const normalizedMethod = String(method || "GET").toUpperCase();
        if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
            return undefined;
        }
        return body;
    }

    private describeExecutionError(error: any) {
        if (!error) return "Unknown error";

        const parts: string[] = [];
        const name = error.name || error.constructor?.name;
        const message = error.message || String(error);

        if (name && message && message !== name) {
            parts.push(`${name}: ${message}`);
        } else if (message) {
            parts.push(message);
        }

        const cause = error.cause;
        if (
            cause &&
            cause.name === "AggregateError" &&
            Array.isArray(cause.errors)
        ) {
            const causeLines = cause.errors
                .map((entry: any) => {
                    const entryName = entry?.name || entry?.constructor?.name || "Error";
                    const entryMessage = entry?.message || String(entry);
                    return `${entryName}: ${entryMessage}`;
                })
                .filter(Boolean);

            if (causeLines.length) {
                parts.push(`Causes: ${causeLines.join(" | ")}`);
            }
        } else if (cause) {
            const causeName = cause.name || cause.constructor?.name || "Error";
            const causeMessage = cause.message || String(cause);
            parts.push(`Cause: ${causeName}: ${causeMessage}`);
        }

        return parts.filter(Boolean).join(" | ") || "Unknown error";
    }

    private getMissingUrlVariables(url: string) {
        const matches = [...url.matchAll(/\{\{([\w.-]+)\}\}/g)];
        return matches
            .map((match) => match[1])
            .filter((key) => !Object.prototype.hasOwnProperty.call(this.registers, key));
    }

    private async promptForRegisterPathOverride(
        action: ExecuteAction,
        responseData: any,
        registerKey: string,
        originalPath: string,
    ) {
        const rawInputPath = await this.askInput(
            `\n[INPUT] Enter alternate response path for ${registerKey} (failed: ${originalPath}) or press Enter to skip: `,
        );
        const inputPath = String(rawInputPath || "").trim();

        if (!inputPath) {
            this.console.log(
                `Skipped registering ${registerKey} because input was empty.`,
                "INPUT",
            );
            this.file.log(
                `Skipped registering ${registerKey} because input was empty.`,
                "INPUT",
            );
            return;
        }

        const overrideValue = getDeepValue(responseData, inputPath);
        if (overrideValue === undefined) {
            this.console.log(
                `Field not found in response for override path: ${inputPath}`,
                "ERROR",
            );
            this.file.log(
                `Field not found in response for override path: ${inputPath}`,
                "ERROR",
            );
            return;
        }

        this.registers[registerKey] = overrideValue;
        if (action.register) {
            action.register[registerKey] = inputPath;
            this.workflowUpdated = true;
        }
        this.console.log(
            `Extracted ${registerKey} = ${overrideValue} (override path: ${inputPath})`,
            "INPUT",
        );
        this.file.log(
            `Extracted ${registerKey} = ${overrideValue} (override path: ${inputPath})`,
            "INPUT",
        );
        this.file.log(
            `Updated workflow register path for ${registerKey}: ${originalPath} -> ${inputPath}`,
            "INFO",
        );
    }

    private async handleInput(action: InputAction) {
        const resolvedLabel = resolveVariables(action.label, this.registers);
        const input = await this.askInput(`\n[INPUT] ${resolvedLabel}: `);

        if (!input) {
            this.console.log(
                `Skipped registering ${action.register} because input was empty.`,
                "INPUT",
            );
            this.file.log(
                `Skipped registering ${action.register} because input was empty.`,
                "INPUT",
            );
            return;
        }

        this.registers[action.register] = input;
        this.console.log(
            `User input for ${action.register}: ${input}`,
            "INPUT",
        );
        this.file.log(`User input for ${action.register}: ${input}`, "INPUT");
    }

    private handleLog(action: LogAction) {
        const resolvedValue = this.resolveLogValue(action);
        this.console.log(`\n${resolvedValue}`, "INFO");
        this.file.log(resolvedValue, "INFO");
    }

    private async handleExecute(action: ExecuteAction): Promise<boolean> {
        if (this.isStopRequested()) {
            this.console.log("Skipping EXECUTE because stop was requested.", "ERROR");
            this.file.log("Skipping EXECUTE because stop was requested.", "ERROR");
            return false;
        }

        const missingUrlVariables = this.getMissingUrlVariables(action.url);
        if (missingUrlVariables.length > 0) {
            const missingList = missingUrlVariables.join(", ");
            this.console.log(
                `Skipping EXECUTE because URL variables are missing: ${missingList}`,
                "ERROR",
            );
            this.file.log(
                `Skipping EXECUTE because URL variables are missing: ${missingList}`,
                "ERROR",
            );
            this.stats.skipped++;
            return true;
        }

        const resolvedAction = this.resolveExecuteAction(action);
        const { url, method, headers, body } = resolvedAction;
        const effectiveBody = this.getRequestBodyForLogsAndExports(method, body);

        const skipPatterns = this.config.skip || [];
        const onlyPatterns = this.config.only || [];

        if (
            skipPatterns.length > 0 &&
            matchesAnyRoutePattern(url, skipPatterns)
        ) {
            this.console.log(`Skipping (skip-pattern): ${url}`, "INFO");
            this.file.log(`Skipping (skip-pattern): ${url}`, "INFO");
            this.stats.skipped++;
            return true;
        }
        if (
            onlyPatterns.length > 0 &&
            !matchesAnyRoutePattern(url, onlyPatterns)
        ) {
            this.file.log(`Hidden by only-pattern: ${url}`, "INFO");
            this.stats.skipped++;
            return true;
        }

        this.console.log(`Executing [${method}] -> ${url}`, "INFO");
        this.file.log(`Executing [${method}] -> ${url}`, "INFO");

        this.console.log(`Headers: ${JSON.stringify(headers)}`, "INFO");
        this.file.log(`Headers: ${JSON.stringify(headers, null, 2)}`, "INFO");
        if (effectiveBody !== undefined) {
            this.console.log(`Body: ${JSON.stringify(effectiveBody)}`, "INFO");
            this.file.log(`Body: ${JSON.stringify(effectiveBody, null, 2)}`, "INFO");
        }

        const prepared = this.prepareRequestPayload(method, headers, effectiveBody);

        if (this.config.dry) {
            this.console.log("Dry run: request not sent", "INFO");
            this.file.log("Dry run: request not sent", "INFO");
            this.stats.skipped++;
            return true;
        }

        if (this.config.delay && this.config.delay > 0) {
            await new Promise((resolve) =>
                setTimeout(resolve, this.config.delay),
            );

            if (this.isStopRequested()) {
                this.console.log(
                    "Execution stopped by user request before sending request.",
                    "ERROR",
                );
                this.file.log(
                    "Execution stopped by user request before sending request.",
                    "ERROR",
                );
                return false;
            }
        }

        try {
            const controller = new AbortController();
            const onStop = () => controller.abort();
            this.config.stopSignal?.addEventListener("abort", onStop);

            const timeoutId = setTimeout(
                () => controller.abort(),
                this.config.timeout,
            );

            let response: Response;
            try {
                response = await fetch(url, {
                    method,
                    headers: prepared.headers,
                    body: prepared.body,
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
                this.config.stopSignal?.removeEventListener("abort", onStop);
            }

            const resDataLog = `Response: [${response.status}] ${response.statusText}`;
            this.console.log(resDataLog, response.ok ? "NETWORK" : "FAIL");
            this.file.log(resDataLog, response.ok ? "NETWORK" : "ERROR");

            const responseText = await response.text();

            if (response.ok) {
                this.stats.success++;
            } else {
                this.stats.failed++;
                this.logFailure(url, method, prepared.headers, effectiveBody, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()),
                    body: responseText,
                });
            }

            let resData: any;
            try {
                resData = JSON.parse(responseText);
            } catch {
                resData = responseText;
            }

            this.file.log(
                `Full Response: ${JSON.stringify(resData, null, 2)}`,
                "INFO",
            );
            this.console.log(
                `Full Response: ${JSON.stringify(resData)}`,
                "INFO",
            );

            if (action.register) {
                for (const [key, path] of Object.entries(action.register)) {
                    const value = getDeepValue(resData, path);
                    if (value !== undefined) {
                        this.registers[key] = value;
                        this.console.log(`Extracted ${key} = ${value}`, "INFO");
                        this.file.log(`Extracted ${key} = ${value}`, "INFO");
                    } else {
                        this.console.log(
                            `Field not found in response: ${path}`,
                            "ERROR",
                        );
                        this.file.log(
                            `Field not found in response: ${path}`,
                            "ERROR",
                        );

                        await this.promptForRegisterPathOverride(
                            action,
                            resData,
                            key,
                            path,
                        );
                    }
                }
            }

            const request = {
                url,
                method,
                // Save original workflow headers (before variable resolution)
                // so exported examples preserve placeholders like {{token}}.
                headers: action.headers || {},
                body:
                    effectiveBody !== undefined
                        ? JSON.stringify(effectiveBody)
                        : undefined,
            }

            this.addExampleToItem(
                action.item_id || "",
                request,
                resData,
                response.status,
                response.statusText,
                response.headers,
                response.ok,
            );
            return response.ok;
        } catch (error: any) {
            const isAbort = error.name === "AbortError";
            const msg =
                isAbort
                    ? this.isStopRequested()
                        ? "STOPPED"
                        : "TIMEOUT"
                    : this.describeExecutionError(error);
            this.console.log(`Execution Failed: ${msg}`, "ERROR");
            this.file.log(`Execution Failed: ${msg}`, "ERROR");
            this.stats.errors++;
            this.logFailure(url, method, prepared.headers, effectiveBody, null, msg);
            return false;
        }
    }
}
