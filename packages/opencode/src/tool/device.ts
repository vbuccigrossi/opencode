import z from "zod"
import { Tool } from "./tool"
import { Device } from "../device"
import { DeviceSync } from "../device/sync"
import { Log } from "../util/log"

/**
 * Device tool — manage registered devices and multi-device sync.
 *
 * Provides CRUD for the device registry plus sync operations.
 */
export const DeviceTool = Tool.define("device", async () => ({
  description: `Manage registered devices for multi-device sync.

Operations:
- list: List all registered devices.
- register: Register a new device (phone, laptop, tablet, etc.).
- update: Update a device's settings (name, type, push URL, events).
- remove: Remove a registered device.
- get: Get details of a specific device by ID.
- sync: Trigger a sync for a device — returns events since its last sync.

Devices with a push URL receive webhook notifications when events occur.
The push_events filter controls which events trigger notifications ("*" = all).

Sync returns events from the event journal since the device's last sync position,
enabling incremental updates across multiple devices.`,
  parameters: z.object({
    operation: z
      .enum(["list", "register", "update", "remove", "get", "sync"])
      .describe("The device operation to perform"),
    id: z.string().optional().describe("Device ID (for get, update, remove, sync)"),
    name: z.string().optional().describe("Device name (for register, update)"),
    type: z.string().optional().describe("Device type: phone, laptop, tablet, desktop (for register, update)"),
    push_url: z.string().optional().describe("Webhook URL for push notifications (for register, update)"),
    push_events: z.array(z.string()).optional().describe('Event filter for push (default: ["*"]). For register, update'),
    include_sessions: z.boolean().optional().describe("Include session list in sync response (for sync)"),
    limit: z.number().optional().describe("Max events to return in sync (default: 200, max: 500)"),
  }),
  async execute(params, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    switch (params.operation) {
      case "list":
        return deviceList()
      case "register":
        return deviceRegister(params)
      case "update":
        return deviceUpdate(params)
      case "remove":
        return deviceRemove(params)
      case "get":
        return deviceGet(params)
      case "sync":
        return deviceSyncOp(params)
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }
  },
}))

const log = Log.create({ service: "tool.device" })

function formatDevice(d: Device.Info): string {
  const lastSync = d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "never"
  const lines = [
    `ID: ${d.id}`,
    `Name: ${d.name}`,
    `Type: ${d.type}`,
    `Push URL: ${d.pushUrl ?? "disabled"}`,
    `Push events: ${d.pushEvents.join(", ")}`,
    `Last sync: ${lastSync}`,
    `Last seen seq: ${d.lastSeenSeq}`,
  ]
  if (d.capabilities.length > 0) lines.push(`Capabilities: ${d.capabilities.join(", ")}`)
  return lines.join("\n")
}

function deviceList(): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  const devices = Device.list()
  if (devices.length === 0) {
    return Promise.resolve({
      title: "device: none registered",
      metadata: { count: 0 },
      output: "No registered devices.",
    })
  }

  const output = devices.map(formatDevice).join("\n\n---\n\n")
  return Promise.resolve({
    title: `device: ${devices.length} device(s)`,
    metadata: { count: devices.length, ids: devices.map((d) => d.id) },
    output,
  })
}

function deviceRegister(params: {
  name?: string
  type?: string
  push_url?: string
  push_events?: string[]
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.name) throw new Error("name is required for register")

  const device = Device.register({
    name: params.name,
    type: params.type,
    pushUrl: params.push_url,
    pushEvents: params.push_events,
  })

  return Promise.resolve({
    title: `device: registered "${device.name}"`,
    metadata: { id: device.id, name: device.name },
    output: `Device registered.\n\n${formatDevice(device)}`,
  })
}

function deviceUpdate(params: {
  id?: string
  name?: string
  type?: string
  push_url?: string
  push_events?: string[]
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for update")

  const existing = Device.get(params.id)
  if (!existing) throw new Error(`Device ${params.id} not found`)

  const device = Device.update({
    id: params.id,
    name: params.name,
    type: params.type,
    pushUrl: params.push_url,
    pushEvents: params.push_events,
  })

  return Promise.resolve({
    title: `device: updated "${device.name}"`,
    metadata: { id: device.id },
    output: `Device updated.\n\n${formatDevice(device)}`,
  })
}

function deviceRemove(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for remove")

  const existing = Device.get(params.id)
  if (!existing) throw new Error(`Device ${params.id} not found`)

  Device.remove(params.id)
  return Promise.resolve({
    title: `device: removed "${existing.name}"`,
    metadata: { id: params.id },
    output: `Removed device "${existing.name}" (${params.id}).`,
  })
}

function deviceGet(params: { id?: string }): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for get")

  const device = Device.get(params.id)
  if (!device) {
    return Promise.resolve({
      title: "device: not found",
      metadata: { id: params.id },
      output: `Device ${params.id} not found.`,
    })
  }

  return Promise.resolve({
    title: `device: ${device.name}`,
    metadata: { id: device.id, name: device.name },
    output: formatDevice(device),
  })
}

function deviceSyncOp(params: {
  id?: string
  include_sessions?: boolean
  limit?: number
}): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
  if (!params.id) throw new Error("id is required for sync")

  const result = DeviceSync.sync({
    deviceID: params.id,
    includeSessions: params.include_sessions,
    limit: params.limit,
  })

  const lines = [
    `Events returned: ${result.events.length}`,
    `Pending: ${result.pending}`,
    `Latest seq: ${result.latestSeq}`,
    `Server time: ${new Date(result.serverTime).toLocaleString()}`,
  ]

  if (result.sessions) {
    lines.push(`Sessions: ${result.sessions.length}`)
  }

  if (result.events.length > 0) {
    lines.push("", "Recent events:")
    for (const e of result.events.slice(0, 20)) {
      lines.push(`  [${e.seq}] ${e.type} (${new Date(e.timeCreated).toLocaleTimeString()})`)
    }
    if (result.events.length > 20) {
      lines.push(`  ... and ${result.events.length - 20} more`)
    }
  }

  return Promise.resolve({
    title: `device: synced ${result.events.length} event(s)`,
    metadata: {
      events: result.events.length,
      pending: result.pending,
      latestSeq: result.latestSeq,
    },
    output: lines.join("\n"),
  })
}
