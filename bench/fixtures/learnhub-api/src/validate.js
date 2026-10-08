import { HttpError } from './errors.js';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates `input` against a schema and returns a new object containing only the
 * declared fields. Unknown fields are dropped, so a request body can never set a
 * field the schema does not mention.
 *
 * Rule options: type ('string' | 'integer' | 'number' | 'boolean'), required,
 * min / max (numbers), minLength / maxLength / pattern / trim (strings), enum.
 * Throws HttpError(400) listing every problem.
 */
export function validate(input, schema) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    let value = source[field];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(`${field} is required`);
      continue;
    }

    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${field} must be a string`);
        continue;
      }
      if (rule.trim !== false) value = value.trim();
      if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${field} must be at least ${rule.minLength} characters`);
      if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${field} must be at most ${rule.maxLength} characters`);
      if (rule.pattern && !rule.pattern.test(value)) errors.push(`${field} has an invalid format`);
    } else if (rule.type === 'integer' || rule.type === 'number') {
      const valid = rule.type === 'integer' ? Number.isInteger(value) : typeof value === 'number' && Number.isFinite(value);
      if (!valid) {
        errors.push(`${field} must be ${rule.type === 'integer' ? 'an integer' : 'a number'}`);
        continue;
      }
      if (rule.min !== undefined && value < rule.min) errors.push(`${field} must be at least ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) errors.push(`${field} must be at most ${rule.max}`);
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push(`${field} must be a boolean`);
        continue;
      }
    }

    if (rule.enum && !rule.enum.includes(value)) errors.push(`${field} must be one of: ${rule.enum.join(', ')}`);
    result[field] = value;
  }

  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
  return result;
}
