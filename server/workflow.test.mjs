import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createApp } from './index.mjs';
import { BatchStore, activeFiles, validateRules } from './store.mjs';
import { WorkbookService } from './workbooks.mjs';

const adapter = fileURLToPath(new URL('../examples/merge_adapter.py', import.meta.url));
const fixtureScript = `
import sys
from pathlib import Path
from openpyxl import Workbook
root=Path(sys.argv[1])
for name, header, rows in [('good.xlsx',['订单号','金额'],[['0001',2]]),('bad.xlsx',['订单号','金额'],[['0002','=1+1']]),('fixed.xlsx',['订单号','金额'],[['0002',3]]),('mapped.xlsx',['交易号','支付金额'],[['0003',4]])]:
    w=Workbook(); s=w.active; s.title='订单'; s.append(header)
    for row in rows: s.append(row)
    w.save(root/name); w.close()
`;

async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error('工作流状态等待超时');
}

async function setup(t, customScript = null) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-workflow-http-'));
  const generated = spawnSync('python', ['-c', fixtureScript, root], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  let scriptPath = adapter;
  if (customScript) { scriptPath = path.join(root, 'custom.py'); await writeFile(scriptPath, customScript); }
  const app = await createApp({ dataRoot: path.join(root, 'batches'), scriptPath, agent: { configured: false, async dispose() {} } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.match(path.basename(root), /^pi-workflow-http-/);
    await rm(root, { recursive: true, force: true });
  });
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const batch = (await call('/api/batches', 'POST', { name: '真实工作簿流程' })).data.batch;
  const route = `/api/batches/${batch.id}`;
  const upload = async (sourceName, remoteName = sourceName, existingId = null) => {
    const bytes = await readFile(path.join(root, sourceName));
    let id = existingId;
    if (!id) id = (await call(route + '/files', 'POST', { name: remoteName, relativePath: `shop/${remoteName}`, size: bytes.length })).data.file.id;
    assert.equal((await call(`${route}/files/${id}?offset=0`, 'PUT', bytes)).status, 200);
    const completed = await call(`${route}/files/${id}/complete`, 'POST', { sha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(completed.status, 200); return completed.data.file;
  };
  const check = async () => {
    assert.equal((await call(route + '/check', 'POST')).status, 202);
    return waitFor(async () => { const current = (await call(route)).data.batch; return current.checkState !== 'checking' ? current : null; });
  };
  const run = async () => {
    assert.equal((await call(route + '/start', 'POST')).status, 202);
    return waitFor(async () => { const current = (await call(route)).data.batch; return ['completed', 'failed'].includes(current.status) ? current : null; });
  };
  return { app, root, base, call, batch, route, upload, check, run };
}

test('真实 XLSX：异常替换、检查点局部复用、合并验收和分页预览', { timeout: 30000 }, async (t) => {
  const flow = await setup(t);
  await flow.upload('good.xlsx');
  const bad = await flow.upload('bad.xlsx');
  assert.equal((await flow.call(flow.route + '/start', 'POST')).status, 409);
  const failed = await flow.check();
  assert.equal(failed.preflight.successCount, 1);
  assert.equal(failed.preflight.failedCount, 1);
  assert.equal(failed.preflight.issues[0].row, 2);
  const replacement = await readFile(path.join(flow.root, 'fixed.xlsx'));
  const edited = await flow.call(`${flow.route}/files/${bad.id}`, 'PATCH', { action: 'replace', name: 'bad.xlsx', relativePath: 'shop/bad.xlsx', size: replacement.length });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.batch.preflight, null);
  const newId = edited.data.batch.files.find((file) => file.name === 'bad.xlsx').id;
  assert.notEqual(newId, bad.id);
  assert.equal((await flow.call(`${flow.route}/files/${bad.id}/complete`, 'POST', { sha256: '0'.repeat(64) })).status, 404);
  await flow.upload('fixed.xlsx', 'bad.xlsx', newId);
  const checked = await flow.check();
  assert.equal(checked.preflight.ok, true, checked.progress.message);
  assert.equal(checked.preflight.cachedCount, 1);
  const completed = await flow.run();
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.validation.recordCount, 2);
  assert.equal(completed.summary.recordCount, 2);
  const output = completed.outputs.find((file) => file.name.endsWith('.xlsx'));
  const preview = await flow.call(output.url + '/preview');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.preview.rows.map((row) => row[0]), ['0001', '0002']);
  assert.equal(preview.data.preview.headers.at(-1), '_来源行号');
  assert.equal((await flow.call(output.url + '/preview?offset=-1')).status, 400);
  assert.equal((await flow.call(output.url.replace('merged-001.xlsx', 'secret.xlsx') + '/preview')).status, 404);
  const download = await fetch(flow.base + output.url);
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.ok(completed.outputs.some((file) => file.name === 'summary.json'));
  assert.equal((await flow.call(flow.route + '/check-report')).data.recordCount, 2);
  const list = (await flow.call('/api/batches')).data.batches;
  assert.equal('preflight' in list[0], false);
});

