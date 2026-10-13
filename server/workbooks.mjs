import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeFiles, appendEvent, requireEditable, validateRules } from './store.mjs';

const workerPath = fileURLToPath(new URL('../examples/workbook_worker.py', import.meta.url));

export async function runWorkbookWorker(request, { pythonCommand = 'python', signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const child = spawn(pythonCommand, [workerPath], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let buffer = '', stderr = '', result, failure;
  let writes = Promise.resolve();
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 32 * 1024 * 1024) { failure = new Error('检查报告超过 32MB，请拆分批次'); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === 'result') result = value.data;
        else if (value.type === 'progress') {
          writes = writes.then(() => onProgress?.(value));
          writes.catch((error) => { failure = error; child.kill(); });
        }
      } catch (error) { failure = error; child.kill(); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  try {
    const outcome = new Promise((resolve) => { child.on('error', (error) => { failure = error; }); child.on('close', (code) => resolve(code)); });
    child.stdin.end(JSON.stringify(request));
    const code = await outcome;
    await writes;
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0 || result === undefined) throw new Error(stderr || '工作簿检查未返回有效结果');
    return result;
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function validateWorkbookOutputs(paths, expectedRecords, options) {
  for (const filePath of paths) {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('成果必须是普通 XLSX 文件');
  }
  return runWorkbookWorker({ action: 'validate', paths, expectedRecords, expectedHeaders: options?.expectedHeaders }, options);
}

export class WorkbookService {
  constructor(store, pythonCommand = 'python') { this.store = store; this.pythonCommand = pythonCommand; this.jobs = new Map(); this.templateLock = Promise.resolve(); }
  async check(id) {
    if (this.jobs.has(id)) return this.store.get(id);
    const controller = new AbortController();
    const job = { controller }; this.jobs.set(id, job);
    try {
      job.admission = this.store.update(id, (value) => {
        requireEditable(value);
        const files = activeFiles(value);
        if (!files.length || files.some((file) => file.status !== 'uploaded')) throw Object.assign(new Error('请先上传所有未排除的输入文件'), { status: 409 });
        value.checkState = 'checking'; value.preflight = null;
        value.progress = { phase: 'checking', message: '正在逐文件检查，成功解析将保存为检查点' };
      });
      const batch = await job.admission;
      job.done = this.#inspect(id, controller.signal);
      job.done.catch((error) => console.error('检查状态保存失败：', String(error.message).slice(-1000)));
      return batch;
    } catch (error) { this.jobs.delete(id); throw error; }
  }
  async #inspect(id, signal) {
    try {
      const report = await runWorkbookWorker({ action: 'check', manifest: await this.store.buildManifest(id) }, {
        pythonCommand: this.pythonCommand, signal,
        onProgress: (progress) => this.store.update(id, (value) => { value.progress = progress; }),
      });
      await this.store.update(id, (batch) => {
        batch.preflight = report; batch.lastPreflight = null; batch.checkState = report.ok ? 'passed' : 'failed';
        batch.progress = { phase: report.ok ? 'ready' : 'check_failed', message: report.ok ? `检查通过：${report.recordCount} 条记录，复用 ${report.cachedCount} 份检查点` : `${report.failedCount} 份文件存在异常，请修正、排除或替换后重试` };
        appendEvent(batch, 'check', batch.progress.message);
      });
    } catch (error) {
      await this.store.update(id, (batch) => { batch.checkState = signal.aborted ? 'interrupted' : 'failed'; batch.preflight = null; batch.progress = { phase: 'check_failed', message: String(error.message).slice(-2000) }; appendEvent(batch, 'check', batch.progress.message); });
    } finally { this.jobs.delete(id); }
  }
  validate(paths, expectedRecords, signal, expectedHeaders) { return validateWorkbookOutputs(paths, expectedRecords, { pythonCommand: this.pythonCommand, signal, expectedHeaders }); }
  preview(filePath, sheet, offset) { return runWorkbookWorker({ action: 'preview', path: filePath, sheet, offset, limit: 25 }, { pythonCommand: this.pythonCommand }); }
  async templates() {
    try { return JSON.parse(await readFile(path.join(this.store.root, 'templates.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  saveTemplate(name, rules) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw Object.assign(new Error('模板名称需为 1 至 120 字'), { status: 400 });
    const validated = validateRules(rules);
    const work = this.templateLock.catch(() => {}).then(async () => {
      const templates = await this.templates();
      if (templates.length >= 1000) throw Object.assign(new Error('最多保存 1,000 个模板版本'), { status: 400 });
      const template = { id: randomUUID(), name: name.trim(), version: templates.filter((item) => item.name === name.trim()).length + 1, createdAt: new Date().toISOString(), rules: validated };
      templates.push(template);
      const target = path.join(this.store.root, 'templates.json');
      await writeFile(target + '.tmp', JSON.stringify(templates), 'utf8'); await rename(target + '.tmp', target);
      return template;
    });
    this.templateLock = work; return work;
  }
  async close() { const jobs = [...this.jobs.values()]; jobs.forEach((job) => job.controller.abort()); await Promise.all(jobs.map(async (job) => { await job.admission?.catch(() => {}); await job.done; })); }
}
