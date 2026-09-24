#!/usr/bin/env bash
# 本机签好鸿蒙包并传到 Release（主名 reunion-vX.hap）。
# CI 只能出未签名包 —— 受限权限（READ/WRITE_WHOLE_CALENDAR）的授权载体是签名 profile，
# 私钥不能上 GitHub，所以最后一步在本机做。
#
#   bash scripts/hap-sign-local.sh              # 取最近一次鸿蒙 CI 的未签名产物
#   bash scripts/hap-sign-local.sh path/to.hap  # 用指定的未签名 HAP
#
# 签名材料和口令放在仓库外的 ~/.hap-sign.env（或 HAP_SIGN_ENV 指定的文件）：
#   HAP_JAVA HAP_SIGNTOOL HAP_P12 HAP_CER HAP_P7B HAP_KEY_ALIAS HAP_KEYSTORE_PWD HAP_KEY_PWD
# 口令那两行留空也行：脚本会自己去本机签名配置（HAP_SIGN_CONFIG，默认
# Documents/hap_installer/signConfig.json）里取，只读进内存、不打印也不入库。
#
# 每次签完会清理 .ci-dl 里的旧构建：只留最近 HAP_KEEP_VERSIONS（默认 3）个版本号的
# reunion-v* 产物，更早的删掉。GitHub 上的 Release 不在这脚本动手范围内。
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${HAP_SIGN_ENV:-$HOME/.hap-sign.env}"
[ -f "$ENV_FILE" ] || { echo "找不到签名配置：$ENV_FILE（口令不入库，需要新建）"; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
HAP_JAVA="${HAP_JAVA:-$HOME/dev/jdk-17/bin/java}"
HAP_SIGNTOOL="${HAP_SIGNTOOL:-$HOME/dev/ohos-sign-tool/hap-sign-tool.jar}"
HAP_KEY_ALIAS="${HAP_KEY_ALIAS:-xiaobai}"
# 口令留空就直接取本机现成的签名配置（只读进变量，不打印、不入库）
CFG="${HAP_SIGN_CONFIG:-$HOME/Documents/hap_installer/signConfig.json}"
pick() { node -e 'const c=require(process.argv[1]);const k=process.argv[2].split(",").find((x)=>c[x]);process.stdout.write(k?String(c[k]):"");' "$CFG" "$1"; }
if [ -f "$CFG" ]; then
  HAP_KEYSTORE_PWD="${HAP_KEYSTORE_PWD:-$(pick keystorePwd,keyPwd)}"
  HAP_KEY_PWD="${HAP_KEY_PWD:-$(pick keyPwd,keystorePwd)}"
fi
for v in HAP_P12 HAP_CER HAP_P7B HAP_KEYSTORE_PWD HAP_KEY_PWD; do
  [ -n "${!v:-}" ] || { echo "$ENV_FILE 里缺 $v"; exit 1; }
done
for f in HAP_JAVA HAP_SIGNTOOL HAP_P12 HAP_CER HAP_P7B; do
  [ -e "${!f}" ] || { echo "$f 指向的文件不存在：${!f}"; exit 1; }
done

VER=$(sed -n "s/^const APP_VERSION *= *'\([0-9.]*\)'.*/\1/p" public/app.js | head -1)
test -n "$VER" || { echo "解析 APP_VERSION 失败"; exit 1; }
ART_DIR=".ci-dl"
mkdir -p "$ART_DIR"
OUT="$ART_DIR/reunion-v$VER-signed.hap"

# 旧构建按版本号清理：文件名里的 reunion-v<版本> 就是分组依据
prune_old_builds() {
  keep="${HAP_KEEP_VERSIONS:-3}"
  local vers keepre f v
  # 版本号后面可能直接接后缀（-signed / -unsigned / -readwhole-experimental），也可能就是 .hap
  vers=$(ls -1 "$ART_DIR" 2>/dev/null | sed -n 's/^reunion-v\([0-9][0-9.]*\)[.-].*/\1/p' | sort -uVr | head -"$keep")
  [ -n "$vers" ] || return 0
  keepre="|$(echo "$vers" | paste -sd'|' -)|"
  for f in "$ART_DIR"/reunion-v*.hap "$ART_DIR"/reunion-v*.apk; do
    [ -e "$f" ] || continue
    v=$(basename "$f" | sed -n 's/^reunion-v\([0-9][0-9.]*\)[.-].*/\1/p')
    case "$keepre" in *"|$v|"*) continue ;; esac
    rm -f -- "$f" && echo "清理旧构建：$f"
  done
}

IN="${1:-}"
if [ -z "$IN" ]; then
  echo "取最近一次鸿蒙 CI 产物…"
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  RUN=$(gh api "repos/$REPO/actions/workflows/harmony.yml/runs?per_page=1" -q '.workflow_runs[0].id')
  # archive:false 上传的产物 zip 内容就是 HAP 本身，别用 gh run download（它会再解一层）
  ART=$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" -q ".artifacts[] | select(.name==\"timemaster-unsigned.hap\") | .id" | head -1)
  test -n "$ART" || { echo "运行 $RUN 里没有 timemaster-unsigned.hap 产物"; exit 1; }
  echo "CI run $RUN / artifact $ART"
  IN="$ART_DIR/reunion-v$VER-unsigned.hap"
  gh api "repos/$REPO/actions/artifacts/$ART/zip" > "$IN"
fi

# profile 里的 allowed-acls 决定受限权限给不给，签之前先看一眼
if command -v openssl >/dev/null 2>&1; then
  if ! openssl smime -verify -noverify -inform DER -in "$HAP_P7B" 2>/dev/null | grep -q WHOLE_CALENDAR; then
    echo "::warning::profile 的 allowed-acls 里没有 WHOLE_CALENDAR，装上去读不到全部日历"
  fi
fi

"$HAP_JAVA" -jar "$HAP_SIGNTOOL" sign-app -mode localSign \
  -keyAlias "$HAP_KEY_ALIAS" -keyPwd "$HAP_KEY_PWD" \
  -keystoreFile "$HAP_P12" -keystorePwd "$HAP_KEYSTORE_PWD" \
  -appCertFile "$HAP_CER" -profileFile "$HAP_P7B" \
  -inFile "$IN" -outFile "$OUT" \
  -signAlg SHA256withECDSA -compatibleVersion 20

"$HAP_JAVA" -jar "$HAP_SIGNTOOL" verify-app -inFile "$OUT" \
  -outCertChain "$ART_DIR/verify-certchain.cer" -outProfile "$ART_DIR/verify-profile.p7b"
echo "已签名并校验通过：$OUT"

# 签成功才清理，中途失败时旧产物还得留着排查
prune_old_builds

# 只有人在终端里敲着跑才可能上传；管道/CI 里跑一律只出本地产物
if [ ! -t 0 ]; then
  echo "非交互运行：不上传，产物留在 $OUT"
  exit 0
fi
read -r -p "把它作为 reunion-v$VER.hap 传到 GitHub Release v$VER？[y/N] " OK
[ "$OK" = "y" ] || { echo "没上传，产物留在 $OUT"; exit 0; }
cp "$OUT" "$ART_DIR/reunion-v$VER.hap"
gh release upload "v$VER" "$ART_DIR/reunion-v$VER.hap" --clobber
