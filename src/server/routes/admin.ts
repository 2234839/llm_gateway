import type { FastifyInstance } from "fastify"
import type { ProviderConfig, RouteRule } from "../types.ts"
import { v4 as uuid } from "uuid"

export async function adminRoutes(fastify: FastifyInstance) {
  // ========== Providers ==========

  fastify.get("/admin/providers", async () => {
    return fastify.db.getProviders()
  })

  fastify.post<{ Body: Omit<ProviderConfig, "id"> }>("/admin/providers", async (request, reply) => {
    const body = request.body
    const provider: ProviderConfig = {
      ...body,
      id: uuid(),
    }
    fastify.db.addProvider(provider)
    fastify.registry.reload()
    return reply.status(201).send(provider)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<ProviderConfig> }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getProvider(id)
    if (!existing) {
      return reply.status(404).send({ error: "Provider not found" })
    }
    fastify.db.updateProvider(id, request.body)
    fastify.registry.reload()
    return reply.send({ ...existing, ...request.body, id })
  })

  fastify.delete<{ Params: { id: string } }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.deleteProvider(id)
    fastify.registry.reload()
    return reply.status(204).send()
  })

  // ========== Provider Test ==========

  fastify.post<{ Body: { baseUrl: string; apiKey: string; type: string; customHeaders?: Record<string, string> } }>("/admin/providers/test", async (request) => {
    const { baseUrl, apiKey, type, customHeaders } = request.body
    const url = baseUrl.replace(/\/+$/, "")
    const start = performance.now()

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(customHeaders ?? {}),
    }

    let testUrl: string
    let method = "GET"

    if (type === "anthropic") {
      testUrl = `${url}/v1/messages`
      headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
      method = "POST"
    } else if (type === "azure-openai") {
      testUrl = `${url}/openai/deployments?api-version=2024-02-01`
      headers["api-key"] = apiKey
    } else {
      testUrl = `${url}/models`
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    const body = type === "anthropic"
      ? JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
      : undefined

    const resp = await fetch(testUrl, { method, headers, body, signal: AbortSignal.timeout(10000) })
    const duration = Math.round(performance.now() - start)

    if (resp.ok) {
      return { success: true, statusCode: resp.status, duration }
    }

    const errorBody = await resp.text().catch(() => "")
    return { success: false, statusCode: resp.status, duration, error: errorBody.slice(0, 500) }
  })

  // ========== Route Rules ==========

  fastify.get("/admin/routes", async () => {
    return fastify.db.getRouteRules()
  })

  fastify.post<{ Body: Omit<RouteRule, "id"> }>("/admin/routes", async (request, reply) => {
    const body = request.body
    const rule: RouteRule = {
      ...body,
      id: uuid(),
    }
    fastify.db.addRouteRule(rule)
    return reply.status(201).send(rule)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<RouteRule> }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.updateRouteRule(id, request.body)
    return reply.send({ id, ...request.body })
  })

  fastify.delete<{ Params: { id: string } }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.deleteRouteRule(id)
    return reply.status(204).send()
  })

  // ========== Logs ==========

  fastify.get<{ Querystring: { limit?: string; offset?: string; model?: string; providerId?: string } }>("/admin/logs", async (request) => {
    const { limit, offset, model, providerId } = request.query
    return fastify.db.getLogs({
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
      model: model ?? undefined,
      providerId: providerId ?? undefined,
    })
  })

  fastify.get("/admin/stats", async () => {
    return fastify.db.getLogStats()
  })

  // ========== Config ==========

  fastify.get("/admin/config", async () => {
    return fastify.db.getConfig()
  })

  fastify.put<{ Body: { port?: number; logLevel?: "debug" | "info" | "warn" | "error"; enableRequestLog?: boolean } }>("/admin/config", async (request) => {
    const current = fastify.db.getConfig()
    const updated = { ...current, ...request.body }
    fastify.db.saveConfig(updated)
    return updated
  })
}
