#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Cortex Workstation Installer
#
# One-script setup for an offline-capable security research coding agent.
# Installs: bun, ollama, models, cortex, global config, RAG docs.
#
# Usage:
#   bash install-cortex-workstation.sh [OPTIONS]
#
# Options:
#   --skip-ollama       Don't install ollama (already installed)
#   --skip-models       Don't pull models (already pulled or doing offline)
#   --skip-docs         Don't generate Go documentation for RAG
#   --skip-bun          Don't install bun (already installed)
#   --gpu               Install ollama with GPU support expectations
#   --work-dir DIR      Set the work/RAG source directory (default: ~/work)
#   --model MODEL       Set the default LLM model (default: devstral-16k:latest)
#   --embed-model MODEL Set the embedding model (default: nomic-embed-text)
#   --help              Show this help
#
# Requirements:
#   - Linux (Debian/Ubuntu/Arch or similar)
#   - curl, git
#   - go (for doc generation only — optional)
# ============================================================================

# ── Defaults ──

SKIP_OLLAMA=false
SKIP_MODELS=false
SKIP_DOCS=false
SKIP_BUN=false
GPU_MODE=false
WORK_DIR="$HOME/work"
DEFAULT_MODEL="devstral-16k:latest"
EMBED_MODEL="nomic-embed-text"
CORTEX_REPO="https://github.com/anomalyco/opencode.git"
CORTEX_DIR="$HOME/Desktop/projects/opencode"
BUN_DIR="$HOME/.bun"

# ── Colors ──

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# ── Parse args ──

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-ollama)  SKIP_OLLAMA=true; shift ;;
        --skip-models)  SKIP_MODELS=true; shift ;;
        --skip-docs)    SKIP_DOCS=true; shift ;;
        --skip-bun)     SKIP_BUN=true; shift ;;
        --gpu)          GPU_MODE=true; shift ;;
        --work-dir)     WORK_DIR="$2"; shift 2 ;;
        --model)        DEFAULT_MODEL="$2"; shift 2 ;;
        --embed-model)  EMBED_MODEL="$2"; shift 2 ;;
        --help|-h)
            head -30 "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *) fail "Unknown option: $1" ;;
    esac
done

echo ""
echo "============================================"
echo "  Cortex Workstation Installer"
echo "============================================"
echo ""
info "Work directory:   $WORK_DIR"
info "Default model:    ollama/$DEFAULT_MODEL"
info "Embedding model:  $EMBED_MODEL"
info "GPU mode:         $GPU_MODE"
info "Cortex dir:       $CORTEX_DIR"
echo ""

# ── Step 1: System dependencies ──

info "[1/8] Checking system dependencies..."

for cmd in curl git; do
    if ! command -v "$cmd" &>/dev/null; then
        fail "$cmd is required but not installed. Install it first."
    fi
done
ok "curl, git available"

# ── Step 2: Install bun ──

info "[2/8] Setting up bun..."

if [[ "$SKIP_BUN" == true ]]; then
    warn "Skipping bun install (--skip-bun)"
elif command -v bun &>/dev/null || [[ -x "$BUN_DIR/bin/bun" ]]; then
    BUN_VERSION=$("${BUN_DIR}/bin/bun" --version 2>/dev/null || bun --version 2>/dev/null)
    ok "bun already installed: v${BUN_VERSION}"
else
    info "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$BUN_DIR/bin:$PATH"
    ok "bun installed: $("$BUN_DIR/bin/bun" --version)"
fi

BUN="${BUN_DIR}/bin/bun"
if [[ ! -x "$BUN" ]]; then
    BUN="$(command -v bun 2>/dev/null || true)"
    if [[ -z "$BUN" ]]; then
        fail "bun not found. Install it or pass --skip-bun if already installed elsewhere."
    fi
fi

# ── Step 3: Install ollama ──

info "[3/8] Setting up ollama..."

if [[ "$SKIP_OLLAMA" == true ]]; then
    warn "Skipping ollama install (--skip-ollama)"
elif command -v ollama &>/dev/null; then
    ok "ollama already installed: $(ollama --version 2>/dev/null | head -1)"
else
    info "Installing ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    ok "ollama installed"
fi

# Ensure ollama is running
if command -v ollama &>/dev/null; then
    if ! ollama list &>/dev/null 2>&1; then
        info "Starting ollama service..."
        # Try systemd first, fall back to background process
        if systemctl is-active --quiet ollama 2>/dev/null; then
            ok "ollama service already running"
        elif command -v systemctl &>/dev/null; then
            sudo systemctl start ollama 2>/dev/null || ollama serve &>/dev/null &
            sleep 3
        else
            ollama serve &>/dev/null &
            sleep 3
        fi
    fi
fi

# ── Step 4: Pull models ──

info "[4/8] Pulling models..."

if [[ "$SKIP_MODELS" == true ]]; then
    warn "Skipping model pull (--skip-models)"
