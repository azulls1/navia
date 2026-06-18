# 🌐 Navia

[![npm](https://img.shields.io/npm/v/navia-ai)](https://www.npmjs.com/package/navia-ai)
[![provenance](https://img.shields.io/badge/npm-provenance-blueviolet)](https://docs.npmjs.com/generating-provenance-statements)
[![MCP](https://img.shields.io/badge/MCP-server-orange)](https://github.com/azulls1/navia#mcp)

> AI-powered autonomous browser agent. Give it a **natural-language instruction** and it opens a **real** browser (Chrome or Firefox), reads the page, clicks, fills forms, extracts data, and operates **any web portal** — just like a person would.

Works with your **Anthropic (Claude) API key** — or with no key at all, using an AI CLI already signed in on your terminal. No per-site scripts: the AI discovers buttons and fields live, following the **navigate → read → act → verify** method.

```bash
npx navia-ai "open example.com and tell me what the page is about"
```

---

## ✨ What it does

- 🧠 **One instruction, not a script.** You describe the task; Navia decides the steps.
- 🦊 **Real Chrome or Firefox**, your choice.
- 🛡️ **Anti-Cloudflare built in.** `--browser chrome` mode connects via **CDP to a real Chrome** → `navigator.webdriver=false` → passes the "Just a moment…" wall. Not evasion: it's your own browser.
- 👁️ **Reads like a human:** accessibility tree (not pixels) + screenshots for visual verification.
- 🧩 **Bulk extraction** with JavaScript (lists → JSON), plus a **typed `extract`** primitive (schema-validated output).
- 🎛️ **Four primitives — the dial:** `agent` (autonomous loop), `observe` (propose actions, no execution), `act` (run one deterministically by ref, no LLM), `extract` (typed data). Script-precise or fully autonomous, your call.
- ✅ **Self-checking:** optional post-task **validator** (`--validate`) re-checks the live page against your goal and retries once if it wasn't actually done.
- 🧠 **Per-domain memory (playbooks):** learns reusable tips per site (and from your `wait_for_human` notes) and re-injects them next time — `navia playbook`.
- 🩹 **Self-healing replay:** deterministic macros that re-locate elements when a site drifts, and re-cache the fixed macro.
- 📊 **Reliability metrics + `navia eval`:** measures steps, tokens, recoveries, loops; judges runs against a task dataset with an LLM judge.
- 💬 **Conversation mode:** keeps the browser & session open and takes follow-up commands — log in once, keep going.
- 🪄 **Zero-setup wizard** (`navia start`) + **persistent config** (`navia init`) + project **scaffolding** (`navia create`).
- 🔐 **Secure by design:** credential vault (passwords/2FA used but never seen by the model), **encrypted by default**, **domain-bound** (a secret only fills on its allowed origin — anti-phishing); prompt-injection **spotlighting**, `evaluate` gating (`--no-eval`) and a network **allow-list** (`--allow-domain`). Asks for confirmation before irreversible actions; hands you the window for login / captcha / 2FA.
- 📦 **CLI + library** (TypeScript, ESM) **+ MCP server** (with secure credential **elicitation**).

## 📦 Installation

```bash
npm install -g navia-ai      # global, to use the `navia` command
# or without installing:
npx navia-ai "your task"
```

First run (installs the Playwright browsers):

```bash
npx playwright install chromium firefox
```

Set your API key (`.env` file or environment variable) — optional if you use the CLI provider (see below):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Run `navia doctor` anytime to check your environment is ready.

## 🚀 Usage (CLI)

```bash
# Interactive mode (welcome + guided questions): just run `navia` with no task, or:
navia start
# Guided flow: AI engine (auto-detected: API key, or your `claude`/`ant` CLI; asks for a
# key only if none) → start URL → login (username + hidden password → encrypted vault) →
# task → browser engine → where to save the journal (detects your Obsidian vaults).
# It's CONVERSATIONAL: after each task it keeps the browser + session open and asks
# "what now?" so you can keep issuing commands without logging in again.
# Tip: if run inside another agent (Claude Code, etc., no real terminal) it won't hang —
# it points you to MCP mode instead.

# Default browser (Chromium)
navia "search 't-shirts' on example-shop.com and list the first 5 products with prices"

# Conversation mode for a one-off task too (stays open, asks for the next):
navia run "explore this site and map its sections" --browser firefox --chat

# Firefox
navia run "go to my-portal.com, sign in, and download my latest invoice" --browser firefox

# Real Chrome (Cloudflare-protected sites)
navia chrome                                   # 1) launch Chrome with debugging
navia run "search QA jobs on {portal}" --browser chrome   # 2) the task

# Other options
navia "..." --headless           # no visible window
navia "..." --slow-mo 300        # go slow (anti rate-limit)
navia "..." --start-url https://...   # open a URL before starting
navia "..." --model claude-opus-4-8   # another model
navia "..." --workspace          # per-task log/brain folder — asks where to save (new folder, detected Obsidian vault, or custom path)
navia "..." --validate           # after finishing, an LLM judge re-checks the live page vs the goal and retries once if needed
navia "..." --no-eval            # disable the `evaluate` JS tool (recommended on untrusted sites)
navia "..." --allow-domain example.com   # network allow-list (repeatable): abort requests to other domains (anti-exfiltration)
```

### Set your defaults once (`navia init`) and scaffold a project (`navia create`)
```bash
navia init                       # interactive: saves model/engine/profile/provider to ~/.navia/config.json
navia init --browser chrome --provider api   # or non-interactive
navia create my-bot              # scaffolds a project: navia.config.json, .env.example, tasks.txt, run.mjs
```
Precedence: CLI flag > env var > `~/.navia/config.json` > built-in default.

During a run:
- If **login / captcha / 2FA** is needed, Navia pauses and hands you the window.
- Before anything **irreversible**, it asks for confirmation (`y/N`). Use `--yes` to auto-approve (test environments only).

### Sessions / profiles (don't log in every time)
```bash
# 1) Sign in once and save the profile (cookies/storage)
navia login my-portal --browser chromium --start-url https://my-portal.com/login

# 2) Reuse that session: start already authenticated, skip login/captcha
navia run "download my latest invoice" --profile my-portal
```
- Profiles are saved in `~/.navia/profiles/` (covered by `.gitignore`).
- **Always encrypted (AES-256-GCM).** By default Navia auto-generates a key at `~/.navia/key` — zero setup. Set **`NAVIA_SECRET`** to use your own passphrase instead (stronger: the key never touches disk; ideal for shared machines).

### Credentials and 2FA without exposing them to the AI
Store passwords / 2FA in an encrypted vault; the AI **uses** them by key but **never sees the value**:
```bash
navia secret set shop.password                       # prompts for the password without showing it
navia secret set shop.password --origin https://accounts.example.com   # bind it: only fills on this origin (anti-phishing)
navia secret totp shop.2fa         # prompts for the TOTP secret (base32 from your authenticator)
navia secret list                  # lists keys (no values)
navia secret reset                 # start fresh — backs up the current vault to .bak (never deletes)
```
Then, in a task, the AI uses `fill_credential(ref, "shop.password")` and `fill_totp(ref, "shop.2fa")` — the real value is injected locally, outside the prompt. The vault is **encrypted by default** (auto-managed key, or your `NAVIA_SECRET`).

**Domain binding (anti-phishing):** if you set `--origin`, the secret is filled **only** when the element's real frame origin matches — typing your password into an unexpected/cross-origin frame is hard-rejected. Tip: the interactive `navia start` wizard asks for the password and stores it for you — no manual setup.

## 🧠 Per-domain memory (playbooks)

Navia learns reusable "operating tips" per site and re-injects them the next time it visits that domain — so it stops rediscovering each site from scratch.

```bash
navia playbook add example.com --note "the 'Sign in' button enables only after re-typing the email"
navia playbook show example.com
navia playbook list
```
Tips are also captured automatically: whatever you type when Navia calls `wait_for_human` is saved as a tip for the current domain. Disable everything with `--no-memory`. Stored in `~/.navia/playbooks/`.

## 📊 Reliability & evals (`navia eval`)

Every run reports **metrics beyond pass/fail** (steps, tokens, error recoveries, repeated-action loops). To benchmark Navia on a set of live-site tasks with an LLM judge (WebJudge-style):

```bash
navia eval --dataset ./tasks.jsonl --report ./report.json
# tasks.jsonl: one {"task_id","task","url","level"} per line (Online-Mind2Web-ish)
```
Reports success rate (overall and by difficulty) plus aggregate metrics. Ships with a small sample dataset if you omit `--dataset`.

## 🔌 As an MCP server (Claude Desktop / Code / Cursor)

Navia also exposes itself as an **MCP server**: its browser tools become available inside your client, where the client's model drives them (CDP snapshot, stable refs, captcha detection, profiles, and vault all included).

**Claude Code:**
```bash
claude mcp add navia -- npx -y navia-ai mcp --browser chromium
```

**Claude Desktop / Cursor** (JSON config):
```json
{
  "mcpServers": {
    "navia": { "command": "npx", "args": ["-y", "navia-ai", "mcp", "--browser", "chromium"] }
  }
}
```
Accepts `--profile <name>` (start authenticated) and `--browser chrome|firefox`. Tools that need a TTY (`confirm_action`/`wait_for_human`) are not exposed: in MCP the human approves inside their own client.

**Secure credential elicitation:** if a task needs a vault secret that isn't stored yet, the MCP server **asks you for it through your client's secure prompt** (MCP elicitation) and saves it encrypted — the value never passes through the model. Discoverable via the MCP registry (`server.json`).

## 🔑 No API key — use your terminal's AI CLI

Navia can "think" with an AI CLI **already authenticated** in your terminal, without an `ANTHROPIC_API_KEY`:

```bash
navia run "..." --provider claude-cli                      # uses `claude` (Claude Code)
navia run "..." --provider claude-cli --cli-command ant    # recommended: Anthropic CLI
```
- In **`auto`** (default), Navia uses `ANTHROPIC_API_KEY` if present; otherwise it falls back to the `claude` CLI.
- **`ant`** (Anthropic CLI) is recommended: `ant auth login` once → it's a clean single-shot completion endpoint over your login, ideal for the loop. `claude` works as a *fallback* but is slower (it's an agent, not a completion endpoint).
- **Any other terminal AI:** set `NAVIA_CLI_CMD="my-cli --flags"` (its stdout is taken as the response).

> Note: CLI mode spawns one process per step → slower than `--provider api`, but needs no key.

## 🔁 Deterministic macros (record and replay, no AI)

Record a run and replay it as many times as you want **with no LLM and no API key** (fast and free). Replay uses **stable locators** (role + name), not ephemeral refs:

```bash
navia "sign in and download this month's invoice" --record ./invoice.jsonl   # record
navia replay ./invoice.jsonl --profile my-portal                              # replay, no AI
```
Ideal for validated, repetitive flows. Secrets aren't stored in the macro: `fill_credential`/`fill_totp` are re-injected fresh from the vault on each replay.

## 🧱 Structured extraction (web → typed JSON)

Extract structured, schema-validated data from a page. Navia forces the model to answer through a tool whose schema **is** your schema, so the result always matches (with a retry otherwise). Requires an API key.

```bash
# schema.json describes the shape you want
navia extract "the first 5 products with name and price" \
  --url https://example-shop.com --schema ./schema.json
```

```ts
import { extract } from "navia-ai";

const data = await extract({
  url: "https://news.example.com",
  instruction: "the top 5 headlines with title and points",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, points: { type: "number" } }, required: ["title"] },
      },
    },
    required: ["items"],
  },
});
```

## 🧑‍💻 Usage (library)

```ts
import { runNavia } from "navia-ai";

const { summary, steps, metrics } = await runNavia({
  task: "Open example.com and extract all the main-menu links",
  browser: "chromium",
  validate: true,            // optional post-task validator
  hooks: {
    log: (m) => console.log(m),
    confirmAction: async (desc) => /* your logic */ true,
    waitForHuman: async (reason) => { /* resolve, then */ return ""; },
  },
});

console.log(summary, metrics); // metrics: steps, toolCalls, toolErrors, tokensIn/Out, recoveries, loopHits
```

### Primitives: `observe` / `act` (the dial)
For deterministic control: see candidate actions without running them, then run exactly one — by `ref`, with **no extra LLM call**.

```ts
import { BrowserDriver, observe, act } from "navia-ai";

const driver = await BrowserDriver.create({ engine: "chromium" });
await driver.navigate("https://example.com");

const actions = await observe({ instruction: "the 'More information' link", driver });
await act(actions[0], { driver });        // deterministic, no LLM
// or one-shot:  await act("click 'More information'", { driver });
```

## 🔧 How it works (architecture)

```
Your instruction ─► BrowserAgent (tool-use loop with Claude)
                      │  navigate · snapshot · click · type · fill_form · batch_actions · evaluate · wait_for · screenshot
                      ▼
                 BrowserDriver (Playwright)
                      ▼
        Real Chrome (CDP)  /  Firefox  /  Chromium  ─►  the website
```

1. **snapshot** = accessibility tree with a `ref` per element (the AI acts by `ref`).
   - On **Chromium/Chrome** the snapshot is built with **CDP** (`Accessibility.getFullAXTree`): it doesn't mutate the DOM, traverses **shadow DOM** and **iframes** (same-process via `frameId`; cross-origin/OOPIF like Turnstile via a dedicated CDP session, with composite refs `fN_id`), and `ref`s are **stable** (`backendNodeId`). Actions are resolved over CDP.
   - On **Firefox** (which doesn't speak CDP) a JS-injection snapshot is used as a *fallback*; there `ref`s are ephemeral → re-snapshot after DOM changes.
   - `ref`s are **versioned** (`v<N>:id`): acting on a stale ref from an old snapshot is rejected with a clear message instead of hitting the wrong node.
2. **evaluate** runs JS to extract lists or resolve stubborn clicks (gate it off with `--no-eval` on untrusted sites). **batch_actions** runs several independent actions in one tool call.
3. **detectChallenge** recognizes walls (Cloudflare/Turnstile/hCaptcha/reCAPTCHA/DataDome) and hands the window to the human.
4. The **system prompt** carries the production-proven method, distilled — and treats all page content as untrusted **data, never instructions** (prompt-injection spotlighting); page text is wrapped/flagged so embedded "ignore your instructions…" attacks don't steer the agent.

| Engine | When to use it |
|---|---|
| `chromium` (default) | Most sites. |
| `firefox` | Alternative; some portals behave better. |
| `chrome` (CDP) | 🔑 **Cloudflare**-walled sites. Launches your real Chrome and connects via CDP. |
| `patchright` | 🥷 Anti-detection without pre-opening Chrome. Patched Playwright (removes the `Runtime.enable` leak). Opt-in: `npm i patchright && npx patchright install chromium`. |

## ⚠️ Responsible use

Navia drives a real browser with your credentials and your session. Use it only on sites and accounts **you own or are authorized to access**, respecting their Terms of Service. The CDP trick **does not forcibly bypass** protections — it uses your real browser. It ships no captcha solvers or stealth tricks: when a human is needed (captcha/2FA), it hands you the window.

## 📄 License

MIT
