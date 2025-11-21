// titan Sweep&Go MCP server
import http from "node:http";
import "dotenv/config";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server";
import { HttpServerTransport } from "@modelcontextprotocol/sdk/server/http.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---- ENV + basic config -----------------------------------------------------

const PORT = Number(process.env.PORT || 10000);  // Render will override to 10000
const MCP_PATH = "/mcp";

const CRM_BASE_URL =
  process.env.CRM_BASE_URL || "https://openapi.sweepandgo.com";

const SNG_API_KEY = process.env.SNG_API_KEY || "";
const ALLOW_WRITES = String(process.env.SNG_ALLOW_WRITES || "false") === "true";

if (!SNG_API_KEY) {
  console.warn(
    "[SNG MCP] WARNING: SNG_API_KEY is not set. All tools will fail until you add it in Render > Environment"
  );
}

// ---- Simple HTTP helper -----------------------------------------------------

async function sngRequest(path, { method = "GET", query, body } = {}) {
  const url = new URL(path, CRM_BASE_URL);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${SNG_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sweep&Go API ${method} ${url.pathname} failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

// ---- Schemas + Tool Implementations ----------------------------------------

const ZipDogsSchema = z.object({
  zip_code: z.string(),
  number_of_dogs: z.number().int().min(1),
  last_time_yard_was_thoroughly_cleaned: z.string(),
});

const OnboardingPriceInputSchema = ZipDogsSchema.extend({
  clean_up_frequency: z.string().optional(),
});

async function tool_get_onboarding_price(args) {
  const input = OnboardingPriceInputSchema.parse(args);
  const data = await sngRequest(
    "/api/v2/client_on_boarding/price_registration_form",
    { method: "POST", body: input }
  );
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_packages_list() {
  const data = await sngRequest("/api/v2/packages_list", { method: "GET" });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_quote_recommendations(args) {
  const input = OnboardingPriceInputSchema.parse(args);

  const [priceInfo, packagesInfo] = await Promise.all([
    sngRequest("/api/v2/client_on_boarding/price_registration_form", {
      method: "POST",
      body: input,
    }),
    sngRequest("/api/v2/packages_list", { method: "GET" }),
  ]);

  const base = priceInfo?.regular_price ?? priceInfo?.price ?? null;
  const initial = priceInfo?.initial_cleanup_price ?? null;
  const recommended = priceInfo?.recommended_frequency ?? null;

  let lines = [];
  lines.push(
    `Here is a summary based on ${input.number_of_dogs} dog(s) in zip ${input.zip_code}.`
  );

  if (base) lines.push(`- Regular visit estimate: ${base}`);
  if (initial) lines.push(`- Initial cleanup estimate: ${initial}`);
  if (recommended) lines.push(`- Recommended frequency: ${recommended}`);

  const cross = packagesInfo?.cross_sells || packagesInfo?.packages || [];
  if (Array.isArray(cross) && cross.length) {
    lines.push("");
    lines.push("Cross-sell ideas you can mention:");
    for (const pkg of cross.slice(0, 5)) {
      lines.push(`- ${pkg.name}: ${pkg.description}`);
    }
  }

  return {
    type: "text",
    text: lines.join("\n"),
  };
}

const CreateClientSchema = z.object({
  zip_code: z.string(),
  number_of_dogs: z.number().int().min(1),
  last_time_yard_was_thoroughly_cleaned: z.string(),
  clean_up_frequency: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  home_address: z.string(),
  city: z.string(),
  state: z.string(),
  home_phone_number: z.string().optional(),
  cell_phone_number: z.string().optional(),
  additional_comment: z.string().optional(),
});

async function tool_create_client(args) {
  if (!ALLOW_WRITES) {
    return {
      type: "text",
      text:
        "Writes disabled. Set SNG_ALLOW_WRITES=true in Render to enable this.",
    };
  }

  const input = CreateClientSchema.parse(args);

  const data = await sngRequest("/api/v1/residential/onboarding", {
    method: "PUT",
    body: input,
  });

  return {
    type: "text",
    text: JSON.stringify(data, null, 2),
  };
}

// ---- Create MCP Server Instance --------------------------------------------

function buildMcpServer() {
  const server = new Server(
    { name: "titan-sweepandgo-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        { name: "get_onboarding_price", inputSchema: OnboardingPriceInputSchema },
        { name: "get_packages_list", inputSchema: {} },
        {
          name: "get_quote_recommendations",
          inputSchema: OnboardingPriceInputSchema,
        },
        { name: "create_client", inputSchema: CreateClientSchema },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments || {};
    switch (req.params.name) {
      case "get_onboarding_price":
        return { content: [await tool_get_onboarding_price(args)] };
      case "get_packages_list":
        return { content: [await tool_get_packages_list()] };
      case "get_quote_recommendations":
        return { content: [await tool_get_quote_recommendations(args)] };
      case "create_client":
        return { content: [await tool_create_client(args)] };
      default:
        throw new Error(`Unknown tool: ${req.params.name}`);
    }
  });

  return server;
}

// ---- HTTP Server + MCP over SSE --------------------------------------------

const mcpServer = buildMcpServer();
const transport = new HttpServerTransport({ path: MCP_PATH });

await mcpServer.connect(transport);

http.createServer(transport.handleRequest).listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${PORT} at ${MCP_PATH}`);
});
