import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { AssociationsSchema, CatalogSchema, SessionSchema, UUID_V4_PATTERN } from './contracts.js';
import { fail } from './errors.js';

const SCHEMA_VERSION = 1;

export class JsonStore {
  constructor(root = process.env.SKILLGESTURE_HOME || path.join(os.homedir(), '.skillgesture')) {
    this.root = path.resolve(root);
    this.skillsRoot = path.join(this.root, 'skills');
    this.sessionsRoot = path.join(this.root, 'sessions');
    this.catalogPath = path.join(this.root, 'catalog.json');
    this.associationsPath = path.join(this.root, 'associations.json');
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await this.withLock(async () => {
      await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
      await this.#rejectSymlink(this.skillsRoot);
      await this.#rejectSymlink(this.sessionsRoot);
      await this.#createJsonIfMissing(this.catalogPath, {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        groups: [],
      });
      await this.#createJsonIfMissing(this.associationsPath, {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        folders: {},
      });
    });
    await this.readCatalog();
    await this.readAssociations();
  }

  async #createJsonIfMissing(filePath, initialValue) {
    try {
      await access(filePath, constants.F_OK);
    } catch {
      const handle = await open(filePath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(initialValue, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#syncDirectory(path.dirname(filePath));
    }
  }

  async readJson(filePath) {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') fail('NOT_FOUND', `Missing storage file: ${path.basename(filePath)}`);
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      fail('STORE_CORRUPT', `Invalid JSON in ${path.basename(filePath)}`);
    }
  }

  async #parseStored(filePath, schema, identityCheck) {
    const value = await this.readJson(filePath);
    const parsed = schema.safeParse(value);
    if (!parsed.success || (identityCheck && !identityCheck(parsed.data))) {
      fail('STORE_CORRUPT', `Invalid stored data in ${path.basename(filePath)}`);
    }
    return parsed.data;
  }

  readCatalog() {
    return this.#parseStored(this.catalogPath, CatalogSchema);
  }

  readAssociations() {
    return this.#parseStored(this.associationsPath, AssociationsSchema);
  }

  async writeJsonAtomic(filePath, value) {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
      await this.#syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async writeMarkdown(relativePath, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 256 * 1024 || content.includes('\0')) {
      fail('INVALID_INPUT', 'Markdown must be valid text no larger than 256 KiB');
    }
    const filePath = this.resolveSkillPath(relativePath);
    const directory = path.dirname(filePath);
    await this.#assertSafeSkillParents(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertSafeSkillParents(directory);
    const temporaryPath = path.join(directory, `.SKILL.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
      await this.#syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async readMarkdown(relativePath) {
    const filePath = this.resolveSkillPath(relativePath);
    await this.#assertSafeSkillParents(path.dirname(filePath));
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      fail('STORE_CORRUPT', 'Registered skill content is not a regular file');
    }
    return readFile(filePath, 'utf8');
  }

  resolveSkillPath(relativePath) {
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
      fail('STORE_CORRUPT', 'Skill content path must be relative');
    }
    const resolved = path.resolve(this.root, relativePath);
    const expectedPrefix = `${this.skillsRoot}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix)) fail('STORE_CORRUPT', 'Skill content path escapes storage root');
    return resolved;
  }

  sessionPath(sessionId) {
    if (!UUID_V4_PATTERN.test(sessionId)) fail('INVALID_SESSION_ID', 'sessionId must be a UUID v4');
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  async readSession(sessionId) {
    try {
      return await this.#parseStored(
        this.sessionPath(sessionId),
        SessionSchema,
        (session) => session.sessionId === sessionId,
      );
    } catch (error) {
      if (error?.code === 'NOT_FOUND') fail('SESSION_NOT_FOUND', `Session ${sessionId} does not exist`);
      throw error;
    }
  }

  writeSession(session) {
    return this.writeJsonAtomic(this.sessionPath(session.sessionId), session);
  }

  async listSessions() {
    const files = await readdir(this.sessionsRoot);
    const sessions = [];
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
      const sessionId = file.slice(0, -5);
      sessions.push(await this.readSession(sessionId));
    }
    return sessions;
  }

  async canonicalFolder(folder) {
    if (typeof folder !== 'string' || folder.length === 0) fail('INVALID_INPUT', 'Folder must be a non-empty path');
    let resolved;
    try {
      resolved = await realpath(path.resolve(folder));
    } catch {
      fail('INVALID_FOLDER', `Folder does not exist: ${folder}`);
    }
    const folderStat = await stat(resolved);
    if (!folderStat.isDirectory()) fail('INVALID_FOLDER', `Path is not a directory: ${folder}`);
    return resolved;
  }

  async canonicalFolders(folders = []) {
    if (!Array.isArray(folders)) fail('INVALID_INPUT', 'folders must be an array');
    const canonical = await Promise.all(folders.map((folder) => this.canonicalFolder(folder)));
    return [...new Set(canonical)].sort();
  }

  async withLock(operation) {
    const release = await lockfile.lock(this.root, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 100, minTimeout: 20, maxTimeout: 100, factor: 1.2 },
    }).catch((error) => fail('STORE_BUSY', `Unable to lock Skillgesture storage: ${error.message}`));
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async #assertSafeSkillParents(directory) {
    const relative = path.relative(this.skillsRoot, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('STORE_CORRUPT', 'Skill directory escapes storage root');
    let current = this.skillsRoot;
    await this.#rejectSymlink(current);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await this.#rejectSymlink(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        break;
      }
    }
  }

  async #rejectSymlink(target) {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) fail('STORE_CORRUPT', `Symbolic links are not allowed in skill storage: ${target}`);
  }

  async #syncDirectory(directory) {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export { SCHEMA_VERSION };
