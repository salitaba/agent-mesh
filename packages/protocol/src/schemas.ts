import {
  ARTIFACT_SCOPES,
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
    id: { type: "string", pattern: "^msg-", maxLength: 200 },
    protocolVersion: { type: "string", maxLength: 100 },
    type: { type: "string", enum: MESSAGE_TYPES },
    timestamp: { type: "string", format: "date-time" },
    goalId: { type: "string", minLength: 1, maxLength: 200 },
    from: { type: "string", minLength: 1, maxLength: 200 },
    to: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1 },
    threadId: { type: "string", minLength: 1, maxLength: 200 },
    replyTo: { type: "string", maxLength: 200 },
    causationId: { type: "string", maxLength: 200 },
    taskId: { type: "string", maxLength: 200 },
    artifactRefs: {
      type: "array",
      items: {
        type: "object",
        required: ["uri"],
        properties: {
          uri: { type: "string", pattern: "^artifact://", maxLength: 500 },
          version: { type: "integer", minimum: 1 },
          digest: { type: "string", maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
    payload: {},
    /**
     * Prose for the recipient. Never parsed by the mesh.
     *
     * Optional and closed like every other envelope field: a `note` that is not
     * declared here is REJECTED by `additionalProperties: false`, not ignored,
     * so a message carrying one fails loudly at send time with the path named.
     */
    note: {
      description: "Free prose for the recipient. Never parsed by the mesh: no op extraction, no discharge inference, no routing. Carries no authority.",
      type: "string",
      maxLength: 2000,
    },
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
      properties: {
        cacheServed: { type: "boolean" },
        contract: { type: "string" },
        contractVersion: { type: "number" },
        mode: { type: "string", enum: ["service", "collab", "broadcast"] },
        delivery: { type: "string", enum: ["interrupt", "deliver", "accrue"] },
        downgraded: { type: "string" },
        /**
         * The asker's own fallback. `assume` is deliberately UNTYPED: it is
         * the answer the ask's contract would have carried, and those shapes
         * are per-contract. `afterMs` is bounded below because a default that
         * fires at once is not a default, it is an ask nobody was given a
         * chance to answer.
         */
        ifUnanswered: {
          type: "object",
          required: ["assume"],
          properties: { assume: {}, afterMs: { type: "number", exclusiveMinimum: 0 } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
    requires: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          text: { type: "string", minLength: 1, maxLength: 2000 },
        },
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
    id: { type: "string", pattern: "^evt-", maxLength: 200 },
    seq: { type: "integer", minimum: 0 },
    protocolVersion: { type: "string", maxLength: 100 },
    type: { type: "string", enum: EVENT_TYPES },
    timestamp: { type: "string", format: "date-time" },
    goalId: { type: "string", maxLength: 200 },
    actorId: { type: "string", maxLength: 200 },
    causationId: { type: "string", maxLength: 200 },
    correlationId: { type: "string", maxLength: 200 },
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
    id: { type: "string", pattern: "^art-", maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 500 },
    type: { type: "string", enum: ARTIFACT_TYPES },
    goalId: { type: "string", minLength: 1, maxLength: 200 },
    owner: { type: "string", minLength: 1, maxLength: 200 },
    version: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ARTIFACT_STATUSES },
    contentRef: { type: "string", maxLength: 1000 },
    digest: { type: "string", pattern: "^sha256:", maxLength: 100 },
    parent: { type: "string", maxLength: 200 },
    // Optional, and must stay so: the schema is `additionalProperties: false`,
    // so the field has to be declared here to be writable at all, and required
    // here would invalidate every artifact logged before it existed.
    scope: { type: "string", enum: ARTIFACT_SCOPES },
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
    createdBy: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const agentConfigSchema = {
  type: "object",
  required: ["role"],
  properties: {
    role: { type: "string", minLength: 1, maxLength: 200 },
    runtime: { type: "string", maxLength: 200 },
    model: { type: "string", maxLength: 200 },
    variant: { type: "string", maxLength: 200 },
    mode: { type: "string", enum: ["peer", "service"] },
    prompt: { type: "string", maxLength: 20000 },
    capabilities: { type: "array", items: { type: "string", maxLength: 200 } },
    requires_approval: { type: "array", items: { type: "string", maxLength: 200 } },
    authority: { type: "array", items: { type: "string", maxLength: 200 } },
    interests: { type: "array", items: { type: "string", maxLength: 200 } },
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
    hard_actions: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "warn", "enforce"] },
        capabilities: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    // Per-agent only. The mesh-wide version of this question is
    // `bus.delivery.classes`, so `mesh.defaults` deliberately does NOT carry a
    // `wake` key: a default here would give an operator a knob that looks like
    // it turns the setting on mesh-wide while the resolver reads only the
    // per-agent copy, and every seat would keep waking. Absent IS the default
    // for this block (see `RawWakePolicy`), so the schema refuses it in the
    // wrong place rather than accepting a key nothing reads.
    // `mail` is the pull path: `"claims"` renders non-obliging mail as a
    // one-line claim whose body is fetched by reading the inbox, while mail
    // that obliges the recipient keeps its body either way -- a seat must
    // never be asked to answer something it was not shown. Absent is `"full"`,
    // which is what every mesh written before this key gets.
    wake: {
      type: "object",
      properties: {
        defer_non_obliging: { type: "boolean" },
        not_for: { type: "array", items: { type: "string", enum: MESSAGE_TYPES } },
        mail: { type: "string", enum: ["full", "claims"] },
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
        name: { type: "string", maxLength: 200 },
      },
      additionalProperties: false,
    },
    mesh: {
      type: "object",
      required: ["id", "goal"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", maxLength: 200 },
        goal: { type: "string", minLength: 1, maxLength: 2000 },
        acceptance_criteria: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "description"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 200 },
              description: { type: "string", minLength: 1, maxLength: 1000 },
              mandatory: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        generate_acceptance_criteria: { type: "boolean" },
        criteria_model: { type: "string", maxLength: 200 },
        workspace: {
          type: "object",
          properties: {
            path: { type: "string" },
            // Tri-state by absence: a missing `git` key defers to the default
            // (ON), while an explicit `false` is an opt-out. `additionalProperties:
            // false` means a project that sets this before the key exists here
            // fails to LOAD rather than being ignored — never add it to the TS
            // type or the scaffold template ahead of this schema.
            git: { type: "boolean" },
          },
          additionalProperties: false,
        },
        runtime: {
          type: "object",
          properties: {
            default: { type: "string", maxLength: 200 },
            model: { type: "string", maxLength: 200 },
            variant: { type: "string", maxLength: 200 },
            requires_approval: { type: "array", items: { type: "string", maxLength: 200 } },
          },
          additionalProperties: false,
        },
        defaults: {
          type: "object",
          properties: {
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
            hard_actions: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["off", "warn", "enforce"] },
                capabilities: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    startup: {
      type: "object",
      properties: { activate: { type: "array", items: { type: "string", maxLength: 200 } } },
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
              may_contact: { type: "array", items: { type: "string", maxLength: 200 } },
              may_be_contacted_by: { type: "array", items: { type: "string", maxLength: 200 } },
            },
            additionalProperties: false,
          },
        },
        transitions: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { requires: { type: "array", items: { type: "string", maxLength: 200 } } },
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
            ttl_ms: { type: "number", minimum: 0 },
            ttl_ms_by_role: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
            by_type: { type: "boolean" },
          },
          additionalProperties: false,
        },
        style: { type: "string", enum: ["high-contact", "balanced", "low-contact"] },
        transport: { type: "string", enum: ["mixed", "typed-only"] },
        vocabulary: { type: "string", enum: ["typed", "contracts"] },
        collab: {
          type: "object",
          properties: {
            box_ms: { type: "number", minimum: 0 },
            max_exchanges: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
        delivery: {
          type: "object",
          properties: {
            classes: { type: "boolean" },
            coalesce_ms: { type: "number", minimum: 0 },
            interrupt_cost_tokens: { type: "number", minimum: 0 },
            attention_tokens: { type: "number", minimum: 0 },
            congestion_every: { type: "number", minimum: 1 },
          },
          additionalProperties: false,
        },
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
                  agent: { type: "string", minLength: 1, maxLength: 200 },
                  event: { type: "string", maxLength: 200 },
                  ignore_if_text_matches: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } },
                  act_if_text_matches: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } },
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
