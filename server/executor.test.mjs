import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { BatchExecutor } from './executor.mjs';

const runner = `
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const manifestPath = args[args.indexOf('--manifest') + 1];
const outputDir = args[args.indexOf('--output-dir') + 1];
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const trace = (kind) => appendFile(manifest.tracePath, JSON.stringify({ kind, batchId: manifest.batchId }) + '\\n');
await trace('start');
await writeFile(join(outputDir, 'manifest-seen.json'), JSON.stringify(manifest));
console.log('an ordinary log line is not a progress event');
if (manifest.mode === 'failure') {
  process.stderr.write('x'.repeat(5000) + ' diagnostic tail');
  process.exit(3);
}
if (manifest.mode === 'wait') {
  process.on('SIGTERM', () => process.exit(0));
  console.log(JSON.stringify({ type: 'progress', phase: 'reading', message: 'waiting', current: 1, total: 2 }));
  await new Promise(resolve => setTimeout(resolve, 10000));
}
if (manifest.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 120));
const steps = manifest.mode === 'progress' ? 150 : 2;
for (let current = 1; current <= steps; current++) {
  console.log(JSON.stringify({ type: 'progress', phase: 'reading', message: 'step ' + current, current, total: steps }));
}
if (manifest.mode !== 'empty') await writeFile(join(outputDir, 'result.xlsx'), 'fixture artifact');
await writeFile(join(outputDir, 'summary.json'), JSON.stringify({ rowCount: 2 }));
await trace('end');
`;

async function waitFor(check, message = '等待执行器状态超时') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(message);
}

