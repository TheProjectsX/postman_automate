import * as fs from "fs";
import {
    FileLogger,
    ConsoleLogger,
} from "./src/utils.ts";
import {
    parseArgs,
    showHelp,
    promptForContext,
    promptText,
} from "./src/cli.ts";
import { PostmanAutomationCore } from "./src/core/run-automation.ts";


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
        const collectionPath = args.collection;
        if (!collectionPath || !fs.existsSync(collectionPath)) {
            throw new Error(`Collection file not found: ${collectionPath}`);
        }

        // Resolve context: CLI flag takes priority, otherwise prompt interactively.
        let context = args.context;
        if (args.contextRequested && context === undefined) {
            context = await promptForContext();
        }

        const core = new PostmanAutomationCore({
            consoleLogger,
            fileLogger,
            promptProvider: {
                prompt: (question: string) => promptText(question),
            },
        });

        await core.run({
            ...args,
            collectionPath,
            context,
        });

        banner("AUTOMATION COMPLETED SUCCESSFULLY");
    } catch (error: any) {
        consoleLogger.log(`FATAL ERROR: ${error.message}`, "ERROR");
        fileLogger.log(`FATAL ERROR: ${error.message}`, "ERROR");
        if (error.stack) fileLogger.log(error.stack, "ERROR");
        process.exit(1);
    }
};

main();
