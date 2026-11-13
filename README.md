# Finance Tracker — take-home task

A personal finance tracker built with TanStack Start, Drizzle (Postgres via
embedded PGlite), TanStack Query, Tailwind/shadcn UI and Paraglide i18n.

**Your task is in [TASK.md](TASK.md).**

## Solution: monthly category budgets

[![Budgets page — click to watch the demo](demo/budgets-page.png)](demo/budgets-demo.webm)

**Demo video (1 min 49 s):** [demo/budgets-demo.webm](demo/budgets-demo.webm) —
one scene per acceptance criterion, recorded by `node scripts/record-demo.mjs`.

- **Design, decisions and known limitations:** [docs/KICKOFF.md](docs/KICKOFF.md)
- **Agent team used to build it:** [.claude/agents/](.claude/agents/) — lead +
  domain, alerts, compliance, frontend, QA and tech-lead reviewer
- **Where the code is:** `src/server/budgets.server.ts` (domain),
  `src/server/budget-alerts.server.ts` (email, max one per budget per month),
  `src/routes/_authed/budgets.tsx` (page), `drizzle/0004_*.sql` (migration)
- **Tests:** `tests/budgets.test.ts`, `tests/budget-alerts.test.ts`,
  `tests/compliance.test.ts`, `tests/e2e/budgets.spec.ts`

## Getting started

Requirements: Node.js 22+ and pnpm 10 (`corepack enable` will pick up the
pinned version). Use `pnpm`, not `npm`.

```bash
pnpm install
pnpm exec playwright install chromium   # for E2E tests
pnpm run dev                            # http://127.0.0.1:3000
```

No `.env` is needed for local development: the database is an embedded
PGlite instance under `./data/pg`. See `.env.example` for optional settings
(set `AI_FAKE=1` if you don't want to configure an AI provider).

`pnpm run check` runs typecheck, lint, unit tests and E2E tests together.
Project conventions are documented in [CLAUDE.md](CLAUDE.md) (identical to
[AGENTS.md](AGENTS.md)).

## How we'd like you to work

You're welcome — encouraged — to use AI coding agents. Treat the task as
you would a real feature in an unfamiliar codebase.

In the interview we'll ask you to:

- walk us through your workflow and your conversations with the agent(s);
- explain the design of your solution and how it fits the existing code;
- demo the feature running locally.

Please keep your agent session history and any agent configuration you
used so you can show them. Note that `.gitignore` excludes `.claude/`,
`.agents/`, `.mcp.json` etc. — remove those entries if you'd like to commit
your setup.
