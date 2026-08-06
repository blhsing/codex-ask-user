import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createAskUserServer } from "../plugins/ask-user/dist/server.js";

async function withClient(responses, run) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAskUserServer();
  const client = new Client(
    { name: "ask-user-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const requests = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    requests.push(request.params);
    const response = responses.shift();
    assert.ok(response, "unexpected elicitation request");
    return response;
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, requests);
    assert.equal(responses.length, 0, "not all elicitation responses were consumed");
  } finally {
    await client.close();
    await server.close();
  }
}

test("advertises the clarification tool and its safety hints", async () => {
  await withClient([], async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "ask_user");
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.properties.questions.maxItems, 3);
  });
});

test("supports a custom single-choice answer", async () => {
  await withClient(
    [
      { action: "accept", content: { answer: "__other__" } },
      { action: "accept", content: { answer: "Use SQLite for the first release" } },
    ],
    async (client, requests) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          questions: [
            {
              id: "database",
              header: "Database",
              question: "Which database should back the first release?",
              kind: "single",
              options: [{ label: "Postgres" }, { label: "MySQL" }],
            },
          ],
        },
      });

      assert.equal(requests.length, 2);
      assert.equal(requests[0].requestedSchema.properties.answer.type, "string");
      assert.deepEqual(result.structuredContent, {
        status: "answered",
        answers: { database: "Use SQLite for the first release" },
        auto_use_recommended: false,
      });
    },
  );
});

test("supports multi-choice answers", async () => {
  await withClient(
    [{ action: "accept", content: { answer: ["choice_0", "choice_2"] } }],
    async (client, requests) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          questions: [
            {
              id: "targets",
              header: "Targets",
              question: "Which clients need support?",
              kind: "multiple",
              options: [{ label: "CLI" }, { label: "IDE" }, { label: "Desktop" }],
            },
          ],
        },
      });

      assert.equal(requests[0].requestedSchema.properties.answer.type, "array");
      assert.deepEqual(result.structuredContent, {
        status: "answered",
        answers: { targets: ["CLI", "Desktop"] },
        auto_use_recommended: false,
      });
    },
  );
});

test("supports a custom multi-choice answer without native maxItems dead-ending the form", async () => {
  await withClient(
    [
      {
        action: "accept",
        content: { answer: ["choice_0", "choice_1", "choice_2", "__other__"] },
      },
      {
        action: "accept",
        content: { answer: ["choice_0", "choice_1", "__other__"] },
      },
      { action: "accept", content: { answer: "Browser extension" } },
    ],
    async (client, requests) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          questions: [
            {
              id: "targets",
              header: "Targets",
              question: "Which clients need support?",
              kind: "multiple",
              options: [{ label: "CLI" }, { label: "IDE" }, { label: "Desktop" }],
              max_selections: 3,
            },
          ],
        },
      });

      assert.equal(requests.length, 3);
      assert.equal(requests[0].requestedSchema.properties.answer.maxItems, undefined);
      assert.match(requests[1].message, /at most 3 answers/i);
      assert.deepEqual(result.structuredContent, {
        status: "answered",
        answers: { targets: ["CLI", "IDE", "Browser extension"] },
        auto_use_recommended: false,
      });
    },
  );
});

test("allows an explicit minimum without requiring recommended options", async () => {
  await withClient(
    [{ action: "accept", content: { answer: ["choice_0"] } }],
    async (client) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          questions: [
            {
              id: "targets",
              header: "Targets",
              question: "Which clients need support?",
              kind: "multiple",
              options: [{ label: "CLI" }, { label: "Desktop" }],
              min_selections: 1,
            },
          ],
        },
      });

      assert.deepEqual(result.structuredContent, {
        status: "answered",
        answers: { targets: ["CLI"] },
        auto_use_recommended: false,
      });
    },
  );
});