async function fixture(t, modes = { first: 'success' }, validation) {
  const root = await mkdtemp(join(tmpdir(), 'pi-executor-'));
  const scriptPath = join(root, 'runner with spaces.mjs');
  const tracePath = join(root, 'trace.jsonl');
  await writeFile(scriptPath, runner);
  const batches = new Map();
  const paths = [];
  const notifications = [];
  for (const id of Object.keys(modes)) {
    const path = join(root, `${id}-input.xlsx`);
    await writeFile(path, 'input fixture');
    batches.set(id, {
      id, status: 'ready', attempt: 0, events: [], outputs: [],
      files: [{ id: `${id}-file`, name: 'input.xlsx', relativePath: 'shop/input.xlsx', path, size: 13, sha256: 'fixture-hash', status: 'uploaded' }],
    });
  }
  const store = {
    root,
    async get(id) {
      if (!batches.has(id)) throw new Error('批次不存在');
      return structuredClone(batches.get(id));
    },
    async update(id, mutator) {
      const batch = structuredClone(batches.get(id));
      if (!batch) throw new Error('批次不存在');
      mutator(batch);
      batches.set(id, batch);
      return structuredClone(batch);
    },
    async executionPaths(id, attempt) {
      const attemptDir = join(root, id, String(attempt));
      const outputDir = join(attemptDir, 'outputs');
      await mkdir(outputDir, { recursive: true });
      const value = { id, attempt, manifestPath: join(attemptDir, 'manifest.json'), outputDir };
      paths.push(value);
      return value;
    },
    async buildManifest(id) {
      return { batchId: id, files: (await this.get(id)).files, mode: modes[id], tracePath };
    },
    async recordOutputs(id, outputDir) {
      const outputs = [];
      for (const name of await readdir(outputDir)) {
        if (!/\.xlsx$/i.test(name)) continue;
        outputs.push({ name, size: (await stat(join(outputDir, name))).size, url: `/batches/${id}/${name}` });
      }
      return outputs;
    },
  };
  // These fixtures exercise scheduling and process events; workbook acceptance
  // is covered by workflow.test.mjs using real XLSX files and the real worker.
  const executor = new BatchExecutor({ store, scriptPath, pythonCommand: process.execPath, onChange: (batch) => notifications.push(batch), validateOutputs: validation || (async () => ({ ok: true, recordCount: 2 })) });
  t.after(async () => {
    await executor.shutdown();
    // Delete only this test's explicit mkdtemp directory.
    assert.equal(resolve(root).startsWith(`${resolve(tmpdir())}\\`) || resolve(root).startsWith(`${resolve(tmpdir())}/`), true);
    assert.match(basename(root), /^pi-executor-/);
    await rm(root, { recursive: true, force: true });
  });
  const completed = (id) => waitFor(async () => {
    const batch = await store.get(id);
    return ['completed', 'failed', 'cancelled', 'interrupted'].includes(batch.status) && batch.finishedAt ? batch : null;
  });
  const trace = async () => {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { store, executor, modes, paths, notifications, completed, trace };
}

test('传递文件清单并发布 XLSX、摘要和真实进度，事件保留最近 100 条', async (t) => {
  const context = await fixture(t, { first: 'progress' });
  assert.equal(context.executor.configured, true);
  const admitted = await context.executor.enqueue('first');
  assert.equal(admitted.status, 'queued');
  const batch = await context.completed('first');
  assert.equal(batch.status, 'completed');
  assert.equal(batch.attempt, 1);
  assert.equal(batch.outputs[0].name, 'result.xlsx');
  assert.deepEqual(batch.summary, { rowCount: 2 });
  assert.ok(context.notifications.some((value) => value.progress?.current === 150));
  assert.equal(batch.events.length, 100);
  assert.equal(batch.events.at(-1).kind, 'completed');
  const seen = JSON.parse(await readFile(join(context.paths[0].outputDir, 'manifest-seen.json'), 'utf8'));
  assert.equal(seen.files[0].relativePath, 'shop/input.xlsx');
  assert.equal(seen.files[0].path, (await context.store.get('first')).files[0].path);
  assert.ok(context.notifications.some((value) => value.progress?.current === 1));
});

test('非零退出保存受限诊断；退出 0 但无 XLSX 仍判失败', async (t) => {
  for (const mode of ['failure', 'empty']) {
    await t.test(mode, async (subtest) => {
      const context = await fixture(subtest, { first: mode });
      await context.executor.enqueue('first');
      const batch = await context.completed('first');
      assert.equal(batch.status, 'failed');
      assert.deepEqual(batch.outputs, []);
      if (mode === 'failure') {
        assert.ok(batch.error.length <= 2000);
        assert.match(batch.error, /进程退出码 3/);
        assert.match(batch.error, /diagnostic tail$/);
      } else assert.match(batch.error, /未生成 XLSX/);
    });
  }
});

test('取消运行进程不会被退出 0 覆盖；排队取消不会启动第二个进程', async (t) => {
  const context = await fixture(t, { first: 'wait', second: 'success' });
  await context.executor.enqueue('first');
  await waitFor(async () => (await context.store.get('first')).progress?.message === 'waiting');
  await context.executor.enqueue('second');
  assert.equal((await context.executor.cancel('second')).status, 'cancelled');
  assert.equal((await context.executor.cancel('first')).status, 'cancelled');
  assert.deepEqual((await context.trace()).map((entry) => entry.batchId), ['first']);
  assert.deepEqual((await context.store.get('first')).outputs, []);
});

test('同一批次重复排队只运行一次，不同批次串行执行', async (t) => {
  const context = await fixture(t, { first: 'slow', second: 'slow' });
  await context.executor.enqueue('first');
  await Promise.all([context.executor.enqueue('second'), context.executor.enqueue('second')]);
  await context.completed('first');
  await context.completed('second');
  assert.deepEqual(await context.trace(), [
    { kind: 'start', batchId: 'first' }, { kind: 'end', batchId: 'first' },
    { kind: 'start', batchId: 'second' }, { kind: 'end', batchId: 'second' },
  ]);
  assert.equal((await context.store.get('second')).attempt, 1);
});

test('已登记为 queued 或 running 的任务不再次启动', async (t) => {
  const context = await fixture(t, { first: 'success', second: 'success' });
  await context.store.update('first', (batch) => { batch.status = 'queued'; });
  await context.store.update('second', (batch) => { batch.status = 'running'; });
  assert.equal((await context.executor.enqueue('first')).status, 'queued');
  assert.equal((await context.executor.enqueue('second')).status, 'running');
  assert.equal((await context.trace()).length, 0);
});

test('失败重试创建新的 attempt 输出目录，清空旧成果', async (t) => {
  const context = await fixture(t, { first: 'empty' });
  await context.executor.enqueue('first');
  assert.equal((await context.completed('first')).status, 'failed');
  context.modes.first = 'success';
  await context.executor.enqueue('first');
  const batch = await context.completed('first');
  assert.equal(batch.status, 'completed');
  assert.equal(batch.attempt, 2);
  assert.equal(batch.outputs.length, 1);
  assert.equal(batch.error, null);
  assert.notEqual(context.paths[0].outputDir, context.paths[1].outputDir);
});

test('shutdown 中断运行和排队任务，随后不再接受任务', async (t) => {
  const context = await fixture(t, { first: 'wait', second: 'success' });
  await context.executor.enqueue('first');
  await waitFor(async () => (await context.store.get('first')).progress?.message === 'waiting');
  await context.executor.enqueue('second');
  await context.executor.shutdown();
  assert.equal((await context.store.get('first')).status, 'interrupted');
  assert.equal((await context.store.get('second')).status, 'interrupted');
  assert.equal((await context.trace()).length, 1);
  await assert.rejects(context.executor.enqueue('first'), /已关闭/);
});

test('拒绝未配置执行器及尚未上传完成的文件', async (t) => {
  const context = await fixture(t);
  const unconfigured = new BatchExecutor({ store: context.store });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(unconfigured.enqueue('first'), /尚未配置/);
  await context.store.update('first', (batch) => { batch.files[0].status = 'pending'; });
  await assert.rejects(context.executor.enqueue('first'), /完成文件上传/);
  assert.equal((await context.trace()).length, 0);
});

test('进程无法启动时记录 failed 状态', async (t) => {
  const context = await fixture(t);
  await context.executor.shutdown();
  const missing = new BatchExecutor({ store: context.store, scriptPath: 'script.py', pythonCommand: join(context.store.root, 'missing-python') });
  t.after(() => missing.shutdown());
  await missing.enqueue('first');
  assert.equal((await context.completed('first')).status, 'failed');
});

test('成果验收期间仍可取消，取消不会被后续完成覆盖', async (t) => {
  let validating = false;
  const context = await fixture(t, { first: 'success' }, async (_paths, _expected, signal) => {
    validating = true;
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('验收已中止'));
      else signal.addEventListener('abort', () => reject(new Error('验收已中止')), { once: true });
    });
    return { ok: true, recordCount: 2 };
  });
  await context.executor.enqueue('first');
  await waitFor(() => validating);
  const cancelled = await context.executor.cancel('first');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.outputs, []);
  assert.equal(cancelled.validation, null);
});
