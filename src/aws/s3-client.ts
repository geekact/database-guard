import { S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../libs/read-config';

export const createS3Client = (config: NonNullable<Config['destination_aws_s3']>) =>
  new S3Client({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: config.access_key,
      secretAccessKey: config.secret_key,
    },
    region: config.region,
  });
