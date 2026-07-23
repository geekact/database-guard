import dayjs from 'dayjs';
import type { Config } from '../libs/read-config';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const deleteOutdatedFiles = async (config: Config, destDir: string) => {
  const {
    destination_local: { keep_days },
  } = config;
  if (keep_days <= 0) return;

  const files = await readdir(destDir, { withFileTypes: true });
  const cutoff = dayjs().subtract(keep_days, 'day').toDate();
  for (const file of files) {
    if (file.isDirectory()) continue;
    const fullPath = path.join(destDir, file.name);
    const fileStat = await stat(fullPath);
    if (fileStat.isFile() && fileStat.mtime < cutoff) {
      await unlink(fullPath);
      console.log(`- ${file.name}`);
    }
  }
};
