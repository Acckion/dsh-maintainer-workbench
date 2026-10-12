import { defineTool, type ValueSchemaSpec, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { compactReportSchema } from '../core/report-assembly.ts';
import type { JobKind } from '../core/types.ts';

/** Project structural constraints into the host tool schema; final Zod/evidence checks stay authoritative. */
function toolSchema(schema: z.ZodTypeAny): ValueSchemaSpec {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return toolSchema(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return toolSchema(schema.innerType());
  if (schema instanceof z.ZodNullable) return { oneOf: [toolSchema(schema.unwrap()), { type: 'null' }] };
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? 'integer' : 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) {
    if (typeof schema.value === 'string') return { type: 'string', const: schema.value };
    if (typeof schema.value === 'number') return { type: 'number', const: schema.value };
    if (typeof schema.value === 'boolean') return { type: 'boolean', const: schema.value };
    if (schema.value === null) return { type: 'null' };
    return { type: 'json' };
  }
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: 'array', items: toolSchema(schema.element) };
  if (schema instanceof z.ZodObject) {
    const properties: ParameterSchemaSpec = {};
    for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodTypeAny][])
      properties[key] = { ...toolSchema(field), ...(!field.isOptional() ? { required: true as const } : {}) };
    return { type: 'object', properties, additionalProperties: false };
  }
  return { type: 'json' };
}

/** This submits data only. It does not execute checks, grant permissions or approve an artifact. */
export function reportTool(kind: JobKind, receive: (value: unknown) => void) {
  return defineTool({
    name: 'submit_stage_report',
    description: 'Submit the concise final stage report. Cite current tool IDs instead of copying commands or logs. The host validates findings and evidence after submission. Do not use during implementation or before requested checks.',
    parameters: { report: { ...toolSchema(compactReportSchema(kind)), required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { received: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Report received for host validation. This receipt is not acceptance or proof of verification.' }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted(); receive(args.report); exec.concludeTurn();
      return { received: true };
    },
  });
}
