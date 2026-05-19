/**
 * Structured tools the vibecoding model may invoke during a multi-turn
 * session. Two tools today:
 *
 *  - `requestEnvVar`  ask the owner to set an env var the generated
 *                     code will read from `process.env`. The value
 *                     flows entirely outside this channel (via the
 *                     signed `set-app-env` order); the tool ack the
 *                     orchestrator feeds back to the model is
 *                     VALUE-FREE by type — it carries only the name,
 *                     a boolean "currently-set", and a status enum.
 *
 *  - `talkToUser`     free-form model→user message + the owner's
 *                     free-form reply. Treated as non-secret by
 *                     contract; the system prompt instructs the model
 *                     never to ask the owner to paste a secret into
 *                     chat.
 *
 * The model-facing schemas live here so the prompt text and the
 * provider tool specs stay in lockstep — every change to the contract
 * surfaces in one place.
 */

import type { ToolSpec } from "@flagship/llm-providers";

export const REQUEST_ENV_VAR_TOOL: ToolSpec = {
  name: "requestEnvVar",
  description:
    "Ask the owner to set a per-app environment variable that the " +
    "generated code needs. The owner sets the value out-of-band via a " +
    "signed set-app-env order — the value is NEVER visible to you and " +
    "NEVER returned by this tool. The response you receive is value-free: " +
    "only an acknowledgement, status, and whether the variable is now set.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "The env-var name (CONSTANT_CASE, no FLAGSHIP_ prefix). The generated app will read this from its process environment.",
      },
      description: {
        type: "string",
        description: "One-line human-readable description of what the value is for.",
      },
      why: {
        type: "string",
        description: "Why the app needs it — the owner sees this verbatim.",
      },
      example: {
        type: "string",
        description: "Optional example shape (e.g. 'sk-...', 'eyJ...'). NEVER include real values.",
      },
      secret: {
        type: "boolean",
        description:
          "Hint to the UI that the value is sensitive (mask in input). True for API keys, tokens, credentials.",
      },
    },
    required: ["name", "description", "why"],
  },
};

export const TALK_TO_USER_TOOL: ToolSpec = {
  name: "talkToUser",
  description:
    "Send a free-form text message to the owner mid-build, e.g. a " +
    "clarifying question or a status update. The owner's free-form " +
    "reply comes back as a user-role message in the next turn. NEVER " +
    "use this to ask the owner to paste a secret value — secrets go " +
    "through requestEnvVar (which routes them via a signed set-app-env " +
    "order, never through chat).",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The free-form message to show the owner.",
      },
    },
    required: ["message"],
  },
};

/** The two tools the daemon advertises on every vibe-code call. */
export const VIBE_CODE_TOOLS: readonly ToolSpec[] = [REQUEST_ENV_VAR_TOOL, TALK_TO_USER_TOOL];

/**
 * The supplement the orchestrator appends to the system prompt when
 * tool use is wired. Kept short — the canonical SYSTEM_PROMPT_V1 still
 * dominates token budget — and structured so the model can't confuse
 * "ask the owner for a secret VALUE via chat" with the legitimate
 * requestEnvVar path.
 */
export const TOOL_USE_PROMPT_SUPPLEMENT = `# Multi-turn tools

You may call these tools while building. Each call PAUSES the build
until the owner responds.

## requestEnvVar({ name, description, why, example?, secret? })

The ONLY legitimate way to ask the owner for a per-app environment
variable the generated code will read. You will receive a value-free
acknowledgement: { acknowledged: true, status: "set" | "declined" |
"deferred", currentlySet: boolean, name }. The actual value is NEVER
returned to you; it lives only inside the user's container at runtime.
If status === "set", subsequent prompts will list the new name in
"Owner-set environment variables (names only)".

Use this for ANY config the app needs that you cannot hardcode:
API keys, account IDs, third-party tokens, custom endpoints, feature
flags. Always justify with a clear \`why\`.

## talkToUser({ message })

Free-form chat with the owner — a clarifying question, a design
checkpoint, a status update. The owner's free-form reply comes back as
the next user-role message. Use sparingly; do not narrate.

# Hard rules for tool use

- NEVER ask the owner to paste a secret VALUE into chat. The chat
  channel (talkToUser) is NOT a secret channel. The only legitimate
  surface for entering a secret is the value-free requestEnvVar flow,
  which the UI maps to a signed set-app-env order.
- NEVER include an env-var VALUE in any tool argument, file you emit,
  or talkToUser message. The daemon will refuse to deploy code that
  inlines a value the model produced.
- Prefer requestEnvVar over talkToUser when the goal is to obtain a
  configuration value.
- After END or QUESTION blocks, no more tools — emit the file blocks.
`;
