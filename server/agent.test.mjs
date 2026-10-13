import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentBridge } from './agent.mjs';

test('Pi 未配置时明确报错，手动流程不触发模型初始化', async () => {
  const keys = ['PI_PROVIDER', 'PI_MODEL', 'PI_API_KEY'];
  const previous = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => delete process.env[key]);
    const bridge = createAgentBridge({ store: {}, executor: {} });
    assert.equal(bridge.configured, false);
    await assert.rejects(bridge.chat('batch', '开始合并', () => {}), /尚未配置 Pi 模型/);
    await bridge.dispose();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('实际 Pi SDK 的离线流验证批次隔离、启动约束和报告边界', { timeout: 15000 }, async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import('@earendil-works/pi-ai');
  const keys = ['PI_PROVIDER', 'PI_MODEL', 'PI_API_KEY'];
  const previous = keys.map((key) => process.env[key]);
  const originalStream = sdk.ModelRuntime.prototype.streamSimple;
  const originalFetch = globalThis.fetch;
  const faux = createFauxCore({ tokensPerSecond: Infinity });
  const requestedIds = [];
  let enqueueCount = 0;
  const batch = {
    id: 'batch-a', name: '测试批次', status: 'ready',
    files: [{ status: 'uploaded', name: 'private.xlsx', rawData: 'PRIVATE_WORKBOOK' }],
    totalBytes: 100, uploadedBytes: 100,
    progress: { phase: 'ready', message: '等待执行' },
    outputs: [{ name: 'result.xlsx', size: 300, url: '/api/batches/batch-a/outputs/result.xlsx' }],
    summary: { rows: 10, path: 'D:\\private\\secret.xlsx', notes: 'x'.repeat(20000), files: ['PRIVATE_WORKBOOK'] },
  };
  const store = {
    directory: () => process.cwd(),
    get: async (id) => { requestedIds.push(id); assert.equal(id, 'batch-a'); return structuredClone(batch); },
  };
  const executor = { configured: false, enqueue: async (id) => {
    assert.equal(id, 'batch-a'); enqueueCount++; batch.status = 'queued'; return structuredClone(batch);
  } };
  let bridge;
  try {
    process.env.PI_PROVIDER = 'openai';
    process.env.PI_MODEL = 'gpt-4.1';
    process.env.PI_API_KEY = 'test-placeholder-key';
    globalThis.fetch = async () => { throw new Error('测试禁止网络访问'); };
    sdk.ModelRuntime.prototype.streamSimple = (model, context, options) => {
      assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name).sort(),
        ['get_batch_status', 'get_merge_report', 'start_order_merge']);
      const serialized = JSON.stringify(context);
      assert.ok(!serialized.includes('PRIVATE_WORKBOOK'));
      assert.ok(!serialized.includes('private.xlsx'));
      assert.ok(!serialized.includes('secret.xlsx'));
      assert.ok(!serialized.includes(process.cwd().replaceAll('\\', '/')));
      return faux.streamSimple(model, context, options);
    };
    bridge = createAgentBridge({ store, executor });
    assert.equal(bridge.configured, true);
    const emit = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('get_batch_status', { batchId: 'another-batch' })),
      fauxAssistantMessage(fauxToolCall('start_order_merge', {})),
      fauxAssistantMessage(fauxToolCall('get_merge_report', {})),
      (context) => {
        const results = context.messages.filter((message) => message.role === 'toolResult');
        assert.equal(results.length, 3);
        assert.ok(results[1].isError);
        const report = JSON.parse(results[2].content[0].text);
        assert.equal(report.summary.text.length <= 8000, true);
        assert.equal(report.outputs[0].url, batch.outputs[0].url);
        assert.equal(JSON.parse(report.summary.text).files.count, 1);
        return fauxAssistantMessage('测试模型回复：执行器尚未配置。');
      },
    ]);
    await bridge.chat('batch-a', '查询批次并开始合并', (event) => emit.push(event));
    assert.equal(enqueueCount, 0);
    assert.ok(emit.some((event) => event.type === 'text'));
    assert.deepEqual(emit.at(-1), { type: 'done', text: '测试模型回复：执行器尚未配置。' });
    assert.ok(requestedIds.length >= 4);

    executor.configured = true;
    batch.files[0].status = 'pending';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('start_order_merge', {})),
      (context) => {
        const last = context.messages.filter((message) => message.role === 'toolResult').at(-1);
        assert.ok(last.isError);
        assert.match(last.content[0].text, /全部文件上传完成/);
        return fauxAssistantMessage('测试模型回复：请完成上传。');
      },
    ]);
    await bridge.chat('batch-a', '开始合并', () => {});
    assert.equal(enqueueCount, 0);

    batch.files[0].status = 'uploaded';
    let releaseResponse;
    let responseStarted;
    const entered = new Promise((resolve) => { responseStarted = resolve; });
    const release = new Promise((resolve) => { releaseResponse = resolve; });
    faux.setResponses([
      async () => { responseStarted(); await release; return fauxAssistantMessage(fauxToolCall('start_order_merge', {})); },
      fauxAssistantMessage(fauxToolCall('start_order_merge', {})),
      fauxAssistantMessage('测试模型回复：已排队。'),
    ]);
    const currentChat = bridge.chat('batch-a', '现在开始合并', () => {});
    await entered;
    await assert.rejects(bridge.chat('batch-a', '同时开始', () => {}), /正在回复/);
    releaseResponse();
    await currentChat;
    assert.equal(enqueueCount, 1);
    assert.equal(batch.status, 'queued');
  } finally {
    await bridge?.dispose();
    sdk.ModelRuntime.prototype.streamSimple = originalStream;
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
