# Autopilot 1.2.3

*An AI coding assistant made from reverse engineered Jetski RAG architecture.*

Autopilot 1.2.3 is the first release under the **Hints Technology** name. It brings a new identity, a much larger toolset around the chat, and a review flow for everything the agent changes in your code.

---

## Highlights

- **Review every change.** Files the agent edits are marked green (new or changed lines) and red (what was there before) in the editor, listed as cards in the chat with `+/−` counts, and can be accepted or reverted per hunk or per file.
- **Keep working while it works.** Type, pick a model, run commands and attach files while a task runs. Send to the same model and your message queues; send to another model and it runs in parallel.
- **Research, then plan, then build.** Research mode studies reference code and writes `Research.md`; Plan mode turns it into `implementation_plan.md`; approving the plan hands over to the coder.
- **Many more models.** Ollama Cloud and OpenRouter models in one picker, with a size slider for model families.
- **An agent that fixes its own errors.** Failing commands and lint errors introduced by an edit are fed back until they pass.

---

## What's new

### Chat and models
- Model picker groups a family into one row, for example **Nemotron 3 (Ollama)**, with a slider for the variant (Nano 30B · Super 120B · Ultra 550B). Moving the slider switches the model.
- New OpenRouter models: Nemotron 3.5 SuperVL 120B, Nemotron 3.5 Lightning 30B, Xing 4.0 29B, Gemma 4 26B, Inkling 975B and Inkling 276B. One OpenRouter key serves all of them (**Autopilot: Set OpenRouter API Key**).
- Ollama Cloud models: Gemma 4 31B, GPT-OSS 120B and 20B, Beam 550B, Nemotron 3 Nano, Super and Ultra.
- Five working modes: **Manual**, **Edit**, **Plan**, **Research** and **Auto**. Permission requests appear as cards in the chat with *Allow once*, *Always allow* and *No (tell the agent what to do instead)*.
- Slash commands are shown as your message, with the command highlighted like an `@file` tag, and their output appears under it like any reply. New in the menu: `/analytics`, `/orchestrate`, `/sdk`, `/pin`, `/revert`, `/permissions`.
- Sticky user messages with a rail connecting each reply, *Show more / Show less* for long messages, a restore button under each message, and `@` file mentions with chips.

### Queue and parallel runs
- Same model busy: your message waits in a queue, shown under your message with a **Cancel** button, and starts by itself.
- Different model: starts immediately in parallel, in its own turn, with its own streaming reply.
- **Stop** stops every running task and clears the queue.
- `/plan`, `/battle`, `/sdk`, `/subagent`, `/orchestrate` and the Plan and Research modes run one at a time because they share workspace state.

### Reviewing what the agent changed
- Green and red markers in the editor, a hover with the full diff, and **Accept / Revert** above every hunk.
- Chat cards for every changed file; revert or accept without opening it. Reverting a file the agent created deletes it.
- Shortcuts: `Alt+J` / `Alt+K` next and previous change, `Alt+Enter` accept, `Alt+Shift+Backspace` revert. Command palette: **Autopilot: Accept all changes in this file**, **Autopilot: Revert all changes in this file**.
- **Restore points:** every message snapshots your workspace in a private shadow git repository, and the restore button rolls code and conversation back to before that message.

### Research
- Research mode breaks your request into requirements, finds matching reference code and writes `Research.md` with the functions and code to reuse.
- GitHub: downloads the most starred repositories as zip files (3 by default, or the number you ask for), keeps them under `.rag/references/` and studies them locally. Ask for a specific tag, release, branch or commit and that exact version is downloaded next to the first.
- Web search through the built-in Google scraper with DuckDuckGo as a fallback, optionally Bright Data's SERP API. Package lookups for npm, PyPI, pub.dev and crates.io.
- External MCP servers that need a package are downloaded on first use; an installed Chrome or Edge is reused instead of downloading Chromium.
- Auto mode can research by itself when a task needs documentation or reference code.

### Input
- Paste or drag screenshots; images are described by a vision model when the selected model cannot see them.
- Record **voice messages** with the microphone button. They go straight to an audio model (Gemma 4 26B) or are transcribed first for other models. `Shift`+click keeps Windows Voice Typing. Audio files can be attached too.
- `Enter` sends, `Shift+Enter` adds a line, `↑` recalls your previous message.

### Analytics
- `/analytics` shows tokens used (session, today, 7 and 30 days, all time), active time, models used, top tools and run outcomes.
- The old status pills above the input were removed; their information lives in `/analytics`.

### Identity
- New name **Autopilot**, new icon, and new identifier **`hintstechnology.autopilot`**, published by Hints Technology.
- A README and these release notes.

---

## Fixes

- **Agent no longer stops on an unresolved error.** Failed commands now return the real output and exit code (or an explicit timeout notice), the default command timeout went from 15 s to 120 s (up to 10 minutes, or background), edits that introduce errors are reported back, and a run that still has errors is asked to keep fixing.
- **Repeated failing calls.** An `edit_file` that fails with *old_str not found* because the text was already changed is now recognised as *already applied*, identical failing calls trigger a loop guard, and the run ends with an honest report instead of 25 identical retries.
- **No more silent "Done".** Errors that arrive inside the model's stream (for example rate limits returned with HTTP 200), reasoning-only replies and empty replies are now shown, with one automatic retry.
- **OpenRouter requests** were sent to the wrong path; they now use `/api/v1/chat/completions`. Requests carry OpenRouter's app attribution headers, and a `403 … only available on agentic harnesses` now explains itself.
- Leaked tool calls in plain text (malformed JSON, wrapped markers) are recovered; images no longer stay in the history and break non-vision models; the planner and researcher write real files instead of placeholders; `create_file` can no longer create a file called `undefined`.
- Web search results, GitHub rate limits and oversized repositories are handled; web pages are converted to readable text instead of raw HTML.
- Plan progress is an ordinary reply in the turn that started it instead of a banner stuck above the chat.

---

## Upgrading from 0.1.0

The extension identifier changed from `rag-rebuild.rag-assistant` to `hintstechnology.autopilot`, so:

1. **Uninstall** the old extension and install `autopilot-1.2.3.vsix`, then **reload the window**.
2. Your conversations, knowledge items and restore points are copied over automatically the first time Autopilot starts.
3. Your settings (`ragAssistant.*`: models, active model and the rest) are kept.
4. **Re-enter your API keys.** Keys live in the IDE's secret storage, which is per extension, so they cannot move across. Use **Autopilot: Set API Key for Model** and **Autopilot: Set OpenRouter API Key**. The "always allow" list and the last mode are reset.

---

## Known limitations

- Free OpenRouter models are rate limited, and some are restricted to agentic apps. If one answers `403`, set `ragAssistant.openRouterAppUrl` to your own URL or choose another model. Free endpoints may log prompts.
- Voice recording needs the IDE to allow microphone access in its panels; if it does not, Autopilot falls back to Windows Voice Typing.
- Change markers follow the file on disk, so a file that has unsaved edits of your own may mark them too.
- Two parallel tasks can edit the same file: there is no file locking. Give them different files.
- The mode menu is locked while a task runs, because changing the mode changes what the running task may do.

---

## Install

Download `autopilot-1.2.3.vsix`, then in the Extensions view choose `…` → **Install from VSIX…** and reload the window. Open the **Autopilot** view in the Explorer sidebar, set an API key and pick a model.

Made by **Hints Technology**.
