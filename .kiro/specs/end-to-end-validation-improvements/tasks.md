# Implementation Plan: end-to-end-validation-improvements

## Overview

Five self-contained quality and reliability improvements to the Navia web automation agent. Each improvement touches a different subsystem: integration test coverage, exponential backoff with jitter, config schema validation, CLI response streaming via SSE, and retry observability. Implementation proceeds layer by layer — pure utilities first, then the client, then wiring, and finally the test suite expansions.

fast-check must be installed as a devDependency before any property-based tests are written:

```
npm install --save-dev fast-check
```

---

## Tasks

- [x] 1. Install fast-check and verify test toolchain
  - Add `fast-check` as a `devDependency` in `package.json` via `npm install --save-dev fast-check`
  - Confirm `vitest run` still passes the existing test suite after the install
  - _Requirements: 2.6, 3.1–3.8, 4.1–4.2, 5.1–5.3_

- [x] 2. Implement `calcDelay` and exponential backoff in `OpenAICompatClient`
  - [x] 2.1 Add `calcDelay` helper and refactor the retry loop in `src/providers/openai-provider.ts`
    - Export `calcDelay(attempt, base?, cap?): number` inside `__test` (formula: `min(base * 2^attempt + uniform(0,200), cap)`)
    - Replace the two `setTimeout(r, 800 * (attempt + 1))` calls with `await sleep(calcDelay(attempt))`
    - Inject `sleep` as a constructor parameter with default `(ms) => new Promise(r => setTimeout(r, ms))` for test overrides
    - Wire `onRetry?.(attempt + 1, waitMs, reason)` call immediately before `await sleep(waitMs)` in both the HTTP-error and network-exception branches
    - Keep the 4-attempt limit and the non-429 4xx fast-fail behaviour unchanged
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.1, 5.2, 5.3_

  - [x] 2.2 Write unit tests for `calcDelay` bounds (example-based)
    - Verify `calcDelay(0)` is in `[500, 700]`; `calcDelay(2)` is in `[2000, 2200]`; any attempt ≤ 30 000
    - Verify retry count: mock returning HTTP 429 four times → exactly 4 fetch calls, error thrown
    - Verify no retry on 4xx: mock returning 401 → exactly 1 fetch call, error thrown immediately
    - Verify error message template contains `cfg.label` and `cfg.baseURL`
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [x] 2.3 Write property test P1 — `calcDelay` bounded by cap
    - **Property 1: calcDelay is bounded by the cap**
    - **Validates: Requirements 2.1**
    - Use `fc.integer({min:0,max:2})`, `fc.integer({min:100,max:1000})`, `fc.integer({min:5000,max:60000})`
    - Assert `result <= cap` and `result >= base * 2^attempt` for all generated inputs
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 1`
    - _File: `test/openai-provider.test.ts`_

  - [x] 2.4 Write property test P2 — non-429 4xx causes immediate failure
    - **Property 2: Non-429 4xx errors cause immediate failure**
    - **Validates: Requirements 2.5**
    - Use `fc.constantFrom(400, 401, 403, 404, 422)`; mock fetch to return that status
    - Assert exactly 1 fetch call and that `create()` throws
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 2`
    - _File: `test/openai-provider.test.ts`_

  - [x] 2.5 Write property test P3 — error message contains label and baseURL
    - **Property 3: Error message always includes provider label and base URL**
    - **Validates: Requirements 2.3**
    - Use `fc.string()` for both `label` and `baseURL`; exhaust all 4 attempts with HTTP 500
    - Assert thrown `Error.message` contains both `label` and `baseURL`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 3`
    - _File: `test/openai-provider.test.ts`_

- [x] 3. Implement `onRetry` callback in `OpenAICompatClient`
  - [x] 3.1 Add `onRetry` optional constructor parameter to `OpenAICompatClient`
    - Signature: `onRetry?: (attempt: number, waitMs: number, reason: string) => void`
    - `attempt` is 1-based; `reason` is `"HTTP <status>"` for HTTP errors or the exception message for network errors
    - Call `this.onRetry?.(attempt + 1, waitMs, reason)` in the retry loop immediately before `await sleep(waitMs)` (already positioned in task 2.1 — wire the constructor parameter here)
    - Update `BrowserAgent` constructor in `src/agent/agent.ts` to optionally pass `opts.hooks?.log` as `onRetry` for the openai provider path
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 3.2 Write unit test for `onRetry` callback
    - Mock server returning HTTP 500 → verify `onRetry` called with `attempt=1`, positive `waitMs`, `reason="HTTP 500"`
    - _Requirements: 5.1_

  - [x] 3.3 Write property test P4 — `onRetry` receives correct attempt and reason
    - **Property 4: onRetry receives the correct attempt number and HTTP reason**
    - **Validates: Requirements 5.1**
    - Use `fc.constantFrom(429, 500, 502, 503)` for status; inject a zero-delay sleep override
    - Assert each `onRetry` call has 1-based attempt, positive `waitMs`, and `reason === "HTTP <status>"`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 4`
    - _File: `test/openai-provider.test.ts`_