test("applies recommended defaults omitted by the elicitation host", async () => {
  await withClient(
    [
      { action: "accept", content: {} },
      { action: "accept", content: {} },
    ],
    async (client, requests) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          force_prompt: true,
          questions: [
            {
              id: "database",
              header: "Database",
              question: "Which database should back the first release?",
              kind: "single",
              options: [
                { label: "Postgres", recommended: true },
                { label: "MySQL" },
              ],
            },
            {
              id: "targets",
              header: "Targets",
              question: "Which clients need support?",
              kind: "multiple",
              options: [
                { label: "CLI", recommended: true },
                { label: "IDE" },
                { label: "Desktop", recommended: true },
              ],
            },
          ],
        },
      });

      assert.equal(requests[0].requestedSchema.required, undefined);
      assert.equal(requests[0].requestedSchema.properties.answer.default, "choice_0");
      assert.equal(requests[1].requestedSchema.required, undefined);
      assert.deepEqual(requests[1].requestedSchema.properties.answer.default, ["choice_0", "choice_2"]);
      assert.deepEqual(result.structuredContent, {
        status: "answered",
        answers: {
          database: "Postgres",
          targets: ["CLI", "Desktop"],
        },
        auto_use_recommended: false,
      });
    },
  );
});

test("returns control to Codex when the user wants discussion", async () => {
  await withClient(
    [{ action: "accept", content: { action: "__discuss_with_codex__" } }],
    async (client) => {
      const result = await client.callTool({
        name: "ask_user",
        arguments: {
          questions: [
            {
              id: "rollout",
              header: "Rollout",
              question: "How should this be rolled out?",
              kind: "text",
            },
          ],
        },
      });

      assert.deepEqual(result.structuredContent, {
        status: "discuss",
        answers: {},
        auto_use_recommended: false,
        pending_question: {
          id: "rollout",
          header: "Rollout",
          question: "How should this be rolled out?",
        },
      });
    },
  );
});

test("does not misattribute a host-declined elicitation to the user", async () => {
  await withClient([{ action: "decline", content: null }], async (client) => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        questions: [
          {
            id: "database",
            header: "Database",
            question: "Which database should back the first release?",
            kind: "single",
            options: [{ label: "Postgres" }, { label: "MySQL" }],
          },
        ],
      },
    });

    assert.deepEqual(result.structuredContent, {
      status: "declined",
      answers: {},
      auto_use_recommended: false,
    });
    const text = result.content.find(({ type }) => type === "text")?.text ?? "";
    assert.match(text, /host declined/i);
    assert.match(text, /approval_policy permits mcp_elicitations/i);
    assert.doesNotMatch(text, /^The user declined/i);
  });
});

test("preselects recommendations and can use them automatically for the session", async () => {
  await withClient(
    [{ action: "accept", content: { answer: ["choice_0", "choice_2", "__always_use_recommended__"] } }],
    async (client, requests) => {
      const question = {
        id: "clients",
        header: "Clients",
        question: "Which clients should be supported?",
        kind: "multiple",
        options: [
          { label: "CLI", recommended: true },
          { label: "IDE" },
          { label: "Desktop", recommended: true },
        ],
      };

      const first = await client.callTool({ name: "ask_user", arguments: { questions: [question] } });
      assert.deepEqual(requests[0].requestedSchema.properties.answer.default, ["choice_0", "choice_2"]);
      assert.equal(requests[0].requestedSchema.properties.always_use_recommended, undefined);
      assert.equal(
        requests[0].requestedSchema.properties.answer.items.anyOf.at(-1).const,
        "__always_use_recommended__",
      );
      assert.equal(first.structuredContent.auto_use_recommended, true);

      const second = await client.callTool({ name: "ask_user", arguments: { questions: [question] } });
      assert.deepEqual(second.structuredContent, {
        status: "answered",
        answers: { clients: ["CLI", "Desktop"] },
        auto_use_recommended: true,
      });
      assert.equal(requests.length, 1, "the second call should use recommendations without another prompt");

      const preference = await client.callTool({
        name: "set_question_preferences",
        arguments: { mode: "ask_every_time" },
      });
      assert.deepEqual(preference.structuredContent, {
        auto_use_recommended: false,
        scope: "session",
      });
    },
  );
});
