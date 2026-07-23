import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: './src/backup-db.ts',
    outDir: './dist',
    format: 'esm',
  },
  {
    entry: './src/backup-binlog.ts',
    outDir: './dist',
    format: 'esm',
  },
  {
    entry: './src/restore-db.ts',
    outDir: './dist',
    format: 'esm',
  },
]);
