import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import dotenv from "dotenv";
import type { WorkflowAction } from "./executor.ts";
dotenv.config({ quiet: true });

// Resolve PROMPT.md relative to this file, not the cwd — safe regardless of
// where the process is started from.
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROMPT = fs.readFileSync(
    path.join(__dirname, "..", "PROMPT.md"),
    "utf-8",
);

const APIKey = process.env.GEMINI_API_KEY;
if (!APIKey) {
    throw new Error("GEMINI_API_KEY is missing. Add it to your .env file.");
}

const genAI = new GoogleGenerativeAI(APIKey);

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

const parseModelList = (raw: string | undefined) => {
    if (!raw) return [];
    return raw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
};

const getCandidateModels = () => {
    const configuredList = parseModelList(process.env.TARGET_MODELS);
    const primary = process.env.TARGET_MODEL?.trim();

    const ordered = [
        ...(primary ? [primary] : []),
        ...configuredList,
        DEFAULT_MODEL,
    ];

    // Preserve order but remove duplicates.
    return [...new Set(ordered)];
};

const isRetryableModelError = (error: any) => {
    const msg = String(error?.message || error || "").toLowerCase();
    return (
        msg.includes("googlegenerativeai error") ||
        msg.includes("quota") ||
        msg.includes("429") ||
        msg.includes("resource_exhausted") ||
        msg.includes("try again later") ||
        msg.includes("high usage")
    );
};

export type SimplifiedRequest = {
    name: string;
    method?: string;
    url: string;
    item_id: string;
};

export type WorkflowCoverageReport = {
    totalExpected: number;
    totalExecute: number;
    missing: SimplifiedRequest[];
    extraItemIds: string[];
    executeWithoutItemId: number;
};

export type GenerateWorkflowOptions = {
    maxAttempts?: number;
    onAttemptFailure?: (
        attempt: number,
        report: WorkflowCoverageReport,
    ) => void;
    onRepairSuccess?: (attempt: number) => void;
    onModelLog?: (message: string, level: "INFO" | "ERROR") => void;
};

export const buildWorkflowCoverageReport = (
    requests: SimplifiedRequest[],
    workflow: WorkflowAction[],
): WorkflowCoverageReport => {
    const expectedIds = new Set(requests.map((r) => r.item_id));
    const executeActions = workflow.filter(
        (a) => a.action === "EXECUTE",
    ) as (WorkflowAction & { item_id?: string })[];

    const seenIds = new Set<string>();
    let executeWithoutItemId = 0;

    for (const action of executeActions) {
        if (!action.item_id) {
            executeWithoutItemId++;
            continue;
        }
        seenIds.add(action.item_id);
    }

    const missing = requests.filter((r) => !seenIds.has(r.item_id));
    const extraItemIds = [...seenIds].filter((id) => !expectedIds.has(id));

    return {
        totalExpected: requests.length,
        totalExecute: executeActions.length,
        missing,
        extraItemIds,
        executeWithoutItemId,
    };
};

export const isWorkflowComplete = (report: WorkflowCoverageReport) =>
    report.missing.length === 0 &&
    report.extraItemIds.length === 0 &&
    report.executeWithoutItemId === 0;

export const formatCoverageError = (report: WorkflowCoverageReport) => {
    const missingPreview = report.missing
        .slice(0, 25)
        .map((r) => `${r.item_id} ${r.method || "UNKNOWN"} ${r.url}`)
        .join("\n");

    const extraPreview = report.extraItemIds.slice(0, 25).join(", ");

    return [
        "Workflow coverage validation failed.",
        `Expected routes: ${report.totalExpected}`,
        `EXECUTE actions: ${report.totalExecute}`,
        `Missing routes: ${report.missing.length}`,
        `Unknown item_id values: ${report.extraItemIds.length}`,
        `EXECUTE without item_id: ${report.executeWithoutItemId}`,
        report.missing.length ? `Missing (preview):\n${missingPreview}` : "",
        report.extraItemIds.length
            ? `Unknown item_id (preview): ${extraPreview}`
            : "",
    ]
        .filter(Boolean)
        .join("\n");
};

