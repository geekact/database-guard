import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { ensureBackupDirs, resolveBackupDestPath } from '../libs/backup-local-path.js';
import type { Config } from '../libs/read-config';
import { createS3Client } from './s3-client.js';

export const downloadFromS3 = async (
  config: NonNullable<Config['destination_aws_s3']>,
  localDir: string,
) => {
  const s3 = createS3Client(config);
  const prefix = config.dir ? `${config.dir.replace(/\/$/, '')}/` : '';
  const dirs = await ensureBackupDirs(localDir);

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      }),
    );
    for (const item of listed.Contents ?? []) {
      if (item.Key && !item.Key.endsWith('/')) keys.push(item.Key);
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  for (const key of keys) {
    const destPath = resolveBackupDestPath(key, dirs);
    if (!destPath) continue;
    if (existsSync(destPath)) continue;

    console.log(`↓ ${config.bucket}/${key} -> ${path.posix.basename(key)}`);
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
    if (!result.Body) {
      throw new Error(`下载失败：${key} 无内容`);
    }
    await pipeline(result.Body as Readable, createWriteStream(destPath));
  }
};
