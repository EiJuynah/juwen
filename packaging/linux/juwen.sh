#!/bin/sh
# ============================================================================
#  juwen 启动器（Linux）
#
#  行为：
#    1. 应用目录 = 本脚本所在目录；安装后为 /opt/juwen。
#       若本脚本被复制/链接到别处（例如 /usr/bin/juwen），而旁边没有
#       server/index.js，则回落到 /opt/juwen。
#    2. 数据根目录 = ${XDG_DATA_HOME:-$HOME/.local/share}/juwen。
#       首次运行创建 <数据根>/data，并把 .env.example 复制成 <数据根>/.env；
#       dotenv 按 **当前工作目录** 读 .env，所以这里 cd 到数据根。
#    3. 优先用 <应用目录>/runtime/node，没有就回落 PATH 上的 node。
#
#  ★ 卸载不会删除数据目录：批注、文档与 .env 都留在 $HOME/.local/share/juwen。
# ============================================================================
set -eu

# ── 解析自身真实路径（兼容软链 / 从 /usr/bin 启动）
SELF=$0
if command -v readlink >/dev/null 2>&1; then
  RESOLVED=$(readlink -f "$SELF" 2>/dev/null || true)
  if [ -n "${RESOLVED:-}" ]; then SELF=$RESOLVED; fi
fi
APP_DIR=$(cd "$(dirname "$SELF")" && pwd)

# 旁边没有应用本体时（例如被装到 /usr/bin），回落到标准安装目录
if [ ! -f "$APP_DIR/server/index.js" ] && [ -f /opt/juwen/server/index.js ]; then
  APP_DIR=/opt/juwen
fi

# ── 数据根目录
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/juwen"
mkdir -p "$DATA_ROOT/data"

# ── 首次运行：复制配置文件（已存在则不覆盖）
if [ ! -f "$DATA_ROOT/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
  cp "$APP_DIR/.env.example" "$DATA_ROOT/.env"
fi

# ── 端口
PORT="${PORT:-5178}"

# ── 内置运行时
NODE_BIN="$APP_DIR/runtime/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[juwen] 未找到内置运行时，改用系统 Node"
  NODE_BIN=node
fi

echo "[juwen] 应用目录：$APP_DIR"
echo "[juwen] 数据目录：$DATA_ROOT"
echo "[juwen] 配置文件：$DATA_ROOT/.env（API Key 填在这里）"
echo "[juwen] 访问地址：http://localhost:$PORT"
echo "[juwen] 按 Ctrl+C 退出"
echo

# ── 约 1.5 秒后自动打开浏览器（没有 xdg-open 就只打印地址）
#    设 JUWEN_NO_BROWSER=1 可跳过自动打开（CI / 无人值守自检用，默认行为不变）
if [ -n "${JUWEN_NO_BROWSER:-}" ]; then
  echo "[juwen] 已跳过自动打开浏览器（JUWEN_NO_BROWSER 已设置）"
elif command -v xdg-open >/dev/null 2>&1; then
  ( sleep 1.5; xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || true ) &
else
  echo "[juwen] 未找到 xdg-open，请手动打开 http://localhost:$PORT"
fi

# ── 以数据根为 cwd 启动服务（DATA_DIR 落在数据根下）
cd "$DATA_ROOT"
export DATA_DIR="$DATA_ROOT/data"
export PORT
exec "$NODE_BIN" "$APP_DIR/server/index.js"
