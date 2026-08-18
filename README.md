# Codex Ask User

Codex Ask User is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Codex a native, structured way to clarify requirements before it commits to a plan or implementation.

It uses MCP elicitation so Codex CLI and Codex desktop can display native controls for:

- single-choice questions;
- multiple-choice questions;
- free-text and custom answers;
- recommended choices that are labeled and preselected;
- a **Discuss with Codex first** path that returns to chat before asking again;
- session-scoped automatic selection of recommended answers.

## Requirements

- Node.js 20 or newer
- Codex CLI or Codex desktop with MCP elicitation enabled

## Build and test

```sh
npm install
npm test
```

The build produces a self-contained MCP server at `plugins/ask-user/dist/server.js`.

## Install as a Codex MCP server

Build the project, then register the generated server using its absolute path:

```sh
codex mcp add ask-user -- node /absolute/path/to/codex-ask-user/plugins/ask-user/dist/server.js
```

Start a new Codex CLI session or desktop task after registration. The server exposes these tools:

- `ask_user` presents one to three single-choice, multiple-choice, or free-text questions.
- `set_question_preferences` enables, disables, or reports automatic use of recommended answers for the current MCP session.

The repository also contains an installable Codex plugin bundle in `plugins/ask-user`. Its `.mcp.json` uses `${PLUGIN_ROOT}`, so the bundle remains relocatable.

`ask_user` is the plugin's MCP tool, not Codex's built-in `request_user_input` tool. It is available in both Default and Plan collaboration modes. If an agent says it cannot ask because `request_user_input` is restricted to Plan mode, explicitly ask it to use the **Ask User plugin's `ask_user` MCP tool** instead. The server advertises this distinction in both its instructions and tool description.

## Codex approval policy

MCP elicitation must be allowed by the active Codex approval policy. To keep other prompt categories non-interactive while allowing questions, use:

```toml
approval_policy = { granular = { sandbox_approval = false, rules = false, mcp_elicitations = true, request_permissions = false, skill_approval = false } }
```

In Codex desktop, the task's permission selector can override `config.toml`. **Full access** uses an approval policy that rejects MCP elicitations without displaying the question. Select the custom configuration and start a new task after changing the policy.

If `ask_user` immediately returns `declined` without visible UI, check the task's active approval policy before treating the result as a user decision.

## Example

An agent can call `ask_user` with a recommended option and an open-ended alternative:

```json
{
  "questions": [
    {
      "id": "database",
      "header": "Database",
      "question": "Which database should back the first release?",
      "kind": "single",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "A strong default for production workloads.",
          "recommended": true
        },
        {
          "label": "SQLite",
          "description": "Simpler deployment for a local-first application."
        }
      ],
      "allow_other": true,
      "allow_discussion": true
    }
  ]
}
```

Selecting **Always use recommended choices** automatically resolves later questions that have recommendations during the current MCP session. Questions without recommendations are still shown. Ask Codex to stop auto-selecting recommendations to restore the default behavior.

## Development

```sh
npm run check
npm run build
npm test
```

- `src/server.ts` contains the MCP server and tool implementation.
- `tests/server.test.js` tests elicitation flows through an in-memory MCP client.
- `scripts/build.mjs` bundles the server with esbuild.
- `plugins/ask-user` contains the Codex plugin manifest and MCP configuration.

## Author

[blhsing](https://github.com/blhsing)
