import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, truncate } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchStore, requireId, activeFiles } from './store.mjs';
import { BatchExecutor } from './executor.mjs';
import { createAgentBridge } from './agent.mjs';
import { WorkbookService } from './workbooks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_SIZE = 4 * 1024 * 1024;
const error = (message, status) => Object.assign(new Error(message), { status });
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function readJson(request, limit = 64 * 1024) {
  let length = 0;
  const pieces = [];
  for await (const piece of request) {
    length += piece.length;
    if (length > limit) throw error('请求内容过大', 413);
    pieces.push(piece);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(pieces).toString('utf8')); }
  catch { throw error('JSON 请求格式无效', 400); }
}

export async function createApp(options = {}) {
  const store = options.store || new BatchStore(options.dataRoot || process.env.BATCH_DATA_DIR || path.join(projectRoot, '.data', 'batches'));
  await store.init();
  const scriptPath = options.scriptPath ?? (process.env.MERGE_SCRIPT ? path.resolve(projectRoot, process.env.MERGE_SCRIPT) : '');
  const pythonCommand = options.pythonCommand || process.env.PYTHON_COMMAND || 'python';
  const workbooks = new WorkbookService(store, pythonCommand);
  const requirePreflight = scriptPath === path.join(projectRoot, 'examples', 'merge_adapter.py');
  const executor = options.executor || new BatchExecutor({ store, scriptPath, pythonCommand, requirePreflight, validateOutputs: (paths, expected, signal, headers) => workbooks.validate(paths, expected, signal, headers) });
  const executorMode = !executor.configured ? 'none' : scriptPath === path.join(projectRoot, 'examples', 'merge_adapter.py') ? 'example' : 'custom';
  const agent = options.agent || createAgentBridge({ store, executor, executorMode });
  const uploading = new Set();
  const finalizing = new Set();
  const chatting = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    try {
      // 本机开发服务仅接受本站请求，防止其他网站向本地应用提交任务。
      const hostName = new URL(`http://${request.headers.host}`).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostName)) throw error('本机原型仅接受本机主机名', 403);
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw error('不接受跨站请求', 403);
      const url = new URL(request.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      if (url.pathname === '/api/config' && method === 'GET') {
        return json(response, 200, { agentConfigured: agent.configured, executorConfigured: executor.configured, executorMode, workflowConfigured: requirePreflight, workspace: '本机开发', maxUploadConcurrency: 3, chunkSize: CHUNK_SIZE });
      }
      if (url.pathname === '/api/templates') {
        if (method === 'GET') return json(response, 200, { templates: await workbooks.templates() });
        if (method === 'POST') { const input = await readJson(request, 1024 * 1024); return json(response, 201, { template: await workbooks.saveTemplate(input.name, input.rules) }); }
      }
      if (url.pathname === '/api/batches') {
        if (method === 'GET') return json(response, 200, { batches: await store.list() });
        if (method === 'POST') return json(response, 201, { batch: await store.create((await readJson(request)).name) });
      }
      if (segments[0] === 'api' && segments[1] === 'batches' && segments[2]) {
        const id = requireId(segments[2]);
        const batch = await store.get(id);
        if (segments.length === 3 && method === 'GET') return json(response, 200, { batch });
        if (segments.length === 4 && segments[3] === 'rules' && method === 'PUT') {
          if (!requirePreflight) throw error('当前自定义脚本未接入字段模板协议，请在适配器中实现后启用', 409);
          const input = await readJson(request, 1024 * 1024);
          let rules = input.rules, template = null;
          if (input.templateId) {
            const saved = (await workbooks.templates()).find((item) => item.id === input.templateId);
            if (!saved) throw error('模板不存在', 404);
            rules = saved.rules; template = { id: saved.id, name: saved.name, version: saved.version };
          }
          return json(response, 200, { batch: await store.setRules(id, rules, template) });
        }
        if (segments.length === 4 && segments[3] === 'check' && method === 'POST') {
          if (!requirePreflight) throw error('当前自定义脚本未接入处理前检查协议', 409);
          return json(response, 202, { batch: await workbooks.check(id) });
        }
        if (segments.length === 4 && segments[3] === 'check-report' && method === 'GET') {
          if (!batch.preflight) throw error('尚无检查报告', 404);
          response.setHeader('content-disposition', "attachment; filename*=UTF-8''check-report.json");
          return json(response, 200, batch.preflight);
        }
        if (segments[3] === 'manifest' && segments.length === 4 && method === 'POST') {
          const input = await readJson(request, 5 * 1024 * 1024);
          return json(response, 200, await store.registerManifest(id, input.files));
        }
        if (segments[3] === 'files') {
          if (segments.length === 4 && method === 'POST') return json(response, 201, { file: await store.registerFile(id, await readJson(request)) });
          const fileId = requireId(segments[4] || '');
          const file = batch.files.find((entry) => entry.id === fileId);
          if (!file) throw error('文件不存在', 404);
          const key = `${id}/${fileId}`;
          if (segments.length === 5 && ['DELETE', 'PATCH'].includes(method)) {
            if (uploading.has(key) || finalizing.has(key)) throw error('请先暂停该文件的上传再修改清单', 409);
            const input = method === 'PATCH' ? await readJson(request) : {};
            return json(response, 200, { batch: await store.editFile(id, fileId, method === 'DELETE' ? 'remove' : input.action, input) });
          }
          if (segments.length === 5 && method === 'PUT') {
            if (!['uploading', 'ready', 'failed', 'interrupted', 'cancelled'].includes(batch.status) || batch.checkState === 'checking' || file.excluded || file.status === 'uploaded') throw error('当前文件不能写入', 409);
            if (uploading.has(key) || finalizing.has(key)) throw error('该文件正在处理另一个上传请求', 409);
            const rawOffset = url.searchParams.get('offset');
            const offset = Number(rawOffset);
            if (rawOffset === null || !Number.isSafeInteger(offset) || offset < 0) throw error('上传偏移量无效', 400);
            uploading.add(key);
            try {
              const destination = store.uploadPath(id, fileId);
              const actual = await stat(destination).then((value) => value.size).catch(() => 0);
              if (actual !== offset) throw error(`上传偏移不一致，服务端已收到 ${actual} 字节，请刷新后续传`, 409);
              let received = 0;
              const limiter = new Transform({ transform(chunk, encoding, callback) {
                received += chunk.length;
                if (received > CHUNK_SIZE || actual + received > file.size) return callback(error('上传分片超过允许大小', 413));
                callback(null, chunk);
              } });
              try {
                await pipeline(request, limiter, createWriteStream(destination, { flags: 'a' }));
              } catch (cause) {
                // 请求中断时回退到分片开始，保留此前完整分片。
                await truncate(destination, actual).catch(() => {});
                throw cause;
              }
              await store.update(id, (value) => {
                const entry = value.files.find((candidate) => candidate.id === fileId);
                entry.bytesReceived = actual + received;
                entry.status = 'uploading';
                value.status = 'uploading';
              });
              return json(response, 200, { bytesReceived: actual + received });
            } finally { uploading.delete(key); }
          }
          if (segments.length === 6 && segments[5] === 'complete' && method === 'POST') {
            if (uploading.has(key) || finalizing.has(key)) throw error('文件仍在处理上传请求', 409);
            const input = await readJson(request);
            if (!/^[a-f0-9]{64}$/i.test(input.sha256 || '')) throw error('需要文件 SHA256 内容校验值', 400);
            finalizing.add(key);
            try { return json(response, 200, { file: await store.finishFile(id, fileId, input.sha256.toLowerCase()) }); }
            finally { finalizing.delete(key); }
          }
        }
        if (segments.length === 4 && segments[3] === 'start' && method === 'POST') {
          if (!executor.configured) throw error('请先在 .env 中接入 Python 合并适配器', 409);
          if (!activeFiles(batch).length || activeFiles(batch).some((file) => file.status !== 'uploaded')) throw error('请先上传完整的批次文件', 409);
          if (!['ready', 'failed', 'interrupted', 'cancelled', 'queued', 'running'].includes(batch.status)) throw error('当前任务不能启动', 409);
          if (batch.checkState === 'checking' || (requirePreflight && !['queued', 'running'].includes(batch.status) && (!batch.preflight?.ok || batch.preflight.inputRevision !== (batch.inputRevision || 0)))) throw error('请先完成处理前检查并修正异常', 409);
          return json(response, 202, { batch: await executor.enqueue(id) });
        }
        if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') return json(response, 200, { batch: await executor.cancel(id) });
        if (segments.length === 4 && segments[3] === 'chat' && method === 'POST') {
          const { message } = await readJson(request);
          if (typeof message !== 'string' || !message.trim() || message.length > 8000) throw error('请输入 1 至 8,000 字的任务说明', 400);
          if (!agent.configured) throw error('请先在 .env 中配置 Pi 模型供应商、模型和密钥', 409);
          if (chatting.has(id)) throw error('当前任务的 Agent 正在回复', 409);
          chatting.add(id);
          let assistantText = '';
          try {
            await store.update(id, (value) => {
              value.messages.push({ role: 'user', content: message.trim(), at: new Date().toISOString() });
              value.messages = value.messages.slice(-100);
            });
            response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
            await agent.chat(id, message.trim(), (event) => {
              if (event.type === 'done') assistantText = event.text || assistantText;
              else if (event.type === 'text') assistantText += event.delta || '';
              if (!response.destroyed) response.write(JSON.stringify(event) + '\n');
            });
            if (assistantText.trim()) await store.update(id, (value) => {
              value.messages.push({ role: 'assistant', content: assistantText, at: new Date().toISOString() });
              value.messages = value.messages.slice(-100);
            });
          } catch (cause) {
            if (!response.destroyed) response.write(JSON.stringify({ type: 'error', message: cause.message }) + '\n');
          } finally { chatting.delete(id); response.end(); }
          return;
        }
        if ([6, 7].includes(segments.length) && segments[3] === 'outputs' && method === 'GET') {
          const attempt = Number(segments[4]);
          const name = segments[5];
          if (!Number.isSafeInteger(attempt) || attempt < 1 || path.basename(name) !== name || /[\\\x00-\x1f]/.test(name)) throw error('结果路径无效', 400);
          const item = batch.outputs.find((entry) => entry.url === `/api/batches/${id}/outputs/${attempt}/${encodeURIComponent(name)}`);
          if (!item) throw error('结果文件不存在', 404);
          const outputDir = path.join(store.directory(id), 'runs', String(attempt), 'outputs');
          const filePath = path.join(outputDir, name);
          if (segments.length === 7) {
            if (segments[6] !== 'preview' || !/\.xlsx$/i.test(name)) throw error('仅支持预览当前 XLSX 成果', 400);
            const raw = url.searchParams.get('offset') || '0', offset = Number(raw);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw error('预览偏移需为 0 至 1,000,000', 400);
            return json(response, 200, { preview: await workbooks.preview(filePath, url.searchParams.get('sheet'), offset) });
          }
          const info = await stat(filePath);
          const type = /\.xlsx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream';
          response.writeHead(200, { 'content-type': type, 'content-length': info.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store' });
          await pipeline(createReadStream(filePath), response);
          return;
        }
      }
      const staticFiles = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (method === 'GET' && staticFiles[url.pathname]) {
        const [name, type] = staticFiles[url.pathname];
        const content = await readFile(path.join(projectRoot, 'public', name));
        response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
        response.end(content);
        return;
      }
      throw error('页面或接口不存在', 404);
    } catch (cause) {
      if (!response.headersSent && !response.destroyed) json(response, cause.status || 500, { error: cause.message || '请求失败' });
      else if (!response.destroyed) response.end();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  return { server, store, executor, agent, workbooks, async close() { await agent.dispose(); await workbooks.close(); await executor.shutdown(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env.PORT || 4317);
  app.server.listen(port, '127.0.0.1', () => console.log(`电商 Work Agent 原型：http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
}
