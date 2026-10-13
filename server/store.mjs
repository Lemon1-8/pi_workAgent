import { mkdir, readdir, readFile, writeFile, rename, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uploadable = new Set(['uploading', 'ready', 'failed', 'interrupted', 'cancelled']);
export const activeFiles = (batch) => batch.files.filter((file) => !file.excluded);
export const defaultRules = () => ({ columns: [], mappings: [], sheetNames: [] });
export function invalidateCheck(batch) {
  batch.inputRevision = (batch.inputRevision || 0) + 1;
  if (batch.preflight) batch.lastPreflight = batch.preflight;
  batch.preflight = null;
  batch.checkState = 'idle';
  batch.outputs = []; batch.summary = null; batch.validation = null; batch.error = null;
  const files = activeFiles(batch);
  batch.status = files.length && files.every((file) => file.status === 'uploaded') ? 'ready' : 'uploading';
  batch.progress = { phase: batch.status, message: '输入或规则已更新，请重新检查' };
}
export function requireEditable(batch) {
  if (!uploadable.has(batch.status) || batch.checkState === 'checking') throw Object.assign(new Error('当前任务正在检查、执行或已完成，不能修改输入'), { status: 409 });
}
export function validateRules(input) {
  if (!input || !Array.isArray(input.columns) || !Array.isArray(input.mappings) || !Array.isArray(input.sheetNames)) throw Object.assign(new Error('模板规则格式无效'), { status: 400 });
  const strings = (values, max) => values.length <= max && values.every((value) => typeof value === 'string' && value.trim() && value.length <= 240) && new Set(values).size === values.length;
  if (!strings(input.columns, 512) || !strings(input.sheetNames, 512) || input.columns.some((name) => ['_来源文件', '_来源工作表', '_来源行号'].includes(name)) || input.mappings.length > 1000) throw Object.assign(new Error('字段或工作表名称无效、重复或超过上限'), { status: 400 });
  const mappings = input.mappings.map((item) => {
    if (!item || !Array.isArray(item.headers) || !strings(item.headers, 512) || !item.headers.length || !item.targets || typeof item.targets !== 'object' || Array.isArray(item.targets)) throw Object.assign(new Error('字段映射格式无效'), { status: 400 });
    for (const [source, target] of Object.entries(item.targets)) if (!item.headers.includes(source) || (target !== null && !input.columns.includes(target))) throw Object.assign(new Error('映射指向了不存在的字段'), { status: 400 });
    const targets = Object.values(item.targets).filter((value) => value !== null);
    if (new Set(targets).size !== targets.length) throw Object.assign(new Error('多个来源字段不能映射到同一个结果字段'), { status: 400 });
    return { headers: item.headers, targets: item.targets };
  });
  if (new Set(mappings.map((item) => JSON.stringify([...item.headers].sort()))).size !== mappings.length) throw Object.assign(new Error('同一来源字段组合只能配置一套映射'), { status: 400 });
  return { columns: input.columns, mappings, sheetNames: input.sheetNames };
}
export function requireId(id) {
  if (!uuid.test(id)) throw Object.assign(new Error('无效的任务或文件标识'), { status: 400 });
  return id;
}
export function appendEvent(batch, kind, message) {
  batch.events.push({ at: new Date().toISOString(), kind, message });
  batch.events = batch.events.slice(-100);
}
export function summaryOf(batch) {
  const { files, messages, events, preflight, lastPreflight, rules, ...summary } = batch;
  return summary;
}

export class BatchStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.batches = new Map();
    this.locks = new Map();
  }
  directory(id) { return path.join(this.root, requireId(id)); }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const batch = JSON.parse(await readFile(path.join(this.directory(entry.name), 'batch.json'), 'utf8'));
      this.batches.set(entry.name, batch);
      if (batch.checkState === 'checking') await this.update(entry.name, (value) => { value.checkState = 'interrupted'; value.preflight = null; value.progress = { phase: 'check_interrupted', message: '后台检查中断，请重新检查；成功解析的文件检查点已保留' }; });
      if (['running', 'queued'].includes(batch.status)) {
        await this.update(entry.name, (value) => {
          value.status = 'interrupted';
          value.progress = { phase: 'interrupted', message: '后台进程中断，输入文件已保留，可重新运行整批任务' };
          appendEvent(value, 'warning', value.progress.message);
        });
      }
      for (const file of batch.files) {
        if (file.status === 'uploaded') continue;
        const size = await stat(this.uploadPath(entry.name, file.id)).then((value) => value.size).catch(() => 0);
        await this.update(entry.name, (value) => {
          const stored = value.files.find((item) => item.id === file.id);
          stored.bytesReceived = size;
          stored.status = size ? 'uploading' : 'pending';
        });
      }
    }
  }
  async persist(batch) {
    const directory = this.directory(batch.id);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, 'batch.json.tmp');
    await writeFile(temporary, JSON.stringify(batch), 'utf8');
    await rename(temporary, path.join(directory, 'batch.json'));
  }
  async create(name) {
    const now = new Date().toISOString();
    const batch = {
      id: randomUUID(), name: String(name || '订单合并任务').trim().slice(0, 120) || '订单合并任务',
      status: 'uploading', createdAt: now, updatedAt: now, files: [], outputs: [], messages: [], events: [],
      fileCount: 0, totalBytes: 0, uploadedBytes: 0,
      progress: { phase: 'uploading', message: '选择文件夹，确认本批文件后上传' },
      inputRevision: 0, rules: defaultRules(), preflight: null, checkState: 'idle',
    };
    await this.persist(batch);
    this.batches.set(batch.id, batch);
    return structuredClone(batch);
  }
  async get(id) {
    requireId(id);
    const batch = this.batches.get(id);
    if (!batch) throw Object.assign(new Error('任务不存在'), { status: 404 });
    return structuredClone(batch);
  }
  async list() {
    return [...this.batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summaryOf);
  }
  async update(id, mutate) {
    requireId(id);
    const previous = this.locks.get(id) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const batch = await this.get(id);
      await mutate(batch);
      batch.updatedAt = new Date().toISOString();
      batch.fileCount = batch.files.length;
      batch.totalBytes = batch.files.reduce((sum, file) => sum + file.size, 0);
      batch.uploadedBytes = batch.files.reduce((sum, file) => sum + file.bytesReceived, 0);
      await this.persist(batch);
      this.batches.set(id, batch);
      return structuredClone(batch);
    });
    this.locks.set(id, work.then(() => {}, () => {}));
    return work;
  }
  uploadPath(batchId, fileId, complete = false) {
    return path.join(this.directory(batchId), 'inputs', `${requireId(fileId)}${complete ? '.xlsx' : '.part'}`);
  }
  async registerFile(batchId, input) {
    if (!input || typeof input !== 'object') throw Object.assign(new Error('文件信息无效'), { status: 400 });
    const name = String(input.name || '');
    const relativePath = String(input.relativePath || name).replaceAll('\\', '/');
    if (!/\.xlsx$/i.test(name) || name.startsWith('~$') || /[\x00-\x1f]/.test(relativePath) || relativePath.length > 1000 || !relativePath || relativePath.startsWith('/') || /^[a-z]:/i.test(relativePath) || relativePath.split('/').includes('..')) {
      throw Object.assign(new Error('请选择有效的 XLSX 文件，相对路径不能越过文件夹'), { status: 400 });
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 256 * 1024 * 1024) {
      throw Object.assign(new Error('单个文件需大于 0 且不超过 256MB'), { status: 400 });
    }
    let registered;
    await this.update(batchId, (batch) => {
      requireEditable(batch);
      const existing = batch.files.find((file) => file.relativePath === relativePath);
      if (existing) {
        if (existing.size !== input.size) throw Object.assign(new Error('同路径文件大小已改变，请新建任务'), { status: 409 });
        if (input.lastModified && existing.lastModified && input.lastModified !== existing.lastModified) throw Object.assign(new Error('同路径文件版本已改变，请新建任务'), { status: 409 });
        registered = existing;
        return;
      }
      if (batch.files.length >= 10000) throw Object.assign(new Error('单批原型最多登记 10,000 个文件'), { status: 400 });
      registered = { id: randomUUID(), name: path.basename(name), relativePath, size: input.size, lastModified: input.lastModified, bytesReceived: 0, status: 'pending' };
      batch.files.push(registered);
      invalidateCheck(batch);
    });
    await mkdir(path.join(this.directory(batchId), 'inputs'), { recursive: true });
    return structuredClone(registered);
  }
  async registerManifest(batchId, inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10000) throw Object.assign(new Error('请选择 1 至 10,000 份 XLSX 文件'), { status: 400 });
    const prepared = inputs.map((input) => {
      if (!input || typeof input !== 'object') throw Object.assign(new Error('清单文件信息无效'), { status: 400 });
      const name = String(input.name || '');
      const relativePath = String(input.relativePath || name).replaceAll('\\', '/');
      if (!/\.xlsx$/i.test(name) || name.startsWith('~$') || /[\x00-\x1f]/.test(relativePath) || relativePath.length > 1000 || !relativePath || relativePath.startsWith('/') || /^[a-z]:/i.test(relativePath) || relativePath.split('/').includes('..')) throw Object.assign(new Error('清单包含无效的 XLSX 路径或 Excel 临时文件'), { status: 400 });
      if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 256 * 1024 * 1024) throw Object.assign(new Error('单个文件需大于 0 且不超过 256MB'), { status: 400 });
      return { id: randomUUID(), name: path.basename(name), relativePath, size: input.size, lastModified: input.lastModified, bytesReceived: 0, status: 'pending' };
    });
    if (new Set(prepared.map((file) => file.relativePath)).size !== prepared.length) throw Object.assign(new Error('清单包含重复的相对路径'), { status: 400 });
    const batch = await this.update(batchId, (value) => {
      requireEditable(value);
      for (const file of prepared) {
        const existing = value.files.find((entry) => entry.relativePath === file.relativePath);
        if (existing && (existing.size !== file.size || (existing.lastModified && file.lastModified && existing.lastModified !== file.lastModified))) throw Object.assign(new Error('已登记的文件版本改变，请新建任务'), { status: 409 });
      }
      let changed = false;
      for (const file of prepared) if (!value.files.some((entry) => entry.relativePath === file.relativePath)) { value.files.push(file); changed = true; }
      if (value.files.length > 10000) throw Object.assign(new Error('单批原型最多 10,000 份文件'), { status: 400 });
      if (changed) invalidateCheck(value);
    });
    await mkdir(path.join(this.directory(batchId), 'inputs'), { recursive: true });
    return { batch, files: batch.files };
  }
  async finishFile(batchId, fileId, expectedHash) {
    const batch = await this.get(batchId);
    requireEditable(batch);
    const file = batch.files.find((entry) => entry.id === requireId(fileId));
    if (!file) throw Object.assign(new Error('文件不存在'), { status: 404 });
    if (file.status === 'uploaded') {
      if (expectedHash && expectedHash !== file.hash) throw Object.assign(new Error('已上传文件内容与当前选择不一致，请新建任务'), { status: 409 });
      return file;
    }
    const partial = this.uploadPath(batchId, fileId);
    const info = await stat(partial);
    if (info.size !== file.size) throw Object.assign(new Error('文件尚未完整上传'), { status: 409 });
    const handle = await open(partial, 'r');
    const magic = Buffer.alloc(2);
    try { await handle.read(magic, 0, 2, 0); } finally { await handle.close(); }
    if (magic.toString() !== 'PK') throw Object.assign(new Error('文件不是 XLSX 的 ZIP 格式'), { status: 400 });
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(partial)) digest.update(chunk);
    const hash = digest.digest('hex');
    if (expectedHash && hash !== expectedHash) throw Object.assign(new Error('文件内容校验失败，文件可能已改变，请新建任务重新上传'), { status: 409 });
    await rename(partial, this.uploadPath(batchId, fileId, true));
    await this.update(batchId, (current) => {
      const stored = current.files.find((entry) => entry.id === fileId);
      stored.status = 'uploaded'; stored.bytesReceived = stored.size; stored.hash = hash;
      invalidateCheck(current);
      if (activeFiles(current).length && activeFiles(current).every((entry) => entry.status === 'uploaded')) {
        current.status = 'ready';
        current.progress = { phase: 'ready', message: '已登记的文件上传完成，等待执行合并' };
      }
    });
    return (await this.get(batchId)).files.find((entry) => entry.id === fileId);
  }
  async buildManifest(id) {
    const batch = await this.get(id);
    return { batchId: id, files: activeFiles(batch).map((file) => ({ id: file.id, name: file.name, relativePath: file.relativePath, size: file.size, sha256: file.hash, path: this.uploadPath(id, file.id, true) })), excluded: batch.files.filter((file) => file.excluded).map((file) => ({ id: file.id, relativePath: file.relativePath, reason: file.exclusionReason })), workflow: { rules: batch.rules || defaultRules(), template: batch.template || null, inputRevision: batch.inputRevision || 0, cacheDir: path.join(this.directory(id), 'checkpoints') } };
  }
  async editFile(id, fileId, action, input = {}) {
    return this.update(id, (batch) => {
      requireEditable(batch);
      const index = batch.files.findIndex((file) => file.id === requireId(fileId));
      if (index < 0) throw Object.assign(new Error('文件不存在'), { status: 404 });
      const file = batch.files[index];
      if (action === 'remove') batch.files.splice(index, 1);
      else if (action === 'exclude') {
        if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw Object.assign(new Error('请填写不超过 500 字的排除原因'), { status: 400 });
        file.excluded = true; file.exclusionReason = input.reason.trim();
      } else if (action === 'include') { file.excluded = false; delete file.exclusionReason; }
      else if (action === 'replace') {
        if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 256 * 1024 * 1024 || input.relativePath !== file.relativePath || input.name !== file.name) throw Object.assign(new Error('替换文件必须同名、同路径，大小为 1 字节至 256MB'), { status: 400 });
        batch.files[index] = { id: randomUUID(), name: file.name, relativePath: file.relativePath, size: input.size, lastModified: input.lastModified, status: 'pending', bytesReceived: 0, ...(file.excluded ? { excluded: true, exclusionReason: file.exclusionReason } : {}) };
      } else throw Object.assign(new Error('未知文件操作'), { status: 400 });
      invalidateCheck(batch);
      appendEvent(batch, 'input', `${({ remove: '移除', exclude: '排除', include: '恢复', replace: '替换' })[action]}：${file.relativePath}${action === 'exclude' ? `；${input.reason.trim()}` : ''}`);
    });
  }
  async setRules(id, rules, template = null) {
    const validated = validateRules(rules);
    return this.update(id, (batch) => { requireEditable(batch); batch.rules = validated; batch.template = template; invalidateCheck(batch); appendEvent(batch, 'rules', template ? `应用模板：${template.name}` : '更新字段和工作表规则'); });
  }
  async executionPaths(id, attempt) {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('无效的任务尝试次数');
    const directory = path.join(this.directory(id), 'runs', String(attempt));
    const outputDir = path.join(directory, 'outputs');
    await mkdir(outputDir, { recursive: true });
    return { manifestPath: path.join(directory, 'manifest.json'), outputDir };
  }
  async recordOutputs(id, outputDir) {
    const batch = await this.get(id);
    const expected = (await this.executionPaths(id, batch.attempt)).outputDir;
    if (path.resolve(outputDir) !== expected) throw new Error('结果目录不属于当前任务');
    const outputs = [];
    for (const entry of await readdir(outputDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(xlsx|csv|json)$/i.test(entry.name)) continue;
      const info = await stat(path.join(outputDir, entry.name));
      outputs.push({ name: entry.name, size: info.size, url: `/api/batches/${id}/outputs/${batch.attempt}/${encodeURIComponent(entry.name)}` });
    }
    return outputs;
  }
}
