import * as fs from "fs";
import * as path from "path";
import {
    extractCollectionVariables,
    simplifyPostmanCollection,
    matchesAnyRoutePattern,
} from "../utils.ts";
import { ActionExecutor } from "../executor.ts";
import type {
    ActionConfig,
    ExecutionLogger,
    ExecutionOutcome,
    PromptProvider,
    WorkflowAction,
} from "../executor.ts";
import type { SimplifiedRequest } from "../brain.ts";

export type RunAutomationEvent =
    | { type: "run.started"; collectionPath: string }
    | {
        type: "workflow.loaded";
        workflowPath: string;
        stepCount: number;
    }
    | {
        type: "workflow.generated";
        workflowPath: string;
        stepCount: number;
    }
    | {
        type: "routes.filtered";
        totalRoutes: number;
        effectiveRoutes: number;
    }
    | {
        type: "run.completed";
        result: ExecutionOutcome;
    };

export type RunAutomationRequest = ActionConfig & {
    collectionPath: string;
    context?: string;
};

export type RunAutomationResult = {
    workflow: WorkflowAction[];
    workflowPathUsed?: string;
    workflowPathGenerated?: string;
    execution: ExecutionOutcome;
};

export type RunAutomationDependencies = {
    consoleLogger: ExecutionLogger;
    fileLogger: ExecutionLogger;
    promptProvider?: PromptProvider;
    onEvent?: (event: RunAutomationEvent) => void;
};

const filterRequestsByPatterns = (
    requests: SimplifiedRequest[],
    skip: string[] = [],
    only: string[] = [],
) => {
    return requests.filter((request) => {
        if (skip.length > 0 && matchesAnyRoutePattern(request.url, skip)) {
            return false;
        }

        if (only.length > 0 && !matchesAnyRoutePattern(request.url, only)) {
            return false;
        }

        return true;
    });
};

export class PostmanAutomationCore {
    private deps: RunAutomationDependencies;

    constructor(dependencies: RunAutomationDependencies) {
        this.deps = dependencies;
    }

    private emit(event: RunAutomationEvent) {
        this.deps.onEvent?.(event);
    }

