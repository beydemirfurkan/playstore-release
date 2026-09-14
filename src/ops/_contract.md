# Operation contract

Every file in `src/ops/` is a self-contained unit with a single responsibility and
a uniform shape, so the orchestrator — a CLI, an MCP server, a library caller —
can run them interchangeably.

```js
/** @type {import("./registry.mjs").OperationMeta} */
export const meta = {
  id: "images", // stable identifier; must match the registry key
  title: "Store graphics", // human-readable title
  phase: "listing", // "build" | "listing" | "release"
  needs: ["images"], // config concerns, ENFORCED before run() is called
  edit: true, // reads/writes inside ctx.edit; false = never opens an edit
  mutates: true, // drives --dry-run and the MCP tool annotations
  destructive: true, // can delete data that already exists on Play
  irreversible: false, // true for promote and review-reply
  args: {
    // parsed generically by the CLI, exposed by MCP
    prune: { type: "boolean", default: true, description: "delete remote images with no local match" },
  },
};

/**
 * @param {import("../core/context.mjs").Context} ctx
 * @param {Record<string, any>} args
 * @returns {Promise<{ status, message?, details?, findings?, changes? }>}
 */
export async function run(ctx, args) {}
```

Rules:

- **Idempotent.** Read current state; only mutate what is wrong. Re-running is a
  no-op → `Status.OK`. Reporting `CHANGED` unconditionally is a bug, not a detail.
- **Injected deps only.** Never read `process.env`, never construct a client, and
  never call `process.cwd()` — use `ctx.resolvePath` so relative paths resolve
  against the config's directory.
- **`needs` is load-bearing.** `runOperation` validates it before calling `run`,
  so an operation may assume the keys it declared are present. Do not re-check.
- **The edit is not yours to commit.** Read and write through `ctx.edit`; the
  orchestrator commits (or discards) when the operation — or the pipeline holding
  it — is done. `ctx.edit.note()` is how one step tells a later one something,
  such as the versionCode it just uploaded.
- **Honest status.** Return `MANUAL` for anything Google only exposes in the
  Console. Under `ctx.dryRun` the client refuses every write for you; only an
  operation with side effects outside HTTP (see `data-safety`) needs its own
  dry-run branch.
- **Fail soft.** Throwing is fine — `runOperation` catches it, records `ERROR`
  with Google's error and any hints attached, discards the edit, and lets the
  rest of the pipeline report.
