import { z } from "zod";
export const inputRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    fields: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
            .refine(
              (id) => !Object.hasOwn(Object.prototype, id),
              "输入字段不能使用保留属性名",
            ),
          question: z.string().trim().min(1).max(1000),
          options: z
            .array(
              z.object({
                label: z.string().min(1).max(200),
                description: z.string().max(1000).optional(),
              }),
            )
            .max(12)
            .optional(),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.fields.map((f) => f.id)).size !== value.fields.length)
      ctx.addIssue({ code: "custom", message: "输入字段标识必须唯一" });
  });
export type InputRequest = z.infer<typeof inputRequestSchema>;
