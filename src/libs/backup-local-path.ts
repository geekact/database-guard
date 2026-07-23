import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BINLOG_FILE_SUFFIX } from '../mysql/binlog.js';

export const isDumpFile = (name: string) => /^db-.+\.sql\.gz$/i.test(name);
export const isBinlogFile = (name: string) => name.endsWith(BINLOG_FILE_SUFFIX);

export const ensureBackupDirs = async (localDir: string) => {
  const dbDir = path.join(localDir, 'db');
  const binlogDir = path.join(localDir, 'binlog');
  await mkdir(dbDir, { recursive: true });
  await mkdir(binlogDir, { recursive: true });
  return { dbDir, binlogDir };
};

/** 根据远程 key 的 basename 解析本地落盘路径；非 dump/binlog 则返回 null */
export const resolveBackupDestPath = (
  key: string,
  dirs: { dbDir: string; binlogDir: string },
): string | null => {
  const basename = path.posix.basename(key);
  if (isDumpFile(basename)) return path.join(dirs.dbDir, basename);
  if (isBinlogFile(basename)) return path.join(dirs.binlogDir, basename);
  return null;
};
