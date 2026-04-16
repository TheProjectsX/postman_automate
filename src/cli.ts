import * as readline from "readline";
import type { ActionConfig } from "./executor.ts";
import type { SimplifiedRequest } from "./brain.ts";
import { matchesAnyRoutePattern } from "./utils.ts";

export type CliArgs = ActionConfig & {
    collection?: string;
    context?: string;
    contextRequested?: boolean;
};

const mergePatterns = (
    current: string[] | undefined,
    rawValue: string | undefined,
): string[] | undefined => {
    if (!rawValue) return current;
    const patterns = rawValue
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    if (!patterns.length) return current;
    return [...(current || []), ...patterns];
};

export const parseArgs = (): CliArgs => {
    const args = process.argv.slice(2);
    const config: CliArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // Split on first '=' only — handles values that themselves contain '='
        // e.g. --url=http://foo.com/bar=baz
        const getVal = (
            a: string,
            next: string | undefined,
        ): string | undefined => {
            if (a.includes("=")) return a.split("=").slice(1).join("=");
            if (next && !next.startsWith("-")) {
                i++;
                return next;
            }
            return undefined;
        };

        if (arg.startsWith("--delay")) {
            config.delay = parseInt(getVal(arg, args[i + 1]) || "0");
        } else if (arg.startsWith("--timeout")) {
            config.timeout = parseInt(getVal(arg, args[i + 1]) || "30000");
        } else if (arg.startsWith("--skip")) {
            config.skip = mergePatterns(
                config.skip,
                getVal(arg, args[i + 1]),
            );
        } else if (arg.startsWith("--only")) {
            config.only = mergePatterns(
                config.only,
                getVal(arg, args[i + 1]),
            );
        } else if (
            arg.startsWith("--workflow") ||
            arg.startsWith("--wf") ||
            arg.startsWith("-wf")
        ) {
            config.workflowPath = getVal(arg, args[i + 1]);
        } else if (arg.startsWith("--context") || arg.startsWith("-c")) {
            config.contextRequested = true;
            config.context = getVal(arg, args[i + 1]);
        } else if (arg === "--dry") {
            config.dry = true;
        } else if (!arg.startsWith("-")) {
            config.collection = arg;
        }
    }

    return config;
};

export const showHelp = () => {
    console.log(`
Usage: node index.ts <collection.json> [flags]

Flags:
  --delay=<ms>         Delay between requests (default: 0)
  --timeout=<ms>       Request timeout in ms (default: 30000)
  --skip=<pattern>     Skip requests whose URL contains pattern (repeatable)
  --only=<pattern>     Only run requests whose URL contains pattern (repeatable)
  --workflow=<path>    Use a pre-generated workflow JSON  (alias: -wf=)
    --wf=<path>          Alias for --workflow
  --context=<text>     Extra instructions or context appended to the AI prompt (alias: -c=)
  --dry                Dry run — plan workflow but do not send requests

Examples:
  node index.ts postman-collection.json --skip=/admin
  node index.ts postman-collection.json --skip=/admin --skip=/internal
  node index.ts postman-collection.json --skip=/admin,/internal
  node index.ts postman-collection.json --only=/auth
  node index.ts postman-collection.json --only=/auth --only=/profile
`);
};

export const promptForContext = (): Promise<string> => {
    return promptText(
        "\n[CONTEXT] Enter additional instructions for the AI (or press Enter to skip):\n> ",
    );
};

export const promptText = (question: string): Promise<string> => {
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
};

export const filterRequestsByCliPatterns = (
    requests: SimplifiedRequest[],
    args: CliArgs,
): SimplifiedRequest[] => {
    const skipPatterns = args.skip || [];
    const onlyPatterns = args.only || [];

    return requests.filter((request) => {
        if (skipPatterns.length > 0 && matchesAnyRoutePattern(request.url, skipPatterns)) {
            return false;
        }

        if (
            onlyPatterns.length > 0 &&
            !matchesAnyRoutePattern(request.url, onlyPatterns)
        ) {
            return false;
        }

        return true;
    });
};
