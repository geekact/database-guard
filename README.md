# db-backup

数据库备份与还原工具，当前支持 MySQL。

## 安装

```bash
npm install -g db-backup
# 或
pnpm add -g db-backup
```

也可不安装，直接用 `npx` 运行。

## 用法

先在项目根目录准备 `db-backup.yaml`，再执行对应命令：

```bash
# 数据库备份（默认读取 ./db-backup.yaml）
npx --no-install backup-db
npx --no-install backup-db ./my-config.yml

# binlog 备份
npx --no-install backup-binlog
npx --no-install backup-binlog ./my-config.yml

# 数据库还原
npx --no-install restore-db
npx --no-install restore-db ./my-config.yml

# 还原时可覆盖账号密码（默认值为配置文件中的账号）
npx --no-install restore-db -u restore_user -p 'secret'
npx --no-install restore-db --username restore_user --password 'secret'
```

查看帮助或版本：

```bash
npx --no-install backup-db --help
npx --no-install restore-db --help
```

## 定时任务（crontab）

先全局安装，再编辑 crontab：

```bash
npm install -g db-backup
crontab -e
```

示例：

```cron
# 每天凌晨 3 点备份数据库
0 3 * * * npx backup-db >> /var/log/backup-db.log 2>&1

# 每小时备份 binlog
0 * * * * npx backup-binlog >> /var/log/backup-binlog.log 2>&1
```

## 配置

配置文件为 YAML，示例如下：

```yaml
database:
  driver: mysql # 目前仅支持 mysql
  host: 127.0.0.1 # 主机地址
  port: 3306 # 端口
  username: root # 用户名
  password: secret # 密码
  database: db1,db2,db3 # 数据库名，多个用逗号分隔

# 可选：系统相关
# system:
#   # sudo: true # 是否使用 sudo 执行命令，默认 true
#   # docker_container_name: my-db # 可选，数据库在 docker 容器内时填写容器名

# 本地备份
destination_local:
  dir: ./db-backup
  keep_days: 7

# 可选：同时上传到 AWS S3
# destination_aws_s3:
#   access_key: YOUR_ACCESS_KEY # AWS Access Key
#   secret_key: YOUR_SECRET_KEY # AWS Secret Key
#   region: ap-northeast-1 # 区域
#   bucket: my-backup-bucket # Bucket 名称
#   # endpoint: https://endpoint # 可选，与ES2同一区域时建议设置为内网地址，免流量费
#   # dir: mysql-backup # 可选，对象目录前缀
```

## MySQL 账号权限

不建议用业务账号直接操作备份。可为备份/还原单独建用户，并按用途授权。

### 全量备份（`backup-db`）

只备份表、视图与数据（不含触发器、事件、存储过程/函数）。目标库上至少需要：

| 权限                 | 用途                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `SELECT`             | 导出表数据                                                              |
| `SHOW VIEW`          | 导出视图                                                                |
| `LOCK TABLES`        | dump 锁表相关                                                           |
| `RELOAD`             | 配合 `--single-transaction` 一致性快照                                  |
| `PROCESS`            | 部分服务器状态读取                                                      |
| `REPLICATION CLIENT` | `--source-data` 读取 binlog 位点（MySQL 8.0.22+ 可用 `BINLOG MONITOR`） |

示例（把 `backup_db` 换成实际库名）：

```sql
CREATE USER 'backup_user'@'%' IDENTIFIED BY 'strong-password';

GRANT SELECT, SHOW VIEW, LOCK TABLES ON backup_db.* TO 'backup_user'@'%';

GRANT RELOAD, PROCESS, REPLICATION CLIENT ON *.* TO 'backup_user'@'%';
-- MySQL 8.0.22+ 可用 BINLOG MONITOR 替代 REPLICATION CLIENT：
-- GRANT RELOAD, PROCESS, BINLOG MONITOR ON *.* TO 'backup_user'@'%';

FLUSH PRIVILEGES;
```

### binlog 备份（`backup-binlog`）

需要：

| 权限                                    | 用途                                      |
| --------------------------------------- | ----------------------------------------- |
| `RELOAD`                                | `FLUSH BINARY LOGS`                       |
| `REPLICATION CLIENT` / `BINLOG MONITOR` | `SHOW BINARY LOGS`、`SHOW VARIABLES` 相关 |

若无法通过 Docker/`docker cp` 或文件系统直接拷贝 binlog，会回退到 `mysqlbinlog --read-from-remote-server`，这时还需要：

| 权限                | 用途                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `REPLICATION SLAVE` | 远程拉取 binlog（MySQL 8 中也可能体现为 `REPLICATION_SLAVE_ADMIN` 等相关权限，以实际版本为准） |

示例：

```sql
GRANT RELOAD, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO 'backup_user'@'%';
FLUSH PRIVILEGES;
```

另外：服务器需开启 `log_bin`；若走文件拷贝，运行本工具的环境还要有读取 MySQL 数据目录（或对应 Docker 容器）中 binlog 文件的权限。

### 还原（`restore-db`）

还原会向目标库导入 SQL，并可能执行 `SET sql_log_bin=0`。目标库上通常需要：

| 权限                                       | 用途                                       |
| ------------------------------------------ | ------------------------------------------ |
| `CREATE` / `DROP` / `ALTER` / `INDEX`      | 建表、删表、改表                           |
| `INSERT` / `UPDATE` / `DELETE`             | 导入数据                                   |
| `REFERENCES`                               | 外键                                       |
| `CREATE VIEW` / `SHOW VIEW`                | 视图                                       |
| `SESSION_VARIABLES_ADMIN`（MySQL 8.0.14+） | `SET sql_log_bin=0`                        |
| `SYSTEM_VARIABLES_ADMIN` 或 `SUPER`        | 同上（权限更大；MySQL 8.0 之前用 `SUPER`） |

示例（还原账号可与备份账号分开，把 `backup_db` 换成实际库名）：

```sql
CREATE USER 'restore_user'@'%' IDENTIFIED BY 'strong-password';

GRANT
  SELECT, INSERT, UPDATE, DELETE,
  CREATE, DROP, ALTER, INDEX, REFERENCES,
  CREATE VIEW, SHOW VIEW
ON backup_db.* TO 'restore_user'@'%';

-- 用于关闭还原过程中的 binlog 写入（MySQL 8.0.14+，权限最小）
GRANT SESSION_VARIABLES_ADMIN ON *.* TO 'restore_user'@'%';
-- 或：GRANT SYSTEM_VARIABLES_ADMIN ON *.* TO 'restore_user'@'%';
-- MySQL 8.0 之前：
-- GRANT SUPER ON *.* TO 'restore_user'@'%';

FLUSH PRIVILEGES;
```