test('确认映射模板版本持久保存，在新批次应用后保持相同输出规则', { timeout: 30000 }, async (t) => {
  const flow = await setup(t);
  await flow.upload('good.xlsx'); await flow.upload('mapped.xlsx');
  const first = await flow.check();
  assert.equal(first.preflight.failedCount, 1);
  const rules = { columns: ['订单号', '金额'], mappings: [{ headers: ['交易号', '支付金额'], targets: { 交易号: '订单号', 支付金额: '金额' } }], sheetNames: ['订单'] };
  const saved = await flow.call('/api/templates', 'POST', { name: '订单模板', rules });
  assert.equal(saved.status, 201);
  const second = await flow.call('/api/templates', 'POST', { name: '订单模板', rules });
  assert.equal(second.data.template.version, 2);
  assert.notEqual(saved.data.template.id, second.data.template.id);
  assert.equal((await flow.call(flow.route + '/rules', 'PUT', { templateId: saved.data.template.id })).status, 200);
  const checked = await flow.check();
  assert.equal(checked.preflight.ok, true, checked.progress.message);
  const completed = await flow.run();
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.summary.template.version, 1);
  const result = (await flow.call(completed.outputs.find((file) => file.name.endsWith('.xlsx')).url + '/preview')).data.preview;
  assert.deepEqual(result.rows.map((row) => row.slice(0, 2)), [['0001', '2'], ['0003', '4']]);
  const fresh = (await flow.call('/api/batches', 'POST', { name: '下月任务' })).data.batch;
  const applied = await flow.call(`/api/batches/${fresh.id}/rules`, 'PUT', { templateId: saved.data.template.id });
  assert.deepEqual(applied.data.batch.rules, rules);
  const reopened = new BatchStore(flow.app.store.root); await reopened.init();
  assert.equal((await reopened.get(fresh.id)).template.version, 1);
  const persisted = JSON.parse(await readFile(path.join(flow.app.store.root, 'templates.json'), 'utf8'));
  assert.equal(persisted.length, 2);
  assert.equal((await new WorkbookService(reopened).templates())[0].id, saved.data.template.id);
});

test('排除原因、清单移除与修改锁：未上传排除项不阻断处理，检查后修改必须重检', { timeout: 30000 }, async (t) => {
  const flow = await setup(t);
  const good = await flow.upload('good.xlsx');
  const pending = (await flow.call(flow.route + '/files', 'POST', { name: 'old.xlsx', size: 10 })).data.file;
  assert.equal((await flow.call(`${flow.route}/files/${pending.id}`, 'PATCH', { action: 'exclude', reason: '' })).status, 400);
  const excluded = await flow.call(`${flow.route}/files/${pending.id}`, 'PATCH', { action: 'exclude', reason: '不属于本期' });
  assert.equal(excluded.status, 200);
  assert.equal(activeFiles(excluded.data.batch).length, 1);
  assert.equal((await flow.call(flow.route + '/check', 'POST')).status, 202);
  assert.equal((await flow.call(`${flow.route}/files/${good.id}`, 'DELETE')).status, 409);
  await waitFor(async () => (await flow.call(flow.route)).data.batch.checkState !== 'checking');
  assert.equal((await flow.call(`${flow.route}/files/${pending.id}`, 'DELETE')).status, 200);
  assert.equal((await flow.call(flow.route + '/start', 'POST')).status, 409);
  await flow.check();
  const completed = await flow.run(); assert.equal(completed.status, 'completed', completed.error);
  assert.equal((await flow.call(`${flow.route}/files/${good.id}`, 'DELETE')).status, 409);
});

test('自定义适配器退出 0 并生成伪 XLSX 时，真实成果验收仍判失败', { timeout: 30000 }, async (t) => {
  const flow = await setup(t, "import argparse\nfrom pathlib import Path\np=argparse.ArgumentParser();p.add_argument('--manifest');p.add_argument('--output-dir');a=p.parse_args();Path(a.output_dir,'broken.xlsx').write_text('not a workbook')\n");
  await flow.upload('good.xlsx');
  const result = await flow.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.outputs.length, 0);
  assert.equal(result.validation, null);
  assert.match(result.error, /zip|workbook/i);
});

test('无效模板映射与 Excel 临时文件拒绝登记，且不会留下部分修改', async (t) => {
  const flow = await setup(t);
  assert.throws(() => validateRules({ columns: ['ID'], mappings: [{ headers: ['a', 'b'], targets: { a: 'ID', b: 'ID' } }], sheetNames: [] }), /同一个/);
  assert.equal((await flow.call('/api/templates', 'POST', { name: '坏模板', rules: { columns: ['ID'], mappings: [{ headers: ['a'], targets: { a: '不存在' } }], sheetNames: [] } })).status, 400);
  assert.equal((await flow.call(flow.route + '/manifest', 'POST', { files: [{ name: 'good.xlsx', size: 10 }, { name: '~$good.xlsx', size: 10 }] })).status, 400);
  assert.equal((await flow.call(flow.route)).data.batch.fileCount, 0);
  assert.equal((await flow.call(flow.route + '/manifest', 'POST', { files: [null] })).status, 400);
});

test('后台检查中断后保留成功检查点，恢复时不采用过期通过状态', { timeout: 30000 }, async (t) => {
  const flow = await setup(t);
  await flow.upload('good.xlsx');
  const checked = await flow.check(); assert.equal(checked.preflight.ok, true);
  await flow.app.store.update(flow.batch.id, (batch) => { batch.checkState = 'checking'; });
  const reopened = new BatchStore(flow.app.store.root); await reopened.init();
  const recovered = await reopened.get(flow.batch.id);
  assert.equal(recovered.checkState, 'interrupted'); assert.equal(recovered.preflight, null);
  const service = new WorkbookService(reopened);
  await service.check(flow.batch.id);
  const passed = await waitFor(async () => { const current = await reopened.get(flow.batch.id); return current.checkState === 'passed' ? current : null; });
  assert.equal(passed.preflight.cachedCount, 1);
  await service.close();
});
