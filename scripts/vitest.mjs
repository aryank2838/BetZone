// Starts Vitest from the folder's real-case path.
//
// On Windows a shell can hand Node the folder as `d:\...` while Vitest works
// out its root as `D:/...`. Node then loads vitest twice as two different
// modules, and every test file fails with "Vitest failed to find the current
// suite". Starting Vitest in a child process from the real-case path avoids
// that. Elsewhere this only passes the arguments straight through.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const cwd = realpathSync.native(process.cwd());
const vitest = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');

const child = spawn(process.execPath, [vitest, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
