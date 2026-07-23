#!/usr/bin/env node

import { Command } from 'commander';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import path from 'node:path';
import { downloadFromOss } from './aliyun/download-from-oss.js';
import { downloadFromS3 } from './aws/download-from-s3.js';
import { getVersion } from './libs/get-version.js';
import { askInput, askPassword, askSelect, askYesNo } from './libs/prompt.js';
import { readConfig } from './libs/read-config.js';
import {
  applyBinlogs,
  listBinlogFilesToApply,
  listLocalDumpFiles,
  parseDumpBinlogPosition,
  resolveMysqlbinlogLocation,
  restoreDump,
} from './mysql/restore.js';

dayjs.extend(customParseFormat);
dayjs.extend(utc);

type RestoreOptions = {
  username?: string;
  password?: string;
};

const program = new Command();

program
  .name('restore-db')
  .description('还原数据库')
  .version(await getVersion())
  .argument('[config]', '配置文件路径', 'database-guard.yaml')
  .option('-u, --username <username>', '数据库用户名（覆盖配置文件）')
  .option('-p, --password <password>', '数据库密码（覆盖配置文件）')
  .action(async (configPath: string, options: RestoreOptions) => {
    const config = await readConfig(configPath);
    const localDir = path.resolve(config.destination_local.dir);
    const dbDir = path.join(localDir, 'db');
    const binlogDir = path.join(localDir, 'binlog');

    // 命令行未传时交互询问（默认值为配置文件）
    if (options.username !== undefined) {
      config.database.username = options.username;
    } else {
      config.database.username = await askInput('数据库用户名', {
        defaultValue: config.database.username,
        validate: (value) => (value.trim() ? true : '用户名不能为空'),
      });
    }

    if (options.password !== undefined) {
      config.database.password = options.password;
    } else {
      config.database.password = await askPassword('数据库密码', {
        defaultValue: config.database.password,
      });
    }

    if (config.destination_aws_s3) {
      const shouldDownload = await askYesNo('从 AWS S3 恢复缺失的备份文件？', false);
      if (shouldDownload) {
        await downloadFromS3(config.destination_aws_s3, localDir);
      }
    }

    if (config.destination_aliyun_oss) {
      const shouldDownload = await askYesNo('从阿里云 OSS 恢复缺失的备份文件？', false);
      if (shouldDownload) {
        await downloadFromOss(config.destination_aliyun_oss, localDir);
      }
    }

    const dumpFiles = await listLocalDumpFiles(dbDir);
    if (!dumpFiles.length) {
      throw new Error(`本地没有全量备份文件：${dbDir}`);
    }

    const selectedDump = await askSelect(
      '请选择要恢复的全量备份文件：',
      dumpFiles.map((file) => path.basename(file)),
      0,
    );
    const dumpPath = path.join(dbDir, selectedDump);

    const stopDatetimeInput = await askInput('输入binlog截止时间点', {
      defaultValue: dayjs.utc().format('YYYY-MM-DDTHH:mm:ss[Z]'),
      validate: (value) => {
        if (!value.trim()) return '时间点不能为空';
        // dayjs 中字面量 Z 需写成 [Z]；Z 单独表示时区偏移
        if (!dayjs.utc(value, 'YYYY-MM-DDTHH:mm:ss[Z]', true).isValid()) {
          return '时间点格式不正确，例如 2026-07-23T04:00:00Z';
        }
        return true;
      },
    });
    // mysqlbinlog --stop-datetime 需要 YYYY-MM-DD HH:mm:ss，配合 TZ=UTC
    const stopDatetime = dayjs
      .utc(stopDatetimeInput, 'YYYY-MM-DDTHH:mm:ss[Z]', true)
      .format('YYYY-MM-DD HH:mm:ss');

    const position = await parseDumpBinlogPosition(dumpPath);
    const binlogFiles = await listBinlogFilesToApply(binlogDir, position);

    console.log('');
    console.log('恢复计划：');
    console.log(`  数 据 库：${config.database.database.join(', ')}`);
    console.log(`  用 户 名：${config.database.username}`);
    console.log(`  备份文件：${selectedDump}`);
    console.log(`  截止时间：${stopDatetimeInput}`);
    console.log('  日志文件：');
    if (binlogFiles.length) {
      for (const file of binlogFiles) {
        console.log(`    ${path.basename(file)}`);
      }
    } else {
      console.log('    （无）');
    }
    console.log('');

    const confirmed = await askYesNo('确认开始恢复？此操作会覆盖目标数据库中的数据', false);
    if (!confirmed) {
      console.log('已取消恢复');
      return;
    }

    if (binlogFiles.length) {
      const location = await resolveMysqlbinlogLocation(config);
      if (location.kind === 'none') return;
    }

    await restoreDump(config, dumpPath);
    await applyBinlogs(config, binlogFiles, position, stopDatetime);
    console.log('恢复完成！');
  });

await program.parseAsync();
