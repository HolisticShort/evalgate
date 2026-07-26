/**
 * A deliberately small JSON Schema subset validator.
 *
 * Why not ajv: the core has one job here — tell a suite author whether model
 * output matched the shape they asked for. Pulling a full-spec validator (and
 * its code-generation machinery) into a library whose selling point is "cheap
 * enough to leave on in CI" is a bad trade for spec coverage nobody's eval
 * suite uses.
 *
 * SUPPORTED: type · required · properties · additionalProperties · items ·
 * enum · const · minimum · maximum · minLength · maxLength · minItems ·
 * maxItems · pattern · anyOf · nullable-via-type-array
 *
 * NOT SUPPORTED: $ref, allOf/oneOf/not, conditionals, format assertions,
 * dependent schemas. Unknown keywords are ignored rather than rejected — an
 * eval suite should not fail because the author pasted a keyword we skip.
 *
 * Callers needing full spec compliance should register a custom `schema`
 * assertion backed by their validator of choice.
 */

type Schema = Record<string, any>

export function validate(value: unknown, schema: Schema, path = ''): string[] {
  const errors: string[] = []
  const at = path || 'root'

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t: string) => matchesType(value, t))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeName(value)}`)
      return errors // shape is wrong; deeper checks would be noise
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => deepEqual(value, e))) {
    errors.push(`${at}: value not in enum`)
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${at}: ${value} < minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${at}: ${value} > maximum ${schema.maximum}`)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${at}: length ${value.length} < minLength ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${at}: length ${value.length} > maxLength ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      errors.push(`${at}: does not match /${schema.pattern}/`)
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${at}: ${value.length} items < minItems ${schema.minItems}`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${at}: ${value.length} items > maxItems ${schema.maxItems}`)
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${at}[${i}]`)))
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required property "${key}"`)
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) errors.push(...validate(value[key], sub as Schema, `${at}.${key}`))
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties))
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) errors.push(`${at}: unexpected property "${key}"`)
        }
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s: Schema) => validate(value, s, path).length === 0)
    if (!ok) errors.push(`${at}: matched none of anyOf`)
  }

  return errors
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
    default:
      return true // unknown type keyword — ignore rather than reject
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]))
  }
  return false
}
