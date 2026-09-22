import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
/** Refuse a second worker process using the same database; reclaim only a dead owner's lock. */
export function lockDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'worker.lock');
  const create = () => { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); };
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('工作区锁文件无效，请核查是否有运行中的实例');
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw e; }
    if (alive) throw new Error(`该工作台数据目录正在被进程 ${pid} 使用；请关闭旧实例或使用不同 MAINTAINER_DATA_DIR`);
    unlinkSync(path); create();
  }
  return () => { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
}
