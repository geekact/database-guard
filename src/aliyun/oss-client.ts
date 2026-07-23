import { createRequire } from 'node:module';
import type { Config } from '../libs/read-config.js';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss') as typeof import('ali-oss');

export const createOssClient = (config: NonNullable<Config['destination_aliyun_oss']>) =>
  new OSS({
    accessKeyId: config.access_key,
    accessKeySecret: config.secret_key,
    region: config.region,
    bucket: config.bucket,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.internal !== undefined ? { internal: config.internal } : {}),
  });
