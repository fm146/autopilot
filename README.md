<p align="center">
  <img src="media/icon.png" width="128" alt="Autopilot logo">
</p>

<h1 align="center">Autopilot</h1>

<p align="center"><b>An AI coding assistant made from reverse engineered Jetski RAG architecture.</b></p>

Autopilot lives in the Explorer sidebar of Antigravity IDE (and any VS Code compatible editor). It chats with the model of your choice, reads and edits your code with real tools, plans and researches before it builds, and shows you every change it makes so you can accept or revert it hunk by hunk.

> Publisher: **Hints Technology** · Identifier: `hintstechnology.autopilot` · Version 1.2.3

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

These are the models in the default `ragAssistant.models` list. Availability depends on your account with each provider, and you can add any model your provider offers with **Autopilot: Add Model** or in settings.

### Ollama

| Model | ID | Notes |
|---|---|---|
| Gemma 4 31B | `gemma4:31b-cloud` | Understands images; the default vision model |
| GPT-OSS 120B | `gpt-oss:120b-cloud` | Strong reasoning. Variant of the **GPT-OSS** row |
| GPT-OSS 20B | `gpt-oss:20b-cloud` | Fastest for quick answers. Variant of the **GPT-OSS** row |
| Beam 550B | `beam` | Largest model for the toughest challenges |
| Nemotron 3 Nano 30B | `nemotron-3-nano:30b-cloud` | Light and fast. Variant of the **Nemotron 3** row |
| Nemotron 3 Super 120B | `nemotron-3-super:cloud` | Balanced reasoning and tool use. Variant of the **Nemotron 3** row |
| Nemotron 3 Ultra 550B | `nemotron-3-ultra:cloud` | Most capable Nemotron. Variant of the **Nemotron 3** row |
| Ollama (local) | `llama3.2` | Local server at `http://localhost:11434`, no key |
| Llama 3.2 Vision (local) | `llama3.2-vision` | Local, understands images |
| Codestral (local) | `codestral` | Local, code model |

Ollama Cloud uses `https://ollama.com` with your Ollama API key.

### OpenRouter

| Model | ID | Notes |
|---|---|---|
| Nemotron 3.5 SuperVL 120B | `nvidia/nemotron-3.5-super-vl:free` | Reads images. Variant of the **Nemotron 3.5** row |
| Nemotron 3.5 Lightning 30B | `nvidia/nemotron-3.5-lightning:free` | Light and fast. Variant of the **Nemotron 3.5** row |
| Xing 4.0 29B | `xingchen-agi/xing4.0-29b-a4b:free` | Fast general model |
| Gemma 4 26B | `google/gemma-4-26b-a4b-it:free` | Understands images **and audio**; the default audio model |
| Inkling 975B | `thinkingmachines/inkling:free` | Largest Inkling. Variant of the **Inkling** row |
| Inkling 276B | `thinkingmachines/inkling-small:free` | Smaller Inkling. Variant of the **Inkling** row |
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4-5` | Paid |
| DeepSeek R1 | `deepseek/deepseek-r1` | Reasoning |
| DeepSeek V3 | `deepseek/deepseek-chat-v3-0324` | General |
| Llama 4 Maverick | `meta-llama/llama-4-maverick` | General |
| QwQ 32B | `qwen/qwq-32b` | Reasoning |
| Mistral Large | `mistralai/mistral-large-2411` | General |

The `:free` models are free to use but rate limited, and some are restricted to agentic apps (see *OpenRouter free models* below). One OpenRouter key serves all of them.

### OpenAI and Google

| Model | ID |
|---|---|
| GPT-4o | `gpt-4o` |
| GPT-4o Mini | `gpt-4o-mini` |
| Gemini 2.5 Flash | `gemini-2.5-flash` |
| Gemini 2.5 Pro | `gemini-2.5-pro` |

Models of the same family and provider share one row in the picker with a slider for the variant, for example **Nemotron 3 (Ollama)** with *Nano 30B · Super 120B · Ultra 550B*.

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
- **Web search:** Google through the built-in scraper, with DuckDuckGo as a fallback. Optionally use Bright Data's SERP API for reliable Google results.
- **Packages:** npm, PyPI, pub.dev and crates.io lookups.
- **MCP servers:** external MCP servers that need a package are downloaded on first use. If Chrome or Edge is installed it is reused, so Chromium is not downloaded again.

Optional credentials: **Autopilot: Set GitHub Token (Research)** (raises the GitHub limit from 60 to 5000 requests per hour) and **Autopilot: Set Bright Data API Key**.

---

## Settings

| Setting | Default | |
|---|---|---|
| `ragAssistant.models` | built-in list | Configured models: `id`, `name`, `provider`, `baseUrl`, `modelId`, optional `description`, `family`, `variant`, `audio` |
| `ragAssistant.activeModelId` | | The model selected in the panel |
| `ragAssistant.visionModelId` | `ollama-cloud-gemma4` | Model that analyzes attached images |
| `ragAssistant.audioModelId` | `openrouter-gemma4-26b` | Model that listens to voice messages when the selected one cannot |
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
- Nothing else is needed for chat, tools, Plan and Research: the extension is self-contained. Node.js and npm are only needed for external MCP servers that are npm packages, and Python 3 only for `/sdk`.
- Git is used for restore points when available.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `HTTP 401` | The API key is missing or wrong. Set it again with the command for that provider. |
| `HTTP 429` | Provider rate limit (common on free tiers). Wait or pick another model. |
| `HTTP 403 … agentic harnesses` | See *OpenRouter free models* above. |
| The reply is empty | Autopilot retries once, then names the model and the error. Send again or switch model. |
| Changes are not marked in an open file | The markers follow the file on disk: save, or reload the file from disk. |
| A command times out | Builds can take long: the agent can pass a larger timeout (up to 10 minutes) or run it in the background. |

---

Made by **Hints Technology**.
