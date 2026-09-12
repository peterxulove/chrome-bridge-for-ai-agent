#!/usr/bin/env bash
# 确保 Chrome Bridge 桥接服务在后台运行（幂等：已在跑就直接返回）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CB_PORT:-8777}"
LOG="${CB_LOG:-/tmp/chrome-bridge.log}"
NODE_BIN="${CB_NODE:-$(command -v node)}"

if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node" /opt/homebrew/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
[ -z "$NODE_BIN" ] && { echo "找不到 node，可用 CB_NODE=/path/to/node 指定"; exit 1; }

if curl -s --noproxy '*' -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "桥接服务已在运行 (127.0.0.1:$PORT)"
  exit 0
fi

echo "启动桥接服务… (日志: $LOG)"
CB_PORT="$PORT" nohup "$NODE_BIN" "$HERE/scripts/bridge.mjs" >> "$LOG" 2>&1 &
disown 2>/dev/null || true

for _ in $(seq 1 20); do
  sleep 0.3
  if curl -s --noproxy '*' -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "已就绪 → http://127.0.0.1:$PORT"
    exit 0
  fi
done

echo "启动失败，看看日志：tail -30 $LOG"
exit 1
