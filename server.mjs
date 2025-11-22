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
const ORG_SLUG = process.env.SNG_ORG_SLUG || process.env.SNG_ORGANIZATION || "";
const MCP_TOKEN = process.env.SNG_MCP_TOKEN || process.env.MCP_TOKEN || "";

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

  // Automatically inject organization identifier if available and not already provided
  if (ORG_SLUG) {
    if (!url.searchParams.has("organization_slug")) {
      url.searchParams.set("organization_slug", ORG_SLUG);
    }
    // Some endpoints expect `organization` instead of `organization_slug`
    if (!url.searchParams.has("organization")) {
      url.searchParams.set("organization", ORG_SLUG);
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

  if (res.status === 204) {
    return {};
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return res.text();
  }

  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Basic HTTP helpers
async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function authFailed(req) {
  if (!MCP_TOKEN) return false;
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return true;
  const token = header.slice("Bearer ".length);
  return token !== MCP_TOKEN;
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

// Shared helpers / schemas
function writesDisabledResponse() {
  return {
    type: "text",
    text:
      "Writes are disabled for this MCP server. Set SNG_ALLOW_WRITES=true in .env if you really want Parker to perform write operations.",
  };
}

const PaymentMethodsListSchema = z.object({
  customer_id: z.string(),
});

const IdSchema = z.object({ id: z.string() });

const PaymentSourceCreateSchema = z.object({
  customer_id: z.string(),
  payment_method_id: z.string(),
  default: z.boolean().optional(),
});

const PreAuthorizationListSchema = z.object({
  customer_id: z.string().optional(),
});

const PreAuthorizationCreateSchema = z.object({
  customer_id: z.string(),
  amount: z.number().int().positive(),
  location_id: z.string(),
  payment_source_id: z.string(),
  external_reference: z.string().optional(),
  description: z.string().optional(),
});

const ChargeListSchema = z.object({
  customer_id: z.string().optional(),
});

const ChargeCreateSchema = z.object({
  customer_id: z.string(),
  amount: z.number().int().positive(),
  location_id: z.string(),
  payment_source_id: z.string(),
  external_reference: z.string().optional(),
  description: z.string().optional(),
});

const RefundSchema = z.object({
  id: z.string(),
  amount: z.number().int().positive().optional(),
});

const CustomerListSchema = z.object({
  page: z.number().int().positive().optional(),
  per: z.number().int().positive().optional(),
});

const CustomerCreateSchema = z.object({
  full_name: z.string(),
  email: z.string(),
  mobile: z.string(),
  address_1: z.string().optional(),
  address_2: z.string().optional(),
  region: z.string().optional(),
  postal_code: z.string().optional(),
  notes: z.string().optional(),
});

const CustomerUpdateSchema = CustomerCreateSchema.partial().refine(
  (val) => Object.keys(val).length > 0,
  { message: "Provide at least one field to update." }
);

const LocationListSchema = CustomerListSchema;

const LocationCreateSchema = z.object({
  name: z.string(),
  address_1: z.string(),
  postal_code: z.string(),
  region: z.string(),
  email: z.string(),
  mobile: z.string(),
  address_2: z.string().optional(),
  website: z.string().optional(),
  logo_url: z.string().optional(),
  type: z.string().optional(),
});

const LocationUpdateSchema = LocationCreateSchema.partial().refine(
  (val) => Object.keys(val).length > 0,
  { message: "Provide at least one field to update." }
);

const WebhookListSchema = z
  .object({
    organization_id: z.string().optional(),
  })
  .refine(
    (val) => Boolean(val.organization_id || ORG_SLUG),
    "organization_id is required unless SNG_ORG_SLUG is set"
  );

const PackagedCrossSellsSchema = z.object({
  location_id: z.string(),
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
      method: "GET",
      query: input,
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

// 2b) Get all free quotes (listed in S&G docs)
async function tool_get_free_quotes() {
  const data = await sngRequest("/api/v2/free_quotes", {
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
      method: "GET",
      query: input,
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
  initial_cleanup_required: z.boolean(),
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

// Payment methods
async function tool_list_payment_methods(args) {
  const input = PaymentMethodsListSchema.parse(args);
  const data = await sngRequest("/api/v1/payment_methods", {
    method: "GET",
    query: { customer_id: input.customer_id },
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_payment_method(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/payment_methods/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Payment sources
async function tool_get_payment_source(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/payment_sources/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_create_payment_source(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = PaymentSourceCreateSchema.parse(args);
  const data = await sngRequest("/api/v1/payment_sources", {
    method: "POST",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Pre-authorizations
async function tool_list_pre_authorizations(args) {
  const input = PreAuthorizationListSchema.parse(args || {});
  const data = await sngRequest("/api/v1/pre_authorizations", {
    method: "GET",
    query: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_pre_authorization(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/pre_authorizations/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_create_pre_authorization(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = PreAuthorizationCreateSchema.parse(args);
  const data = await sngRequest("/api/v1/pre_authorizations", {
    method: "POST",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_delete_pre_authorization(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/pre_authorizations/${input.id}`, {
    method: "DELETE",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Charges
async function tool_list_charges(args) {
  const input = ChargeListSchema.parse(args || {});
  const data = await sngRequest("/api/v1/charges", {
    method: "GET",
    query: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_charge(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/charges/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_create_charge(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = ChargeCreateSchema.parse(args);
  const data = await sngRequest("/api/v1/charges", {
    method: "POST",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_refund_charge(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = RefundSchema.parse(args);
  const body = input.amount !== undefined ? { amount: input.amount } : undefined;
  const data = await sngRequest(`/api/v1/charges/${input.id}/refund`, {
    method: "POST",
    body,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Customers
async function tool_list_customers(args) {
  const input = CustomerListSchema.parse(args || {});
  const data = await sngRequest("/api/v1/customers", {
    method: "GET",
    query: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_customer(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/customers/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_create_customer(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = CustomerCreateSchema.parse(args);
  const data = await sngRequest("/api/v1/customers", {
    method: "POST",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_update_customer(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const { id, ...rest } = { ...(args || {}) };
  const idInput = IdSchema.parse({ id });
  const input = CustomerUpdateSchema.parse(rest);
  const data = await sngRequest(`/api/v1/customers/${idInput.id}`, {
    method: "PUT",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_delete_customer(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/customers/${input.id}`, {
    method: "DELETE",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Locations
async function tool_list_locations(args) {
  const input = LocationListSchema.parse(args || {});
  const data = await sngRequest("/api/v1/locations", {
    method: "GET",
    query: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_get_location(args) {
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/locations/${input.id}`, {
    method: "GET",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_create_location(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = LocationCreateSchema.parse(args);
  const data = await sngRequest("/api/v1/locations", {
    method: "POST",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_update_location(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const { id, ...rest } = { ...(args || {}) };
  const idInput = IdSchema.parse({ id });
  const input = LocationUpdateSchema.parse(rest);
  const data = await sngRequest(`/api/v1/locations/${idInput.id}`, {
    method: "PUT",
    body: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Webhooks
async function tool_list_webhooks(args) {
  const input = WebhookListSchema.parse(args || {});
  const organization_id = input.organization_id || ORG_SLUG;
  const data = await sngRequest("/api/v1/webhooks", {
    method: "GET",
    query: { organization_id },
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

async function tool_retry_webhook(args) {
  if (!ALLOW_WRITES) return writesDisabledResponse();
  const input = IdSchema.parse(args);
  const data = await sngRequest(`/api/v1/webhooks/${input.id}/retry`, {
    method: "PUT",
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// Packaged cross-sells
async function tool_get_packaged_cross_sells(args) {
  const input = PackagedCrossSellsSchema.parse(args);
  const data = await sngRequest("/api/v1/packaged_cross_sells", {
    method: "GET",
    query: input,
  });
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

// ---------------------------------------------------------------------------
// MCP HTTP (JSON-RPC) support
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-06-18";

const MCP_TOOLS = [
  {
    name: "sweepgo_get_onboarding_price",
    description: "Get onboarding price for a residential Sweep&Go client.",
    inputSchema: {
      type: "object",
      properties: {
        zip_code: { type: "string", description: "5-digit zip code" },
        number_of_dogs: { type: "integer", minimum: 1 },
        last_time_yard_was_thoroughly_cleaned: {
          type: "string",
          enum: [
            "one_week",
            "two_weeks",
            "three_weeks",
            "one_month",
            "two_months",
            "3-4_months",
            "5-6_months",
            "7-9_months",
            "10+_months",
          ],
        },
        clean_up_frequency: {
          type: "string",
          enum: [
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
          ],
        },
      },
      required: [
        "zip_code",
        "number_of_dogs",
        "last_time_yard_was_thoroughly_cleaned",
        "clean_up_frequency",
      ],
    },
    handler: tool_get_onboarding_price,
  },
  {
    name: "sweepgo_get_quote_recommendations",
    description:
      "Return a human-readable quote summary Parker can read to the customer.",
    inputSchema: {
      type: "object",
      properties: {
        zip_code: { type: "string" },
        number_of_dogs: { type: "integer", minimum: 1 },
        last_time_yard_was_thoroughly_cleaned: { type: "string" },
        clean_up_frequency: { type: "string" },
      },
      required: [
        "zip_code",
        "number_of_dogs",
        "last_time_yard_was_thoroughly_cleaned",
      ],
    },
    handler: tool_get_quote_recommendations,
  },
  {
    name: "sweepgo_get_packages_list",
    description: "Fetch packaged cross-sells / add-on bundles.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: tool_get_packages_list,
  },
  {
    name: "sweepgo_create_client",
    description:
      "Create a new residential Sweep&Go client in Sweep&Go (requires SNG_ALLOW_WRITES=true).",
    inputSchema: {
      type: "object",
      properties: {
        zip_code: { type: "string" },
        number_of_dogs: { type: "integer", minimum: 1 },
        last_time_yard_was_thoroughly_cleaned: { type: "string" },
        clean_up_frequency: { type: "string" },
        initial_cleanup_required: { type: "boolean" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string", format: "email" },
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
        "initial_cleanup_required",
        "first_name",
        "last_name",
        "email",
        "home_address",
        "city",
        "state",
      ],
    },
    handler: tool_create_client,
  },
];

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  };
}

async function handleJsonRpc(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  const raw = await readRequestBody(req);
  const rawTrimmed = raw?.trim() || "";
  console.log("[MCP] jsonrpc raw body", {
    contentLength: Number(req.headers["content-length"] || 0),
    rawPreview: rawTrimmed.slice(0, 500),
  });

  if (authFailed(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(jsonRpcError(null, -32600, "Unauthorized: invalid token"))
    );
    return;
  }

  // Some clients send empty bodies; default to tools/list for compatibility
  if (!rawTrimmed) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        result: { tools: MCP_TOOLS.map(({ handler, ...rest }) => rest), nextCursor: null },
      })
    );
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawTrimmed);
  } catch (err) {
    // On parse error, fall back to tools/list to be forgiving
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        result: { tools: MCP_TOOLS.map(({ handler, ...rest }) => rest), nextCursor: null },
      })
    );
    return;
  }

  if (!payload || payload.jsonrpc !== "2.0" || !payload.method) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload?.id ?? null,
        result: { tools: MCP_TOOLS.map(({ handler, ...rest }) => rest), nextCursor: null },
      })
    );
    return;
  }

  const id = payload.id ?? null;
  const method = String(payload.method || "");
  const methodLower = method.toLowerCase();
  const params = payload.params || {};

  const respond = (result) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };

  try {
    switch (methodLower) {
      case "initialize": {
        respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "titan-sweepandgo", version: "1.0.0" },
          capabilities: {
            tools: { listChanged: false },
            resources: {},
            prompts: {},
          },
        });
        return;
      }
      case "notifications/initialized": {
        // Retell MCP client sends this notification; acknowledge quietly
        respond({});
        return;
      }
      case "tools/list": {
        respond({ tools: MCP_TOOLS.map(({ handler, ...rest }) => rest), nextCursor: null });
        return;
      }
      case "tools/call": {
        const toolName = params.name;
        const args = params.arguments || {};
        const tool = MCP_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          throw new Error(`Unknown tool: ${toolName}`);
        }
        const content = await tool.handler(args);
        respond({ content: [content] });
        return;
      }
      default:
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(jsonRpcError(id, -32601, "Method not found"))
        );
        return;
    }
  } catch (err) {
    const message = err?.message || "Server error";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: message, isError: true }],
        },
      })
    );
  }
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
        name: "get_free_quotes",
        description:
          "Fetch all pre-configured free quotes from Sweep&Go (api/v2/free_quotes).",
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
            initial_cleanup_required: { type: "boolean" },
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
            "initial_cleanup_required",
            "first_name",
            "last_name",
            "email",
            "home_address",
            "city",
            "state",
          ],
        },
      },
      {
        name: "list_payment_methods",
        description: "List payment methods for a specific customer.",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
          },
          required: ["customer_id"],
        },
      },
      {
        name: "get_payment_method",
        description: "Fetch a single payment method by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "get_payment_source",
        description: "Fetch a payment source by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_payment_source",
        description:
          "[MUTATING] Create a payment source from an existing payment method for a customer.",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            payment_method_id: { type: "string" },
            default: { type: "boolean" },
          },
          required: ["customer_id", "payment_method_id"],
        },
      },
      {
        name: "list_pre_authorizations",
        description: "List pre-authorizations (optionally filtered by customer).",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
          },
        },
      },
      {
        name: "get_pre_authorization",
        description: "Fetch a pre-authorization by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_pre_authorization",
        description:
          "[MUTATING] Create a pre-authorization for a customer/payment source.",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            amount: { type: "number" },
            location_id: { type: "string" },
            payment_source_id: { type: "string" },
            external_reference: { type: "string" },
            description: { type: "string" },
          },
          required: [
            "customer_id",
            "amount",
            "location_id",
            "payment_source_id",
          ],
        },
      },
      {
        name: "delete_pre_authorization",
        description: "[MUTATING] Delete a pre-authorization by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_charges",
        description: "List charges (optionally filtered by customer).",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
          },
        },
      },
      {
        name: "get_charge",
        description: "Fetch a charge by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_charge",
        description:
          "[MUTATING] Create a charge for a customer/payment source at a location.",
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            amount: { type: "number" },
            location_id: { type: "string" },
            payment_source_id: { type: "string" },
            external_reference: { type: "string" },
            description: { type: "string" },
          },
          required: [
            "customer_id",
            "amount",
            "location_id",
            "payment_source_id",
          ],
        },
      },
      {
        name: "refund_charge",
        description:
          "[MUTATING] Refund a charge (full or partial when amount is provided).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            amount: { type: "number" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_customers",
        description: "List customers with optional pagination.",
        inputSchema: {
          type: "object",
          properties: {
            page: { type: "number" },
            per: { type: "number" },
          },
        },
      },
      {
        name: "get_customer",
        description: "Fetch a customer by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_customer",
        description: "[MUTATING] Create a customer.",
        inputSchema: {
          type: "object",
          properties: {
            full_name: { type: "string" },
            email: { type: "string" },
            mobile: { type: "string" },
            address_1: { type: "string" },
            address_2: { type: "string" },
            region: { type: "string" },
            postal_code: { type: "string" },
            notes: { type: "string" },
          },
          required: ["full_name", "email", "mobile"],
        },
      },
      {
        name: "update_customer",
        description: "[MUTATING] Update customer fields (any combination).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            full_name: { type: "string" },
            email: { type: "string" },
            mobile: { type: "string" },
            address_1: { type: "string" },
            address_2: { type: "string" },
            region: { type: "string" },
            postal_code: { type: "string" },
            notes: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "delete_customer",
        description: "[MUTATING] Delete a customer by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_locations",
        description: "List locations with optional pagination.",
        inputSchema: {
          type: "object",
          properties: {
            page: { type: "number" },
            per: { type: "number" },
          },
        },
      },
      {
        name: "get_location",
        description: "Fetch a location by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_location",
        description: "[MUTATING] Create a location.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            address_1: { type: "string" },
            address_2: { type: "string" },
            postal_code: { type: "string" },
            region: { type: "string" },
            email: { type: "string" },
            mobile: { type: "string" },
            website: { type: "string" },
            logo_url: { type: "string" },
            type: { type: "string" },
          },
          required: [
            "name",
            "address_1",
            "postal_code",
            "region",
            "email",
            "mobile",
          ],
        },
      },
      {
        name: "update_location",
        description: "[MUTATING] Update location fields (any combination).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            address_1: { type: "string" },
            address_2: { type: "string" },
            postal_code: { type: "string" },
            region: { type: "string" },
            email: { type: "string" },
            mobile: { type: "string" },
            website: { type: "string" },
            logo_url: { type: "string" },
            type: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_webhooks",
        description:
          "List webhooks for an organization. Defaults to SNG_ORG_SLUG when organization_id is omitted.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: { type: "string" },
          },
        },
      },
      {
        name: "retry_webhook",
        description: "[MUTATING] Retry a webhook delivery by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "get_packaged_cross_sells",
        description: "Fetch packaged cross-sells for a location.",
        inputSchema: {
          type: "object",
          properties: {
            location_id: { type: "string" },
          },
          required: ["location_id"],
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
      case "get_free_quotes":
        return { content: [await tool_get_free_quotes()] };
      case "get_quote_recommendations":
        return { content: [await tool_get_quote_recommendations(args)] };
      case "create_client":
        return { content: [await tool_create_client(args)] };
      case "list_payment_methods":
        return { content: [await tool_list_payment_methods(args)] };
      case "get_payment_method":
        return { content: [await tool_get_payment_method(args)] };
      case "get_payment_source":
        return { content: [await tool_get_payment_source(args)] };
      case "create_payment_source":
        return { content: [await tool_create_payment_source(args)] };
      case "list_pre_authorizations":
        return { content: [await tool_list_pre_authorizations(args)] };
      case "get_pre_authorization":
        return { content: [await tool_get_pre_authorization(args)] };
      case "create_pre_authorization":
        return { content: [await tool_create_pre_authorization(args)] };
      case "delete_pre_authorization":
        return { content: [await tool_delete_pre_authorization(args)] };
      case "list_charges":
        return { content: [await tool_list_charges(args)] };
      case "get_charge":
        return { content: [await tool_get_charge(args)] };
      case "create_charge":
        return { content: [await tool_create_charge(args)] };
      case "refund_charge":
        return { content: [await tool_refund_charge(args)] };
      case "list_customers":
        return { content: [await tool_list_customers(args)] };
      case "get_customer":
        return { content: [await tool_get_customer(args)] };
      case "create_customer":
        return { content: [await tool_create_customer(args)] };
      case "update_customer":
        return { content: [await tool_update_customer(args)] };
      case "delete_customer":
        return { content: [await tool_delete_customer(args)] };
      case "list_locations":
        return { content: [await tool_list_locations(args)] };
      case "get_location":
        return { content: [await tool_get_location(args)] };
      case "create_location":
        return { content: [await tool_create_location(args)] };
      case "update_location":
        return { content: [await tool_update_location(args)] };
      case "list_webhooks":
        return { content: [await tool_list_webhooks(args)] };
      case "retry_webhook":
        return { content: [await tool_retry_webhook(args)] };
      case "get_packaged_cross_sells":
        return { content: [await tool_get_packaged_cross_sells(args)] };
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
const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  // Well-known discovery
  if (req.method === "OPTIONS" && req.url === "/.well-known/mcp.json") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/.well-known/mcp.json") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        mcpServer: {
          version: MCP_PROTOCOL_VERSION,
          endpoints: [{ url: `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}${MCP_PATH}`, protocol: "http" }],
        },
      })
    );
    return;
  }

  // Simple health check on root for Render/uptime probes
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Titan Sweep&Go MCP server is up");
    return;
  }

  if (!req.url?.startsWith(MCP_PATH)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  console.log(
    `[MCP] incoming connection`,
    JSON.stringify({ method: req.method, url: req.url, headers: req.headers })
  );

  // Allow preflight for browsers/clients
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = parsedUrl.searchParams.get("sessionId");

  // SSE setup (GET)
  if (req.method === "GET") {
    // If this is a plain GET without sessionId and accepts JSON, serve tools/list for compatibility
    const acceptsJson =
      (req.headers["accept"] || "").toLowerCase().includes("application/json");
    const hasSession = Boolean(sessionId);
    if (!hasSession && acceptsJson) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          result: { tools: MCP_TOOLS.map(({ handler, ...rest }) => rest), nextCursor: null },
        })
      );
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    const transport = new SSEServerTransport(MCP_PATH, res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => transports.delete(transport.sessionId);

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      console.error("[MCP] transport error", err);
      transports.delete(transport.sessionId);
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

  // Incoming messages (POST)
  if (req.method === "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");

    // JSON-RPC MCP over HTTP (no sessionId)
    if (!sessionId) {
      return handleJsonRpc(req, res);
    }

    // SSE POST messages with session
    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unknown session" },
          id: null,
        })
      );
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      console.error("[MCP] handlePostMessage error", err);
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

  // Method not allowed
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    })
  );
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Titan Sweep&Go MCP SSE listening on ${host}${MCP_PATH}`);
});
