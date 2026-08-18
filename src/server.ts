import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { PrimitiveSchemaDefinition } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DISCUSS = "__discuss_with_codex__";
const OTHER = "__other__";
const ALWAYS_USE_RECOMMENDED = "__always_use_recommended__";
const ALL_MODES_GUIDANCE =
  "This MCP ask_user tool is available in both Default and Plan collaboration modes. " +
  "It is distinct from Codex's built-in request_user_input tool and does not inherit that tool's Plan-mode restriction. " +
  "When the user explicitly asks you to use ask_user or the Ask User plugin, call this tool regardless of the current collaboration mode; do not refuse on the basis that request_user_input is Plan-only.";

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("Short text shown on the clickable option."),
  description: z
    .string()
    .min(1)
    .max(160)
    .optional()
    .describe("A concise explanation of the option's impact or tradeoff."),
  recommended: z
    .boolean()
    .default(false)
    .describe("Preselect this option and label it as recommended. A single-choice question may have only one."),
});

const questionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .describe("Stable snake_case key for the returned answer."),
    header: z.string().min(1).max(40).describe("Short title for the question."),
    question: z.string().min(1).max(500).describe("The decision or missing information to ask about."),
    kind: z
      .enum(["single", "multiple", "text"])
      .describe("single renders radio choices, multiple renders checkboxes, and text accepts a free-form answer."),
    options: z
      .array(optionSchema)
      .min(2)
      .max(8)
      .optional()
      .describe("Required for single and multiple questions; omit for text questions."),
    allow_other: z
      .boolean()
      .default(true)
      .describe("Add an Enter my own answer choice to single or multiple questions."),
    allow_discussion: z
      .boolean()
      .default(true)
      .describe("Add a Discuss with Codex first choice. The tool returns control to the agent for discussion."),
    min_selections: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Minimum number of answers for a multiple-choice question; a custom answer counts as one."),
    max_selections: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum number of answers for a multiple-choice question; a custom answer counts as one."),
  })
  .superRefine((question, context) => {
    const needsOptions = question.kind === "single" || question.kind === "multiple";
    if (needsOptions && !question.options) {
      context.addIssue({ code: "custom", message: `${question.kind} questions require options`, path: ["options"] });
    }
    if (!needsOptions && question.options) {
      context.addIssue({ code: "custom", message: "text questions must not include options", path: ["options"] });
    }
    if (question.kind !== "multiple" && (question.min_selections || question.max_selections)) {
      context.addIssue({ code: "custom", message: "selection limits apply only to multiple questions" });
    }
    if (
      question.min_selections &&
      question.max_selections &&
      question.min_selections > question.max_selections
    ) {
      context.addIssue({ code: "custom", message: "min_selections cannot exceed max_selections" });
    }
    if (question.options && question.max_selections && question.max_selections > question.options.length + 1) {
      context.addIssue({
        code: "custom",
        message: "max_selections cannot exceed the number of choices plus a possible custom answer",
        path: ["max_selections"],
      });
    }
    const recommendedCount = question.options?.filter((option) => option.recommended).length ?? 0;
    if (question.kind === "single" && recommendedCount > 1) {
      context.addIssue({
        code: "custom",
        message: "single questions may have at most one recommended option",
        path: ["options"],
      });
    }
    if (
      question.kind === "multiple" &&
      question.min_selections &&
      recommendedCount > 0 &&
      recommendedCount < question.min_selections
    ) {
      context.addIssue({
        code: "custom",
        message: "recommended options must satisfy min_selections so they can be chosen automatically",
        path: ["options"],
      });
    }
    if (question.kind === "multiple" && question.max_selections && recommendedCount > question.max_selections) {
      context.addIssue({
        code: "custom",
        message: "recommended options must not exceed max_selections",
        path: ["options"],
      });
    }
  });

type Question = z.infer<typeof questionSchema>;
type Answer = string | string[];
type AskStatus = "answered" | "discuss" | "declined" | "cancelled";

interface QuestionResult {
  status: AskStatus;
  answer?: Answer;
  alwaysUseRecommended?: boolean;
}

function titledOption(label: string, description?: string): string {
  return description ? `${label} — ${description}` : label;
}

function actionResult(action: "accept" | "decline" | "cancel"): QuestionResult | undefined {
  if (action === "decline") return { status: "declined" };
  if (action === "cancel") return { status: "cancelled" };
  return undefined;
}

async function elicitText(server: McpServer, question: Question, message?: string): Promise<QuestionResult> {
  const result = await server.server.elicitInput({
    mode: "form",
    message: message ?? question.question,
    requestedSchema: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          title: question.header,
          description: question.question,
          minLength: 1,
          maxLength: 4000,
        },
      },
      required: ["answer"],
    },
  });

  const stopped = actionResult(result.action);
  if (stopped) return stopped;
  const answer = result.content?.answer;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("The client returned an invalid free-text answer.");
  }
  return { status: "answered", answer: answer.trim() };
}

