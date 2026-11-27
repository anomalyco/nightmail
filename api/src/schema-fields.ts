// What a request or response body is made of, as the docs list it. The app's reference pages (app/src/features/docs,
// painted at build time too) and the API's Markdown copies (openapi-docs.ts: /docs/operations/<id>.md, the tag
// references) both draw from here, so a page and its copy name the same fields in the same order.
// - Fields: the schema's own, merged from every part of an allOf (a shared schema plus a few fields), with their
//   required flags; an object field's fields one level down, named by their path (template.name, headers[].value),
//   an object that may be null's too (risk.score). A field that is one of several objects shows its type.
// - Variants (a oneOf or anyOf of objects): each with its own fields, titled by what tells them apart in the schema
//   itself: the one property each variant fixes to its own value ("type: slack"), else the variant's own title, else
//   "Variant 1", "Variant 2"… with its schema's name where it has one. Nothing here adds to api/openapi.json.
// - An object with no fields is "No fields"; anything else (a string, a file) is its type.
type Json = Record<string, any>

export type Field = { path: string; type: string; required: boolean; description: string | null }
export type Variant = { title: string; description: string | null; fields: Field[] }
export type Body = { name: string | null; description: string | null } & (
  | { kind: 'fields'; fields: Field[] }
  | { kind: 'variants'; variants: Variant[] }
  | { kind: 'empty' }
  | { kind: 'value'; type: string })

/** The operations whose body is an object with no fields: the only bodies the docs may show without any (app/site-pages.ts
 *  and api/scripts/check-agent-docs.ts stop the build on any other). */
export const NO_FIELD_BODIES = new Set(['pauseCampaign', 'resumeCampaign', 'unscheduleCampaign'])

export function resolveSchema(document: Json, schema: Json | undefined, seen = new Set<string>()): Json {
  if (!schema) return {}
  if (typeof schema.$ref !== 'string') return schema
  if (seen.has(schema.$ref)) return {}
  seen.add(schema.$ref)
  const [, , section, name] = schema.$ref.split('/')
  return resolveSchema(document, document.components?.[section]?.[name], seen)
}
const refName = (input: Json | undefined): string | null => typeof input?.$ref === 'string' ? input.$ref.split('/').at(-1) ?? null : null

/** A schema with its allOf parts merged into one object: their fields in order, every required field, the first description. */
function merged(document: Json, input: Json | undefined, depth = 0): Json {
  const schema = resolveSchema(document, input)
  if (!Array.isArray(schema.allOf) || depth > 8) return schema
  const parts = schema.allOf.map((part: Json) => merged(document, part, depth + 1))
  const { allOf: _, ...own } = schema
  return {
    ...own,
    type: own.type ?? 'object',
    description: own.description ?? parts.find((part: Json) => part.description)?.description,
    properties: Object.assign({}, ...parts.map((part: Json) => part.properties ?? {}), own.properties ?? {}),
    required: [...new Set([...parts.flatMap((part: Json) => part.required ?? []), ...own.required ?? []])],
  }
}
const hasFields = (schema: Json) => Object.keys(schema.properties ?? {}).length > 0

/** A schema's type as a field's row names it: string, object, Endpoint[], string or null. */
export function schemaType(document: Json, input: Json | undefined): string {
  const schema = merged(document, input)
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((value: Json) => schemaType(document, value)).join(' or ')
  if (Array.isArray(schema.type)) return schema.type.join(' or ')
  if (schema.type === 'array') return `${schemaType(document, schema.items)}[]`
  return schema.type ?? (schema.properties ? 'object' : 'value')
}

/** A field's object: its schema merged, or the one object of an "object or null" (a oneOf or anyOf of it and null). */
function orNull(document: Json, input: Json | undefined): Json {
  const schema = merged(document, input), union: Json[] | undefined = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(union)) return schema
  const parts = union.map(part => merged(document, part)), objects = parts.filter(hasFields)
  return objects.length === 1 && parts.every(part => part === objects[0] || part.type === 'null') ? objects[0]! : schema
}
/** An object's fields, with an object field's own fields one level down (an array of objects' as name[].field; an object
 *  that may be null's too). */
function fieldsOf(document: Json, schema: Json): Field[] {
  const required = new Set<string>(schema.required ?? [])
  const row = (path: string, definition: Json, isRequired: boolean): Field => ({ path, type: schemaType(document, definition), required: isRequired, description: resolveSchema(document, definition).description ?? null })
  return Object.entries<Json>(schema.properties ?? {}).flatMap(([property, definition]) => {
    const field = row(property, definition, required.has(property))
    const value = orNull(document, definition), items = value.type === 'array' ? orNull(document, value.items) : null
    const nested = hasFields(value) ? { prefix: `${property}.`, schema: value } : items && hasFields(items) ? { prefix: `${property}[].`, schema: items } : null
    if (!nested) return [field]
    const inner = new Set<string>(nested.schema.required ?? [])
    return [field, ...Object.entries<Json>(nested.schema.properties).map(([child, definition]) => row(`${nested.prefix}${child}`, definition, inner.has(child)))]
  })
}

/** The value a variant fixes a property to (a const, or an enum of one). */
const fixed = (document: Json, property: Json | undefined): string | null => {
  const schema = resolveSchema(document, property)
  if (schema.const !== undefined) return String(schema.const)
  return Array.isArray(schema.enum) && schema.enum.length === 1 ? String(schema.enum[0]) : null
}
function titles(document: Json, inputs: Json[], variants: Json[]): string[] {
  // The property every variant fixes, each to a value of its own: what tells them apart.
  const keys = Object.keys(variants[0]?.properties ?? {}).filter(key => {
    const values = variants.map(variant => fixed(document, variant.properties?.[key]))
    return values.every(value => value !== null) && new Set(values).size === values.length
  })
  const key = keys[0]
  return variants.map((variant, i) => key ? `${key}: ${fixed(document, variant.properties[key])}` : typeof variant.title === 'string' && variant.title ? variant.title : `Variant ${i + 1}${refName(inputs[i]) ? `: ${refName(inputs[i])}` : ''}`)
}

/** What a body (a request body, a response's) is made of, for a page or a Markdown copy to list. */
export function describeBody(document: Json, input: Json): Body {
  const name = refName(input), schema = merged(document, input), description: string | null = schema.description ?? null
  if (hasFields(schema)) return { name, description, kind: 'fields', fields: fieldsOf(document, schema) }
  const union: Json[] | undefined = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union) && union.length) {
    const variants = union.map(part => merged(document, part)), named = titles(document, union, variants)
    if (variants.some(hasFields)) return { name, description, kind: 'variants', variants: variants.map((variant, i) => ({ title: named[i]!, description: variant.description ?? null, fields: fieldsOf(document, variant) })) }
  }
  if (schema.type === 'object' && !schema.additionalProperties) return { name, description, kind: 'empty' }
  return { name, description, kind: 'value', type: schemaType(document, schema) }
}

/** An operation's responses as the docs list them: statuses with the same description and body (the ten "Request
 *  failed" rows) are one row. */
export function responseRows(responses: Record<string, Json>): { statuses: string[]; description: string; schema?: Json }[] {
  const rows: { statuses: string[]; description: string; schema?: Json }[] = []
  for (const [status, response] of Object.entries(responses ?? {})) {
    const schema: Json | undefined = response.content?.['application/json']?.schema
    const same = rows.find(row => row.description === response.description && JSON.stringify(row.schema) === JSON.stringify(schema))
    if (same) same.statuses.push(status); else rows.push({ statuses: [status], description: response.description ?? '', schema })
  }
  return rows
}
