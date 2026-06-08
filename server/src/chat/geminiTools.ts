import type Anthropic from "@anthropic-ai/sdk";
import { CHAT_TOOL_DEFINITIONS } from "./tools";

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type JsonSchema = Record<string, unknown>;

function mapJsonType(type: unknown): string {
  const t = String(type || "string").toLowerCase();
  switch (t) {
    case "object":
      return "OBJECT";
    case "string":
      return "STRING";
    case "number":
    case "integer":
      return "NUMBER";
    case "boolean":
      return "BOOLEAN";
    case "array":
      return "ARRAY";
    default:
      return "STRING";
  }
}

function convertSchemaNode(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  if (node.type !== undefined) {
    out.type = mapJsonType(node.type);
  }
  if (typeof node.description === "string") {
    out.description = node.description;
  }
  if (Array.isArray(node.enum)) {
    out.enum = node.enum;
  }
  if (node.properties && typeof node.properties === "object") {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(
      node.properties as Record<string, JsonSchema>
    )) {
      props[key] = convertSchemaNode(value);
    }
    out.properties = props;
  }
  if (node.items && typeof node.items === "object") {
    out.items = convertSchemaNode(node.items as JsonSchema);
  }
  if (Array.isArray(node.required)) {
    out.required = node.required;
  }
  return out;
}

function claudeToolToGemini(tool: Anthropic.Tool): GeminiFunctionDeclaration {
  const schema = (tool.input_schema || { type: "object", properties: {} }) as JsonSchema;
  const parameters = convertSchemaNode({
    type: "object",
    properties: schema.properties || {},
    required: schema.required
  });
  return {
    name: tool.name,
    description: tool.description,
    parameters
  };
}

/** Tools exposed on Gemini Live voice sessions only. */
export const GEMINI_LIVE_TOOL_NAMES = [
  "search_web",
  "read_emails",
  "get_calls",
  "get_queue",
  "get_action_list",
  "save_note",
  "get_notes",
  "get_weather",
  "get_execution_log",
  "open_panel",
  "get_memory",
  "get_intel"
] as const;

const GEMINI_LIVE_FUNCTION_DECLARATIONS: GeminiFunctionDeclaration[] =
  CHAT_TOOL_DEFINITIONS.filter((t) =>
    GEMINI_LIVE_TOOL_NAMES.includes(t.name as (typeof GEMINI_LIVE_TOOL_NAMES)[number])
  ).map(claudeToolToGemini);

export const GEMINI_LIVE_TOOL_DECLARATIONS = [
  {
    functionDeclarations: GEMINI_LIVE_FUNCTION_DECLARATIONS
  }
];

export function buildGeminiLiveTools() {
  return GEMINI_LIVE_TOOL_DECLARATIONS;
}
