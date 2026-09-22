#!/usr/bin/env bash
# 生成 GitHub Release 说明。
# 优先取 CHANGELOG.md 里对应的 "## vX.Y.Z" 小节（发版前由人工/AI 拟写），
# 没有该小节时退回「相较上一个 v* 标签的提交记录」。
# 用法：release-notes.sh <版本号> [输出文件]
set -euo pipefail

VER="${1:?用法: release-notes.sh <版本号> [输出文件]}"
OUT="${2:-RELEASE_NOTES.md}"
TAG="v$VER"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

section() {
  [ -f "$ROOT/CHANGELOG.md" ] || return 0
  awk -v tag="$TAG" '
    /^## / { if (inb) exit; sub(/^## /, ""); sub(/[[:space:]].*$/, ""); inb = ($0 == tag); next }
    inb { print }
  ' "$ROOT/CHANGELOG.md"
}

from_log() {
  git -C "$ROOT" fetch --quiet --tags origin 2>/dev/null || true
  local prev range
  prev="$(git -C "$ROOT" tag --sort=-v:refname --merged HEAD 2>/dev/null | grep -E '^v[0-9]' | grep -vx "$TAG" | head -1 || true)"
  range="${prev:+$prev..HEAD}"
  range="${range:-HEAD}"
  echo "相较 ${prev:-初始版本} 的改动："
  echo
  git -C "$ROOT" log --no-merges --pretty=format:'- %s (%h)' $range | head -80
  echo
}

{
  echo "$TAG"
  echo
  body="$(section)"
  if [ -n "$body" ]; then
    echo "$body"
  else
    from_log
  fi
  echo
  echo "Android 装 APK 即可；鸿蒙 HAP 未签名，需自行签名后安装。"
} > "$OUT"

cat "$OUT"