    async run(request: RunAutomationRequest): Promise<RunAutomationResult> {
        const { consoleLogger, fileLogger } = this.deps;

        if (!request.collectionPath) {
            throw new Error("Collection path is required.");
        }

        this.emit({
            type: "run.started",
            collectionPath: request.collectionPath,
        });

        if (!fs.existsSync(request.collectionPath)) {
            throw new Error(`Collection file not found: ${request.collectionPath}`);
        }

        consoleLogger.log(`Loading collection: ${request.collectionPath}`, "INFO");
        fileLogger.log(`Loading collection: ${request.collectionPath}`, "INFO");

        const collectionJson = fs.readFileSync(request.collectionPath, "utf-8");
        const collection = JSON.parse(collectionJson);
        const variables = extractCollectionVariables(collection);

        let workflow: WorkflowAction[] = [];
        let workflowPathGenerated: string | undefined;

        if (request.workflowPath) {
            consoleLogger.log(
                `Using pre-generated workflow: ${request.workflowPath}`,
                "INFO",
            );
            fileLogger.log(`Loading workflow from: ${request.workflowPath}`, "INFO");

            if (!fs.existsSync(request.workflowPath)) {
                throw new Error(`Workflow file not found: ${request.workflowPath}`);
            }

            workflow = JSON.parse(fs.readFileSync(request.workflowPath, "utf-8"));

            const { requests } = simplifyPostmanCollection(collection);
            const effectiveRequests = filterRequestsByPatterns(
                requests,
                request.skip,
                request.only,
            );

            const { validateWorkflowCoverage } = await import("../brain.ts");
            validateWorkflowCoverage(
                effectiveRequests,
                workflow,
                "Loaded workflow is incomplete.",
            );

            this.emit({
                type: "workflow.loaded",
                workflowPath: request.workflowPath,
                stepCount: workflow.length,
            });
        } else {
            consoleLogger.log("\nAnalyzing collection structure...", "INFO");
            fileLogger.log("Analyzing collection structure...", "INFO");

            const { requests } = simplifyPostmanCollection(collection);
            const effectiveRequests = filterRequestsByPatterns(
                requests,
                request.skip,
                request.only,
            );

            consoleLogger.log(`Found ${requests.length} potential API routes`, "INFO");
            fileLogger.log(`Found ${requests.length} potential API routes`, "INFO");

            if (effectiveRequests.length !== requests.length) {
                const routeFilterMsg =
                    `Route filters active: ${effectiveRequests.length}/${requests.length} routes eligible for workflow generation`;
                consoleLogger.log(routeFilterMsg, "INFO");
                fileLogger.log(routeFilterMsg, "INFO");
            }

            this.emit({
                type: "routes.filtered",
                totalRoutes: requests.length,
                effectiveRoutes: effectiveRequests.length,
            });

            fileLogger.log(
                `Simplified requests: ${JSON.stringify(requests, null, 2)}`,
                "DEBUG",
            );

            if (request.context) {
                consoleLogger.log(`Context: ${request.context}`, "INFO");
                fileLogger.log(`Context: ${request.context}`, "INFO");
            }

            consoleLogger.log("\nAI is preparing execution workflow...", "AI");
            fileLogger.log("Hitting Gemini AI for workflow generation...", "AI");

            const { generateWorkflowWithCoverage } = await import("../brain.ts");

            try {
                workflow = await generateWorkflowWithCoverage(
                    effectiveRequests,
                    variables,
                    request.context,
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
                            const msg = `Workflow repaired successfully on attempt ${attempt}.`;
                            consoleLogger.log(msg, "AI");
                            fileLogger.log(msg, "AI");
                        },
                        onModelLog: (message, level) => {
                            fileLogger.log(
                                message,
                                level === "ERROR" ? "ERROR" : "AI",
                            );
                        },
                    },
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

            const workflowDir = path.join(process.cwd(), "workflows");
            if (!fs.existsSync(workflowDir)) {
                fs.mkdirSync(workflowDir, { recursive: true });
            }

            const now = new Date();
            const ts =
                now.toISOString().split("T")[0] +
                "_" +
                now.toTimeString().split(" ")[0].replace(/:/g, "-");
            const savePath = path.join(workflowDir, `workflow_${ts}.json`);

            fs.writeFileSync(savePath, JSON.stringify(workflow, null, 2), "utf-8");
            workflowPathGenerated = savePath;

            consoleLogger.log(
                `Workflow saved to: ${path.relative(process.cwd(), savePath)}`,
                "INFO",
            );
            fileLogger.log(`Workflow saved to: ${savePath}`, "INFO");
            fileLogger.log(`AI Response: ${JSON.stringify(workflow, null, 2)}`, "AI");

            this.emit({
                type: "workflow.generated",
                workflowPath: savePath,
                stepCount: workflow.length,
            });
        }

        consoleLogger.log(
            `Workflow loaded with ${workflow.length} planned steps`,
            "INFO",
        );

        const executorConfig: ActionConfig = {
            delay: request.delay,
            timeout: request.timeout,
            skip: request.skip,
            only: request.only,
            dry: request.dry,
            workflowPath: request.workflowPath,
            exportBaseName: path.parse(request.collectionPath).name,
            runtimeWorkflowPath: workflowPathGenerated,
            stopSignal: request.stopSignal,
        };

        const executor = new ActionExecutor(
            this.deps.consoleLogger,
            this.deps.fileLogger,
            executorConfig,
            collection,
            this.deps.promptProvider,
        );

        executor.registerInitialVariables(variables);
        const execution = await executor.execute(workflow);

        this.emit({ type: "run.completed", result: execution });

        return {
            workflow,
            workflowPathUsed: request.workflowPath,
            workflowPathGenerated,
            execution,
        };
    }
}
