import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../libs/read-config';
import { buildExecCommand, mysqlConnectionArgs, mysqlQuery, runCommand, runDocker } from './helper.js';

const STATE_FILE = '.binlog-backup-state';
export const BINLOG_FILE_SUFFIX = '.bin';

export const toLocalBinlogName = (logName: string) => `${logName}${BINLOG_FILE_SUFFIX}`;

const getBinlogDir = async (config: Config) => {
  const basename = await mysqlQuery(config, "SHOW VARIABLES LIKE 'log_bin_basename'");
  // output: log_bin_basename\t/var/lib/mysql/mysql-bin
  const value = basename.split('\t')[1]?.trim();
  if (!value) {
    throw new Error('无法获取 log_bin_basename，请确认已开启 binary log');
  }
  return path.posix.dirname(value);
};

const copyBinlogFile = async (
  config: Config,
  destDir: string,
  logName: string,
  sourcePath: string,
) => {
  const { system } = config;
  const destPath = path.join(destDir, logName);

  if (system.docker_container_name) {
    await runDocker(config, ['cp', `${system.docker_container_name}:${destPath}`, sourcePath]);
    return;
  }

  try {
    await copyFile(destPath, sourcePath);
    return;
  } catch {
    console.warn('binlog 文件复制失败，改用 mysqlbinlog 拉取');
  }

  const { command, args } = buildExecCommand(config, 'mysqlbinlog', [
    '--read-from-remote-server',
    '--raw',
    `--result-dir=${path.dirname(sourcePath)}`,
    ...mysqlConnectionArgs(config),
    logName,
  ]);
  await runCommand(command, args);
  // mysqlbinlog --raw 按原始日志名落盘，再改名为带 .bin 后缀的本地文件
  const rawPath = path.join(path.dirname(sourcePath), logName);
  if (rawPath !== sourcePath) {
    await rename(rawPath, sourcePath);
  }
};

export const backupBinlogs = async (config: Config, destDir: string) => {
  {
    const logBin = await mysqlQuery(config, "SHOW VARIABLES LIKE 'log_bin'");
    const logBinValue = logBin.split('\t')[1]?.trim().toUpperCase();
    if (logBinValue !== 'ON') {
      throw new Error('MySQL 未开启 binary log（log_bin=OFF）');
    }
  }

  await mysqlQuery(config, 'FLUSH BINARY LOGS');

  const binaryLogsOutput = await mysqlQuery(config, 'SHOW BINARY LOGS');
  const logs = binaryLogsOutput
    ? binaryLogsOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = '', size = '0'] = line.split('\t');
          return { name, size: Number(size) || 0 };
        })
    : [];
  // 最后一个是当前正在写入的 binlog，跳过备份
  logs.pop();
  if (!logs.length) return [];

  const statePath = path.join(destDir, STATE_FILE);
  let lastBackedUp: string | null = null;
  try {
    lastBackedUp = (await readFile(statePath, 'utf8')).trim() || null;
  } catch {
    // 首次备份，无状态文件
  }
  const startIndex = lastBackedUp ? logs.findIndex((log) => log.name === lastBackedUp) + 1 : 0;
  const pending = logs.slice(startIndex);
  if (!pending.length) return [];

  const remoteDir = await getBinlogDir(config);
  const savedFiles: string[] = [];

  for (const log of pending) {
    const localName = toLocalBinlogName(log.name);
    const localPath = path.join(destDir, localName);
    console.log(`+ ${localName}`);
    await copyBinlogFile(config, remoteDir, log.name, localPath);
    savedFiles.push(localPath);
    await writeFile(statePath, `${log.name}\n`, 'utf8');
  }

  return savedFiles;
};
