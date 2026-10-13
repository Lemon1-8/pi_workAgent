import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BatchStore } from './store.mjs';

async function setup(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-work-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BatchStore(directory);
  await store.init();
  return store;
}
test('清单整体校验；无效路径不留下部分登记', async (context) => {
  const store = await setup(context);
  const batch = await store.create('测试');
  await assert.rejects(store.registerManifest(batch.id, [
    { name: 'a.xlsx', relativePath: '店铺/a.xlsx', size: 10 },
    { name: 'b.xlsx', relativePath: '../b.xlsx', size: 10 },
  ]), /无效/);
  assert.equal((await store.get(batch.id)).fileCount, 0);
});
test('并行更新不丢文件，持久记录重启可读', async (context) => {
  const store = await setup(context);
  const batch = await store.create('多店铺');
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.registerFile(batch.id, { name: `${index}.xlsx`, size: 10 })));
  assert.equal((await store.get(batch.id)).fileCount, 20);
  const restarted = new BatchStore(store.root);
  await restarted.init();
  assert.equal((await restarted.get(batch.id)).files.length, 20);
});
test('上传哈希验证，重复完成不会重复计数', async (context) => {
  const store = await setup(context);
  const batch = await store.create('来源');
  const content = Buffer.from('PK fixture upload bytes');
  const file = await store.registerFile(batch.id, { name: 'a.xlsx', size: content.length });
  await writeFile(store.uploadPath(batch.id, file.id), content);
  await assert.rejects(store.finishFile(batch.id, file.id, '0'.repeat(64)), /校验失败/);
  assert.equal((await store.get(batch.id)).files[0].status, 'pending');
  const hash = createHash('sha256').update(content).digest('hex');
  await store.finishFile(batch.id, file.id, hash);
  await store.finishFile(batch.id, file.id, hash);
  const result = await store.get(batch.id);
  assert.equal(result.status, 'ready');
  assert.equal(result.fileCount, 1);
  assert.equal(result.uploadedBytes, content.length);
  await assert.rejects(store.finishFile(batch.id, file.id, 'f'.repeat(64)), /不一致/);
});
test('同相对路径的新版本不能混入续传批次', async (context) => {
  const store = await setup(context);
  const batch = await store.create('版本');
  await store.registerManifest(batch.id, [{ name: 'a.xlsx', size: 10, lastModified: 100 }]);
  await assert.rejects(store.registerManifest(batch.id, [{ name: 'a.xlsx', size: 10, lastModified: 200 }]), /版本改变/);
  assert.equal((await store.get(batch.id)).fileCount, 1);
});
test('重启保留已接收分片，运行任务转为可见中断', async (context) => {
  const store = await setup(context);
  const batch = await store.create('恢复');
  const file = await store.registerFile(batch.id, { name: 'a.xlsx', size: 10 });
  await writeFile(store.uploadPath(batch.id, file.id), 'PK123');
  await store.update(batch.id, (value) => { value.status = 'running'; });
  const restarted = new BatchStore(store.root);
  await restarted.init();
  const result = await restarted.get(batch.id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.files[0].bytesReceived, 5);
  assert.equal(await readFile(store.uploadPath(batch.id, file.id), 'utf8'), 'PK123');
});
