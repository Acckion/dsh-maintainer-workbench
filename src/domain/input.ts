import { z } from "zod";
export const inputRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    fields: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
            .refine(
              (id) => !Object.hasOwn(Object.prototype, id),
              "输入字段不能使用保留属性名",
            ),
          gapId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(),
          actor: z.enum(["reporter","maintainer"]).optional(),
          required: z.boolean().optional(),
          question: z.string().trim().min(1).max(1000),
          purpose: z.enum(["information", "decision", "plan_confirmation"]).optional(),
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

export const answerStateSchema=z.enum(['provided','unknown','unavailable','reporter']);
export type InputAnswer={value:string;state:z.infer<typeof answerStateSchema>};
export function meaningfulAnswer(answer:InputAnswer):boolean {
 return answer.state==='provided' && !!answer.value.trim() && !/^(?:未知|不知道|不清楚|尚未提供|无法提供|待补充|unknown|n\/a)[。.!！\s]*$/i.test(answer.value.trim());
}
/** Reuse only exact, same-version question/actor answers; never guess facts from similar text. */
export function unansweredInputRequest(request:InputRequest|undefined, waits:readonly import('./processing.ts').ProcessingWait[]):InputRequest|undefined {
 if(!request)return;
 const normalize=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
 const fields=request.fields.filter(field=>!waits.some(wait=>wait.questions?.some(old=>old.id===field.id && normalize(old.question)===normalize(field.question) && old.actor===field.actor && old.purpose===field.purpose && wait.answers?.[old.id] && meaningfulAnswer(wait.answers[old.id]))));
 return fields.length===request.fields.length?request:fields.length?{...request,fields}:undefined;
}