function recommendedAnswer(question: Question): Answer | undefined {
  if (question.kind === "text") return undefined;
  const recommended = (question.options ?? []).filter((option) => option.recommended).map((option) => option.label);
  if (recommended.length === 0) return undefined;
  return question.kind === "single" ? recommended[0] : recommended;
}

async function elicitQuestion(
  server: McpServer,
  question: Question,
  autoUseRecommended: boolean,
  validationMessage?: string,
): Promise<QuestionResult> {
  const automaticAnswer = recommendedAnswer(question);
  if (autoUseRecommended && automaticAnswer !== undefined) {
    return { status: "answered", answer: automaticAnswer };
  }

  if (question.kind === "text") {
    if (!question.allow_discussion) return elicitText(server, question);

    const action = await server.server.elicitInput({
      mode: "form",
      message: question.question,
      requestedSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            title: question.header,
            description: "Answer now, or return to the chat to talk through the decision first.",
            oneOf: [
              { const: "answer", title: "Enter my answer" },
              { const: DISCUSS, title: "Discuss with Codex first" },
            ],
            default: "answer",
          },
        },
        required: ["action"],
      },
    });

    const stopped = actionResult(action.action);
    if (stopped) return stopped;
    if (action.content?.action === DISCUSS) return { status: "discuss" };
    return elicitText(server, question, `Enter your answer: ${question.question}`);
  }

  const options = question.options ?? [];
  const hasRecommendation = automaticAnswer !== undefined;
  const choices = options.map((option, index) => ({
    const: `choice_${index}`,
    title: titledOption(`${option.label}${option.recommended ? " (Recommended)" : ""}`, option.description),
  }));
  if (question.allow_other) choices.push({ const: OTHER, title: "Enter my own answer" });
  if (question.allow_discussion) choices.push({ const: DISCUSS, title: "Discuss with Codex first" });
  if (hasRecommendation) {
    choices.push({
      const: ALWAYS_USE_RECOMMENDED,
      title: "Always use recommended choices",
    });
  }

  let answerDefinition: PrimitiveSchemaDefinition;
  let defaultSelection: string | string[] | undefined;
  if (question.kind === "single") {
    const recommendedIndex = options.findIndex((option) => option.recommended);
    defaultSelection = recommendedIndex >= 0 ? `choice_${recommendedIndex}` : undefined;
    answerDefinition = {
      type: "string",
      title: question.header,
      description: question.question,
      oneOf: choices,
      ...(defaultSelection ? { default: defaultSelection } : {}),
    };
  } else {
    const recommendedValues = options
      .map((option, index) => (option.recommended ? `choice_${index}` : undefined))
      .filter((value): value is string => value !== undefined);
    defaultSelection = recommendedValues.length > 0 ? recommendedValues : undefined;
    answerDefinition = {
      type: "array",
      title: question.header,
      description: question.question,
      items: { anyOf: choices },
      minItems: question.min_selections ?? 1,
      ...(defaultSelection ? { default: defaultSelection } : {}),
    };
  }

  const properties: Record<string, PrimitiveSchemaDefinition> = { answer: answerDefinition };

  const result = await server.server.elicitInput({
    mode: "form",
    message: validationMessage ?? question.question,
    requestedSchema: {
      type: "object",
      properties,
      // Some hosts omit an unchanged preselected value from the response and
      // expect the server to apply the JSON Schema default.
      ...(defaultSelection === undefined ? { required: ["answer"] } : {}),
    },
  });

  const stopped = actionResult(result.action);
  if (stopped) return stopped;

  const submittedAnswer = result.content?.answer ?? defaultSelection;
  let selected = question.kind === "single" ? [submittedAnswer] : submittedAnswer;
  if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string")) {
    throw new Error("The client returned an invalid selection.");
  }
  if (selected.includes(DISCUSS)) return { status: "discuss" };
  const alwaysUseRecommended = selected.includes(ALWAYS_USE_RECOMMENDED);
  if (alwaysUseRecommended) {
    selected = question.kind === "single" ? [defaultSelection] : defaultSelection;
    if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string")) {
      throw new Error("Always use recommended choices requires at least one recommended option.");
    }
  }

  const answerCount = selected.filter(
    (value) => value !== DISCUSS && value !== ALWAYS_USE_RECOMMENDED,
  ).length;
  const minSelections = question.min_selections ?? 1;
  if (answerCount < minSelections) {
    return elicitQuestion(
      server,
      question,
      false,
      `Select at least ${minSelections} answer${minSelections === 1 ? "" : "s"}. A custom answer counts as one.`,
    );
  }
  if (question.max_selections && answerCount > question.max_selections) {
    return elicitQuestion(
      server,
      question,
      false,
      `Select at most ${question.max_selections} answer${question.max_selections === 1 ? "" : "s"}. A custom answer counts as one.`,
    );
  }

  const labels = selected
    .filter((value): value is string => typeof value === "string" && value !== OTHER)
    .map((value) => {
      const match = /^choice_(\d+)$/.exec(value);
      if (!match) throw new Error(`The client returned an unknown choice: ${value}`);
      const option = options[Number(match[1])];
      if (!option) throw new Error(`The client returned an unknown choice: ${value}`);
      return option.label;
    });

  if (selected.includes(OTHER)) {
    const custom = await elicitText(server, question, `Enter your own answer: ${question.question}`);
    if (custom.status !== "answered") return custom;
    labels.push(custom.answer as string);
  }

  return {
    status: "answered",
    answer: question.kind === "single" ? labels[0] : labels,
    alwaysUseRecommended,
  };
}

