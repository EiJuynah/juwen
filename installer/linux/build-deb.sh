#!/usr/bin/env bash
# ============================================================================
#  用 staging 目录打一个 .deb（在 ubuntu runner 上跑；本机没有 dpkg-deb）
#
#  用法：installer/linux/build-deb.sh <staging> <version> <outdir>
#  产出：<outdir>/juwen_<version>_amd64.deb
#
#  包内布局：
#    /opt/juwen/**                     ← staging 全部内容（含内置 runtime/node）
#    /usr/bin/juwen                    ← 启动器副本（旁边没有应用本体时回落 /opt/juwen）
#    /usr/share/applications/juwen.desktop
#    /DEBIAN/control
#
#  ★ 卸载（dpkg -r juwen）不会动用户数据目录 ${XDG_DATA_HOME:-~/.local/share}/juwen。
# ============================================================================
set -euo pipefail

STAGE=${1:?用法: build-deb.sh <staging> <version> <outdir>}
VER=${2:?缺少 version}
OUT=${3:?缺少 outdir}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STAGE=$(cd "$STAGE" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

PKGROOT=$(mktemp -d)
trap 'rm -rf "$PKGROOT"' EXIT

mkdir -p "$PKGROOT/DEBIAN" \
         "$PKGROOT/opt/juwen" \
         "$PKGROOT/usr/bin" \
         "$PKGROOT/usr/share/applications"

# ── 应用本体
cp -a "$STAGE/." "$PKGROOT/opt/juwen/"

# ── 权限：目录 755、文件 644、可执行文件 755
find "$PKGROOT/opt/juwen" -type d -exec chmod 755 {} +
find "$PKGROOT/opt/juwen" -type f -exec chmod 644 {} +
chmod 755 "$PKGROOT/opt/juwen/juwen.sh"
[ -f "$PKGROOT/opt/juwen/runtime/node" ] && chmod 755 "$PKGROOT/opt/juwen/runtime/node"
[ -f "$PKGROOT/opt/juwen/runtime/LICENSE" ] && chmod 644 "$PKGROOT/opt/juwen/runtime/LICENSE"

# ── /usr/bin/juwen：启动器副本（与 /opt/juwen/juwen.sh 字节相同；
#    它自己会在「旁边没有 server/index.js」时回落到 /opt/juwen）
install -m 0755 "$SCRIPT_DIR/usr-bin-juwen" "$PKGROOT/usr/bin/juwen"
install -m 0644 "$SCRIPT_DIR/juwen.desktop" "$PKGROOT/usr/share/applications/juwen.desktop"

# ── control（Description 首行是简短摘要，后续行以单个空格开头，空行写作 " ."）
INSTALLED_KB=$(du -sk "$PKGROOT" | cut -f1)
cat > "$PKGROOT/DEBIAN/control" <<EOF
Package: juwen
Version: ${VER}
Architecture: amd64
Maintainer: Yujie <hanyujie2269@163.com>
Section: utils
Priority: optional
Recommends: xdg-utils
Installed-Size: ${INSTALLED_KB}
Description: juwen - 智能解读工作台
 上传一份文件、划出看不懂的地方，由 AI 讲明白，并可追问。
 解释强制标注依据段落，可回查原文；数据与 API Key 全部留在本机。
 .
 安装后可从应用菜单启动，或直接执行 juwen；卸载不会删除数据目录。
EOF

# ── 打包（--root-owner-group 让包内文件归属 root:root，CI 上无需 fakeroot）
dpkg-deb --build --root-owner-group "$PKGROOT" "$OUT/juwen_${VER}_amd64.deb"
echo "[build-deb] 已产出 $OUT/juwen_${VER}_amd64.deb"
