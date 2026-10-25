#!/bin/bash
# 分批提交并推送大目录（每批默认 90 个文件，避免单次 push 过大被 408/断连）
# 用法: push_batches.sh <repo 路径> [子目录=html] [每批文件数=90]
set -u
REPO="${1:?用法: push_batches.sh <repo> [dir] [batch]}"
DIR="${2:-html}"
BATCH="${3:-90}"
cd "$REPO" || exit 1
LIST="/tmp/_push_list.$$"
git status --porcelain | awk '{print $2}' | grep -E "^${DIR}/.*\.(html|csv)$" | sort > "$LIST"
TOTAL=$(wc -l < "$LIST" | tr -d ' ')
echo "待推送 $TOTAL 个文件"
i=0
while [ "$i" -lt "$TOTAL" ]; do
  sed -n "$((i+1)),$((i+BATCH))p" "$LIST" > "${LIST}.chunk"
  N=$(wc -l < "${LIST}.chunk" | tr -d ' ')
  git add -- $(cat "${LIST}.chunk") || exit 1
  git commit -qm "${DIR} 批次 $((i+1))-$((i+N))" || true
  OK=0
  for try in 1 2 3; do
    if git push origin HEAD; then OK=1; break; fi
    echo "push 失败，30 秒后重试 ($try)"; sleep 30
  done
  [ "$OK" -eq 1 ] || { echo "推送失败，停在 $i"; exit 1; }
  echo "已推送 $((i+N))/$TOTAL"
  i=$((i+BATCH))
done
rm -f "$LIST" "${LIST}.chunk"
echo "全部推送完成"
