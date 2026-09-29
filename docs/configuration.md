# Configuration

Yarvis keeps its configuration in three places, split by what the value is:

| Kind | Where | Set from |
| --- | --- | --- |
| Secrets: the database URL, API keys, tokens | One item in the macOS Keychain, or in 1Password | **Settings → Credentials** |
| Everything else you change from the UI | `~/.yarvis/settings.json` | The Settings screen, or by hand |
| Machine-level overrides | Environment variables | Your shell, before `bun run tauri dev` |

Your data (chat history, memory, tasks, workspaces, PR notes) is none of these.
It lives in Postgres.

Secrets never go in env files or in the repo.

## Secrets

Every secret sits in **one** Keychain item (service `com.mikebennett.yarvis`,
account `secrets`), stored as a single JSON object. macOS asks for permission
per item, so one item means one prompt per session instead of one per secret.

The Rust core reads that item when it starts the sidecar and passes each value
in as an environment variable. The UI can save and clear a secret, but it never
reads one back.

| Setting | Used for | Passed to the sidecar as |
| --- | --- | --- |
| Database URL | Everything stored in Postgres | `DATABASE_URL` |
| Anthropic API key | Claude chat | `ANTHROPIC_API_KEY` |
| Gemini API key | Gemini chat, embeddings, cloud voice | `GEMINI_API_KEY` |
| Cerebras API key | Cerebras chat | `CEREBRAS_API_KEY` |
| Hugging Face token | Cloud speech to text | `HUGGINGFACE_API_KEY` |
| GitHub token | PRs, issues, stacks | `GITHUB_TOKEN` |
| Azure DevOps token | Azure PRs | `AZURE_DEVOPS_TOKEN` |
| JIRA API token | JIRA issues | `JIRA_API_TOKEN` |
| Google client secret | Google Calendar | `GOOGLE_CLIENT_SECRET` |
| Telegram bot token | The Telegram bot | `TELEGRAM_BOT_TOKEN` |
| Telegram allowed chat ids | Who the bot answers | `TELEGRAM_ALLOWED_CHAT_IDS` |
| Telegram OTP secret | The bot's optional second factor | `TELEGRAM_OTP_SECRET` |

The same item also holds the credentials for custom LLM providers, MCP servers
and the embeddings provider.

The Telegram chat-id allowlist isn't a credential, but it stays in the Keychain.
With the OTP second factor off, it is the bot's only access check, so it
shouldn't be a plain, freely editable setting.

AWS Bedrock uses the standard AWS credential chain (`~/.aws`, `AWS_PROFILE`,
`AWS_REGION`, default region `us-east-1`), not a Keychain entry.

### Token scopes

- **GitHub.** A classic PAT needs `repo`. A fine-grained PAT needs
  **Contents: Read** (the review reads file bodies to show context) plus pull
  request and issue access. Merging a stack needs write access to the repo.
- **Azure DevOps.** A PAT with **Code (read)** and **Pull Request Threads (read &
  write)**. Set the organization URL (`https://dev.azure.com/your-org`) under
  Settings → Credentials. Code search needs the **Code Search** extension
  installed in your organization. Without it, guided review still works, but
  the agent can't search the repo.
- **JIRA.** Atlassian Cloud only. Create the token at id.atlassian.com →
  Security → API tokens. Set your site URL (`https://your-org.atlassian.net`)
  and account email under Settings → Credentials.

### Touch ID

Putting the Keychain item behind Touch ID needs a code-signed app with an
application-identifier entitlement. Dev builds aren't signed, so they fall back
to the login-password prompt. The 1Password store below gets you a Touch ID
prompt today, because the 1Password desktop app supplies it.

### 1Password instead of the Keychain

**Settings → Credentials → Secret store** moves the secrets item to a 1Password
item, named by vault and item title. The same JSON object is stored in the
item's notes field (`op://<vault>/<item>/notesPlain`), so every secret moves
together.

It needs the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
with the desktop app's CLI integration turned on. That integration is what puts
each read behind Touch ID. A GUI launch has a minimal `PATH`, so Yarvis also
looks in `/opt/homebrew/bin` and `/usr/local/bin`. Set `YARVIS_OP_BIN` if `op`
is somewhere else.