const buildCoverageRepairContext = (
    report: WorkflowCoverageReport,
    previousWorkflow: WorkflowAction[],
    attempt: number,
) => {
    const missingRoutes = report.missing
        .map(
            (r) =>
                `- ${r.item_id} | ${r.method || "UNKNOWN"} | ${r.url} | ${r.name}`,
        )
        .join("\n");

    return `
AUTOMATED VALIDATION RESULT (attempt ${attempt})
- Your previous workflow omitted routes or had invalid EXECUTE entries.
- You MUST include every route exactly once by item_id.
- Every EXECUTE MUST include a valid item_id from the supplied requests.

Missing routes to include:
${missingRoutes || "- None"}

Invalid metadata:
- Unknown item_id count: ${report.extraItemIds.length}
- EXECUTE without item_id count: ${report.executeWithoutItemId}

Previous workflow JSON:
${JSON.stringify(previousWorkflow, null, 2)}
`;
};

export const validateWorkflowCoverage = (
    requests: SimplifiedRequest[],
    workflow: WorkflowAction[],
    prefix = "Workflow is incomplete.",
) => {
    const report = buildWorkflowCoverageReport(requests, workflow);
    if (!isWorkflowComplete(report)) {
        throw new Error(`${prefix}\n${formatCoverageError(report)}`);
    }
    return report;
};

export const generateWorkflowWithCoverage = async (
    requests: SimplifiedRequest[],
    variables: Record<string, any> = {},
    context?: string,
    options: GenerateWorkflowOptions = {},
): Promise<WorkflowAction[]> => {
    const maxAttempts = options.maxAttempts ?? 3;
    const userContext = context?.trim() || "";
    let repairContext = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const mergedContext = [userContext, repairContext]
            .filter(Boolean)
            .join("\n\n");

        const workflow = await processPostmanAI(
            requests,
            variables,
            mergedContext,
            options.onModelLog,
        );

        const report = buildWorkflowCoverageReport(requests, workflow);
        if (isWorkflowComplete(report)) {
            if (attempt > 1) {
                options.onRepairSuccess?.(attempt);
            }
            return workflow;
        }

        options.onAttemptFailure?.(attempt, report);

        if (attempt === maxAttempts) {
            throw new Error(formatCoverageError(report));
        }

        repairContext = buildCoverageRepairContext(report, workflow, attempt);
    }

    throw new Error("AI failed to produce a workflow.");
};

export const processPostmanAI = async (
    requests: SimplifiedRequest[],
    variables: Record<string, any> = {},
    context?: string,
    onModelLog?: (message: string, level: "INFO" | "ERROR") => void,
): Promise<WorkflowAction[]> => {
    const contextBlock = context?.trim()
        ? `\n## Additional Context / Instructions:\n${context.trim()}\n`
        : "";

    const prompt = `Initial Variables:
${JSON.stringify(variables, null, 2)}

Postman Simplified Requests:
${JSON.stringify(requests, null, 2)}`;

    const instructions = `${PROMPT}${contextBlock}`;

    const models = getCandidateModels();
    let lastError: any;

    const logModel = (message: string, level: "INFO" | "ERROR") => {
        if (onModelLog) {
            onModelLog(message, level);
            return;
        }

        if (level === "ERROR") {
            console.error(message);
        } else {
            console.warn(message);
        }
    };

    for (let i = 0; i < models.length; i++) {
        const modelName = models[i];
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: "application/json" },
            systemInstruction: instructions,
        });

        try {
            const result = await model.generateContent(prompt);
            const response = result.response.text();
            try {
                return JSON.parse(response) as WorkflowAction[];
            } catch {
                logModel(`AI Response: ${response}`, "ERROR");
                throw new Error(
                    `Failed to parse JSON response from AI model \"${modelName}\". The model may have returned malformed output.`,
                );
            }
        } catch (error: any) {
            lastError = error;

            const canRetryWithNextModel =
                i < models.length - 1 && isRetryableModelError(error);

            if (canRetryWithNextModel) {
                logModel(
                    `Model \"${modelName}\" failed (${error?.message || error}). Retrying with next configured model...`,
                    "INFO",
                );
                continue;
            }

            throw error;
        }
    }

    throw lastError || new Error("AI failed to produce a workflow.");
};
