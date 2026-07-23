import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Config } from '../libs/read-config';
import {
  buildExecCommand,
  forwardMysqlStderr,
  mysqlConnectionArgs,
  runCommand,
  runDocker,
  waitForExit,
} from './helper.js';
import { pullMysqlbinlogImage } from './install-mysqlbinlog.js';
import { BINLOG_FILE_SUFFIX, toLocalBinlogName } from './binlog.js';
import { styleText } from 'node:util';

export type BinlogPosition = {
  file: string;
  position: number;
};

export type MysqlbinlogLocation =
  | { kind: 'container' }
  | { kind: 'host' }
  | { kind: 'image'; image: string }
  | { kind: 'none' };

type SpawnCmd = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** 从 mysqldump --source-data=2 的注释中解析 binlog 位点 */
export const parseDumpBinlogPosition = async (dumpPath: string): Promise<BinlogPosition> => {
  const rl = readline.createInterface({
    input: createReadStream(dumpPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const master = line.match(/MASTER_LOG_FILE='([^']+)'[,\s]+MASTER_LOG_POS=(\d+)/i);
      if (master) {
        return { file: master[1]!, position: Number(master[2]) };
      }
      const source = line.match(/SOURCE_LOG_FILE='([^']+)'[,\s]+SOURCE_LOG_POS=(\d+)/i);
      if (source) {
        return { file: source[1]!, position: Number(source[2]) };
      }
    }
  } finally {
    rl.close();
  }

  throw new Error('无法从全量备份中解析 binlog 位点，请确认备份时使用了 --source-data=2');
};

