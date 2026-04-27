# Contributing

## Scope

This repository contains reusable browser-side LLM packages plus an example host.

Prefer changes in this order:

1. `packages/*` for reusable behavior
2. `examples/*` for demo-only behavior
3. `docs/*` for user-facing guidance

## Expectations

- Keep diffs small and reviewable
- Do not introduce new legacy paths or duplicate implementations
- Prefer package entry points over example-local copies
- Keep browser-storage behavior grounded by tests

## Verification

Run before proposing changes:

```bash
npm test
npm run build
```

If you touched browser install/runtime behavior, also validate:

- the main host at `/`
- the second host at `/sdk-host.html`

## Documentation

When behavior or structure changes:

- update `README.md`
- update `docs/README.md` if the docs map changes
- update the relevant guide or architecture note
