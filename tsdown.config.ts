import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: './src/backup-db.ts',
    outDir: './dist',
    format: 'esm',
    dts: false,
  },
  {
    entry: './src/backup-binlog.ts',
    outDir: './dist',
    format: 'esm',
    dts: false,
  },
  {
    entry: './src/restore-db.ts',
    outDir: './dist',
    format: 'esm',
    dts: false,
  },
]);
