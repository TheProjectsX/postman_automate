import * as fs from "fs";
import * as path from "path";

type ExtractedRequest = {
    name: string;
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    item_id: string;
};

type PostmanItem = {
    name: string;
    item?: PostmanItem[];
    request?: any;
    _id?: string;
    response?: any[];
};

type PostmanCollection = {
    item: PostmanItem[];
    variable?: { key: string; value: any }[];
};

export const simplifyPostmanCollection = (collection: PostmanCollection) => {
    const results: ExtractedRequest[] = [];

    let counter = 0;
    const traverse = (items: PostmanItem[], parentPath: string[] = []) => {
        for (const item of items) {
            const currentPath = [...parentPath, item.name];

            // If it's a request
            if (item.request) {
                const { request } = item;
                const item_id = `postman_item_${++counter}`;
                item._id = item_id;

                const url =
                    (request.url?.host || []).join("") +
                    "/" +
                    (request.url?.path || []).join("/");

                const headers = (request.header || []).reduce(
                    (acc: Record<string, string>, h: any) => {
                        acc[h.key] = h.value;
                        return acc;
                    },
                    {},
                );

                let body: any = undefined;
                if (request.body?.raw) {
                    try {
                        body = JSON.parse(request.body.raw);
                    } catch {
                        body = request.body.raw;
                    }
                }

                results.push({
                    name: item.name,
                    method: request.method,
                    url,
                    headers: Object.keys(headers).length ? headers : undefined,
                    body,
                    item_id,
                });
            }

            // If it has nested items
            if (item.item && item.item.length > 0) {
                traverse(item.item, currentPath);
            }
        }
    };
    traverse(collection.item);

    const variables = (collection.variable || []).reduce((acc: any, v: any) => {
        acc[v.key] = v.value;
        return acc;
    }, {});

    return { requests: results, variables };
};

export const C = {
    cyan: "\x1b[36m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    reset: "\x1b[0m",
};

export const cc = (color: string, text: string) => `${color}${text}${C.reset}`;

export type LogType = "INFO" | "ERROR" | "AI" | "NETWORK" | "INPUT" | "BANNER" | "SUCCESS" | "FAIL";

export class ConsoleLogger {
    private typeToColor: Record<LogType, string> = {
        INFO: C.cyan,
        ERROR: C.red,
        AI: C.magenta,
        NETWORK: C.green,
        INPUT: C.yellow,
        BANNER: C.blue,
        SUCCESS: C.green,
        FAIL: C.red,
    };

    private centerPad(text: string, length: number): string {
        if (text.length >= length) return text;
        const leftSpace = Math.floor((length - text.length) / 2);
        const rightSpace = length - text.length - leftSpace;
        return " ".repeat(leftSpace) + text + " ".repeat(rightSpace);
    }

    log(message: string, type: LogType = "INFO", colorOverride?: string) {
        const color = colorOverride || this.typeToColor[type] || C.reset;
        const newLineMatch = message.match(/^\n+/);
        const prefix = newLineMatch ? newLineMatch[0] : "";
        const cleanMessage = message.replace(/^\n+/, "").replace(/\n/g, "");

        if (type === "BANNER") {
            console.log(`${color}${prefix}${cleanMessage}${C.reset}`);
        } else {
            const datetime = new Date().toLocaleTimeString();
            const paddedType = this.centerPad(type, 7);
            console.log(
                `${color}${prefix}[${datetime}] [${paddedType}] ${cleanMessage}${C.reset}`,
            );
        }
    }
}

export class FileLogger {
    private filename: string;
    private logDir = path.join(process.cwd(), "logs", "process_logs");

    constructor(filename?: string) {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        const now = new Date();
        const date = now.toISOString().split("T")[0];
        const time = now.toTimeString().split(" ")[0].replace(/:/g, "-");

        if (filename) {
            this.filename = path.join(this.logDir, filename);
        } else {
            this.filename = path.join(
                this.logDir,
                `process_${date}_${time}.log`,
            );
        }
    }

    log(message: string, type: string = "INFO") {
        const datetime = new Date().toISOString();
        const formattedMessage = `[${datetime}] [${type}] ${message}\n`;
        fs.appendFileSync(this.filename, formattedMessage);
    }

    clear() {
        if (fs.existsSync(this.filename)) {
            fs.writeFileSync(this.filename, "");
        }
    }

    read() {
        if (!fs.existsSync(this.filename)) return "";
        return fs.readFileSync(this.filename, "utf-8");
    }

    getPath() {
        return this.filename;
    }
}

export const resolveVariables = (
    text: string,
    registers: Record<string, any>,
): string => {
    if (typeof text !== "string") return text;
    // Support {{variable}} with characters: word, dot, hyphen
    return text.replace(/\{\{([\w.-]+)\}\}/g, (match, key) => {
        return registers.hasOwnProperty(key) ? String(registers[key]) : match;
    });
};

export const resolveObject = (
    obj: any,
    registers: Record<string, any>,
): any => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") return resolveVariables(obj, registers);
    if (Array.isArray(obj))
        return obj.map((item) => resolveObject(item, registers));
    if (typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            const resolvedKey = resolveVariables(key, registers);
            result[resolvedKey] = resolveObject(value, registers);
        }
        return result;
    }
    return obj;
};

export const getDeepValue = (obj: any, path: string) => {
    return path.split(".").reduce((acc, part) => acc && acc[part], obj);
};
