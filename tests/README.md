# fzstd tests

This folder contains test cases for fzstd.

## How to execute tests

Original cases, run with [Deno](https://deno.land/):

```bash
deno test --no-check tests/simple_cases_test.ts
```

Streaming and large-offset regression cases, run with [Bun](https://bun.sh/):

```bash
bun test tests/streaming_regression_test.ts

# Optional large-offset test (up to ~800 MB peak RAM, needs zstd on PATH).
FZSTD_BIG_TESTS=1 bun test tests/streaming_regression_test.ts
```
