import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeFiles } from './store.mjs';
import { validateWorkbookOutputs } from './workbooks.mjs';

const now = () => new Date().toISOString();

function event(batch, kind, message) {
  batch.events = [...(batch.events ?? []), { at: now(), kind, message }].slice(-100);
}

function progressValue(value) {
  if (!value || value.type !== 'progress' || typeof value.message !== 'string') return null;
  const progress = {
    phase: typeof value.phase === 'string' ? value.phase.slice(0, 100) : 'processing',
    message: value.message.slice(0, 1000),
  };
  for (const key of ['current', 'total']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) progress[key] = value[key];
  }
  return progress;
}

export class BatchExecutor {
  #store;
  #scriptPath;
  #pythonCommand;
  #onChange;
  #jobs = new Map();
  #queue = [];
  #active = null;
  #closed = false;
  #validateOutputs;
  #requirePreflight;

  constructor({ store, scriptPath, pythonCommand = 'python', onChange, validateOutputs = (paths, expected, signal, expectedHeaders) => validateWorkbookOutputs(paths, expected, { signal, expectedHeaders }), requirePreflight = false }) {
    this.#store = store;
    this.#scriptPath = scriptPath;
    this.#pythonCommand = pythonCommand;
    this.#onChange = onChange;
    this.#validateOutputs = validateOutputs;
    this.#requirePreflight = requirePreflight;
  }

  get configured() {
    return typeof this.#scriptPath === 'string' && this.#scriptPath.trim() !== ''
      && typeof this.#pythonCommand === 'string' && this.#pythonCommand.trim() !== '';
  }

  async #update(id, mutator) {
    const batch = await this.#store.update(id, mutator);
    // A disconnected UI subscriber must not fail a business task.
    try { await this.#onChange?.(batch); } catch { /* notification only */ }
    return batch;
  }

