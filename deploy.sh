#!/usr/bin/env bash
# deploy.sh — Deploy ariyankhan.com to the live FTP server (Mac / Linux / Git Bash)
#
# Usage:
#   bash deploy.sh                        # deploy all site files
#   bash deploy.sh index.html             # deploy one file
#   bash deploy.sh index.html about.html  # deploy multiple files
#   bash deploy.sh --dry-run              # preview only

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
FILES=()

for arg in "$@"; do
    [[ "$arg" == "--dry-run" ]] && DRY_RUN=true || FILES+=("$arg")
done

# ── Colours ───────────────────────────────────────────────────────────────────
G='\033[0;32m' Y='\033[0;33m' R='\033[0;31m' D='\033[0;90m' E='\033[0m'

# ── Load .env ─────────────────────────────────────────────────────────────────
ENV="$ROOT/.env"
[[ -f "$ENV" ]] || { echo "ERROR: .env not found. Copy .env.example to .env and add your credentials."; exit 1; }
set -o allexport; source "$ENV"; set +o allexport

# ── Skip list ─────────────────────────────────────────────────────────────────
SKIP=(deploy.ps1 deploy.sh .env .env.example .gitignore ftp_download.ps1 .git .claude .deploy-cache .DS_Store Thumbs.db mail-config.local.php)

should_skip() {
    local top="${1%%/*}"
    for s in "${SKIP[@]}"; do [[ "$top" == "$s" ]] && return 0; done
    return 1
}

# ── Resolve target files ──────────────────────────────────────────────────────
if [[ ${#FILES[@]} -gt 0 ]]; then
    TARGETS=("${FILES[@]}")
else
    mapfile -t TARGETS < <(
        find "$ROOT" -type f | sed "s|$ROOT/||" | sort | while IFS= read -r f; do
            should_skip "$f" || echo "$f"
        done
    )
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
OK=0; FAIL=0

echo ""
echo -e "  ${Y}ariyankhan.com$([ "$DRY_RUN" = true ] && echo ' [DRY RUN]')${E}"
echo -e "  ${D}${FTP_HOST}${FTP_REMOTE_DIR}${E}"
echo ""

for rel in "${TARGETS[@]}"; do
    remote="ftp://${FTP_HOST}${FTP_REMOTE_DIR}/${rel}"

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${D}- $rel${E}"; continue
    fi

    if curl -s -S --ftp-ssl -k --ftp-create-dirs \
           -u "${FTP_USER}:${FTP_PASS}" \
           -T "$ROOT/$rel" "$remote" 2>/dev/null; then
        echo -e "  ${G}v $rel${E}"; OK=$((OK+1))
    else
        echo -e "  ${R}x $rel${E}"; FAIL=$((FAIL+1))
    fi
done

echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${Y}Dry run — ${#TARGETS[@]} file(s) would be uploaded.${E}"
elif [[ $FAIL -gt 0 ]]; then
    echo -e "  ${R}Done — $OK uploaded, $FAIL failed.${E}"
else
    echo -e "  ${G}Done — $OK file(s) uploaded.${E}"
fi
echo ""
