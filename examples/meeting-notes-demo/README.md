# Meeting Notes Demo

## What It Is

This example host demonstrates how to wire `browser-llm-kit` into a browser UI plus a small Node service.

It provides:

- sample list + structured-record workflow
- browser-side local model install via `OPFS + Worker`
- server-side scoring and sample persistence
- a second host page at `/sdk-host.html` for SDK-boundary verification

## Layout

- `web/` - browser entry pages and styles
- `server/` - Node example server
- `shared/fixtures/` - sample data and templates
- `shared/prompts/` - prompt templates
- `shared/` - shared helpers

## Run

```bash
npm start
```

Before using the browser-side local model install flow, place the model file at:

```text
examples/meeting-notes-demo/web/assets/llm/gemma-4-E2B-it-web.task
```

That path is intentionally gitignored so the example can run with a locally provisioned model without checking a multi-GB asset into the repository.

Open:

- `http://localhost:3001/`
- `http://localhost:3001/sdk-host.html`

## HTTPS

For local network or secure-context testing:

```bash
npm run start:https
```

Related notes:

- [`docs/archive/internal-https-preview.md`](../../docs/archive/internal-https-preview.md)
