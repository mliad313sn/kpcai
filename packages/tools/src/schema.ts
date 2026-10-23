/**
 * A small JSON Schema validator for tool inputs: `type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`, string/number/array bounds.
 * Unknown keywords are ignored (MCP servers validate their own inputs as well);
 * the goal is to stop malformed model output before any tool runs.
 */
type Schema = Record<string, unknown>;

const MAX_DEPTH = 32;
const MAX_ERRORS = 10;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: unknown, v: unknown): boolean {
  const list = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(v);
  return list.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function isSchema(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class Checker {
  readonly errors: string[] = [];

  fail(at: string, msg: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${at || '(input)'}: ${msg}`);
  }

  check(schema: unknown, v: unknown, at: string, depth: number): void {
    if (!isSchema(schema)) return;
    if (depth > MAX_DEPTH) return this.fail(at, 'value nested too deeply');
    if (schema.type !== undefined && !typeMatches(schema.type, v)) {
      return this.fail(at, `expected ${JSON.stringify(schema.type)}, got ${typeOf(v)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, v))) {
      this.fail(at, `must be one of ${JSON.stringify(schema.enum)}`);
    }
    if ('const' in schema && !deepEqual(schema.const, v)) {
      this.fail(at, `must equal ${JSON.stringify(schema.const)}`);
    }
    if (typeof v === 'string') this.checkString(schema, v, at);
    if (typeof v === 'number') this.checkNumber(schema, v, at);
    if (Array.isArray(v)) this.checkArray(schema, v, at, depth);
    else if (isSchema(v)) this.checkObject(schema, v, at, depth);
  }

  private checkString(s: Schema, v: string, at: string): void {
    if (typeof s.minLength === 'number' && v.length < s.minLength) {
      this.fail(at, `shorter than ${s.minLength}`);
    }
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) {
      this.fail(at, `longer than ${s.maxLength}`);
    }
  }

  private checkNumber(s: Schema, v: number, at: string): void {
    if (typeof s.minimum === 'number' && v < s.minimum) this.fail(at, `below ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) this.fail(at, `above ${s.maximum}`);
  }

  private checkArray(s: Schema, v: unknown[], at: string, depth: number): void {
    if (typeof s.minItems === 'number' && v.length < s.minItems) {
      this.fail(at, `fewer than ${s.minItems} items`);
    }
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) {
      this.fail(at, `more than ${s.maxItems} items`);
    }
    v.forEach((item, i) => this.check(s.items, item, `${at}[${i}]`, depth + 1));
  }

  private checkObject(s: Schema, v: Schema, at: string, depth: number): void {
    const props = isSchema(s.properties) ? s.properties : {};
    const required = Array.isArray(s.required) ? s.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in v)) this.fail(join(at, key), 'is required');
    }
    for (const [key, val] of Object.entries(v)) {
      if (key in props) this.check(props[key], val, join(at, key), depth + 1);
      else if (s.additionalProperties === false) this.fail(join(at, key), 'is not allowed');
      else this.check(s.additionalProperties, val, join(at, key), depth + 1);
    }
  }
}

function join(at: string, key: string): string {
  return at ? `${at}.${key}` : key;
}

/** Returns the validation errors (empty when valid). Tool input must be an object. */
export function validateInput(schema: Record<string, unknown>, input: unknown): string[] {
  const c = new Checker();
  if (!isSchema(input)) {
    c.fail('', `tool input must be an object, got ${typeOf(input)}`);
    return c.errors;
  }
  c.check(schema, input, '', 0);
  return c.errors;
}
