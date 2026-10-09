import { defineTool } from "@deepseek-ai/dsh-tools";
import { inputRequestSchema, type InputRequest } from "../domain/input.ts";

/** Scoped override: questions conclude the Agent turn instead of holding a worker slot. */
export function inputTool(request: (input: InputRequest) => void) {
  return defineTool({
    name: "ask_user_question",
    description:
      "Ask the maintainer for missing information. The workbench saves the questions and pauses this run. Do not continue implementation until the maintainer answers and starts a new run.",
    parameters: {
      questions: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            question: { type: "string", required: true },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string", required: true },
                  description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { pending: { type: "boolean", required: true } },
      },
      render: () => [
        {
          type: "text",
          text: "Questions saved for the maintainer. This run pauses without assuming an answer.",
        },
      ],
    },
    async execute(args, exec) {
      const fields = args.questions.map((q, index) => ({
        id:
          /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(q.id) &&
          !Object.hasOwn(Object.prototype, q.id)
            ? q.id
            : `question_${index + 1}`,
        question: q.question,
        options: q.options,
      }));
      const input = inputRequestSchema.parse({
        reason: "Agent 需要维护者补充信息",
        fields,
      });
      exec.signal.throwIfAborted();
      request(input);
      exec.concludeTurn();
      return { pending: true };
    },
  });
}
