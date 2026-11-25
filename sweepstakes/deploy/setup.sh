#!/usr/bin/env bash
# 懸賞ツール MCP サーバーのサーバー導入スクリプト
# 対象: Oracle Cloud Ampere A1 (aarch64) / Ubuntu 24.04。何度実行しても同じ結果になる (冪等) ように書いている。
#
# 使い方 (リポジトリを clone したサーバー上で):
#   sudo SWEEP_DOMAIN=sweep.example.com ./sweepstakes/deploy/setup.sh
#
# 環境変数:
#   APP_DIR        配置先 (既定 /opt/sweep)。このスクリプトのあるパッケージを rsync でコピーする
#   SWEEP_USER     実行ユーザー (既定 sweep)
#   SWEEP_DOMAIN   指定すると Caddy を導入し /etc/caddy/Caddyfile をこのドメインで生成する
#   OPEN_FIREWALL  1 にすると Ubuntu イメージの iptables に 80/443 の許可を追加して保存する
#   ENABLE_TIMER   1 にすると定期実行 (sweep-run.timer) を有効化する
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "root で実行してください (sudo $0)" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/sweep}"
SWEEP_USER="${SWEEP_USER:-sweep}"
DATA_DIR="$APP_DIR/data"
ENV_DIR=/etc/sweep
ENV_FILE="$ENV_DIR/env"
BROWSERS_DIR="$APP_DIR/ms-playwright"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------------------
log "基本パッケージ"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync openssl fonts-noto-cjk

# ---------------------------------------------------------------------------
log "Node.js 22"
need_node=1
if command -v node >/dev/null 2>&1; then
  ver="$(node -p 'process.versions.node')"
  major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
  if (( major > 22 || (major == 22 && minor >= 13) )); then need_node=0; fi
fi
if (( need_node )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

# ---------------------------------------------------------------------------
log "専用ユーザー $SWEEP_USER"
if ! id -u "$SWEEP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SWEEP_USER"
fi

# ---------------------------------------------------------------------------
log "アプリを $APP_DIR に配置"
mkdir -p "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude ms-playwright --exclude profile.json --exclude '*.log' \
    "$SRC_DIR"/ "$APP_DIR"/
fi
# アプリ本体は root 所有 (実行ユーザーからは読み取り専用)。data/ は実行ユーザー所有のまま触らない
find "$APP_DIR" -path "$DATA_DIR" -prune -o -exec chown root:root {} + -exec chmod go-w {} +

log "npm ci"
cd "$APP_DIR"
npm ci --no-audit --no-fund

log "Playwright の Chromium と依存ライブラリ ($BROWSERS_DIR)"
npx playwright install --with-deps chromium
chmod -R a+rX "$BROWSERS_DIR"

# ---------------------------------------------------------------------------
log "データディレクトリ $DATA_DIR"
install -d -m 0700 -o "$SWEEP_USER" -g "$SWEEP_USER" "$DATA_DIR" "$DATA_DIR/screenshots"

log "環境変数ファイル $ENV_FILE"
install -d -m 0750 -o root -g "$SWEEP_USER" "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  token="$(openssl rand -hex 32)"
  sed -e "s|^SWEEP_MCP_TOKEN=.*|SWEEP_MCP_TOKEN=$token|" \
      -e "s|/opt/sweep|$APP_DIR|g" \
      "$APP_DIR/deploy/env.example" > "$ENV_FILE"
  echo "SWEEP_MCP_TOKEN を新規生成しました (表示: sudo grep SWEEP_MCP_TOKEN $ENV_FILE)"
else
  echo "既存の $ENV_FILE を使います (上書きしません)"
fi
chown root:"$SWEEP_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

# ---------------------------------------------------------------------------
log "systemd ユニット"
for unit in sweep-mcp.service sweep-run.service sweep-run.timer; do
  sed -e "s|/opt/sweep|$APP_DIR|g" -e "s|^User=sweep|User=$SWEEP_USER|" -e "s|^Group=sweep|Group=$SWEEP_USER|" \
    "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
done
chmod 0755 "$APP_DIR/deploy/sweep-run.sh"
systemctl daemon-reload
systemctl enable sweep-mcp.service
systemctl restart sweep-mcp.service
if [[ "${ENABLE_TIMER:-0}" == "1" ]]; then
  systemctl enable --now sweep-run.timer
else
  echo "定期実行を有効にするには: sudo systemctl enable --now sweep-run.timer"
fi

# ---------------------------------------------------------------------------
if [[ -n "${SWEEP_DOMAIN:-}" ]]; then
  log "Caddy ($SWEEP_DOMAIN)"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y caddy
  fi
  sed -e "s|sweep.example.com|$SWEEP_DOMAIN|g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile.new
  if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile 2>/dev/null; then
    [[ -f /etc/caddy/Caddyfile ]] && cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig || true
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  else
    rm -f /etc/caddy/Caddyfile.new
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable caddy
  systemctl reload-or-restart caddy
fi

# ---------------------------------------------------------------------------
if [[ "${OPEN_FIREWALL:-0}" == "1" ]]; then
  log "iptables で 80/443 を許可"
  apt-get install -y iptables-persistent
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      # Oracle の Ubuntu イメージは INPUT の末尾近くに REJECT があるので、その前に挿入する
      reject_line="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
      if [[ -n "$reject_line" ]]; then
        iptables -I INPUT "$reject_line" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      else
        iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      fi
    fi
  done
  netfilter-persistent save
fi

log "完了"
echo "状態確認: systemctl status sweep-mcp / curl -s http://127.0.0.1:8787/healthz"
echo "プロフィール: Muse から update_profile で登録するか、$DATA_DIR/profile.json を作成 (所有者 $SWEEP_USER, 0600)"
