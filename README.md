<p align="center">
  <img src="media/icon.png" width="128" alt="Autopilot logo">
</p>

<h1 align="center">Autopilot</h1>

<p align="center"><b>An AI coding assistant made from reverse engineered Jetski RAG architecture.</b></p>

Autopilot lives in the Explorer sidebar of Antigravity IDE (and any VS Code compatible editor). It chats with the model of your choice, reads and edits your code with real tools, plans and researches before it builds, and shows you every change it makes so you can accept or revert it hunk by hunk.

> Publisher: **Hints Technology** · Identifier: `hintstechnology.autopilot` · Version 1.3.5

---

## Highlights

| | |
|---|---|
| **Any model, one panel** | Ollama (local and Ollama Cloud), OpenRouter, OpenAI, Gemini and custom OpenAI-compatible endpoints. Models of the same family share one row with a size slider. |
| **Five working modes** | Manual, Edit, Plan, Research and Auto, from "ask before everything" to "just do it". |
| **Plan and Research** | Research mode studies reference code and writes `Research.md`; Plan mode reads it and writes `implementation_plan.md`; approving the plan hands over to the coder. |
| **Change review** | What the agent edits is marked green and red in the editor, listed in the chat, and can be accepted or reverted per hunk or per file. |
| **Queue and parallel runs** | Keep typing while the model works. Same model: your message queues. Different model: it runs in parallel. |
| **Restore points** | Every message takes a snapshot of your workspace in a private shadow git repository, so you can roll code and conversation back to before any message. |
| **Voice, images, files** | Paste screenshots, record voice messages, `@`-mention files, add context. |
| **Analytics** | `/analytics` shows token usage, active hours, models and tools used. |

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%"><img src="media/screenshots/chat.png" alt="An agent run with tool calls and a changed-file card"><br><sub>An agent run: tool calls, a changed-file card with Accept / Revert, and the Done summary</sub></td>
    <td align="center" width="50%"><img src="media/screenshots/review.png" alt="Green and red change markers in the editor"><br><sub>The same change in the editor: green for the new line, red for the old one, Accept / Revert above it</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/screenshots/models.png" alt="Model picker with variant sliders"><br><sub>Model picker: one row per family, a slider for the variant</sub></td>
    <td align="center"><img src="media/screenshots/queue.png" alt="A queued message and a parallel run"><br><sub>Same model busy: the message queues. Another model: it runs in parallel</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="media/screenshots/commands.png" alt="Slash command menu"><br><sub>Slash commands</sub></td>
    <td align="center"><img src="media/screenshots/welcome.png" alt="Welcome screen"><br><sub>A new conversation</sub></td>
  </tr>
</table>

<sub>The agent-run and queue screenshots show the real panel with sample messages.</sub>

---

## Supported models

The model picker lists these 16 models, grouped into 11 rows. Models of the same family and provider share one row with a **slider** for the variant: move it to switch model.

