import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import {
    FileLogger,
    ConsoleLogger,
    getDeepValue,
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

export type WorkflowAction =
    | RegisterAction
    | InputAction
    | LogAction
    | ExecuteAction;

export type ActionConfig = {
    delay?: number;
    timeout?: number;
    skip?: string;
    only?: string;
    dry?: boolean;
    workflowPath?: string;
};

export class ActionExecutor {
    private registers: Record<string, any> = {};
    private console: ConsoleLogger;
    private file: FileLogger;
    private config: ActionConfig;
    private stats = { total: 0, success: 0, failed: 0, skipped: 0, errors: 0 };
    private failedLogsDir: string;

    private collection: any;

    constructor(
        console: ConsoleLogger,
        file: FileLogger,
        config: ActionConfig = {},
        collection?: any,
    ) {
        this.console = console;
        this.file = file;
        this.config = {
            delay: 0,
            timeout: 30000,
            ...config,
        };
        this.collection = collection;

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

    async execute(actions: WorkflowAction[]) {
        this.console.log("\n--- Starting Workflow Execution ---", "INFO");
        this.file.log("--- Starting Workflow Execution ---", "INFO");
        this.stats.total = actions.filter((a) => a.action === "EXECUTE").length;
        let consecutiveErrors = 0;
        const CONSECUTIVE_ERROR_LIMIT = 5;
        for (const action of actions) {
            const success = await this.runAction(action);
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

        if (this.collection) {
            await this.finalizeExport();
        }
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
        const filename = `collection_export_${ts}.json`;
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
    }

    private addExampleToItem(
        itemId: string,
        action: ExecuteAction,
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

            // Format response headers for Postman
            const postmanHeaders: any[] = [];
            resHeaders.forEach((value, key) => {
                postmanHeaders.push({ key, value });
            });

            const isJson = typeof response === "object" && response !== null;

            item.response.push({
                name: exampleName,
                originalRequest: {
                    method: item.request.method,
                    header: item.request.header || [],
                    body: action.body
                        ? {
                              mode: "raw",
                              raw: JSON.stringify(action.body, null, 2),
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

        const actionPath = urlPath(action.url);

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
                        item.request.method === action.method &&
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
                `addExampleToItem: no matching item found for item_id="${itemId}" url="${action.url}" method="${action.method}"`,
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

        const safeName = url.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
        const filePath = path.join(
            this.failedLogsDir,
            `${method}_${safeName}_${Date.now()}.md`,
        );

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
            } catch {}

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

    private async handleInput(action: InputAction) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const input = await new Promise<string>((resolve) => {
            rl.question(`\n[INPUT] ${action.label}: `, (answer) => {
                rl.close();
                resolve(answer);
            });
        });

        this.registers[action.register] = input;
        this.console.log(
            `User input for ${action.register}: ${input}`,
            "INPUT",
        );
        this.file.log(`User input for ${action.register}: ${input}`, "INPUT");
    }

    private handleLog(action: LogAction) {
        const resolvedValue = resolveVariables(action.value, this.registers);
        this.console.log(`\n${resolvedValue}`, "INFO");
        this.file.log(resolvedValue, "INFO");
    }

    private async handleExecute(action: ExecuteAction): Promise<boolean> {
        const url = resolveVariables(action.url, this.registers);
        const method = action.method;

        if (
            this.config.skip &&
            url.toLowerCase().includes(this.config.skip.toLowerCase())
        ) {
            this.console.log(`Skipping (skip-pattern): ${url}`, "INFO");
            this.file.log(`Skipping (skip-pattern): ${url}`, "INFO");
            this.stats.skipped++;
            return true;
        }
        if (
            this.config.only &&
            !url.toLowerCase().includes(this.config.only.toLowerCase())
        ) {
            this.file.log(`Hidden by only-pattern: ${url}`, "INFO");
            this.stats.skipped++;
            return true;
        }

        const headers = resolveObject(action.headers || {}, this.registers);
        const body = resolveObject(action.body, this.registers);

        this.console.log(`Executing [${method}] -> ${url}`, "INFO");
        this.file.log(`Executing [${method}] -> ${url}`, "INFO");

        this.file.log(`Headers: ${JSON.stringify(headers, null, 2)}`, "INFO");
        if (body) {
            this.file.log(`Body: ${JSON.stringify(body, null, 2)}`, "INFO");
        }

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
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                this.config.timeout,
            );

            const response = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            const resDataLog = `Response: [${response.status}] ${response.statusText}`;
            this.console.log(resDataLog, response.ok ? "NETWORK" : "FAIL");
            this.file.log(resDataLog, response.ok ? "NETWORK" : "ERROR");

            const responseText = await response.text();

            if (response.ok) {
                this.stats.success++;
            } else {
                this.stats.failed++;
                this.logFailure(url, method, headers, body, {
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
                    }
                }
            }
            this.addExampleToItem(
                action.item_id || "",
                action,
                resData,
                response.status,
                response.statusText,
                response.headers,
                response.ok,
            );
            return response.ok;
        } catch (error: any) {
            const msg = error.name === "AbortError" ? "TIMEOUT" : error.message;
            const cause = error.cause
                ? ` (Cause: ${error.cause.message || error.cause})`
                : "";
            this.console.log(`Execution Failed: ${msg}${cause}`, "ERROR");
            this.file.log(`Execution Failed: ${msg}${cause}`, "ERROR");
            this.stats.errors++;
            this.logFailure(url, method, headers, body, null, msg + cause);
            return false;
        }
    }
}