export const listLocalDumpFiles = async (dbDir: string) => {
  let entries: string[] = [];
  try {
    entries = await readdir(dbDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^db-.+\.sql\.gz$/i.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(dbDir, name));
};

export const listLocalBinlogFiles = async (binlogDir: string) => {
  let entries: string[] = [];
  try {
    entries = await readdir(binlogDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(BINLOG_FILE_SUFFIX) && !name.startsWith('.'))
    .sort()
    .map((name) => path.join(binlogDir, name));
};

/** 将 SQL 流导入目标库 */
const executeSqlStream = async (config: Config, input: NodeJS.ReadableStream, label: string) => {
  const { command, args } = buildExecCommand(
    config,
    'mysql',
    [
      ...mysqlConnectionArgs(config),
      '--default-character-set=utf8mb4',
      '--init-command=SET sql_log_bin=0',
    ],
    { stdin: true },
  );
  const mysql = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  mysql.stderr.on('data', forwardMysqlStderr);

  try {
    await Promise.all([pipeline(input, mysql.stdin!), waitForExit(mysql, label)]);
  } catch (err) {
    mysql.kill();
    throw err;
  }
};

/** 导入全量 .sql.gz 备份 */
export const restoreDump = async (config: Config, dumpPath: string) => {
  console.log(`+ ${path.basename(dumpPath)}`);
  await executeSqlStream(config, createReadStream(dumpPath).pipe(createGunzip()), 'mysql 恢复失败');
};

/** 将 binlog 完整解码为 SQL 文件 */
const decodeBinlogToSql = async (binlogCmd: SpawnCmd, sqlPath: string) => {
  const binlog = spawn(binlogCmd.command, binlogCmd.args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: binlogCmd.env ? { ...process.env, ...binlogCmd.env } : undefined,
  });
  binlog.stderr.on('data', forwardMysqlStderr);
  await Promise.all([
    pipeline(binlog.stdout, createWriteStream(sqlPath)),
    waitForExit(binlog, 'mysqlbinlog 解码失败'),
  ]);
};

/** 将本地 binlog 拷入容器临时目录，返回容器内路径 */
const stageBinlogsInContainer = async (config: Config, localFiles: string[]) => {
  const container = config.system.docker_container_name!;
  const remoteDir = `/tmp/database-guard-restore-${Date.now()}`;
  const mkdirCmd = buildExecCommand(config, 'mkdir', ['-p', remoteDir]);
  await runCommand(mkdirCmd.command, mkdirCmd.args);

  const remoteFiles: string[] = [];
  for (const localFile of localFiles) {
    const remoteFile = `${remoteDir}/${path.basename(localFile)}`;
    await runDocker(config, ['cp', localFile, `${container}:${remoteFile}`]);
    remoteFiles.push(remoteFile);
  }

  return { remoteDir, remoteFiles };
};

/**
 * 按全量备份位点筛选需要应用的本地 binlog 文件。
 */
export const listBinlogFilesToApply = async (binlogDir: string, position: BinlogPosition) => {
  const allFiles = await listLocalBinlogFiles(binlogDir);
  const expected = toLocalBinlogName(position.file);
  const startIndex = allFiles.map((file) => path.basename(file)).indexOf(expected);
  if (startIndex < 0) {
    throw new Error(`本地缺少全量备份对应的 binlog 文件 ${expected}，无法继续增量恢复`);
  }
  return allFiles.slice(startIndex);
};

export const resolveMysqlbinlogLocation = async (config: Config): Promise<MysqlbinlogLocation> => {
  if (config.system.docker_container_name) {
    try {
      // 不仅要存在，还要能真正跑起来（拷贝进来的 Ubuntu 二进制在 OL 容器会缺库）
      const { command, args } = buildExecCommand(config, 'sh', [
        '-c',
        'command -v mysqlbinlog >/dev/null && mysqlbinlog --version',
      ]);
      await runCommand(command, args);
      return { kind: 'container' };
    } catch {
      // 容器内没有或不可用，继续查宿主机
    }
  }

  try {
    await runCommand('sh', ['-c', 'command -v mysqlbinlog >/dev/null && mysqlbinlog --version']);
    return { kind: 'host' };
  } catch {
    // 都没有
  }

  if (config.system.docker_container_name) {
    const image = await pullMysqlbinlogImage(config);
    if (image) return { kind: 'image', image };
  }

  console.warn(styleText('yellow', '未找到 mysqlbinlog，请安装后再重试'));
  return { kind: 'none' };
};

/** 用独立 ubuntu/mysql 镜像运行 mysqlbinlog（挂载本地 binlog 目录） */
const buildMysqlbinlogFromImage = (
  config: Config,
  image: string,
  localBinlogPath: string,
  programArgs: string[],
  env: Record<string, string>,
): SpawnCmd => {
  const hostDir = path.resolve(path.dirname(localBinlogPath));
  const containerPath = `/binlogs/${path.basename(localBinlogPath)}`;
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const args = [
    'run',
    '--rm',
    ...envArgs,
    '-v',
    `${hostDir}:/binlogs:ro`,
    '--entrypoint',
    'mysqlbinlog',
    image,
    ...programArgs,
    containerPath,
  ];

  if (config.system.sudo) {
    return { command: 'sudo', args: ['docker', ...args] };
  }
  return { command: 'docker', args };
};

/**
 * 从全量备份位点开始应用 binlog，直到 stopDatetime（UTC）。
 */
export const applyBinlogs = async (
  config: Config,
  files: string[],
  position: BinlogPosition,
  stopDatetime: string,
) => {
  if (!files.length) return;

  const location = await resolveMysqlbinlogLocation(config);
  if (location.kind === 'none') return;

  const useContainer = location.kind === 'container';
  let binlogPaths = files;
  let cleanup: (() => Promise<void>) | undefined;

  if (useContainer) {
    const { remoteDir, remoteFiles } = await stageBinlogsInContainer(config, files);
    binlogPaths = remoteFiles;
    cleanup = async () => {
      try {
        const rmCmd = buildExecCommand(config, 'rm', ['-rf', remoteDir]);
        await runCommand(rmCmd.command, rmCmd.args);
      } catch {
        // 清理失败不影响恢复结果
      }
    };
  }

  try {
    for (let i = 0; i < binlogPaths.length; i++) {
      const binlogPath = binlogPaths[i]!;
      const localBinlogPath = files[i]!;
      const name = path.basename(binlogPath);
      console.log(`+ ${name} (${i + 1}/${binlogPaths.length})`);

      const programArgs = [
        '--disable-log-bin', // 恢复时不写入新的 binlog，避免污染目标库日志
        ...(i === 0 ? [`--start-position=${position.position}`] : []),
        `--stop-datetime=${stopDatetime}`,
      ];

      const env = { TZ: 'UTC' };
      const binlogCmd: SpawnCmd =
        location.kind === 'container'
          ? buildExecCommand(config, 'mysqlbinlog', [...programArgs, binlogPath], { env })
          : location.kind === 'image'
            ? buildMysqlbinlogFromImage(config, location.image, localBinlogPath, programArgs, env)
            : { command: 'mysqlbinlog', args: [...programArgs, binlogPath], env };

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'database-guard-binlog-'));
      const sqlPath = path.join(tmpDir, `${name}.sql`);
      try {
        await decodeBinlogToSql(binlogCmd, sqlPath);
        await executeSqlStream(config, createReadStream(sqlPath), 'mysql 执行 binlog SQL 失败');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  } finally {
    await cleanup?.();
  }
};