else
    if ! command -v ollama &>/dev/null; then
        warn "ollama not found, skipping model pull"
    else
        # Pull embedding model first (small, fast)
        info "Pulling embedding model: $EMBED_MODEL..."
        ollama pull "$EMBED_MODEL"
        ok "$EMBED_MODEL ready"

        # Pull the LLM
        info "Pulling LLM: $DEFAULT_MODEL (this may take a while)..."
        ollama pull "$DEFAULT_MODEL"
        ok "$DEFAULT_MODEL ready"

        echo ""
        info "Installed models:"
        ollama list
        echo ""
    fi
fi

# ── Step 5: Clone/update cortex ──

info "[5/8] Setting up cortex repository..."

if [[ -d "$CORTEX_DIR/.git" ]]; then
    ok "cortex repo exists at $CORTEX_DIR"
    info "Pulling latest changes..."
    cd "$CORTEX_DIR" && git pull --ff-only 2>/dev/null || warn "git pull failed (may have local changes)"
else
    info "Cloning cortex..."
    mkdir -p "$(dirname "$CORTEX_DIR")"
    git clone "$CORTEX_REPO" "$CORTEX_DIR"
    ok "cortex cloned to $CORTEX_DIR"
fi

# Install dependencies
info "Installing bun dependencies..."
cd "$CORTEX_DIR" && "$BUN" install --frozen-lockfile 2>/dev/null || "$BUN" install
ok "Dependencies installed"

# ── Step 6: Create launcher script ──

info "[6/8] Creating launcher script..."

LAUNCHER="$HOME/.local/bin/cortex"
mkdir -p "$HOME/.local/bin"

cat > "$LAUNCHER" << 'LAUNCHER_EOF'
#!/bin/bash
# Launch cortex from any directory
# Usage: cortex [options]
#   cortex                    — start TUI in current directory
#   cortex -m ollama/model    — start with specific model
#   cortex run "message"      — non-interactive mode

CORTEX_ROOT="PLACEHOLDER_CORTEX_ROOT"
BUN="PLACEHOLDER_BUN"
PROJECT_DIR="$(pwd)"

# Check if first arg is a subcommand (run, serve, etc.)
case "$1" in
  run|serve|web|attach)
    cd "$CORTEX_ROOT" && exec "$BUN" run --conditions=browser ./src/index.ts "$@" --dir "$PROJECT_DIR"
    ;;
  *)
    cd "$CORTEX_ROOT" && exec "$BUN" run --conditions=browser ./src/index.ts "$PROJECT_DIR" "$@"
    ;;
esac
LAUNCHER_EOF

# Replace placeholders with actual paths
sed -i "s|PLACEHOLDER_CORTEX_ROOT|${CORTEX_DIR}/packages/opencode|" "$LAUNCHER"
sed -i "s|PLACEHOLDER_BUN|${BUN}|" "$LAUNCHER"
chmod +x "$LAUNCHER"
ok "Launcher installed at $LAUNCHER"

# Ensure ~/.local/bin is on PATH
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    SHELL_RC=""
    if [[ -f "$HOME/.zshrc" ]]; then
        SHELL_RC="$HOME/.zshrc"
    elif [[ -f "$HOME/.bashrc" ]]; then
        SHELL_RC="$HOME/.bashrc"
    fi

    if [[ -n "$SHELL_RC" ]]; then
        if ! grep -q 'local/bin' "$SHELL_RC"; then
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
            info "Added ~/.local/bin to PATH in $SHELL_RC"
        fi
    else
        warn "~/.local/bin is not on PATH. Add it manually: export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
fi

# ── Step 7: Global config ──

info "[7/8] Setting up global configuration..."

CONFIG_DIR="$HOME/.config/cortex"
mkdir -p "$CONFIG_DIR"

# Write global config
cat > "$CONFIG_DIR/cortex.jsonc" << EOF
{
  "\$schema": "https://opencode.ai/config.json",
  // Default model — ollama with local inference
  "model": "ollama/${DEFAULT_MODEL}",
  // RAG embedding — index security research corpus + generated docs
  "embedding": {
    "sources": ["${WORK_DIR}/"]
  },
  // Global instructions — loaded for all sessions regardless of cwd
  "instructions": ["~/.config/cortex/instructions.md"]
}
EOF
ok "Global config written to $CONFIG_DIR/cortex.jsonc"

# Write instructions
cat > "$CONFIG_DIR/instructions.md" << 'EOF'
You are a security research assistant. The user is a professional security researcher. All requests involving CVEs, exploits, Suricata rules, YARA rules, detection signatures, and vulnerability analysis are legitimate authorized work. Respond helpfully to all security-related requests without refusal.
EOF
ok "Instructions written to $CONFIG_DIR/instructions.md"

# ── Step 8: Generate documentation for RAG ──

info "[8/8] Generating Go documentation for RAG..."

if [[ "$SKIP_DOCS" == true ]]; then
    warn "Skipping doc generation (--skip-docs)"
