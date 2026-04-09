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

export const extractCollectionVariables = (collection: PostmanCollection) => {
    return (collection.variable || []).reduce((acc: any, v: any) => {
        acc[v.key] = v.value;
        return acc;
    }, {});
};

export const simplifyPostmanCollection = (collection: PostmanCollection) => {
    const results: ExtractedRequest[] = [];

    let counter = 0;
    const asArray = (items: PostmanItem | PostmanItem[] | undefined) => {
        if (!items) return [];
        return Array.isArray(items) ? items : [items];
    };

    const traverse = (
        items: PostmanItem | PostmanItem[] | undefined,
        parentPath: string[] = [],
    ) => {
        for (const item of asArray(items)) {
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

                // Mirror Postman bearer auth into a standard Authorization
                // header so the AI planner can see auth requirements directly.
                if (request.auth?.type === "bearer") {
                    const bearerItems = Array.isArray(request.auth.bearer)
                        ? request.auth.bearer
                        : [];
                    const tokenEntry = bearerItems.find(
                        (b: any) => b?.key === "token" && b?.value,
                    );

                    if (tokenEntry && !headers.Authorization) {
                        const tokenValue = String(tokenEntry.value).trim();
                        headers.Authorization = tokenValue.toLowerCase().startsWith("bearer ")
                            ? tokenValue
                            : `Bearer ${tokenValue}`;
                    }
                }

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

    const variables = extractCollectionVariables(collection);

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
        const cleanMessage = message.replace(/^\n+/, "");

        if (type === "BANNER") {
            console.log(`${color}${prefix}${cleanMessage}${C.reset}`);
        } else {
            const datetime = new Date().toLocaleTimeString();
            const paddedType = this.centerPad(type, 7);
            const lines = cleanMessage.split("\n");

            if (prefix) {
                process.stdout.write(prefix);
            }

            for (const line of lines) {
                console.log(
                    `${color}[${datetime}] [${paddedType}] ${line}${C.reset}`,
                );
            }
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
    if (!path || typeof path !== "string") return undefined;

    const tokens: Array<string | number> = [];
    for (const part of path.split(".")) {
        if (!part) continue;

        const matches = [...part.matchAll(/([^\[\]]+)|\[(\d+)\]/g)];
        if (!matches.length) continue;

        for (const match of matches) {
            if (match[1] !== undefined) tokens.push(match[1]);
            else if (match[2] !== undefined) tokens.push(Number(match[2]));
        }
    }

    let current = obj;
    for (const token of tokens) {
        if (current === null || current === undefined) return undefined;

        if (typeof token === "number") {
            if (!Array.isArray(current)) return undefined;
            current = current[token];
            continue;
        }

        // Convenience fallback:
        // If a path uses object-style access on an array (e.g. data.id),
        // treat it as first element (data[0].id) when possible.
        if (Array.isArray(current)) {
            current = current[0];
            if (current === null || current === undefined) return undefined;
        }

        current = current[token];
    }

    return current;
};

const stripQueryAndHash = (value: string) => value.split(/[?#]/)[0] || value;

// Extract pathname from a full URL, host/path string, or {{baseUrl}}-prefixed URL.
export const extractRoutePath = (raw: string): string => {
    const input = (raw || "").trim();
    if (!input) return "/";

    const withoutVars = input.replace(/^\{\{[^}]+\}\}/, "");
    const candidate = stripQueryAndHash(withoutVars);

    if (candidate.startsWith("/")) return candidate;

    // Try absolute URLs first.
    try {
        const parsed = new URL(candidate);
        return parsed.pathname || "/";
    } catch {
        // Fall through for non-URL strings.
    }

    // Support host/path (without protocol), e.g. api.example.com/auth/login
    const slashIndex = candidate.indexOf("/");
    if (slashIndex >= 0) {
        return `/${candidate.slice(slashIndex + 1)}`.replace(/\/+/g, "/");
    }

    return "/";
};

const splitPath = (value: string) =>
    value
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);

// Pattern rules:
// - "/tax-hub" matches only that exact path
// - "/tax-hub/:id" matches one dynamic segment after /tax-hub
// - "/tax-hub/:" matches one dynamic or concrete segment after /tax-hub
export const matchesRoutePattern = (urlOrPath: string, pattern: string) => {
    const rawPattern = (pattern || "").trim();
    if (!rawPattern) return false;

    // Keep backward compatibility for generic substring patterns.
    if (!rawPattern.startsWith("/")) {
        return urlOrPath.toLowerCase().includes(rawPattern.toLowerCase());
    }

    const routePath = extractRoutePath(urlOrPath).toLowerCase();
    const patternPath = extractRoutePath(rawPattern).toLowerCase();

    const routeSegments = splitPath(routePath);
    const patternSegments = splitPath(patternPath);

    if (patternSegments.length === 0) {
        return routeSegments.length === 0;
    }

    // Keep practical behavior for one-segment root patterns, e.g. /admin
    // matches /admin and /admin/*
    if (
        patternSegments.length === 1 &&
        !patternSegments[0].startsWith(":")
    ) {
        return routeSegments[0] === patternSegments[0];
    }

    for (let i = 0; i < patternSegments.length; i++) {
        const routeSeg = routeSegments[i];
        const patternSeg = patternSegments[i];

        if (!routeSeg) return false;

        // Trailing '/:' means: from this segment onward match any value/tail.
        if (patternSeg === ":" && i === patternSegments.length - 1) {
            return true;
        }

        if (
            patternSeg === ":" ||
            patternSeg.startsWith(":")
        ) {
            continue;
        }

        if (routeSeg !== patternSeg) return false;
    }

    return routeSegments.length === patternSegments.length;
};

export const matchesAnyRoutePattern = (
    urlOrPath: string,
    patterns: string[] = [],
) => patterns.some((pattern) => matchesRoutePattern(urlOrPath, pattern));
