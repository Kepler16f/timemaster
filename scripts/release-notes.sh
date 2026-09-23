#!/usr/bin/env bash
# 生成 GitHub Release 说明。
# 取 CHANGELOG.md 里「比上一个已发布标签新」的所有小节（发版前由人工/AI 拟写）——
# 跨过几个版本补发一次时，中间几版的内容也会一起带上，读者看到的才是完整的相较说明。
# 一个小节都没有时退回「相较上一个 v* 标签的提交记录」。
# 用法：release-notes.sh <版本号> [输出文件]
set -euo pipefail

VER="${1:?用法: release-notes.sh <版本号> [输出文件]}"
OUT="${2:-RELEASE_NOTES.md}"
TAG="v$VER"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

section() { # section <vX.Y.Z>
  [ -f "$ROOT/CHANGELOG.md" ] || return 0
  awk -v tag="$1" '
    /^## / { if (inb) exit; sub(/^## /, ""); sub(/[[:space:]].*$/, ""); inb = ($0 == tag); next }
    inb { print }
  ' "$ROOT/CHANGELOG.md"
}

prev_tag() { # 仓库上已有的最新标签 = 上一个真正发布过的版本
  git -C "$ROOT" fetch --quiet --tags origin 2>/dev/null || true
  git -C "$ROOT" ls-remote --tags origin 'refs/tags/v*' 2>/dev/null \
    | awk '{print $2}' | sed 's|refs/tags/||' | grep -E '^v[0-9]' | grep -vx "$TAG" \
    | sort -V | tail -1 || true
}

# CHANGELOG 自上而下排到 prev_tag 为止，就是要写进说明的所有版本
newer_sections() {
  local stop="$1"
  [ -f "$ROOT/CHANGELOG.md" ] || return 0
  awk -v stop="$stop" '
    /^## / {
      h = $0; sub(/^## /, "", h); sub(/[[:space:]].*$/, "", h)
      if (h == stop) exit
      print h
    }
  ' "$ROOT/CHANGELOG.md" | head -8
}

from_log() {
  local prev range
  prev="${PREV:-$(git -C "$ROOT" tag --sort=-v:refname --merged HEAD 2>/dev/null | grep -E '^v[0-9]' | grep -vx "$TAG" | head -1 || true)}"
  range="${prev:+$prev..HEAD}"
  range="${range:-HEAD}"
  echo "相较 ${prev:-初始版本} 的改动："
  echo
  git -C "$ROOT" log --no-merges --pretty=format:'- %s (%h)' $range | head -80
  echo
}

PREV="$(prev_tag)"
body=""
if [ -n "$PREV" ]; then
  for s in $(newer_sections "$PREV"); do
    sec="$(section "$s")"
    [ -n "$sec" ] || continue
    if [ -n "$sec" ]; then
      body+="## $s"$'\n\n'"$sec"$'\n\n'
    fi
  done
else
  sec="$(section "$TAG")"
  [ -n "$sec" ] && body="## $TAG"$'\n\n'"$sec"$'\n'
fi

{
  if [ -n "$body" ]; then
    echo "$body"
  else
    echo "$TAG"
    echo
    from_log
  fi
  echo
  echo "Android 装 APK 即可；鸿蒙 HAP 未签名，需自行签名后安装。"
} > "$OUT"

cat "$OUT"
