import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  EVENT_TYPES,
  MESSAGE_TYPES,
  TRUST_SOURCES,
} from "./catalog";

export const messageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-mesh.dev/schemas/message.schema.json",
  title: "MeshMessage",
  type: "object",
  required: ["id", "type", "timestamp", "goalId", "from", "to", "threadId", "artifactRefs", "payload", "priority"],
  properties: {
    id: { type: "string", pattern: "^msg-" },
    protocolVersion: { type: "string" },
    type: { type: "string", enum: MESSAGE_TYPES },
    timestamp: { type: "string", format: "date-time" },
    goalId: { type: "string" },
    from: { type: "string" },
    to: { type: "array", items: { type: "string" }, minItems: 1 },
    threadId: { type: "string" },
    replyTo: { type: "string" },
    causationId: { type: "string" },
    taskId: { type: "string" },
    artifactRefs: {
      type: "array",
      items: {
        type: "object",
        required: ["uri"],
        properties: {
          uri: { type: "string", pattern: "^artifact://" },
          version: { type: "integer", minimum: 1 },
          digest: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    payload: {},
    /**
     * Runtime-owned delivery control. Agents cannot set this:
     * `sanitizeAgentMessageInput` strips it from every send, and the closed
     * property set means a forged field fails validation instead of being
     * silently ignored.
     */
    control: {
      description:
        "Runtime-owned delivery control. Agents cannot set this: sanitizeAgentMessageInput strips it from every send, and the closed property set means a forged field fails validation instead of being ignored.",
      type: "object",
      properties: { cacheServed: { type: "boolean" } },
      additionalProperties: false,
    },
    priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
    ttl: { type: "string" },
    requires: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
        additionalProperties: false,
      },
    },
    budgetHint: {
      type: "object",
      properties: { maxTokens: { type: "integer" }, maxTurns: { type: "integer" } },
      additionalProperties: false,
    },
    provenance: {
      type: "object",
      required: ["source", "trustLevel"],
      properties: {
        source: { type: "string", enum: TRUST_SOURCES as unknown as string[] },
        trustLevel: { type: "integer", minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const eventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-mesh.dev/schemas/event.schema.json",
  title: "MeshEvent",
  type: "object",
  required: ["id", "type", "timestamp", "payload"],
  properties: {
    id: { type: "string", pattern: "^evt-" },
    seq: { type: "integer", minimum: 0 },
    protocolVersion: { type: "string" },
    type: { type: "string", enum: EVENT_TYPES },
    timestamp: { type: "string", format: "date-time" },
    goalId: { type: "string" },
    actorId: { type: "string" },
    causationId: { type: "string" },
    correlationId: { type: "string" },
    payload: { type: "object" },
  },
  additionalProperties: false,
} as const;

export const artifactSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-mesh.dev/schemas/artifact.schema.json",
  title: "Artifact",
  type: "object",
  required: [
    "id", "name", "type", "goalId", "owner", "version", "status",
    "contentRef", "digest", "metadata", "createdAt", "createdBy",
  ],
  properties: {
    id: { type: "string", pattern: "^art-" },
    name: { type: "string" },
    type: { type: "string", enum: ARTIFACT_TYPES },
    goalId: { type: "string" },
    owner: { type: "string" },
    version: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ARTIFACT_STATUSES },
    contentRef: { type: "string" },
    digest: { type: "string", pattern: "^sha256:" },
    parent: { type: "string" },
    metadata: { type: "object" },
    provenance: {
      type: "object",
      required: ["source", "trustLevel"],
      properties: {
        source: { type: "string", enum: TRUST_SOURCES as unknown as string[] },
        trustLevel: { type: "integer", minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
    createdAt: { type: "string", format: "date-time" },
    createdBy: { type: "string" },
  },
  additionalProperties: false,
} as const;

const agentConfigSchema = {
  type: "object",
  required: ["role"],
  properties: {
    role: { type: "string" },
    runtime: { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    mode: { type: "string", enum: ["peer", "service"] },
    prompt: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    authority: { type: "array", items: { type: "string" } },
    interests: { type: "array", items: { type: "string" } },
    session: {
      type: "object",
      properties: { persistent: { type: "boolean" }, max_context_tokens: { type: "integer" } },
      additionalProperties: false,
    },
    delegation: {
      type: "object",
      properties: {
        allow: { type: "boolean" },
        max_depth: { type: "integer", minimum: 0 },
        max_workers: { type: "integer", minimum: 0 },
        worker_budget_tokens: { type: "integer" },
      },
      additionalProperties: false,
    },
    budget: {
      type: "object",
      properties: {
        tokens: { type: "integer" },
        wall_clock_minutes: { type: "number" },
        max_events: { type: "integer" },
        max_activations: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const meshConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-mesh.dev/schemas/mesh.schema.json",
  title: "MeshConfig",
  type: "object",
  required: ["version", "mesh", "agents"],
  properties: {
    version: { type: "integer", const: 1 },
    // Optional by design: identity for the multi-project host. A mesh.yaml
    // without it stays valid and the loader derives a slug from the folder
    // name, so no existing config breaks.
    project: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}$" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    mesh: {
      type: "object",
      required: ["id", "goal"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        goal: { type: "string" },
        acceptance_criteria: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "description"],
            properties: {
              id: { type: "string" },
              description: { type: "string" },
              mandatory: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        workspace: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
        runtime: {
          type: "object",
          properties: { default: { type: "string" }, model: { type: "string" }, variant: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    startup: {
      type: "object",
      properties: { activate: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    agents: { type: "object", minProperties: 1, additionalProperties: agentConfigSchema },
    policies: {
      type: "object",
      properties: {
        communication: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              may_contact: { type: "array", items: { type: "string" } },
              may_be_contacted_by: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        transitions: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { requires: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        },
        escalation: {
          type: "object",
          properties: {
            thread: { type: "object", properties: { max_depth: { type: "integer" } }, additionalProperties: false },
            repeated_conflict: { type: "object", properties: { threshold: { type: "integer" } }, additionalProperties: false },
            artifact_review_rounds: { type: "object", properties: { max: { type: "integer" } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        rules: { type: "array" },
      },
      additionalProperties: false,
    },
    bus: {
      type: "object",
      properties: {
        commitments: {
          type: "object",
          properties: {
            semantic: { type: "string", enum: ["compat", "strict"] },
          },
          additionalProperties: false,
        },
        transport: { type: "string", enum: ["mixed", "typed-only"] },
      },
      additionalProperties: false,
    },
    budgets: {
      type: "object",
      properties: {
        mission: {
          type: "object",
          properties: {
            tokens: { type: "integer" },
            wall_clock_minutes: { type: "number" },
            max_events: { type: "integer" },
          },
          additionalProperties: false,
        },
        agent: { type: "object", additionalProperties: { type: "integer" } },
        thread: {
          type: "object",
          properties: {
            tokens: { type: "integer" },
            reserve_tokens: { type: "integer", minimum: 1 },
            soft_cap: { type: "number", minimum: 0, maximum: 1 },
          },
          additionalProperties: false,
        },
        task: {
          type: "object",
          properties: { tokens: { type: "integer" } },
          additionalProperties: false,
        },
        auto_raise: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            factor: { type: "number", minimum: 1.1 },
            max_multiple: { type: "number", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    scheduling: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["event-driven"] },
        activation: {
          type: "object",
          properties: {
            strategy: { type: "string", enum: ["interest", "interest+triage"] },
            max_activation_delay_ms: { type: "integer" },
          },
          additionalProperties: false,
        },
        triage: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["off", "heuristic"] },
            rules: {
              type: "array",
              items: {
                type: "object",
                required: ["agent"],
                properties: {
                  agent: { type: "string" },
                  event: { type: "string" },
                  ignore_if_text_matches: { type: "array", items: { type: "string" } },
                  act_if_text_matches: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        concurrency: {
          type: "object",
          properties: {
            max_active_agents: { type: "integer", minimum: 1 },
            max_parallel_service_agents: { type: "integer", minimum: 1 },
            max_total_agents: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
        timeouts: {
          type: "object",
          properties: {
            turn_timeout_ms: { type: "integer" },
            wait_wakeup_ms: { type: "integer" },
            lease_ttl_ms: { type: "integer" },
            idle_quiet_period_ms: { type: "integer" },
            stall_idle_ms: { type: "integer" },
            stall_cooldown_ms: { type: "integer" },
            stall_noop_retry_ms: { type: "integer" },
            turn_silence_ms: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    server: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "integer" },
        state_dir: { type: "string" },
        dashboard: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const SCHEMAS = {
  mesh: meshConfigSchema,
  message: messageSchema,
  event: eventSchema,
  artifact: artifactSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;
