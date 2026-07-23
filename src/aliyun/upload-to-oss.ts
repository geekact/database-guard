import path from 'node:path';
import type { Config } from '../libs/read-config.js';
import { createOssClient } from './oss-client.js';

export const uploadToOss = async (
  config: NonNullable<Config['destination_aliyun_oss']>,
  files: string[],
) => {
  const oss = createOssClient(config);

  for (const filename of files) {
    const basename = path.basename(filename);
    const key = [config.dir, basename].filter(Boolean).join('/');
    console.log(`${basename} -> ${config.bucket}/${key}`);
    await oss.put(key, filename);
  }
};
