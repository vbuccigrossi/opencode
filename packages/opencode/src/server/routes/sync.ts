import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { lazy } from "../../util/lazy"
import { Device } from "../../device"
import { DeviceSync } from "../../device/sync"
import z from "zod"

export const SyncRoutes = lazy(() => {
  const app = new Hono()

  // ── Device Management ──

  app.get(
    "/device",
    describeRoute({
      summary: "List registered devices",
      operationId: "device.list",
      responses: {
        200: {
          description: "List of devices",
          content: { "application/json": { schema: resolver(Device.Info.array()) } },
        },
      },
    }),
    async (c) => c.json(Device.list()),
  )

  app.post(
    "/device",
    describeRoute({
      summary: "Register a new device",
      operationId: "device.register",
      responses: {
        200: {
          description: "Registered device",
          content: { "application/json": { schema: resolver(Device.Info) } },
        },
      },
    }),
    validator("json", Device.RegisterInput),
    async (c) => {
      const input = c.req.valid("json")
      const info = Device.register(input)
      return c.json(info, 201)
    },
  )

  app.patch(
    "/device/:deviceID",
    describeRoute({
      summary: "Update a device",
      operationId: "device.update",
      responses: {
        200: {
          description: "Updated device",
          content: { "application/json": { schema: resolver(Device.Info) } },
        },
      },
    }),
    validator("param", z.object({ deviceID: z.string() })),
    validator("json", Device.UpdateInput.omit({ id: true })),
    async (c) => {
      const { deviceID } = c.req.valid("param")
      const body = c.req.valid("json")
      const info = Device.update({ id: deviceID, ...body })
      return c.json(info)
    },
  )

  app.delete(
    "/device/:deviceID",
    describeRoute({
      summary: "Remove a device",
      operationId: "device.remove",
      responses: {
        200: {
          description: "Device removed",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
      },
    }),
    validator("param", z.object({ deviceID: z.string() })),
    async (c) => {
      const { deviceID } = c.req.valid("param")
      Device.remove(deviceID)
      return c.json(true)
    },
  )

  // ── Sync ──

  app.post(
    "/sync",
    describeRoute({
      summary: "Sync a device",
      description:
        "Returns events since the device's last sync and optionally a session snapshot. " +
        "The device's sync cursor is updated automatically.",
      operationId: "device.sync",
      responses: {
        200: {
          description: "Sync response with events and optional sessions",
          content: { "application/json": { schema: resolver(DeviceSync.SyncResponse) } },
        },
      },
    }),
    validator("json", DeviceSync.SyncRequest),
    async (c) => {
      const input = c.req.valid("json")
      try {
        const result = DeviceSync.sync(input)
        return c.json(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 400)
      }
    },
  )

  return app
})
