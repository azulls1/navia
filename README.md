# 🌐 Navia

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
- 🧩 **Bulk extraction** with JavaScript (lists → JSON).
- 🔐 **Secure by design:** asks for confirmation before irreversible actions (submit, pay, delete) and hands you the window for login / captcha / 2FA.
- 📦 **CLI + library** (TypeScript, ESM) **+ MCP server**.

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
# It asks for the start URL, login (username + hidden password → encrypted vault),
# the task, the browser engine and the AI provider, then confirms and runs.

# Default browser (Chromium)
navia "search 't-shirts' on example-shop.com and list the first 5 products with prices"

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
navia "..." --workspace          # write a per-task log/brain folder (Obsidian/Desktop)
```

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
- Set **`NAVIA_SECRET`** to **encrypt** the profile (AES-256-GCM). It holds session cookies — recommended.

### Credentials and 2FA without exposing them to the AI
Store passwords / 2FA in an encrypted vault; the AI **uses** them by key but **never sees the value**:
```bash
navia secret set occ.password      # prompts for the password without showing it
navia secret totp occ.2fa          # prompts for the TOTP secret (base32 from your authenticator)
navia secret list                  # lists keys (no values)
```
Then, in a task, the AI uses `fill_credential(ref, "occ.password")` and `fill_totp(ref, "occ.2fa")` — the real value is injected locally, outside the prompt. (Encrypted with `NAVIA_SECRET`.)

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

const { summary, steps } = await runNavia({
  task: "Open example.com and extract all the main-menu links",
  browser: "chromium",
  hooks: {
    log: (m) => console.log(m),
    confirmAction: async (desc) => /* your logic */ true,
    waitForHuman: async (reason) => { /* resolve, then */ return ""; },
  },
});

console.log(summary);
```

## 🔧 How it works (architecture)

```
Your instruction ─► BrowserAgent (tool-use loop with Claude)
                      │  navigate · snapshot · click · type · fill_form · evaluate · wait_for · screenshot
                      ▼
                 BrowserDriver (Playwright)
                      ▼
        Real Chrome (CDP)  /  Firefox  /  Chromium  ─►  the website
```

1. **snapshot** = accessibility tree with a `ref` per element (the AI acts by `ref`).
   - On **Chromium/Chrome** the snapshot is built with **CDP** (`Accessibility.getFullAXTree`): it doesn't mutate the DOM, traverses **shadow DOM** and **iframes** (same-process via `frameId`; cross-origin/OOPIF like Turnstile via a dedicated CDP session, with composite refs `fN_id`), and `ref`s are **stable** (`backendNodeId`). Actions are resolved over CDP.
   - On **Firefox** (which doesn't speak CDP) a JS-injection snapshot is used as a *fallback*; there `ref`s are ephemeral → re-snapshot after DOM changes.
2. **evaluate** runs JS to extract lists or resolve stubborn clicks.
3. **detectChallenge** recognizes walls (Cloudflare/Turnstile/hCaptcha/reCAPTCHA/DataDome) and hands the window to the human.
4. The **system prompt** carries the production-proven method, distilled.

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
