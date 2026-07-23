import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Config } from '../libs/read-config';
import { buildExecCommand, forwardMysqlStderr, mysqlConnectionArgs, waitForExit } from './helper.js';
import path from 'node:path';

export const mysqldump = async (
  config: Config & { database: { driver: 'mysql' } },
  destFilename: string,
) => {
  const { database } = config;
  const { command, args } = buildExecCommand(config, 'mysqldump', [
    ...mysqlConnectionArgs(config),
    '--single-transaction', // InnoDB 一致性快照，不锁表
    '--quick', // 逐行取出结果，降低大表内存占用
    '--source-data=2', // 记录 binlog 位置（注释形式写入 dump）
    '--hex-blob', // blob 以十六进制导出，避免乱码/截断
    '--order-by-primary', // 按主键排序，保证 dump 文件的顺序一致
    '--skip-triggers', // 不导出触发器
    '--default-character-set=utf8mb4',
    '--set-gtid-purged=OFF', // 禁用 GTID，避免误用
    // 不传 --routines / --events：默认不导出函数、存储过程、事件
    '--databases',
    ...database.database,
  ]);

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', forwardMysqlStderr);

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(destFilename)),
    waitForExit(child, 'mysqldump 失败'),
  ]);

  console.log(`+ ${path.basename(destFilename)}`);
};
