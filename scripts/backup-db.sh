#!/bin/bash
# 拼豆店数据库自动备份
# 每天执行，pg_dump 全量备份 + gzip 压缩，保留 30 天
set -euo pipefail

BACKUP_DIR=/opt/pindou-backup
KEEP_DAYS=30
DB_NAME=pindou

mkdir -p "$BACKUP_DIR"

STAMP=$(date +%F_%H%M%S)
FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

# 用 peer 认证（root 切 postgres），不需要密码，也不会把密码写进脚本
if ! sudo -u postgres pg_dump "$DB_NAME" 2>/dev/null | gzip > "$FILE"; then
  echo "$(date '+%F %T') [失败] pg_dump 执行出错" >> "$BACKUP_DIR/backup.log"
  rm -f "$FILE"
  exit 1
fi

# 校验：文件必须存在且非空，否则视为失败
if [ ! -s "$FILE" ]; then
  echo "$(date '+%F %T') [失败] 备份文件为空" >> "$BACKUP_DIR/backup.log"
  rm -f "$FILE"
  exit 1
fi

# 清理超过保留期的旧备份
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete

SIZE=$(du -h "$FILE" | cut -f1)
COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" | wc -l)
echo "$(date '+%F %T') [成功] $FILE ($SIZE) 现有备份 $COUNT 份" >> "$BACKUP_DIR/backup.log"
