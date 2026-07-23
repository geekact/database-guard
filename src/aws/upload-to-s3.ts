import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Config } from '../libs/read-config';
import { createS3Client } from './s3-client.js';

export const uploadToS3 = async (
  config: NonNullable<Config['destination_aws_s3']>,
  files: string[],
) => {
  const s3 = createS3Client(config);

  for (const filename of files) {
    const basename = path.basename(filename);
    const key = [config.dir, basename].filter(Boolean).join('/');
    console.log(`${basename} -> ${config.bucket}/${key}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(filename),
      }),
    );
  }
};
