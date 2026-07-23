#!/usr/bin/env node

import { Command } from 'commander';
import { getVersion } from './libs/get-version.js';
import { readConfig } from './libs/read-config.js';
import { mysqldump } from './mysql/mysqldump.js';
import path from 'node:path';
import dayjs from 'dayjs';
import { mkdir } from 'node:fs/promises';
import { uploadToOss } from './aliyun/upload-to-oss.js';
import { uploadToS3 } from './aws/upload-to-s3.js';
import { deleteOutdatedFiles } from './local/delete-outdated-files.js';

const program = new Command();

program
  .name('backup-db')
  .description('备份数据库')
  .version(await getVersion())
  .argument('[config]', '配置文件路径', 'database-guard.yaml')
  .action(async (configPath: string) => {
    const config = await readConfig(configPath);

    const filename = path.resolve(
      config.destination_local.dir,
      'db',
      `db-${dayjs().format('YYYYMMDDHHmmss')}.sql.gz`,
    );
    await mkdir(path.dirname(filename), { recursive: true });

    console.log(`开始导出数据库 ${config.database.database.join(',')}...`);
    await mysqldump(config, filename);

    console.log('删除过期的备份文件...');
    await deleteOutdatedFiles(config, path.dirname(filename));

    if (config.destination_aws_s3) {
      console.log('AWS S3 存储桶已配置，开始上传...');
      await uploadToS3(config.destination_aws_s3, [filename]);
    }

    if (config.destination_aliyun_oss) {
      console.log('阿里云 OSS 已配置，开始上传...');
      await uploadToOss(config.destination_aliyun_oss, [filename]);
    }

    console.log('备份结束！');
  });

await program.parseAsync();
