import { readPackageUp } from 'read-package-up';

export const getVersion = async (cwd = import.meta.dirname) => {
  const pkg = await readPackageUp({ cwd });
  return pkg?.packageJson.version ?? '0.0.0';
};
