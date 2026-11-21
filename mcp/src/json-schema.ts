import { z } from 'zod'

/**
 * A tool's input schema as JSON Schema, for ListTools. `io: 'input'` describes what a caller
 * sends, so a field with a default stays optional (#95), and draft-07 matches what
 * zod-to-json-schema emitted before zod 4.
 */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
}
