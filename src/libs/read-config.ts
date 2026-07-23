import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  database: z.object(
    {
      driver: z.literal('mysql', {
        error: 'database.driver 必填，且仅支持 mysql',
      }),
      host: z.string({ error: 'database.host 必填' }),
      port: z.number({ error: 'database.port 必填' }),
      username: z.string({ error: 'database.username 必填' }),
      password: z.string({ error: 'database.password 必填' }),
      database: z.string({ error: 'database.database 必填' }).transform((value) =>
        value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    },
    { error: 'database 配置必填' },
  ),
  system: z
    .object({
      sudo: z.boolean().default(true),
      docker_container_name: z.string().optional(),
    })
    .default({ sudo: true }),
  destination_local: z.object(
    {
      dir: z.string({ error: 'destination_local.dir 必填' }),
      keep_days: z.number({ error: 'destination_local.keep_days 必填' }),
    },
    { error: 'destination_local 配置必填' },
  ),
  destination_aws_s3: z
    .object({
      endpoint: z.url().optional(),
      access_key: z.string({ error: 'destination_aws_s3.access_key 必填' }),
      secret_key: z.string({ error: 'destination_aws_s3.secret_key 必填' }),
      region: z.string({ error: 'destination_aws_s3.region 必填' }),
      bucket: z.string({ error: 'destination_aws_s3.bucket 必填' }),
      dir: z.string().optional(),
    })
    .optional(),
  destination_aliyun_oss: z
    .object({
      endpoint: z.string().optional(),
      access_key: z.string({ error: 'destination_aliyun_oss.access_key 必填' }),
      secret_key: z.string({ error: 'destination_aliyun_oss.secret_key 必填' }),
      region: z.string({ error: 'destination_aliyun_oss.region 必填' }),
      bucket: z.string({ error: 'destination_aliyun_oss.bucket 必填' }),
      dir: z.string().optional(),
      internal: z.boolean().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const readConfig = async (configPath: string): Promise<Config> => {
  const fileData = fs.readFileSync(path.resolve(configPath), 'utf8');
  const config = yaml.parse(fileData);

  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }

  return result.data;
};
