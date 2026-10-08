// In-memory stand-in for MongoDB. The API mirrors the official driver
// (find, findOne, countDocuments, insertOne, updateOne, findOneAndUpdate, deleteOne)
// and supports the common query and update operators, so data-access code reads like
// real Mongo code. Documents use numeric `id`s instead of ObjectIds.
// Every operation is asynchronous, like a network round-trip to a real database.

const tick = () => new Promise((resolve) => setImmediate(resolve));

export class DuplicateKeyError extends Error {
  constructor(collection, field, value) {
    super(`E11000 duplicate key error collection: ${collection} index: ${field}_1 dup key: { ${field}: ${JSON.stringify(value)} }`);
    this.name = 'DuplicateKeyError';
    this.code = 11000;
    this.keyPattern = { [field]: 1 };
  }
}

class Collection {
  constructor(name, { unique = [] } = {}) {
    this.name = name;
    this.unique = unique;
    this.docs = [];
    this.nextId = 1;
  }

  reset(docs = []) {
    this.docs = docs.map((doc) => structuredClone(doc));
    this.nextId = Math.max(0, ...this.docs.map((doc) => doc.id ?? 0)) + 1;
  }

  async find(filter = {}, options = {}) {
    await tick();
    let result = this.docs.filter((doc) => matches(doc, filter));
    if (options.sort) result = sortDocs(result, options.sort);
    if (options.skip) result = result.slice(options.skip);
    if (options.limit) result = result.slice(0, options.limit);
    return result.map((doc) => project(structuredClone(doc), options.projection));
  }

  async findOne(filter = {}, options = {}) {
    await tick();
    const doc = this.docs.find((d) => matches(d, filter));
    return doc ? project(structuredClone(doc), options.projection) : null;
  }

  async countDocuments(filter = {}) {
    await tick();
    return this.docs.filter((doc) => matches(doc, filter)).length;
  }

  async insertOne(doc) {
    await tick();
    const toInsert = { id: this.nextId, ...structuredClone(doc) };
    this.checkUnique(toInsert);
    this.nextId = Math.max(this.nextId, toInsert.id) + 1;
    this.docs.push(toInsert);
    return structuredClone(toInsert);
  }

  async updateOne(filter, update) {
    await tick();
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    this.replaceInPlace(doc, applyUpdate(structuredClone(doc), update));
    return { matchedCount: 1, modifiedCount: 1 };
  }

  /** Atomically finds one document and updates it. Returns the document before or after the update. */
  async findOneAndUpdate(filter, update, { returnDocument = 'before' } = {}) {
    await tick();
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return null;
    const before = structuredClone(doc);
    this.replaceInPlace(doc, applyUpdate(structuredClone(doc), update));
    return returnDocument === 'after' ? structuredClone(doc) : before;
  }

  async deleteOne(filter) {
    await tick();
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index === -1) return { deletedCount: 0 };
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }

  replaceInPlace(doc, updated) {
    this.checkUnique(updated, doc);
    for (const key of Object.keys(doc)) delete doc[key];
    Object.assign(doc, updated);
  }

  checkUnique(candidate, existing) {
    for (const field of this.unique) {
      const value = candidate[field];
      if (value === undefined) continue;
      if (this.docs.some((d) => d !== existing && d[field] === value)) throw new DuplicateKeyError(this.name, field, value);
    }
  }
}

function getPath(doc, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = doc;
  for (const key of keys) {
    if (target[key] == null || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[last] = value;
}

function deletePath(doc, path) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((value, key) => (value == null ? undefined : value[key]), doc);
  if (parent != null) delete parent[last];
}

function isOperatorObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof RegExp || value instanceof Date) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function equals(a, b) {
  if (b === null) return a == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((item) => equals(item, b));
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchCondition(value, condition) {
  if (condition instanceof RegExp) return typeof value === 'string' && condition.test(value);
  if (!isOperatorObject(condition)) return equals(value, condition);
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case '$eq':
        return equals(value, arg);
      case '$ne':
        return !equals(value, arg);
      case '$gt':
        return value != null && value > arg;
      case '$gte':
        return value != null && value >= arg;
      case '$lt':
        return value != null && value < arg;
      case '$lte':
        return value != null && value <= arg;
      case '$in':
        return arg.some((item) => equals(value, item));
      case '$nin':
        return !arg.some((item) => equals(value, item));
      case '$exists':
        return (value !== undefined) === Boolean(arg);
      case '$regex':
        return typeof value === 'string' && new RegExp(arg, condition.$options ?? '').test(value);
      case '$options':
        return true;
      case '$not':
        return !matchCondition(value, arg);
      default:
        throw new Error(`Unsupported query operator ${op}`);
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((f) => matches(doc, f));
    if (key === '$and') return condition.every((f) => matches(doc, f));
    if (key === '$nor') return !condition.some((f) => matches(doc, f));
    return matchCondition(getPath(doc, key), condition);
  });
}

function applyUpdate(doc, update) {
  const operators = Object.keys(update);
  if (operators.length === 0 || !operators.every((op) => op.startsWith('$'))) {
    throw new Error('Update document requires atomic operators such as $set or $inc');
  }
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields)) {
      switch (op) {
        case '$set':
          setPath(doc, path, structuredClone(value));
          break;
        case '$unset':
          deletePath(doc, path);
          break;
        case '$inc':
          setPath(doc, path, (getPath(doc, path) ?? 0) + value);
          break;
        case '$push':
          setPath(doc, path, [...(getPath(doc, path) ?? []), structuredClone(value)]);
          break;
        default:
          throw new Error(`Unsupported update operator ${op}`);
      }
    }
  }
  return doc;
}

function sortDocs(docs, sort) {
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [path, direction] of entries) {
      const x = getPath(a, path);
      const y = getPath(b, path);
      if (x < y) return -direction;
      if (x > y) return direction;
    }
    return 0;
  });
}

function project(doc, projection) {
  if (!projection) return doc;
  const entries = Object.entries(projection);
  if (entries.every(([, keep]) => !keep)) {
    for (const [path] of entries) deletePath(doc, path);
    return doc;
  }
  const result = {};
  for (const [path, keep] of entries) if (keep) setPath(result, path, getPath(doc, path));
  if (projection.id !== 0) result.id = doc.id;
  return result;
}

export const db = {
  users: new Collection('users', { unique: ['email'] }),
  sessions: new Collection('sessions', { unique: ['token'] }),
  courses: new Collection('courses'),
  orders: new Collection('orders'),
};
