#!/usr/bin/env node

import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { uploadToOss } from './aliyun/upload-to-oss.js';
import { uploadToS3 } from './aws/upload-to-s3.js';
import { getVersion } from './libs/get-version.js';
import { readConfig } from './libs/read-config.js';
import { backupBinlogs } from './mysql/binlog.js';
import { deleteOutdatedFiles } from './local/delete-outdated-files.js';

const program = new Command();

program
  .name('backup-binlog')
  .description('备份 MySQL binlog')
  .version(await getVersion())
  .argument('[config]', '配置文件路径', 'db-backup.yaml')
  .action(async (configPath: string) => {
    const config = await readConfig(configPath);

    const destDir = path.resolve(config.destination_local.dir, 'binlog');
    await mkdir(destDir, { recursive: true });

    console.log('开始导出binlog文件...');
    const files = await backupBinlogs(config, destDir);
    console.log('删除过期的备份文件...');
    await deleteOutdatedFiles(config, destDir);

    if (config.destination_aws_s3) {
      console.log('AWS S3 存储桶已配置，开始上传...');
      await uploadToS3(config.destination_aws_s3, files);
    }

    if (config.destination_aliyun_oss) {
      console.log('阿里云 OSS 已配置，开始上传...');
      await uploadToOss(config.destination_aliyun_oss, files);
    }

    console.log('备份结束！');
  });

await program.parseAsync();