  async enqueue(batchId) {
    if (!this.configured) throw new Error('尚未配置 Python 执行脚本');
    if (this.#closed) throw new Error('执行器已关闭');
    const existing = this.#jobs.get(batchId);
    if (existing) {
      await existing.admission;
      return this.#store.get(batchId);
    }

    const job = { id: batchId, cancelled: false, interrupted: false, child: null, controller: new AbortController() };
    job.permit = new Promise((resolve) => { job.release = resolve; });
    this.#jobs.set(batchId, job);
    job.admission = this.#update(batchId, (batch) => {
      if (['queued', 'running'].includes(batch.status)) {
        job.skip = true;
        return;
      }
      if (!['ready', 'failed', 'interrupted', 'cancelled'].includes(batch.status)
        || !Array.isArray(batch.files) || activeFiles(batch).length === 0
        || activeFiles(batch).some((file) => file.status !== 'uploaded') || batch.checkState === 'checking') {
        throw new Error('批次必须完成文件上传后才能执行');
      }
      if (this.#requirePreflight && (!batch.preflight?.ok || batch.preflight.inputRevision !== (batch.inputRevision || 0))) throw new Error('请先完成本批次的处理前检查并修正异常');
      batch.status = 'queued';
      batch.progress = { phase: 'queued', message: '等待执行' };
      batch.error = null;
      batch.outputs = [];
      batch.summary = null;
      batch.validation = null;
      batch.startedAt = null;
      batch.finishedAt = null;
      event(batch, 'queued', '等待执行');
    });
    job.done = job.admission.then(async (batch) => {
      if (job.skip) return batch;
      job.admitted = true;
      if (job.cancelled || job.interrupted) job.release();
      else {
        this.#queue.push(job);
        this.#pump();
      }
      await job.permit;
      return this.#run(job);
    }).catch(async (error) => {
      // Admission errors are returned to enqueue(), not turned into a run.
      if (!job.admitted) return null;
      return this.#terminal(job, 'failed', String(error.message ?? error).slice(-2000));
    }).finally(() => {
      this.#jobs.delete(batchId);
      if (this.#active === job) this.#active = null;
      this.#pump();
    });
    // Persistence failures remain visible to cancellation/shutdown callers,
    // while a background run must not create an unhandled rejection.
    job.done.catch(() => {});
    return job.admission;
  }

  #pump() {
    if (this.#closed || this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active = job;
    job.release();
  }

  async #terminal(job, status, error = null, result = {}) {
    return this.#update(job.id, (batch) => {
      const finalStatus = job.cancelled ? 'cancelled' : job.interrupted ? 'interrupted' : status;
      if (batch.status === finalStatus && batch.finishedAt) return;
      batch.status = finalStatus;
      batch.finishedAt = now();
      batch.error = finalStatus === 'failed' ? error : null;
      batch.outputs = finalStatus === 'completed' ? result.outputs : [];
      batch.summary = finalStatus === 'completed' ? result.summary ?? null : null;
      batch.validation = finalStatus === 'completed' ? result.validation ?? null : null;
      const messages = {
        completed: '执行完成，结果文件已生成',
        failed: '执行失败',
        cancelled: '已取消执行',
        interrupted: '服务停止，执行已中断',
      };
      batch.progress = { ...(batch.progress ?? {}), phase: finalStatus, message: messages[finalStatus] };
      event(batch, finalStatus, messages[finalStatus]);
    });
  }

  async #run(job) {
    try {
      if (job.cancelled || job.interrupted) return this.#terminal(job, 'cancelled');
      const batch = await this.#update(job.id, (value) => {
        value.attempt = (Number.isInteger(value.attempt) ? value.attempt : 0) + 1;
        value.status = 'running';
        value.startedAt = now();
        value.progress = { phase: 'running', message: '开始执行' };
        event(value, 'running', '开始执行');
      });
      const { manifestPath, outputDir } = await this.#store.executionPaths(job.id, batch.attempt);
      const manifest = await this.#store.buildManifest(job.id);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      if (job.cancelled || job.interrupted) return this.#terminal(job, 'cancelled');

      const child = spawn(this.#pythonCommand, [
        this.#scriptPath, '--manifest', manifestPath, '--output-dir', outputDir,
      ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      job.child = child;
      let stderr = '';
      let buffer = '';
      let discardLine = false;
      let writes = Promise.resolve();
      let processError = null;
      const consumeLine = (line) => {
        let progress;
        try { progress = progressValue(JSON.parse(line)); } catch { return; }
        if (!progress || job.cancelled || job.interrupted) return;
        writes = writes.then(async () => {
          if (job.cancelled || job.interrupted) return;
          await this.#update(job.id, (value) => {
            if (value.status !== 'running' || job.cancelled || job.interrupted) return;
            value.progress = progress;
            event(value, 'progress', progress.message);
          });
        });
        // Keep a rejection observed while the child is still running.
        writes.catch(() => {});
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const parts = chunk.split('\n');
        for (let index = 0; index < parts.length; index += 1) {
          if (!discardLine) {
            buffer += parts[index];
            if (buffer.length > 16_384) { buffer = ''; discardLine = true; }
          }
          if (index < parts.length - 1) {
            if (!discardLine) consumeLine(buffer);
            buffer = '';
            discardLine = false;
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      const outcome = await new Promise((resolve) => {
        child.on('error', (error) => { processError = error; });
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      job.child = null;
      if (buffer && !discardLine) consumeLine(buffer);
      await writes;
      if (job.cancelled || job.interrupted) return this.#terminal(job, 'cancelled');
      if (processError || outcome.code !== 0) {
        const reason = processError?.message
          ?? `进程退出码 ${outcome.code ?? '未知'}${outcome.signal ? ` (${outcome.signal})` : ''}`;
        const header = reason.slice(0, 400);
        const diagnostic = stderr ? `${header}\n${stderr.slice(-(1999 - header.length))}` : header;
        return this.#terminal(job, 'failed', diagnostic);
      }

      const outputs = await this.#store.recordOutputs(job.id, outputDir);
      if (!outputs.some((output) => /\.xlsx$/i.test(output.name))) {
        return this.#terminal(job, 'failed', '执行脚本正常退出，但未生成 XLSX 结果文件');
      }
      let summary = null;
      try {
        const summaryPath = join(outputDir, 'summary.json');
        const info = await lstat(summaryPath);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 65_536) {
          summary = JSON.parse(await readFile(summaryPath, 'utf8'));
        }
      } catch { /* summary.json is optional */ }
      await this.#update(job.id, (value) => { value.progress = { phase: 'validating', message: '正在检查成果可读性与记录数量' }; });
      const expectedRecords = this.#requirePreflight ? batch.preflight.recordCount : Number.isSafeInteger(summary?.recordCount) ? summary.recordCount : undefined;
      let validation;
      try {
        validation = await this.#validateOutputs(outputs.filter((output) => /\.xlsx$/i.test(output.name)).map((output) => join(outputDir, output.name)), expectedRecords, job.controller.signal, this.#requirePreflight ? [...batch.preflight.columns, '_来源文件', '_来源工作表', '_来源行号'] : undefined);
      } catch (error) { throw new Error(`成果验收失败：${error.message}`); }
      return this.#terminal(job, 'completed', null, { outputs, summary, validation });
    } catch (error) {
      return this.#terminal(job, 'failed', String(error.message ?? error).slice(-2000));
    }
  }

  async cancel(batchId) {
    const job = this.#jobs.get(batchId);
    if (!job) return this.#store.get(batchId);
    job.cancelled = true;
    job.controller.abort();
    this.#queue = this.#queue.filter((item) => item !== job);
    job.child?.kill();
    job.release();
    await job.done;
    // Cancellation can arrive while the successful result is being persisted.
    return this.#terminal(job, 'cancelled');
  }

  async shutdown() {
    this.#closed = true;
    this.#queue = [];
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      job.interrupted = true;
      job.controller.abort();
      job.child?.kill();
      job.release();
    }
    await Promise.all(jobs.map(async (job) => {
      await job.done;
      if (job.admitted) await this.#terminal(job, 'interrupted');
    }));
  }
}
