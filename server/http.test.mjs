import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createApp } from './index.mjs';

async function setup(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-work-http-'));
  const executor = { configured: false, async shutdown() {} };
  const agent = { configured: false, async dispose() {} };
  const app = await createApp({ dataRoot: root, executor, agent });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, async call(route, method = 'GET', body, headers = {}) {
    const response = await fetch(base + route, { method, headers: body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json', ...headers } : headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  } };
}
test('分片续传、偏移冲突、完整校验以及未接执行器的真实提示', async (context) => {
  const app = await setup(context);
  const { data: { batch } } = await app.call('/api/batches', 'POST', { name: '中文任务' });
  const content = Buffer.from('PK fixture contents for chunks');
  const { data: { files } } = await app.call(`/api/batches/${batch.id}/manifest`, 'POST', { files: [{ name: '订单.xlsx', relativePath: '店铺/订单.xlsx', size: content.length }] });
  const route = `/api/batches/${batch.id}/files/${files[0].id}`;
  assert.equal((await app.call(route + '?offset=0', 'PUT', content.subarray(0, 8))).status, 200);
  assert.equal((await app.call(route + '?offset=0', 'PUT', content.subarray(8))).status, 409);
  assert.equal((await app.call(route + '?offset=8', 'PUT', content.subarray(8))).status, 200);
  assert.equal((await app.call(route + '/complete', 'POST', { sha256: '0'.repeat(64) })).status, 409);
  const sha256 = createHash('sha256').update(content).digest('hex');
  assert.equal((await app.call(route + '/complete', 'POST', { sha256 })).status, 200);
  assert.equal((await app.call(route + '/complete', 'POST', { sha256 })).status, 200);
  const result = await app.call(`/api/batches/${batch.id}`);
  assert.equal(result.data.batch.uploadedBytes, content.length);
  assert.equal(result.data.batch.status, 'ready');
  const start = await app.call(`/api/batches/${batch.id}/start`, 'POST', {});
  assert.equal(start.status, 409);
  assert.match(start.data.error, /Python/);
});
test('读取接口不返回配置密钥，跨站调用被阻止，未知工具未伪造答复', async (context) => {
  const app = await setup(context);
  const config = await app.call('/api/config');
  assert.equal(config.data.agentConfigured, false);
  assert.equal('PI_API_KEY' in config.data, false);
  const denied = await app.call('/api/batches', 'POST', { name: '跨站' }, { origin: 'https://example.com' });
  assert.equal(denied.status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.base + '/api/config', { headers: { host: 'example.com' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  const { data: { batch } } = await app.call('/api/batches', 'POST', {});
  const chat = await app.call(`/api/batches/${batch.id}/chat`, 'POST', { message: '开始合并' });
  assert.equal(chat.status, 409);
  assert.match(chat.data.error, /配置 Pi/);
});
test('输出下载受当前任务成果清单限制', async (context) => {
  const app = await setup(context);
  const { data: { batch } } = await app.call('/api/batches', 'POST', {});
  await app.store.update(batch.id, (value) => { value.attempt = 1; });
  const { outputDir } = await app.store.executionPaths(batch.id, 1);
  await writeFile(path.join(outputDir, '结果.xlsx'), Buffer.from('PK output'));
  await app.store.update(batch.id, async (value) => { value.outputs = await app.store.recordOutputs(batch.id, outputDir); });
  const completed = await app.store.get(batch.id);
  const response = await fetch(app.base + completed.outputs[0].url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'PK output');
  assert.equal((await app.call(`/api/batches/${batch.id}/outputs/1/secret.xlsx`)).status, 404);
});
