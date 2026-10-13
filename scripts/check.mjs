import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['server', 'scripts', 'public']) {
  for (const name of await readdir(directory)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('JavaScript 语法检查通过');
