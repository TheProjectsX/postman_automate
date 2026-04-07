# Postman AI Automator

**Status:** Beta v1

A small CLI that turns a Postman Collection into a step-by-step JSON workflow (REGISTER / INPUT / LOG / EXECUTE), using Gemini to plan the flow and then execute it. It also saves generated workflows for reuse and writes detailed logs while it runs.

**Flow (what / where / why / how)**

- What: Convert a Postman Collection into an ordered JSON workflow of actions (REGISTER, INPUT, LOG, EXECUTE).
- Where: Input is your `collection.json`; output is stored in `workflows/` with run logs in `logs/process_logs/`.
- Why: Enforces consistent API execution order and variable handling, even for complex collections.
- How: Parses and simplifies the collection, sends a structured prompt to Gemini, validates the JSON response, then optionally executes each step.

**Quick start**

1. Create `.env` with `GEMINI_API_KEY`.
2. Run:

```bash
node index.ts <postman-collection>.json
```

**Outputs**

- Generated workflows are saved under `workflows/`.
- Run logs are written under `logs/process_logs/`.
- Run errors are written under `logs/error_logs`.
- Response saved postman collections exported under `exports/`.

**Flags**

```bash
--delay=<ms>         Delay between requests (default: 0)
--timeout=<ms>       Request timeout in ms (default: 30000)
--skip=<pattern>     Skip requests whose URL contains pattern
--only=<pattern>     Only run requests whose URL contains pattern
--workflow=<path>    Use a pre-generated workflow JSON (alias: -wf=)
--context=<text>     Extra AI instructions (alias: -c=)
--dry                Dry run - plan workflow but do not send requests
```