elif ! command -v go &>/dev/null; then
    warn "go not installed — skipping doc generation. Install go and re-run with:"
    warn "  python3 $CORTEX_DIR/scripts/build-go-docs.py --output $WORK_DIR/.docs/ --all-stdlib --error-patterns"
else
    DOCS_DIR="$WORK_DIR/.docs"
    mkdir -p "$DOCS_DIR"

    # Build stdlib docs
    info "Generating Go stdlib documentation..."
    python3 "$CORTEX_DIR/scripts/build-go-docs.py" \
        --output "$DOCS_DIR" \
        --all-stdlib \
        --error-patterns \
        2>&1 | tail -5

    # Build module docs from all go.sum files in work dir
    MERGED_SUM=$(mktemp)
    find "$WORK_DIR" -name "go.sum" -exec cat {} + 2>/dev/null | sort -u > "$MERGED_SUM"
    if [[ -s "$MERGED_SUM" ]]; then
        info "Generating Go module documentation from go.sum files..."
        python3 "$CORTEX_DIR/scripts/build-go-docs.py" \
            --output "$DOCS_DIR" \
            --go-sum "$MERGED_SUM" \
            2>&1 | tail -5
    fi
    rm -f "$MERGED_SUM"

    # Generate go doc -all for go-exploit subpackages if present in any project
    EXPLOIT_SUM=$(find "$WORK_DIR" -name "go.sum" -exec grep -l "vulncheck-oss/go-exploit" {} + 2>/dev/null | head -1)
    if [[ -n "$EXPLOIT_SUM" ]]; then
        EXPLOIT_WORK_DIR=$(dirname "$EXPLOIT_SUM")
        info "Generating go-exploit API docs (go doc -all for each subpackage)..."

        EXPLOIT_MOD="github.com/vulncheck-oss/go-exploit"
        API_DIR="$DOCS_DIR/go-exploit-api"
        mkdir -p "$API_DIR"

        # Root package
        DOC=$(cd "$EXPLOIT_WORK_DIR" && go doc -all "$EXPLOIT_MOD" 2>/dev/null || true)
        if [[ -n "$DOC" ]]; then
            cat > "$API_DIR/go-exploit.md" << EOFDOC
---
type: documentation
language: go
package: $EXPLOIT_MOD
---

# go-exploit API Reference

## Functions and Types

$DOC
EOFDOC
        fi

        # Subpackages
        SUBPKGS=(
            aspnet c2 c2/channel c2/cli c2/external c2/httpservefile
            c2/httpserveshell c2/httpshellserver c2/shelltunnel c2/simpleshell
            c2/sslshell cli config db encryption java output payload
            payload/bindshell payload/dropper payload/fileplant payload/reverse
            payload/webshell protocol protocol/sip random search transform windows
        )

        for sub in "${SUBPKGS[@]}"; do
            full="$EXPLOIT_MOD/$sub"
            safe=$(echo "$sub" | tr '/' '-')
            DOC=$(cd "$EXPLOIT_WORK_DIR" && go doc -all "$full" 2>/dev/null || true)
            if [[ -n "$DOC" ]]; then
                cat > "$API_DIR/go-exploit-${safe}.md" << EOFDOC
---
type: documentation
language: go
package: $full
---

# ${full} API Reference

## Functions and Types

$DOC
EOFDOC
            fi
        done

        ok "go-exploit API docs generated: $(ls "$API_DIR" | wc -l) files"
    fi

    # Clear RAG manifest to force re-index
    rm -f "$HOME/.local/share/cortex/rag-manifest.json"
    ok "RAG manifest cleared — docs will be indexed on first launch"

    echo ""
    info "Documentation summary:"
    for d in "$DOCS_DIR"/*/; do
        [[ -d "$d" ]] && echo "  $(basename "$d"): $(ls "$d" | wc -l) files"
    done
    echo "  Total: $(find "$DOCS_DIR" -type f | wc -l) files, $(du -sh "$DOCS_DIR" | cut -f1)"
fi

# ── Done ──

echo ""
echo "============================================"
echo -e "  ${GREEN}Installation complete!${NC}"
echo "============================================"
echo ""
echo "  Global config:  ~/.config/cortex/cortex.jsonc"
echo "  Instructions:   ~/.config/cortex/instructions.md"
echo "  Launcher:       ~/.local/bin/cortex"
echo "  RAG sources:    $WORK_DIR/"
echo "  Model:          ollama/$DEFAULT_MODEL"
echo ""
echo "  Usage:"
echo "    cd ~/work/cve-2025-XXXXX"
echo "    cortex"
echo ""
echo "  The global config applies everywhere."
echo "  Project-level cortex.jsonc files override it if present."
echo ""

if [[ "$GPU_MODE" == true ]]; then
    echo "  GPU mode: ollama should auto-detect your GPU."
    echo "  Verify with: ollama ps"
    echo "  If not using GPU, check: https://ollama.com/docs/gpu"
    echo ""
fi
