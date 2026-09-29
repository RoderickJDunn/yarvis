#!/usr/bin/env bash
# Reports which Yarvis setup steps are already done, one line per check.
# Read-only: it installs, starts and changes nothing.
# Usage: check.sh [database-name]   (default: yarvis)

set -u
DB="${1:-yarvis}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

ok()   { printf 'OK      %-22s %s\n' "$1" "$2"; }
miss() { printf 'MISSING %-22s %s\n' "$1" "$2"; }
warn() { printf 'WARN    %-22s %s\n' "$1" "$2"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Homebrew's postgresql@17 is keg-only, so its tools may be installed but not on PATH.
for dir in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if ! have psql && [ -x "$dir/psql" ]; then
    warn "postgres-path" "psql found in $dir but not on PATH"
    PATH="$dir:$PATH"
  fi
done

echo "repo: $REPO"
echo "arch: $(uname -m)  macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"

xcode-select -p >/dev/null 2>&1 && ok "xcode-clt" "$(xcode-select -p)" || miss "xcode-clt" "run: xcode-select --install"
have brew  && ok "homebrew" "$(brew --version 2>/dev/null | head -1)" || miss "homebrew" "see https://brew.sh"
have mise  && ok "mise" "$(mise --version 2>/dev/null)" || warn "mise" "not installed (optional; the repo pins bun and rust in mise.toml)"
have bun   && ok "bun" "$(bun --version)" || miss "bun" "install with mise, or https://bun.com"
have cargo && ok "rust" "$(cargo --version)" || miss "rust" "install with mise, or https://rustup.rs"

if have psql; then
  ok "psql" "$(psql --version)"
  if pg_isready -q 2>/dev/null; then
    ok "postgres-server" "accepting connections"
    if [ "$(psql -d postgres -Atc "select count(*) from pg_available_extensions where name = 'vector'" 2>/dev/null)" = "1" ]; then
      ok "pgvector" "available to this server"
    else
      miss "pgvector" "run: brew install pgvector (needs Postgres 17 or 18 from Homebrew)"
    fi
    if psql -d "$DB" -Atc 'select 1' >/dev/null 2>&1; then
      ok "database" "$DB exists"
      if [ "$(psql -d "$DB" -Atc "select count(*) from pg_extension where extname = 'vector'" 2>/dev/null)" = "1" ]; then
        ok "vector-extension" "enabled in $DB"
      else
        miss "vector-extension" "run: psql -d $DB -c 'CREATE EXTENSION IF NOT EXISTS vector;'"
      fi
      tables="$(psql -d "$DB" -Atc "select count(*) from information_schema.tables where table_schema = 'public'" 2>/dev/null)"
      if [ "${tables:-0}" -gt 0 ]; then
        ok "migrations" "$tables tables in $DB (the app has connected)"
      else
        warn "migrations" "no tables yet; they appear once the app connects"
      fi
    else
      miss "database" "run: createdb $DB"
    fi
  else
    miss "postgres-server" "run: brew services start postgresql@17"
  fi
else
  miss "postgres" "run: brew install postgresql@17 pgvector"
fi

[ -d "$REPO/node_modules" ] && ok "bun-install" "node_modules present" || miss "bun-install" "run: bun install (in $REPO)"

have claude && ok "claude-code" "$(claude --version 2>/dev/null | head -1)" || warn "claude-code" "not on PATH (needed for workspaces)"
if have gh; then
  gh extension list 2>/dev/null | grep -q "gh-stack" && ok "gh + gh-stack" "installed" || warn "gh-stack" "optional: gh extension install github/gh-stack"
else
  warn "gh" "optional: brew install gh (for the Stack tab)"
fi
have uv && ok "uv" "$(uv --version)" || warn "uv" "optional: brew install uv (for local voice)"
[ -d "$REPO/.venv" ] && ok "speech-venv" ".venv present" || warn "speech-venv" "optional: uv sync (for local voice)"
have op && ok "1password-cli" "$(op --version)" || warn "1password-cli" "optional (only to keep secrets in 1Password)"

[ -f "$HOME/.yarvis/settings.json" ] && ok "settings-file" "~/.yarvis/settings.json exists" || warn "settings-file" "none yet (fine: defaults apply)"
