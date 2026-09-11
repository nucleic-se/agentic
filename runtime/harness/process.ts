import type { ChildProcess } from 'node:child_process';

/** Stop the command's process group, including helpers that inherited its pipes. */
export function killProcessGroup(child: ChildProcess): void {
    try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
}
