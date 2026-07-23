import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../libs/read-config';

/** mysql / mysqldump / mysqlbinlog 共用的连接参数 */
export const mysqlConnectionArgs = (config: Config) => {
  const { database } = config;
  return [
    `--user=${database.username}`,
    `--password=${database.password}`,
    `--host=${database.host}`,
    `--port=${database.port}`,
  ];
};

/** 过滤 mysql 命令行密码警告，其余 stderr 实时输出 */
export const forwardMysqlStderr = (data: Buffer) => {
  const msg = data.toString();
  if (msg.includes('Using a password on the command line')) return;
  process.stderr.write(msg);
};

/** 等待子进程结束；非 0 退出码时抛错 */
export const waitForExit = (child: ChildProcess, label: string) => {
  const { resolve, reject, promise } = Promise.withResolvers<void>();
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${label}，退出码 ${code}`));
  });
  return promise;
};

/** 组装 mysql/mysqldump 等命令，统一处理 docker / sudo */
export const buildExecCommand = (
  config: Config,
  program: string,
  programArgs: string[],
  options: {
    /** 需要向子进程写入 stdin 时开启（docker exec 会加 -i） */
    stdin?: boolean;
    /** 传入子进程的环境变量（docker exec 会加 -e） */
    env?: Record<string, string>;
  } = {},
): { command: string; args: string[]; env?: Record<string, string> } => {
  let command = program;
  let args = [...programArgs];

  if (config.system.docker_container_name) {
    const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]);
    args = [
      'exec',
      ...envArgs,
      ...(options.stdin ? ['-i'] : []),
      config.system.docker_container_name,
      program,
      ...args,
    ];
    command = 'docker';
  }

  if (config.system.sudo) {
    args = [command, ...args];
    command = 'sudo';
  }

  return {
    command,
    args,
    ...(config.system.docker_container_name || !options.env ? {} : { env: options.env }),
  };
};

export const runCommand = async (command: string, args: string[]) => {
  const { resolve, reject, promise } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>();

  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error(`${command} failed with code ${code}: ${stderr || stdout}`));
      return;
    }
    resolve({ code, stdout, stderr });
  });

  return promise;
};

/** 执行 docker 命令，统一处理 sudo */
export const runDocker = async (config: Config, args: string[]) => {
  if (config.system.sudo) {
    return runCommand('sudo', ['docker', ...args]);
  }
  return runCommand('docker', args);
};

export const mysqlQuery = async (config: Config, sql: string) => {
  const { command, args } = buildExecCommand(config, 'mysql', [
    ...mysqlConnectionArgs(config),
    '--batch', // 批处理输出，便于解析
    '--raw', // 不做转义，原样输出
    '--skip-column-names', // 不输出列名，只保留数据行
    '--execute',
    sql,
  ]);

  const { stdout } = await runCommand(command, args);
  return stdout.trim();
};
