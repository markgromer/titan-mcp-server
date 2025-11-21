// Titan Sweep&Go MCP server

import http from "node:http";
import "dotenv/config";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// ENV + basic config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);
const MCP_PATH = "/mcp";

const CRM_BASE_URL =
  process.env.CRM_BASE_URL || "https://openapi.sweepandgo.com";
const SNG_API_KEY = process.env.SNG_API_KEY || "";
const ALLOW_WRITES = String(process.env.SNG_ALLOW_WRITES || "false") === "true";

if (!SNG_API_KEY) {
  console.warn(
    "[SNG MCP] WARNING: SNG_API_KEY is not set. All tools will fail until you add it to .env"
  );
}

// ---------------------------------------------------------------------------
// Simple HTTP helper (uses global fetch - Node 18+)
// ---------------------------------------------------------------------------

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

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sweep&Go API ${method} ${url.pathname} failed: ${res.status} ${res.statusText} ${text}`
    );
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const ZipDogsSchema = z.object({
  zip_code: z.string().describe("5-digit ZIP code, e.g. 85706"),
  number_of_dogs: z
    .number()
    .int()
    .min(1)
    .describe("Number of dogs in the household"),
  last_time_yard_was_thoroughly_cleaned: z
    .enum([
      "one_week",
      "two_weeks",
      "three_weeks",
      "one_month",
      "two_months",
      "3-4_months",
      "5-6_months",
      "7-9_months",
      "10+_months",
    ])
    .describe("How long since the yard was last thoroughly cleaned"),
});

const OnboardingPriceInputSchema = ZipDogsSchema.extend({
  clean_up_frequency: z
    .enum([
      "seven_times_a_week",
      "six_times_a_week",
      "five_times_a_week",
      "four_times_a_week",
      "three_times_a_week",
      "two_times_a_week",
      "once_a_week",
      "every_other_week",
      "once_every_four_weeks",
      "once_a_month",
    ])
    .optional()
    .describe("Desired service frequency, if known"),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// 1) Get onboarding price / cross-sell info
async function tool_get_onboarding_price(args) {
  const input = OnboardingPriceInputSchema.parse(args);

  const data = await sngRequest(
    "/api/v2/client_on_boarding/price_registration_form",
    {
      method: "POST",
      body: input,
    }
  );

  return {
    type: "text",
    text: JSON.stringify(data, null, 2),
  };
}

// 2) Get available packaged cross-sells
async function tool_get_packages_list() {
  const data = await sngRequest("/api/v2/packages_list", {
    method: "GET",
  });

  return {
    type: "text",
    text: JSON.stringify(data, null, 2),
  };
}

// 3) Parker-friendly quote + frequency recommendation
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
  const recommendedFrequency = priceInfo?.recommended_frequency ?? null;

  const lines = [];

  lines.push(
    `Here is a summary based on ${input.number_of_dogs} dog(s) in zip ${input.zip_code}.`
  );

  if (base !== null) {
    lines.push(`- Regular visit estimate: ${base}`);
  }
  if (initial !== null) {
    lines.push(`- Initial cleanup estimate: ${initial}`);
  }
  if (recommendedFrequency) {
    lines.push(`- Recommended frequency: ${recommendedFrequency}`);
  }

  const cross = packagesInfo?.cross_sells || packagesInfo?.packages || [];
  if (Array.isArray(cross) && cross.length) {
    lines.push("");
    lines.push("Cross-sell ideas you can mention:");
    for (const pkg of cross.slice(0, 5)) {
      const name = pkg.name || "Package";
      const desc = pkg.description || "";
      lines.push(`- ${name}: ${desc}`.trim());
    }
  }

  return {
    type: "text",
    text: lines.join("\n"),
  };
}

// 4) Create client (mutating)
const CreateClientInputSchema = z.object({
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
        "Writes are disabled for this MCP server. Set SNG_ALLOW_WRITES=true in .env if you really want Parker to create clients.",
    };
  }

  const input = CreateClientInputSchema.parse(args);

  const data = await sngRequest("/api/v1/residential/onboarding", {
    method: "PUT",
    body: input,
  });

  return {
    type: "text",
    text:
      "Client created in Sweep&Go.\n\nResponse:\n" +
      JSON.stringify(data, null, 2),
  };
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

function createTitanServer() {
  const server = new Server(
    {
      name: "titan-sweepandgo-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      {
        name: "get_onboarding_price",
        description:
          "Look up Sweep&Go onboarding price info for a household (dogs, zip, last cleaned, optional frequency). Returns raw JSON from Sweep&Go.",
        inputSchema: {
          type: "object",
          properties: {
            zip_code: { type: "string" },
            number_of_dogs: { type: "number" },
            last_time_yard_was_thoroughly_cleaned: { type: "string" },
            clean_up_frequency: { type: "string" },
          },
          required: [
            "zip_code",
            "number_of_dogs",
            "last_time_yard_was_thoroughly_cleaned",
          ],
        },
      },
      {
        name: "get_packages_list",
        description:
          "Fetch packaged cross-sells / add-on bundles from Sweep&Go for the organization.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_quote_recommendations",
        description:
          "Given dogs/zip/last cleaned (and optional frequency), fetch pricing and packages and return a human-readable summary Parker can use as a quote.",
        inputSchema: {
          type: "object",
          properties: {
            zip_code: { type: "string" },
            number_of_dogs: { type: "number" },
            last_time_yard_was_thoroughly_cleaned: { type: "string" },
            clean_up_frequency: { type: "string" },
          },
          required: [
            "zip_code",
            "number_of_dogs",
            "last_time_yard_was_thoroughly_cleaned",
          ],
        },
      },
      {
        name: "create_client",
        description:
          "[MUTATING] Create a new residential client in Sweep&Go using the onboarding form fields. Respects SNG_ALLOW_WRITES flag.",
        inputSchema: {
          type: "object",
          properties: {
            zip_code: { type: "string" },
            number_of_dogs: { type: "number" },
            last_time_yard_was_thoroughly_cleaned: { type: "string" },
            clean_up_frequency: { type: "string" },
            first_name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string" },
            home_address: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            home_phone_number: { type: "string" },
            cell_phone_number: { type: "string" },
            additional_comment: { type: "string" },
          },
          required: [
            "zip_code",
            "number_of_dogs",
            "last_time_yard_was_thoroughly_cleaned",
            "clean_up_frequency",
            "first_name",
            "last_name",
            "email",
            "home_address",
            "city",
            "state",
          ],
        },
      },
    ];

    return { tools };
  });

  // Call tools
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};

    switch (name) {
      case "get_onboarding_price":
        return { content: [await tool_get_onboarding_price(args)] };
      case "get_packages_list":
        return { content: [await tool_get_packages_list()] };
      case "get_quote_recommendations":
        return { content: [await tool_get_quote_recommendations(args)] };
      case "create_client":
        return { content: [await tool_create_client(args)] };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Start MCP server with SSE transport on /mcp and a simple 404 elsewhere
// ---------------------------------------------------------------------------

const mcpServer = createTitanServer();

const httpServer = http.createServer(async (req, res) => {
  if (req.url?.startsWith(MCP_PATH)) {
    console.log(
      `[MCP] incoming connection`,
      JSON.stringify({ method: req.method, url: req.url, headers: req.headers })
    );

    // Allow preflight for browsers/clients
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    // Always attempt SSE; connector should keep the stream open.
    // Make sure CORS is permissive for browser-based clients.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    // Construct transport with req/res and path
    const transport = new SSEServerTransport({
      request: req,
      response: res,
      path: MCP_PATH,
    });
    try {
      await mcpServer.connect(transport);
    } catch (err) {
      console.error("[MCP] transport error", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: err?.message || "Server error" },
          id: null,
        })
      );
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Titan Sweep&Go MCP SSE listening on ${host}${MCP_PATH}`);
});
