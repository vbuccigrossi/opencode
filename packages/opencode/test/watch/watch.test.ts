import { describe, expect, test, afterEach } from "bun:test"
import { Watch } from "../../src/watch"

describe("watch.core", () => {
  afterEach(() => {
    Watch.clear()
  })

  test("starts a process and returns info", () => {
    const info = Watch.start("echo hello", "test echo")
    expect(info.id).toStartWith("watch_")
    expect(info.label).toBe("test echo")
    expect(info.command).toBe("echo hello")
    expect(info.status).toBe("running")
    expect(info.pid).toBeGreaterThan(0)
    expect(info.startedAt).toBeGreaterThan(0)
  })

  test("list returns active watches", () => {
    Watch.start("sleep 10", "sleeper 1")
    Watch.start("sleep 10", "sleeper 2")
    const list = Watch.list()
    expect(list.length).toBe(2)
    expect(list[0].label).toBe("sleeper 1")
    expect(list[1].label).toBe("sleeper 2")
  })

  test("get returns specific watch", () => {
    const info = Watch.start("sleep 10", "my watch")
    const retrieved = Watch.get(info.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.label).toBe("my watch")
  })

  test("get returns undefined for unknown ID", () => {
    expect(Watch.get("watch_nonexistent")).toBeUndefined()
  })

  test("stop kills a running process", () => {
    const info = Watch.start("sleep 60", "long sleeper")
    const result = Watch.stop(info.id)
    expect(result.status).toBe("killed")
  })

  test("captures output from a fast command", async () => {
    const info = Watch.start("echo 'line1' && echo 'line2' && echo 'line3'", "echo test")
    // Wait for process to complete
    await new Promise((r) => setTimeout(r, 500))
    const result = Watch.poll(info.id)
    expect(result.totalLines).toBeGreaterThanOrEqual(3)
    expect(result.newLines.some((l) => l.includes("line1"))).toBe(true)
    expect(result.newLines.some((l) => l.includes("line3"))).toBe(true)
  })

  test("poll returns new lines since last poll", async () => {
    const info = Watch.start("echo 'batch1' && sleep 0.3 && echo 'batch2'", "batch test")
    await new Promise((r) => setTimeout(r, 150))
    const poll1 = Watch.poll(info.id)
    expect(poll1.newLines.some((l) => l.includes("batch1"))).toBe(true)

    await new Promise((r) => setTimeout(r, 400))
    const poll2 = Watch.poll(info.id)
    // batch2 should appear in poll2 but not in poll1
    expect(poll2.newLines.some((l) => l.includes("batch2"))).toBe(true)
  })

  test("remove deletes a watch", () => {
    const info = Watch.start("sleep 10", "removable")
    expect(Watch.get(info.id)).toBeDefined()
    const removed = Watch.remove(info.id)
    expect(removed).toBe(true)
    expect(Watch.get(info.id)).toBeUndefined()
  })

  test("remove returns false for unknown ID", () => {
    expect(Watch.remove("watch_nope")).toBe(false)
  })

  test("clear removes all watches", () => {
    Watch.start("sleep 10", "w1")
    Watch.start("sleep 10", "w2")
    expect(Watch.list().length).toBe(2)
    Watch.clear()
    expect(Watch.list().length).toBe(0)
  })

  test("detects process exit", async () => {
    const info = Watch.start("echo done", "quick")
    await new Promise((r) => setTimeout(r, 500))
    const retrieved = Watch.get(info.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.status).toBe("exited")
    expect(retrieved!.exitCode).toBe(0)
  })

  test("pattern trigger fires on match", async () => {
    const info = Watch.start("echo 'BUILD_COMPLETE'", "trigger test", [
      { type: "pattern", pattern: "BUILD_COMPLETE", action: "notify" },
    ])
    await new Promise((r) => setTimeout(r, 500))
    const result = Watch.poll(info.id)
    expect(result.notifications.length).toBeGreaterThanOrEqual(1)
    expect(result.notifications.some((n) => n.includes("Pattern matched"))).toBe(true)
  })

  test("exit trigger fires on process exit", async () => {
    const info = Watch.start("echo bye", "exit trigger", [
      { type: "exit", action: "notify" },
    ])
    await new Promise((r) => setTimeout(r, 500))
    const result = Watch.poll(info.id)
    expect(result.notifications.some((n) => n.includes("exited"))).toBe(true)
  })

  test("poll throws for unknown watch ID", () => {
    expect(() => Watch.poll("watch_unknown")).toThrow("not found")
  })

  test("stop throws for unknown watch ID", () => {
    expect(() => Watch.stop("watch_unknown")).toThrow("not found")
  })

  test("poll includes analysis", async () => {
    const info = Watch.start("echo 'error TS1234: something wrong'", "error test")
    await new Promise((r) => setTimeout(r, 500))
    const result = Watch.poll(info.id)
    expect(result.analysis.errors.length).toBeGreaterThanOrEqual(1)
  })
})