| Picker row | Variants (slider) | Model IDs | Notes |
|---|---|---|---|
| **Gemma 4 31B** (Ollama) | | `gemma4:31b-cloud` | Understands screenshots and images. The default vision model |
| **GPT-OSS** (Ollama) | 20B · 120B | `gpt-oss:20b-cloud`<br>`gpt-oss:120b-cloud` | 20B is the fastest for quick answers; 120B is strong at reasoning for complex tasks |
| **Beam 550B** (Ollama) | | `beam` | Largest model, for the toughest challenges |
| **Nemotron 3** (Ollama) | Nano 30B · Super 120B · Ultra 550B | `nemotron-3-nano:30b-cloud`<br>`nemotron-3-super:cloud`<br>`nemotron-3-ultra:cloud` | Nano is light and fast; Super balances reasoning and tool use; Ultra is the most capable |
| **Nemotron 3.5** (OpenRouter) | Lightning 30B · SuperVL 120B | `nvidia/nemotron-3.5-lightning:free`<br>`nvidia/nemotron-3.5-super-vl:free` | Lightning is light and fast; SuperVL reads images and reasons well |
| **Xing 4.0 29B** (OpenRouter) | | `xingchen-agi/xing4.0-29b-a4b:free` | Fast general model |
| **Gemma 4 26B** (OpenRouter) | | `google/gemma-4-26b-a4b-it:free` | Understands images **and audio**. The default audio model |
| **Inkling** (OpenRouter) | 276B · 975B | `thinkingmachines/inkling-small:free`<br>`thinkingmachines/inkling:free` | 276B answers quicker; 975B is the largest, for the toughest challenges |
| **Claude Fast / Balanced / Deep (Anthropic)** | | `claude` | Your claude.ai account through a Chrome window. One row with a slider for Claude's effort setting: **Fast** (Low), **Balanced** (Medium), **Deep** (High). Sees images, takes files. See *Claude, ChatGPT and Gemini through their websites* below |
| **ChatGPT Instant / Thinking (OpenAI)** | | `chatgpt` | Your chatgpt.com account through a Chrome window. One row with a slider: **Instant** (the site's Think switch off) and **Thinking** (switch on). Sees images, hears audio, takes files |
| **Gemini Fast / Balanced / Deep (Google)** | | `gemini` | Your gemini.google.com account through a Chrome window. One row with a slider for Gemini's reasoning level: **Fast** (Low), **Balanced** (Medium), **Deep** (High). Sees images, hears audio, takes files |

- **Ollama** models run on Ollama Cloud (`https://ollama.com`, your Ollama API key). **OpenRouter** models use one OpenRouter key for all of them.
- The `:free` models are free to use but rate limited, and some are restricted to agentic apps (see *OpenRouter free models* below).
- Availability depends on your account with each provider.
### Claude, ChatGPT and Gemini through their websites

These three use the **chat websites with your own account** instead of an API key: claude.ai, chatgpt.com and gemini.google.com. Autopilot drives them with [Botasaurus](https://github.com/omkarcloud/botasaurus), a real Chrome with anti-detection. Each site has **one row with a slider** in the model picker:

| Site | Slider | What it switches on the website |
|---|---|---|
| **ChatGPT** | Instant · Thinking | the *Think* switch of the message box (off / on) |
| **Gemini** | Fast · Balanced · Deep | the *reasoning level* in the mode menu (Low / Medium / High) |
| **Claude** | Fast · Balanced · Deep | the *Effort* setting in the model menu (Low / Medium / High) |

**First use**

1. Pick one of the rows and send a message.
2. Read the notice and confirm once per site. **Automating these websites may go against their terms of service, and the account can be limited or suspended.** The official APIs are the supported way: Anthropic, OpenAI and Gemini keys, or Claude and others through OpenRouter.
3. Autopilot first checks, in a background (invisible) Chrome, whether you are already signed in, and tells you in the chat: **"✓ Signed in to ChatGPT as <your name>. Sending your message…"** and your message goes straight to the site's chat box. If you are **not** signed in it says so, and a Chrome window opens: **sign in there yourself** (Autopilot waits 5 minutes). It never sees your password; the sign-in stays in a private Chrome profile on your machine (`~/.rag-assistant/mcp-packages/botasaurus/work/profiles`), so you sign in once and not again until the site asks for it.
4. The answer streams back into the chat, with *Thought for Ns…* while the model has not started writing. The browser keeps running in the background for the next messages and closes after 60 idle minutes. If it was closed or crashed, Autopilot starts it again by itself and sends the message once more.

**How it behaves**

- **One Autopilot chat = one website chat.** Every message of a session, also after you close and reopen the IDE, continues the same chat on the site (its address is remembered per session). A new website chat is started only when the site says the conversation is full, or after `ragAssistant.webChatMaxChars` characters (default 120000); it then receives the whole conversation again.
- **Tools.** The websites have no tool API: the model is told to write tool calls as `TOOL_CALL {json}` lines and Autopilot turns them back into real tool calls (also when a page typesets the quotes as curly quotes). The first message of a chat carries the instructions, the tool list and the conversation; later messages carry what is new plus a short reminder of the protocol, because long chats forget the first message.
- **Images, audio and files.** The sites take them as attachments: ChatGPT and Gemini see images, hear audio and read files; Claude sees images and reads files. A voice message goes to the audio model (`ragAssistant.audioModelId`) first; if that is missing or fails it goes to ChatGPT and then to Gemini, which transcribe it for the model you picked. A free account has a daily upload limit: when a site refuses a file Autopilot says so and sends nothing.
- **Limits.** Replies are slower than an API and the website's own usage limits apply. Needs Chrome and Python 3.10+; Botasaurus is installed on first use.
- **Other windows.** One browser profile per site: do not use the same site in an Autopilot window and in a second program that automates it at the same time, they would take the profile from each other.
- **When a site changes its layout** patch its selectors with `ragAssistant.webChatSites`, without waiting for a new version. Fields: `url`, `input`, `send`, `assistant`, `streaming`, `signedOut`, `signedIn`, `account`, `think`, `level`, `attachLimit`.

- **Other models:** add OpenAI, Gemini, a local Ollama server or any OpenAI-compatible endpoint with **Autopilot: Add Model**, or by editing `ragAssistant.models` (`provider` is `ollama`, `openai`, `gemini`, `openrouter` or `custom`). Give models a shared `family` and a `variant` to put them on one slider row.

---

## Getting started

1. **Install** the `.vsix` (Extensions view → `…` → *Install from VSIX…*) and reload the window.
2. Open the **Autopilot** view in the Explorer sidebar.
3. **Add your API key**
   - Ollama Cloud, OpenAI, Gemini, custom: `Ctrl+Shift+P` → **Autopilot: Set API Key for Model**.
   - OpenRouter: `Ctrl+Shift+P` → **Autopilot: Set OpenRouter API Key** (one key serves every OpenRouter model).
   - Keys live in the IDE's secret storage, never in settings files.
4. Pick a model with the selector under the input box and start typing.

Local Ollama needs no key: choose a model whose `baseUrl` is `http://localhost:11434`.

---

## The chat box

| Action | How |
|---|---|
| Send | `Enter` |
| New line | `Shift+Enter` |
| Recall your previous message | `↑` |
| Commands | type `/` |
| Mention a file or folder | type `@` |
| Attach an image | paste (`Ctrl+V`), drag and drop, or the `+` menu |
| Voice message | the microphone button (click to record, click to stop). `Shift`+click uses Windows Voice Typing instead |
| Switch mode | the mode button, or `Shift+Tab` |

While a task runs you can still type, pick a model, use commands and attach files. See *Queue and parallel runs* below for what Enter does then.

### Models

Models of one family and provider are a single row, for example **Nemotron 3 (Ollama)**, with a slider for the variant (Nano 30B · Super 120B · Ultra 550B). Moving the slider switches the model immediately. Add your own with **Autopilot: Add Model** or by editing `ragAssistant.models`.

Images are described by a vision model (`ragAssistant.visionModelId`) when the selected model cannot see them; the selected model still writes the reply. Voice messages go straight to an audio model (`"audio": true` in the model config), or are transcribed by `ragAssistant.audioModelId` first.

### Modes

| Mode | What the agent may do |
|---|---|
| **Manual** | Asks before every edit and every command. |
| **Edit** | Edits files freely, asks before running commands. |
| **Plan** | Read-only. Explores, then writes a step-by-step plan to `.rag/plans/<session>/implementation_plan.md` and waits for your approval. |
| **Research** | Read-only. Breaks your request into requirements, finds matching reference code (downloaded GitHub repositories, documentation) and writes `Research.md` with the functions and code to reuse. |
| **Auto** | Edits and vetted commands run on their own. Destructive actions still ask. |

Permission prompts appear as cards in the chat with *Allow once*, *Always allow* and *No (tell the agent what to do instead)*.

### Queue and parallel runs

- Send a message to a model that is **busy** and it waits in a queue (with a *Cancel* button) and starts automatically afterwards.
- Send it to a **different model** and it runs right away, in parallel, in its own turn.
- `/plan`, `/battle`, `/sdk`, `/subagent`, `/orchestrate` and the Plan and Research modes share workspace state, so they run one at a time.
- The **Stop** button (shown when the box is empty) stops every running task and clears the queue.

---

## Reviewing what the agent changed

Every file the agent edits appears in the chat as a card:

```
✎ index.html      +1 −1      ✓ Accept   ✕ Revert
```

When the file is open in an editor, the changes are marked in place: **green** for new or changed lines, **red** notes (and a hover with the full diff) for what was there before, and **Accept / Revert** buttons above every hunk.

| Shortcut | Action |
|---|---|
| `Alt+J` / `Alt+K` | next / previous change |
| `Alt+Enter` | accept the change under the cursor |
| `Alt+Shift+Backspace` | revert the change under the cursor |

Command palette: **Autopilot: Accept all changes in this file**, **Autopilot: Revert all changes in this file**. For a file the agent created, *Revert* deletes it.

Besides this per-hunk review, every user message has a **restore** button (the round icon under the bubble) that rolls the workspace and/or the conversation back to before that message.

---

## Slash commands

| Command | |
|---|---|
| `/plan <task>` | Plan the task (writes `implementation_plan.md`). `/plan approve`, `/plan reject`, `/plan modify <feedback>`, `/plan status` |
| `/fix` | Fix the diagnostics of the active file |
| `/diag` | Show IDE diagnostics in the chat |
| `/battle <prompt>` | Two models answer the same prompt, a third judges |
| `/agent <role>` | Switch agent role (developer, architect, reviewer…) |
| `/subagent <task>`, `/orchestrate <task>` | Run a team of sub-agents |
| `/checkpoint`, `/fork` | Save, list, restore and fork conversation checkpoints |
| `/knowledge` | Knowledge base: add, list, search |
| `/sidecar` | Background processes: start, stop, list, logs |
| `/sdk` | Run Python SDK agent scripts |
| `/pin`, `/revert`, `/permissions` | Pin context, undo recorded edits, manage "always allow" |
| `/rag`, `/security` | Toggle RAG search, toggle PolicyGuardian checks |
| `/model`, `/tools`, `/context`, `/terminal` | Inspect models, tools, system prompt, last terminal output |
| `/analytics` | Token usage, active hours, models and tools used (`/analytics reset` clears it) |
| `/new`, `/help` | New conversation, list all commands |

---

## Research mode and web tools

Research mode and Auto mode can look things up on their own:

- **GitHub:** the most starred repositories for a topic are downloaded as zip files (3 by default, or as many as you ask for), kept under `.rag/references/` and studied locally. Ask for another version and that exact tag, release, branch or commit is downloaded next to the first.
- **Web search:** Google through the built-in scraper, with DuckDuckGo as a fallback. Optionally use Bright Data's SERP API for reliable Google results. Free engines block bursts of automated queries (a blocked engine rests for 4 minutes). When both are blocked, the search is retried through **[Botasaurus](https://github.com/omkarcloud/botasaurus)**, a real Chrome with anti-detection, which is served normal results; pages that answer `web_fetch` with a bot challenge (Cloudflare and similar) are retried the same way. Botasaurus is a Python package installed on first use (about 5 minutes; Chrome and Python 3.10+ must be installed), and an optional proxy helps when your IP address itself is blocked. If that is not available either, paper and journal queries fall back to OpenAlex and arXiv, programming errors to Stack Overflow and general-knowledge questions to Wikipedia, and the agent is told what else to use instead of retrying.
- **Packages:** npm, PyPI, pub.dev and crates.io lookups.
- **Stack Overflow:** when a build, test or run fails and the error text does not show the fix, the agent searches Stack Overflow (official API) and applies the accepted answer. Available in every mode.
- **MCP servers:** external MCP servers that need a package are downloaded on first use. If Chrome or Edge is installed it is reused, so Chromium is not downloaded again.

### When GitHub has no reference: the paper route

Research mode first looks for an implementation on GitHub. Only when it finds **none** (two keyword variants come back empty, or none of the repositories implements the requirement) does it switch to papers, and the Google Scholar tools stay locked until then:

1. **Find the paper.** `scholar_search` uses the [Google Scholar MCP server](https://github.com/JackKuo666/Google-Scholar-MCP-Server) (`search_google_scholar_key_words`, `search_google_scholar_advanced`, `get_author_info`). Google Scholar often blocks scripted requests with a bot check; when that happens the answer says so and OpenAlex and arXiv are searched instead.
2. **Study the system.** `paper_read` reads the paper (arXiv and HTML pages; PDFs cannot be read) and the agent extracts the algorithm, data structures, formulas and parameters.
3. **Reimplement the code.** The agent writes the implementation and a test into `.rag/prototype/<session>/`. Nothing else in your project is touched.
4. **Test it.** `prototype_run` runs the test. You are asked once per research run to allow running commands there.
5. **Fix errors.** If the test fails, the agent looks the error up on Stack Overflow (then Google with `site:stackoverflow.com`), fixes the code and runs it again, up to six cycles.
6. **Report.** `Research.md` gets a **Paper-based reimplementation** section: the paper, the method, the exact code that was run, its test result (PASS or FAIL) and the fixes with their Stack Overflow links.

The Google Scholar MCP server is a Python program. On first use it is downloaded into `~/.rag-assistant/mcp-packages/google-scholar` with its own virtual environment (Python 3.10 or newer must be installed; set `RAG_PYTHON` to choose one). It is not part of the extension package.

Optional credentials: **Autopilot: Set GitHub Token (Research)** (raises the GitHub limit from 60 to 5000 requests per hour) and **Autopilot: Set Bright Data API Key**.

---

## Settings

| Setting | Default | |
|---|---|---|
| `ragAssistant.models` | built-in list | Configured models: `id`, `name`, `provider`, `baseUrl`, `modelId`, optional `description`, `family`, `variant`, `audio` |
| `ragAssistant.activeModelId` | | The model selected in the panel |
| `ragAssistant.visionModelId` | `ollama-cloud-gemma4` | Model that analyzes attached images |
| `ragAssistant.audioModelId` | `openrouter-gemma4-26b` | Model that listens to voice messages when the selected one cannot; if it fails, ChatGPT (web) is tried |
| `ragAssistant.systemPrompt` | | Prepended to every conversation |
| `ragAssistant.maxTokens` | `8192` | Maximum output tokens per response |
| `ragAssistant.temperature` | `0.7` | Sampling temperature |
| `ragAssistant.contextWindow` | `24000` | Token budget; history is trimmed to fit |
| `ragAssistant.ragTopK` | `5` | RAG chunks retrieved per query |
| `ragAssistant.agentRole` | `default` | Default agent role |
| `ragAssistant.policyGuardianEnabled` | `true` | Security checks on shell commands |
| `ragAssistant.brightDataZone` | | Zone for the Bright Data SERP API |
| `ragAssistant.openRouterAppUrl` | | URL that identifies this app to OpenRouter |
| `ragAssistant.openRouterCategories` | `ide-extension,cli-agent` | OpenRouter app categories (max 2) |
| `ragAssistant.stealthBrowser` | `true` | Retry blocked searches and challenge pages through Botasaurus (a real Chrome with anti-detection) |
| `ragAssistant.webChatSites` | `{}` | Patch the page selectors of Claude, ChatGPT and Gemini when a website changes its layout |
| `ragAssistant.webChatMaxChars` | `120000` | A website chat that took this much text is replaced by a new one (with the whole conversation again) |
| `ragAssistant.searchProxy` | | Optional proxy for the stealth browser, e.g. `http://user:pass@host:port` (or the `RAG_SEARCH_PROXY` environment variable) |

### OpenRouter free models

Some free OpenRouter models are limited to agentic apps and answer `403 … only available on agentic harnesses`. Autopilot identifies itself with the headers OpenRouter documents for this (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`). If a model still refuses, set `ragAssistant.openRouterAppUrl` to your own URL or choose another model. Free endpoints are rate limited (`429`).

---

## How it works

Autopilot follows the architecture of the Jetski language server, rebuilt as a VS Code extension:

- **Agent loop** (CortexStep style): the model streams text and calls tools; results go back to it until the task is done. Failing commands and lint errors introduced by an edit are fed back so the agent fixes them instead of stopping.
- **Prompt assembly** in layers: system prompt, agent role, knowledge items, RAG results (BM25 workspace search), diagnostics, pinned context, current turn.
- **Tools:** file view / edit / search, shell, notebooks, browser, GitHub and web research, sub-agents, and any MCP server you configure.
- **PolicyGuardian** vets shell commands before they run.
- **Shadow git** takes a snapshot before each message without touching your repository.
- **Trajectory store** records every step so a conversation can be checkpointed, forked and resumed.

---

## Your data

- API keys: the IDE's secret storage.
- Conversations, trajectories, knowledge items, analytics and shadow git snapshots: the extension's global storage folder on your machine.
- Plans, research notes and downloaded reference repositories: `.rag/` inside your workspace (add it to `.gitignore`).
- Prompts and files you ask about are sent to the model provider you selected. Free tiers of some providers log prompts: do not send confidential code to them.

---

## Requirements

- Antigravity IDE or VS Code 1.85+
- Nothing else is needed for chat, tools, Plan and Research: the extension is self-contained. Node.js and npm are only needed for external MCP servers that are npm packages, and Python 3.10+ only for `/sdk`, the Google Scholar paper route and the Botasaurus stealth browser (which also needs Google Chrome).
- Git is used for restore points when available.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `HTTP 401` | The API key is missing or wrong. Set it again with the command for that provider. |
| `HTTP 429` | Provider rate limit (common on free tiers). Wait or pick another model. |
| `HTTP 403 … agentic harnesses` | See *OpenRouter free models* above. |
| The reply is empty | Autopilot retries once, then names the model and the error. Send again or switch model. |
| Changes are not marked in an open file | The markers follow the file on disk: save, or reload the file from disk. |
| Paper route: "Google Scholar MCP needs Python 3.10 or newer" | Install Python from python.org, or set the `RAG_PYTHON` environment variable to the interpreter's path. |
| Paper route: Google Scholar returns nothing | Scholar blocks scripted clients; Autopilot then uses OpenAlex and arXiv automatically. |
| Web search still fails | Google and DuckDuckGo block your IP and the stealth browser could not run (it needs Chrome and Python 3.10+). Set `ragAssistant.searchProxy`, or a Bright Data key, or wait a few minutes. |
| A command times out | Builds can take long: the agent can pass a larger timeout (up to 10 minutes) or run it in the background. |

---

Made by **Hints Technology**.
