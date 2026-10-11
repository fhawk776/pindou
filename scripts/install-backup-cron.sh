#!/bin/bash
# 安装数据库备份定时任务（幂等：已存在则不重复添加，保留其他 crontab 条目）
set -euo pipefail

CRON_LINE="0 3 * * * /opt/pindou-backup/backup.sh"

EXISTING=$(crontab -l 2>/dev/null || true)

if echo "$EXISTING" | grep -qF "/opt/pindou-backup/backup.sh"; then
  echo "备份定时任务已存在，跳过添加"
else
  {
    echo "$EXISTING"
    echo "# 拼豆店数据库每日备份（凌晨 3 点）"
    echo "$CRON_LINE"
  } | grep -v '^$' | crontab -
  echo "✓ 备份定时任务已添加"
fi

echo ""
echo "===== 当前完整 crontab ====="
crontab -l