- [x] 4. Implement `validateConfig` in `src/config.ts`
  - [x] 4.1 Add `validateConfig` function and update `loadConfigSync` in `src/config.ts`
    - Implement `validateConfig(raw: unknown): NaviaConfig` with all rules from the design:
      - Throw if root is not a plain object (null, array, primitive)
      - Validate `model` (must be string), `browser` (set of 4), `provider` (set of 4), `workspace` (boolean or string), `profile` (string)
      - Silently strip unknown fields
    - Update `loadConfigSync` to call `validateConfig(raw)` instead of `as NaviaConfig`; surface ENOENT as `{}`; wrap `JSON.parse` to throw with file path on bad JSON
    - Export `validateConfig` as a named export
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 4.2 Write example-based unit tests for `validateConfig` in `test/config.test.ts` (new file)
    - Invalid `model` type (number) → throws with "model" in message
    - Invalid `browser` value ("safari") → throws with "browser" and the value in message
    - Invalid `provider` value ("gemini") → throws with "provider" in message
    - Invalid `workspace` type (number) → throws with "workspace" in message
    - Unknown fields → stripped, only known fields returned
    - Non-object root: null, array, 42, "string" → all throw
    - `loadConfigSync` with missing file → returns `{}`
    - `loadConfigSync` with malformed JSON → throws with file path in message
    - _Requirements: 3.1–3.8_

  - [x] 4.3 Write property test P5 — `validateConfig` rejects non-string model
    - **Property 5: validateConfig rejects non-string model values**
    - **Validates: Requirements 3.1**
    - Use `fc.oneof(fc.integer(), fc.boolean(), fc.array(fc.string()), fc.constant(null))`
    - Assert throws with message containing `"model"`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 5`
    - _File: `test/config.test.ts`_

  - [x] 4.4 Write property test P6 — `validateConfig` rejects invalid browser values
    - **Property 6: validateConfig rejects invalid browser values**
    - **Validates: Requirements 3.2**
    - Use `fc.string()` filtered to exclude `{"chromium","chrome","firefox","patchright"}`
    - Assert throws with message containing `"browser"` and the offending value
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 6`
    - _File: `test/config.test.ts`_

  - [x] 4.5 Write property test P7 — `validateConfig` rejects invalid provider values
    - **Property 7: validateConfig rejects invalid provider values**
    - **Validates: Requirements 3.3**
    - Use `fc.string()` filtered to exclude `{"auto","api","claude-cli","openai"}`
    - Assert throws with message containing `"provider"`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 7`
    - _File: `test/config.test.ts`_

  - [x] 4.6 Write property test P8 — `validateConfig` rejects invalid workspace types
    - **Property 8: validateConfig rejects non-boolean non-string workspace values**
    - **Validates: Requirements 3.4**
    - Use `fc.oneof(fc.integer(), fc.constant(null), fc.array(fc.string()))`
    - Assert throws with message containing `"workspace"`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 8`
    - _File: `test/config.test.ts`_

  - [x] 4.7 Write property test P9 — `validateConfig` strips unknown fields
    - **Property 9: validateConfig strips unknown fields**
    - **Validates: Requirements 3.5**
    - Use `fc.dictionary(fc.string(), fc.anything())` merged with a partial valid config
    - Assert returned object contains only keys from `{"model","browser","provider","workspace","profile"}`
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 9`
    - _File: `test/config.test.ts`_

  - [x] 4.8 Write property test P10 — `validateConfig` rejects non-object root values
    - **Property 10: validateConfig rejects non-object root values**
    - **Validates: Requirements 3.8**
    - Use `fc.oneof(fc.constant(null), fc.array(fc.anything()), fc.integer(), fc.boolean(), fc.string())`
    - Assert all inputs throw
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 10`
    - _File: `test/config.test.ts`_

