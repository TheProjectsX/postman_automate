import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
    FileLogger,
    ConsoleLogger,
    simplifyPostmanCollection,
} from "./src/utils.ts";
import { processPostmanAI } from "./src/brain.ts";
import { ActionExecutor } from "./src/executor.ts";
import type { WorkflowAction, ActionConfig } from "./src/executor.ts";

type CliArgs = ActionConfig & {
    collection?: string;
    context?: string;
    contextRequested?: boolean;
};

const parseArgs = (): CliArgs => {
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
            config.skip = getVal(arg, args[i + 1]);
        } else if (arg.startsWith("--only")) {
            config.only = getVal(arg, args[i + 1]);
        } else if (arg.startsWith("--workflow") || arg.startsWith("-wf")) {
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

const showHelp = () => {
    console.log(`
Usage: node index.ts <collection.json> [flags]

Flags:
  --delay=<ms>         Delay between requests (default: 0)
  --timeout=<ms>       Request timeout in ms (default: 30000)
  --skip=<pattern>     Skip requests whose URL contains pattern
  --only=<pattern>     Only run requests whose URL contains pattern
  --workflow=<path>    Use a pre-generated workflow JSON  (alias: -wf=)
  --context=<text>     Extra instructions or context appended to the AI prompt (alias: -c=)
  --dry                Dry run — plan workflow but do not send requests
`);
};

const promptForContext = (): Promise<string> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(
            "\n[CONTEXT] Enter additional instructions for the AI (or press Enter to skip):\n> ",
            (answer) => {
                rl.close();
                resolve(answer.trim());
            },
        );
    });
};

const main = async () => {
    const args = parseArgs();

    if (!args.collection) {
        showHelp();
        process.exit(1);
    }

    const consoleLogger = new ConsoleLogger();
    const fileLogger = new FileLogger();
    fileLogger.clear();

    const banner = (msg: string) => {
        consoleLogger.log(
            "==========================================",
            "BANNER",
        );
        consoleLogger.log(`   ${msg.padEnd(35)}`, "BANNER");
        consoleLogger.log(
            "==========================================",
            "BANNER",
        );

        fileLogger.log("==========================================", "BANNER");
        fileLogger.log(`   ${msg.padEnd(35)}`, "BANNER");
        fileLogger.log("==========================================", "BANNER");
    };

    banner("POSTMAN AI AUTOMATOR - STARTING");

    try {
        // 1. Load Collection
        const collectionPath = args.collection;
        if (!fs.existsSync(collectionPath)) {
            throw new Error(`Collection file not found: ${collectionPath}`);
        }

        consoleLogger.log(`Loading collection: ${collectionPath}`, "INFO");
        fileLogger.log(`Loading collection: ${collectionPath}`, "INFO");

        const collectionJson = fs.readFileSync(collectionPath, "utf-8");
        const collection = JSON.parse(collectionJson);

        // 2. Simplify Collection
        consoleLogger.log("\nAnalyzing collection structure...", "INFO");
        fileLogger.log("Analyzing collection structure...", "INFO");

        const { requests, variables } = simplifyPostmanCollection(collection);
        consoleLogger.log(
            `Found ${requests.length} potential API routes`,
            "INFO",
        );

        fileLogger.log(
            `Simplified requests: ${JSON.stringify(requests, null, 2)}`,
            "DEBUG",
        );

        // 3. Obtain Workflow
        let workflow: WorkflowAction[];

        if (args.workflowPath) {
            consoleLogger.log(
                `Using pre-generated workflow: ${args.workflowPath}`,
                "INFO",
            );
            fileLogger.log(
                `Loading workflow from: ${args.workflowPath}`,
                "INFO",
            );
            if (!fs.existsSync(args.workflowPath)) {
                throw new Error(
                    `Workflow file not found: ${args.workflowPath}`,
                );
            }
            workflow = JSON.parse(fs.readFileSync(args.workflowPath, "utf-8"));
        } else {
            // Resolve context: CLI flag takes priority, otherwise prompt interactively
            let context = args.context;
            if (args.contextRequested && context === undefined) {
                // --context flag was passed with no value — ask interactively
                context = await promptForContext();
            }
            // Empty string means "no context" — that's fine, brain handles it

            if (context) {
                consoleLogger.log(`Context: ${context}`, "INFO");
                fileLogger.log(`Context: ${context}`, "INFO");
            }

            consoleLogger.log("\nAI is preparing execution workflow...", "AI");
            fileLogger.log(
                "Hitting Gemini AI for workflow generation...",
                "AI",
            );

            try {
                workflow = await processPostmanAI(requests, variables, context);

                // Save workflow for future use
                const workflowDir = path.join(process.cwd(), "workflows");
                if (!fs.existsSync(workflowDir))
                    fs.mkdirSync(workflowDir, { recursive: true });

                const now = new Date();
                const ts =
                    now.toISOString().split("T")[0] +
                    "_" +
                    now.toTimeString().split(" ")[0].replace(/:/g, "-");
                const savePath = path.join(workflowDir, `workflow_${ts}.json`);

                fs.writeFileSync(
                    savePath,
                    JSON.stringify(workflow, null, 2),
                    "utf-8",
                );

                consoleLogger.log(
                    `Workflow saved to: ${path.relative(process.cwd(), savePath)}`,
                    "INFO",
                );
                fileLogger.log(`Workflow saved to: ${savePath}`, "INFO");
                fileLogger.log(
                    `AI Response: ${JSON.stringify(workflow, null, 2)}`,
                    "AI",
                );
            } catch (error: any) {
                if (
                    error.message.includes("429") ||
                    error.message.includes("Quota")
                ) {
                    consoleLogger.log(
                        "AI Quota Exceeded. Use --workflow=<path> to reuse a cached workflow.",
                        "ERROR",
                    );
                }
                throw error;
            }
        }

        consoleLogger.log(
            `Workflow loaded with ${workflow.length} planned steps`,
            "INFO",
        );

        // 4. Execute Workflow
        const executor = new ActionExecutor(
            consoleLogger,
            fileLogger,
            args,
            collection,
        );
        executor.registerInitialVariables(variables);

        await executor.execute(workflow);

        banner("AUTOMATION COMPLETED SUCCESSFULLY");
    } catch (error: any) {
        consoleLogger.log(`FATAL ERROR: ${error.message}`, "ERROR");
        fileLogger.log(`FATAL ERROR: ${error.message}`, "ERROR");
        if (error.stack) fileLogger.log(error.stack, "ERROR");
        process.exit(1);
    }
};

main();
