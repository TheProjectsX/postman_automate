import * as fs from "fs";
import * as path from "path";
import {
    FileLogger,
    ConsoleLogger,
    extractCollectionVariables,
    simplifyPostmanCollection,
} from "./src/utils.ts";
import { ActionExecutor } from "./src/executor.ts";
import type { WorkflowAction } from "./src/executor.ts";
import {
    parseArgs,
    showHelp,
    promptForContext,
    filterRequestsByCliPatterns,
} from "./src/cli.ts";


export const consoleLogger = new ConsoleLogger();
export const fileLogger = new FileLogger();

const main = async () => {
    const args = parseArgs();

    if (!args.collection) {
        showHelp();
        process.exit(1);
    }


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

        const variables = extractCollectionVariables(collection);

        // 3. Obtain Workflow
        let workflow: WorkflowAction[] = [];
        let runtimeWorkflowPath: string | undefined;

        if (args.workflowPath) {
            // Annotate collection request items with synthetic _id values so
            // exported response examples can map back to items reliably.
            simplifyPostmanCollection(collection);

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
            // 2. Simplify Collection
            consoleLogger.log("\nAnalyzing collection structure...", "INFO");
            fileLogger.log("Analyzing collection structure...", "INFO");

            const { requests } = simplifyPostmanCollection(collection);
            const effectiveRequests = filterRequestsByCliPatterns(
                requests,
                args,
            );

            consoleLogger.log(
                `Found ${requests.length} potential API routes`,
                "INFO",
            );
            if (effectiveRequests.length !== requests.length) {
                consoleLogger.log(
                    `Route filters active: ${effectiveRequests.length}/${requests.length} routes eligible for workflow generation`,
                    "INFO",
                );
                fileLogger.log(
                    `Route filters active: ${effectiveRequests.length}/${requests.length} routes eligible for workflow generation`,
                    "INFO",
                );
            }

            fileLogger.log(
                `Simplified requests: ${JSON.stringify(requests, null, 2)}`,
                "DEBUG",
            );

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

            const { generateWorkflowWithCoverage } = await import("./src/brain.ts");

            try {
                workflow = await generateWorkflowWithCoverage(
                    effectiveRequests,
                    variables,
                    context,
                    {
                        maxAttempts: 3,
                        onAttemptFailure: (attempt, report) => {
                            const summary =
                                `AI workflow attempt ${attempt} incomplete: missing=${report.missing.length}, ` +
                                `unknown_item_id=${report.extraItemIds.length}, ` +
                                `no_item_id=${report.executeWithoutItemId}`;
                            consoleLogger.log(summary, "ERROR");
                            fileLogger.log(summary, "ERROR");
                        },
                        onRepairSuccess: (attempt) => {
                            consoleLogger.log(
                                `Workflow repaired successfully on attempt ${attempt}.`,
                                "AI",
                            );
                            fileLogger.log(
                                `Workflow repaired successfully on attempt ${attempt}.`,
                                "AI",
                            );
                        },
                        onModelLog: (message, level) => {
                            fileLogger.log(
                                message,
                                level === "ERROR" ? "ERROR" : "AI",
                            );
                        },
                    },
                );

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
                runtimeWorkflowPath = savePath;

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
            {
                ...args,
                exportBaseName: path.parse(collectionPath).name,
                runtimeWorkflowPath,
            },
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