- [x] 5. Checkpoint — ensure all tests pass so far
  - Run `npm test` (i.e., `vitest run`) and confirm existing tests plus the new unit/property tests for backoff, onRetry, and validateConfig are all green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement CLI response streaming (`StreamHook` + SSE) in `OpenAICompatClient`
  - [x] 6.1 Add `StreamHook` type, streaming constructor parameter, and `createStreaming` method in `src/providers/openai-provider.ts`
    - Export `StreamHook = (chunk: string) => void`
    - Add `streamHook?: StreamHook` as second constructor parameter to `OpenAICompatClient` (before `onRetry`)
    - Implement `private async createStreaming(...)` using the SSE parsing logic from the design: `ReadableStream` + `TextDecoder`, accumulate `delta.content` and `delta.tool_calls`, build `Anthropic.Message` at `[DONE]`
    - In `create()`, select streaming vs non-streaming: `const useStream = !!this.streamHook && (this.cfg.label === "Groq" || this.cfg.label === "OpenRouter")`
    - When `streamHook` is undefined, omit the `stream` field from the request body
    - Apply the existing retry policy (via `onRetry` + `sleep`) on stream interruptions — treat as network errors
    - Malformed SSE chunks are silently skipped; invalid tool-call `arguments` JSON at `[DONE]` sets `input = {}`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 6.2 Wire `StreamHook` into `BrowserAgent` in `src/agent/agent.ts`
    - In the `isOpenAI` branch of the `BrowserAgent` constructor, pass `opts.hooks?.log ? (chunk: string) => opts.hooks!.log!(chunk) : undefined` as the `streamHook` argument when constructing `OpenAICompatClient`
    - _Requirements: 4.7_

  - [x] 6.3 Write unit test — non-streaming fallback when no StreamHook
    - Verify that when `streamHook` is `undefined`, the request body does NOT include `"stream": true`
    - _Requirements: 4.3_

  - [x] 6.4 Write unit test — SSE accumulation round-trip
    - Split a valid JSON string into 3 fragments delivered as `delta.tool_calls[0].function.arguments` SSE chunks
    - Assert the resulting `tool_use` block's `input` deep-equals the original object
    - _Requirements: 4.2_

  - [x] 6.5 Write property test P11 — `StreamHook` called for every non-empty content chunk
    - **Property 11: StreamHook is called for every non-empty content chunk**
    - **Validates: Requirements 4.1**
    - Use `fc.array(fc.string({minLength:1}), {minLength:1})` for a sequence of content chunks
    - Assert `streamHook` called exactly `chunks.length` times, in order, before `create()` resolves
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 11`
    - _File: `test/openai-provider.test.ts`_

  - [x] 6.6 Write property test P12 — tool-call argument accumulation round-trip
    - **Property 12: Tool-call argument accumulation is correct for any fragmentation**
    - **Validates: Requirements 4.2**
    - Use `fc.object()` for the target JSON object; `fc.array(fc.integer({min:1,max:10}))` for split points
    - Assert `tool_use.input` deep-equals the original object for any fragmentation
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 12`
    - _File: `test/openai-provider.test.ts`_

- [x] 7. Expand integration test suite in `test/loop-integration.test.ts`
  - [x] 7.1 Add `lengthTurn` and `failingToolTurn` helpers and the tool-error recovery scenario
    - Add `lengthTurn(text?)` helper (returns a response with `finish_reason: "length"`)
    - Add `failingToolTurn(name, args, id)` helper that uses an unrecognised tool name (e.g. `"bad_tool"`) to trigger an `is_error` result without propagating an exception
    - Write the "tool error recovery" test: tool success → `failingToolTurn` → `textTurn`; assert `metrics.toolErrors >= 1` and `metrics.recoveries === 0`
    - Reuse the existing `mockLLM`, `afterEach`, and `describe` block
    - _Requirements: 1.1, 1.6, 1.7_

  - [x] 7.2 Add the truncated response scenario
    - Write the "truncated response" test: `lengthTurn` → tool call → `textTurn`; assert `metrics.toolErrors === 0`, loop continues, `result.steps >= 2`
    - _Requirements: 1.2, 1.6, 1.7_

  - [x] 7.3 Add the max-steps termination scenario
    - Write the "max-steps" test: infinite tool calls (mock always repeats), `maxSteps: 2`; assert `result.steps === 2` and `result.summary` contains the max-steps message
    - _Requirements: 1.3, 1.6, 1.7_

  - [x] 7.4 Write property test P13 — max-steps termination is exact for any N
    - **Property 13: max-steps termination is exact for any N**
    - **Validates: Requirements 1.3**
    - Use `fc.integer({min:1,max:4})` for `maxSteps`; mock that always returns a tool call
    - Assert `result.steps === maxSteps` and `result.summary` contains the max-steps message for all N
    - Tag with comment: `// Feature: end-to-end-validation-improvements, Property 13`
    - Each iteration starts its own `mockLLM` server and closes it in the assertion body
    - _File: `test/loop-integration.test.ts`_

- [x] 8. Final checkpoint — ensure all tests pass
  - Run `npm test` and verify the full suite (existing + all new unit, integration, and property tests) is green
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; the core implementation tasks (2.1, 3.1, 4.1, 6.1, 6.2, 7.1–7.3) are mandatory.
- All property tests require fast-check installed in task 1 before they can run.
- The `sleep` injection in task 2.1 is essential for keeping property tests fast (no real timers).
- Tasks 3.1 and 2.1 are closely coupled — the `onRetry` call site is written in 2.1 but the constructor parameter is formalised in 3.1; both should be reviewed together.
- Integration test scenarios (7.x) each call `runNavia` with a real headless browser — keep `maxSteps` ≤ 4 and set a 60 s per-test timeout.
- Property tests P11 and P12 test the internal SSE streaming logic; they should construct a thin in-process SSE mock rather than spinning up a real HTTP server.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8"] },
    { "id": 3, "tasks": ["3.2", "3.3", "6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4"] }
  ]
}
```
