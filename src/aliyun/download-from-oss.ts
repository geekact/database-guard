import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensureBackupDirs, resolveBackupDestPath } from '../libs/backup-local-path.js';
import type { Config } from '../libs/read-config.js';
import { createOssClient } from './oss-client.js';

export const downloadFromOss = async (
  config: NonNullable<Config['destination_aliyun_oss']>,
  localDir: string,
) => {
  const oss = createOssClient(config);
  const prefix = config.dir ? `${config.dir.replace(/\/$/, '')}/` : '';
  const dirs = await ensureBackupDirs(localDir);

  const keys: string[] = [];
  let marker: string | undefined;
  do {
    const listed = await oss.list(
      {
        'max-keys': 1000,
        ...(prefix ? { prefix } : {}),
        ...(marker ? { marker } : {}),
      },
      {},
    );
    for (const item of listed.objects ?? []) {
      if (item.name && !item.name.endsWith('/')) keys.push(item.name);
    }
    marker = listed.isTruncated ? listed.nextMarker : undefined;
  } while (marker);

  for (const key of keys) {
    const destPath = resolveBackupDestPath(key, dirs);
    if (!destPath) continue;
    if (existsSync(destPath)) continue;

    console.log(`↓ ${config.bucket}/${key} -> ${path.posix.basename(key)}`);
    await oss.get(key, destPath);
  }
};
