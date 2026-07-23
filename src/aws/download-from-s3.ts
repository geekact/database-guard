import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Config } from '../libs/read-config';
import { createS3Client } from './s3-client.js';
import { BINLOG_FILE_SUFFIX } from '../mysql/binlog.js';

const isDumpFile = (name: string) => /^db-.+\.sql\.gz$/i.test(name);
const isBinlogFile = (name: string) => name.endsWith(BINLOG_FILE_SUFFIX);

export const downloadFromS3 = async (
  config: NonNullable<Config['destination_aws_s3']>,
  localDir: string,
) => {
  const s3 = createS3Client(config);
  const prefix = config.dir ? `${config.dir.replace(/\/$/, '')}/` : '';
  const dbDir = path.join(localDir, 'db');
  const binlogDir = path.join(localDir, 'binlog');
  await mkdir(dbDir, { recursive: true });
  await mkdir(binlogDir, { recursive: true });

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

  let downloaded = 0;

  for (const key of keys) {
    const basename = path.posix.basename(key);
    let destPath: string | null = null;
    if (isDumpFile(basename)) {
      destPath = path.join(dbDir, basename);
    } else if (isBinlogFile(basename)) {
      destPath = path.join(binlogDir, basename);
    }
    if (!destPath) continue;
    if (existsSync(destPath)) continue;

    console.log(`${config.bucket}/${key} -> ${basename}`);
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
    downloaded += 1;
  }
};
