import { styleText } from 'node:util';
import type { Config } from '../libs/read-config';
import { mysqlQuery, runDocker } from './helper.js';

/** 列出 Docker Hub 公开仓库的 tag 名 */
const listDockerHubTags = async (repository: string): Promise<string[]> => {
  const tags: string[] = [];
  let url: string | null =
    `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=-last_updated`;

  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`查询 ${repository} tags 失败：HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      next?: string | null;
      results?: Array<{ name: string }>;
    };
    for (const item of data.results ?? []) {
      tags.push(item.name);
    }
    url = data.next ?? null;
  }

  return tags;
};

/** ubuntu/mysql tag 评分：同大版本下优先 edge、更新的 Ubuntu 发行版 */
const scoreUbuntuMysqlTag = (tag: string) => {
  let score = 0;
  if (tag.includes('_edge')) score += 200;
  else if (tag.includes('_beta')) score += 100;
  const ubuntuRelease = tag.match(/-(\d+\.\d+)/)?.[1];
  if (ubuntuRelease) score += Number.parseFloat(ubuntuRelease);
  return score;
};

/** 按服务器大版本匹配 ubuntu/mysql 候选镜像（如 8.4 → 8.4-26.04_edge） */
const resolveUbuntuMysqlImageCandidates = async (version: string): Promise<string[]> => {
  const majorMinor = version.split('.').slice(0, 2).join('.');

  try {
    const ubuntuTags = await listDockerHubTags('ubuntu/mysql');
    return ubuntuTags
      .filter((tag) => tag === majorMinor || tag.startsWith(`${majorMinor}-`))
      .sort((a, b) => scoreUbuntuMysqlTag(b) - scoreUbuntuMysqlTag(a))
      .map((tag) => `ubuntu/mysql:${tag}`);
  } catch (err) {
    console.warn(
      styleText(
        'yellow',
        `查询 ubuntu/mysql tags 失败：${err instanceof Error ? err.message : err}`,
      ),
    );
    return [];
  }
};

/**
 * 按服务器版本拉取可用的 ubuntu/mysql 镜像（用于在独立容器中运行 mysqlbinlog）。
 * 不拷贝进 DB 容器：Ubuntu 二进制与 Oracle Linux glibc 不兼容。
 */
export const pullMysqlbinlogImage = async (config: Config): Promise<string | null> => {
  let version: string;
  try {
    const rawVersion = await mysqlQuery(config, 'SELECT VERSION()');
    const match = rawVersion.trim().match(/^(\d+\.\d+\.\d+)/);
    if (!match) {
      throw new Error(`无法解析 MySQL 版本：${rawVersion}`);
    }
    version = match[1]!;
  } catch (err) {
    console.warn(
      styleText(
        'yellow',
        `无法获取 MySQL 版本，跳过自动准备 mysqlbinlog：${err instanceof Error ? err.message : err}`,
      ),
    );
    return null;
  }

  const candidates = await resolveUbuntuMysqlImageCandidates(version);
  for (const image of candidates) {
    try {
      await runDocker(config, ['image', 'inspect', image]);
    } catch {
      console.log(`拉取 ${image} 以获取 mysqlbinlog...`);
      try {
        await runDocker(config, ['pull', image]);
      } catch {
        console.warn(styleText('yellow', `拉取 ${image} 失败`));
      }
    }

    try {
      // 确认镜像内有可用的 mysqlbinlog
      await runDocker(config, ['run', '--rm', '--entrypoint', 'mysqlbinlog', image, '--version']);
      return image;
    } catch {
      console.warn(styleText('yellow', `验证 ${image} 失败`));
    }
  }

  return null;
};
