import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

// Resolve PROMPT.md relative to this file, not the cwd — safe regardless of
// where the process is started from.
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROMPT = fs.readFileSync(path.join(__dirname, "..", "PROMPT.md"), "utf-8");

const APIKey = process.env.GEMINI_API_KEY;
if (!APIKey) {
    throw new Error("GEMINI_API_KEY is missing. Add it to your .env file.");
}

const genAI = new GoogleGenerativeAI(APIKey);

export const processPostmanAI = async (
    requests: any[],
    variables: Record<string, any> = {},
    context?: string,
) => {
    const model = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite-preview", // gemini-3.1-flash-lite-preview
        generationConfig: { responseMimeType: "application/json" },
    });

    const contextBlock = context?.trim()
        ? `\n-------------------------------------\nADDITIONAL CONTEXT / INSTRUCTIONS\n-------------------------------------\n${context.trim()}\n`
        : "";

    const prompt = `${PROMPT}${contextBlock}
Initial Variables:
${JSON.stringify(variables, null, 2)}

Postman Simplified Requests:
${JSON.stringify(requests, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    try {
        return JSON.parse(response);
    } catch {
        throw new Error(
            "Failed to parse JSON response from AI. The model may have returned malformed output.",
        );
    }
};