function toolResult(
  status: AskStatus,
  answers: Record<string, Answer>,
  pending?: Question,
  autoUseRecommended = false,
) {
  const structuredContent: Record<string, unknown> = {
    status,
    answers,
    auto_use_recommended: autoUseRecommended,
  };
  let text: string;

  if (status === "answered") {
    const lines = Object.entries(answers).map(([id, answer]) =>
      `- ${id}: ${Array.isArray(answer) ? answer.join(", ") : answer}`,
    );
    text = `User answered:\n${lines.join("\n")}`;
  } else if (status === "discuss" && pending) {
    structuredContent.pending_question = {
      id: pending.id,
      header: pending.header,
      question: pending.question,
    };
    text =
      `The user chose to discuss \"${pending.question}\" with Codex first. ` +
      "Pause the decision, explain the relevant tradeoffs in chat, answer follow-up questions, and call ask_user again when the user is ready to decide.";
  } else if (status === "declined") {
    text =
      "The host declined the question request before an answer was returned. " +
      "The user may have declined it, or the active Codex approval policy may have auto-rejected MCP elicitations without showing a prompt. " +
      "Do not guess the user's preference. Check that approval_policy permits mcp_elicitations, then ask again only after the policy is corrected.";
  } else {
    text = "The user cancelled the question prompt. Stop this decision flow and wait for their direction.";
  }

  return { structuredContent, content: [{ type: "text" as const, text }] };
}

export function createAskUserServer(): McpServer {
  let autoUseRecommended = false;
  const server = new McpServer(
    { name: "codex-ask-user", version: "0.1.0" },
    {
      instructions:
        `${ALL_MODES_GUIDANCE} Use ask_user before committing to a plan or implementation when ambiguity, missing requirements, or a meaningful user preference could change the result. Mark the best option(s) recommended. If the user chooses discussion, discuss in chat and ask again afterward.`,
    },
  );

  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description:
        `${ALL_MODES_GUIDANCE} Use this when ambiguity, missing information, or a meaningful user decision should be resolved before finalizing a plan or starting implementation. It presents native Codex UI for single-choice, multi-choice, or free-text answers. Mark the best option(s) recommended so they are preselected. Users can enter a custom answer, discuss a choice first, or automatically use recommendations for later questions. If status is discuss, talk through the tradeoffs and call this tool again afterward.`,
      inputSchema: {
        questions: z.array(questionSchema).min(1).max(3).describe("One to three focused questions, asked in order."),
        force_prompt: z
          .boolean()
          .default(false)
          .describe("Show the prompt even when recommended choices are normally selected automatically."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ questions, force_prompt }) => {
      const answers: Record<string, Answer> = {};
      for (const question of questions) {
        const result = await elicitQuestion(server, question, autoUseRecommended && !force_prompt);
        if (result.status !== "answered") {
          return toolResult(result.status, answers, question, autoUseRecommended);
        }
        if (result.answer === undefined) throw new Error("No answer was returned.");
        answers[question.id] = result.answer;
        if (result.alwaysUseRecommended) autoUseRecommended = true;
      }
      return toolResult("answered", answers, undefined, autoUseRecommended);
    },
  );

  server.registerTool(
    "set_question_preferences",
    {
      title: "Set question preferences",
      description:
        "Use this when the user asks to start or stop automatically choosing recommended answers, or asks whether automatic recommendations are active. The preference lasts for the current Codex MCP session. Users can request this naturally in chat, for example: stop auto-selecting recommendations.",
      inputSchema: {
        mode: z
          .enum(["ask_every_time", "use_recommended", "status"])
          .describe("ask_every_time disables automatic answers; use_recommended enables them; status only reports the setting."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ mode }) => {
      if (mode === "ask_every_time") autoUseRecommended = false;
      if (mode === "use_recommended") autoUseRecommended = true;
      const text = autoUseRecommended
        ? "Recommended choices will be selected automatically for this Codex session. Questions without recommendations will still be shown."
        : "Automatic recommendations are off. Codex will ask every question and preselect recommendations when available.";
      return {
        structuredContent: { auto_use_recommended: autoUseRecommended, scope: "session" },
        content: [{ type: "text", text }],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createAskUserServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