How switching works:

- Saving checks the vault is reachable and copies your current secrets to it.
  Only then does it record the choice. A mistyped vault leaves you on the store
  you were using.
- The item is created as a Secure Note if it doesn't exist.
- **A store that already holds secrets is never overwritten**, and the old
  store keeps its copy. Switching back doesn't re-copy, so any secret you
  changed in the meantime is the older value there. Settings tells you which
  case happened: copied, nothing to copy, or target already occupied.

Writes pass the secrets to `op` on standard input, never as command arguments.
Other processes can read command arguments with no prompt at all.

## `~/.yarvis/settings.json`

This file holds everything you set from the Settings screen that isn't a
secret. Both the Rust core and the sidecar read and write it.

- A missing file, a missing key, or a malformed file all fall back to the
  built-in defaults. A fresh install needs no file at all.
- The directory is created `0700` and the file `0600`, because it can hold
  your JIRA email and similar.
- Writes are atomic (temp file, then rename).
- Every running copy of the app shares this file, including
  `bun run dev:instance` copies.

[`settings.example.json`](settings.example.json) is a starter file with every
common key set to its default. Copy it into place if you want a file to edit by
hand:

```bash
mkdir -p ~/.yarvis && chmod 700 ~/.yarvis
cp docs/settings.example.json ~/.yarvis/settings.json
chmod 600 ~/.yarvis/settings.json
```

Don't copy it over a file you already have. The app has written your
providers and MCP servers into that one.

> **Known issue.** Saving a setting the Rust core owns (the agent command,
> the terminal cap, the Azure, JIRA, Google or Telegram fields, or the secret
> store) rewrites the file with only the Rust core's keys. That drops the
> sidecar's sections listed further down, such as your custom providers and
> voice setup. Back up the file before changing those fields.

### Keys the Rust core owns

| Key | Default | Meaning |
| --- | --- | --- |
| `agentName` | `"Claude"` | Title of a workspace's agent tab |
| `agentCommand` | `"claude --permission-mode auto"` | The command a workspace's agent session runs. Add a model or permission flags here. `YARVIS_CLAUDE_COMMAND` overrides it. |
| `maxPtySessions` | `60` | Most terminal sessions that can be live at once, from 1 to 1000 |
| `secretBackend` | `"keychain"` | `"keychain"` or `"onepassword"` |
| `onePasswordVault`, `onePasswordItem` | unset | Where the secrets item lives when using 1Password |
| `azureDevopsOrgUrl` | unset | `https://dev.azure.com/your-org` |
| `jiraBaseUrl` | unset | `https://your-org.atlassian.net` |
| `jiraEmail` | unset | The Atlassian account the JIRA token belongs to |
| `googleClientId` | unset | The Google OAuth client id. The secret half goes in the Keychain. |
| `telegramOtpWindowMinutes` | `120` | How long `/unlock` keeps the Telegram bot open |

`null` and a missing key both mean "use the default".

### Keys the sidecar owns

| Key | Holds | Set from |
| --- | --- | --- |
| `customProviders` | Your OpenAI- or Anthropic-compatible endpoints, keyed by id | Settings → LLM Providers |
| `providerModels` | Your edited model list per provider. Replaces the built-in list for that provider once saved. | Settings → LLM Providers → Models |
| `mcpServers` | MCP servers Yarvis connects to, keyed by id | Settings → Tools & MCP |
| `chatConfig` | `maxSteps` (100), `maxOutputTokens` (none), `compactAtTokens` (200000) | Settings → Assistant → Turn budget |
| `complexityModels` | The provider and model behind the `low`, `medium` and `max` tiers specialists can ask for | Settings → Assistant |
| `githubPrConfig` | `reviewQuery` for the Needs review tab, `reviewingLookbackDays` for Reviewing | Settings → PR review |
| `wipConfig` | Which sources feed the in-progress list, and a GitHub issue label filter | Settings → Work in progress |
| `jobConfig` | `ccDigestEnabled` and `ccDigestProjectDirs` for the Claude Code transcript digest | Settings → Assistant |
| `voiceConfig` | Speech providers and models, voice, speak replies, hands-free | Settings → Voice |
| `embeddingsConfig` | The embeddings endpoint | Settings → Embeddings |

