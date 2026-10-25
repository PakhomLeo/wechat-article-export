---
name: wechat-article-export
description: 批量导出微信公众号文章为整页 HTML（文件名 entry_id.html）并推送到 GitHub 存档仓库。适用于用户给出包含 entry_id、文章名称、链接（长链或短链）的清单，要求“抓取/补抓/归档公众号文章”“整页 HTML”“传到 GitHub”，或提到 wechat-article-archive 仓库时。短链直接抓；长链需通过微信桌面端「文件传输助手」转成短链后再抓。
---

# 微信文章批量导出

## 前置条件（缺一不可）

1. 微信已登录，主窗口停在「文件传输助手」聊天，运行中不要动鼠标键盘。
2. Computer Use 运行时可用；socket 缺失时先在 node_repl 里创建一次：
   `var cua = await (await import('@qoder-space/computer-use')).ComputerUse.createAppClient();`
3. `gh auth status` 正常，目标仓库一般用私有仓库 `PakhomLeo/wechat-article-archive`。
   本地没有副本时先 `gh repo clone PakhomLeo/wechat-article-archive`（仓库较大，可用 `-- --filter=blob:none` 后再按需 checkout）。
4. 运行 harvest 时设 `QODER_CU_BINARY_PATH="$HOME/.qoder-cn/bin/qoder-cn-computer-use/Qoder CN Computer Use.app"`，
   运行时掉线后重启进程会自动拉起。

## 输出约定

- `REPO/html/<entry_id>.html`：整页页面源码，文件名用 entry_id。
- `REPO/html/_manifest-<批次名>.csv`：entry_id、类型、文章名称、链接、状态、文件。
- 不额外生成文件夹结构；图片保持页面里的远程地址。

## 流程

设 `LIST=清单.csv`、`STATE=work/<批次名>`、`REPO=<仓库路径>`。

```bash
SK=<技能目录>/scripts

# 1. 建计划：分桶，生成微信表和待抓列表
python3 $SK/export.py plan --list "$LIST" --repo "$REPO" --state "$STATE" \
  --shortlinks <已有短链.jsonl>... --dead <dead.jsonl>...

# 2. 有短链的直接抓（3 并发，自动重试）
python3 $SK/export.py fetch --state "$STATE" --repo "$REPO" --workers 3

# 3. 长链走微信转短链（只在有待抓项时；约 25–30 秒/条）
QODER_HOME="$HOME/.qoder-cn" \
QODER_CU_BINARY_PATH="$HOME/.qoder-cn/bin/qoder-cn-computer-use/Qoder CN Computer Use.app" \
caffeinate -dims node $SK/harvest.mjs --table "$STATE/wechat-table.txt" \
  --out "$STATE/shortlinks.jsonl" --fail "$STATE/failures.jsonl" --dead <dead.jsonl>

# 4. 合并新短链后再抓
python3 $SK/export.py collect --state "$STATE" --shortlinks "$STATE/shortlinks.jsonl"
python3 $SK/export.py fetch --state "$STATE" --repo "$REPO"

# 5. 清单 + 推送（分批，约 90 个/次）
python3 $SK/export.py manifest --list "$LIST" --state "$STATE" --repo "$REPO" --name <批次名>
bash $SK/push_batches.sh "$REPO" html 90
```

`plan` 会打印分桶结果；`status` 可随时查看进度；`manifest` 会打印各状态计数。

## 判定规则（务必照此，别误判）

- 成功页面：含 `id="js_content"`（普通文章）或 `content_noencode`（小绿书图文）。两者都算成功。
- `<200KB` 的响应（常见 17KB）是风控页，**退避重试**，不要判死。
- `该内容已被发布者删除` → dead。
- `此账号已自主注销` → dead（账号注销）。
- 2.6MB 左右、只有“使用完整服务”的空壳 → no_content（需微信内打开）；先检查是否漏了小绿书。
- harvest 取不到链接（`copy link failed`）只试一次，写 dead.jsonl 后跳过。

## 验证

- 清单行数 = 输入 CSV 行数；有文件数 + 各 dead/no_content = 总数。
- 推送后对比：`git rev-parse HEAD` 与 `git ls-remote origin main` 一致，`git status` 干净。

## 环境备忘

- 微信浅色/深色主题都支持（判据是发送按钮绿色与否、菜单行反差）。
- 微信长时间运行后可能 AX 无响应（System Events 报 0 窗口）：退出并重开微信，按手机确认登录。
- 合盖会休眠，`caffeinate` 拦不住；长任务要插电并保持开盖。