Custom providers and MCP servers carry generated ids and timestamps. Add them
from the UI rather than by hand.

`githubPrConfig` and `jobConfig` are read as whole objects. If you edit them by
hand, include every field, as the example file does.

## Embeddings

Memory search uses vector embeddings stored in the `memories.embedding` column,
which is `vector(1536)`. Whatever embedder is active must output 1536
dimensions, and longer output is truncated to fit.

Yarvis picks the embedder in this order:

1. The endpoint under **Settings → Embeddings**, if one is set. It must be
   OpenAI-compatible, for example a LiteLLM gateway in front of Gemini
   (`http://localhost:4000/v1`, model `gemini-embedding-001`) or a local Qwen3
   embedding server.
2. Gemini directly, if a Gemini key is saved.
3. An offline hash embedder. It works with no setup, but recall quality is much
   lower.

Each memory records which embedder made its vector. When you change
providers, Settings shows a "re-embed needed" warning. **Re-embed all** in
Settings regenerates every vector.

## Environment variables

You don't need any of these for normal use. They are for running more than one
copy of the app, or for debugging.

| Variable | Effect |
| --- | --- |
| `YARVIS_WORKSPACES_ROOT` | Where workspace clones and worktrees go. Default `~/dev/yarvis-workspaces`. |
| `YARVIS_DATABASE_URL` | Overrides the database URL from the Keychain, for this process only |
| `YARVIS_CLAUDE_COMMAND` | Overrides `agentCommand` |
| `YARVIS_OP_BIN` | Path to the 1Password `op` binary |
| `YARVIS_INSTANCE` | Names this process as a secondary instance. Use `bun run dev:instance` instead of setting this by hand. |
| `YARVIS_BACKGROUND_WORKERS` | `1` or `0`: whether this instance runs the pollers, jobs and Telegram bot |
| `YARVIS_GLOBAL_SHORTCUTS` | `1` or `0`: whether this instance owns the global hotkeys |
| `YARVIS_DEV_PORT` | Pin the Vite dev-server port. Default 1420. |
| `YARVIS_DEBUG_MCP` | `1` logs raw MCP server replies |
| `YARVIS_DEBUG_MEMORY` | `1` logs memory store operations |
| `YARVIS_SETTINGS_PATH` | A different settings file, for the sidecar only. The Rust core ignores it. |
| `YARVIS_AGENTS_DIR` | A different directory for your specialist definitions. Default `~/.yarvis/agents`. |
| `CLAUDE_HOME` | Where Claude Code keeps sessions. Default `~/.claude`. |
| `AWS_PROFILE`, `AWS_REGION`, … | The usual AWS credential chain, for Bedrock |

The sidecar inherits the environment of the shell that started the app. A
`DATABASE_URL` or provider key exported in that shell reaches the sidecar
unless the Keychain has its own value for it.

## Settings screen map

The tabs in **Settings**, in order:

1. **Credentials.** Secret store choice, the secrets list, and the non-secret
   integration fields (Azure org URL, JIRA URL and email, Google client id).
2. **LLM Providers.** Each provider's model list and capability tags, and your
   custom providers.
3. **Tools & MCP.** MCP servers Yarvis connects to, Yarvis's own MCP endpoint,
   and the Tool Manager.
4. **Repositories.** The repos workspaces can use, the workspace agent
   command, and the terminal cap.
5. **PR review.** The Needs review search and the Reviewing lookback.
6. **Voice.** Speech to text and text to speech.
7. **Embeddings.** The embeddings endpoint.
8. **Telegram.** Bot token, allowed chats, and the optional second factor.
9. **Work in progress.** Which sources feed the in-progress list.
10. **Assistant.** Turn budget, complexity tiers, specialists, and background
    jobs.
11. **Diagnostics.** The sidecar log.
