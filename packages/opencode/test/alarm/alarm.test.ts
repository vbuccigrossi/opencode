import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Alarm } from "../../src/alarm"

describe("alarm", () => {
  beforeEach(() => {
    Alarm.clear()
  })

  afterEach(() => {
    Alarm.clear()
  })

  describe("parseDuration", () => {
    it("parses seconds", () => {
      expect(Alarm.parseDuration("30s")).toBe(30_000)
      expect(Alarm.parseDuration("1s")).toBe(1_000)
      expect(Alarm.parseDuration("90s")).toBe(90_000)
    })

    it("parses minutes", () => {
      expect(Alarm.parseDuration("5m")).toBe(300_000)
      expect(Alarm.parseDuration("1m")).toBe(60_000)
      expect(Alarm.parseDuration("90m")).toBe(5_400_000)
    })

    it("parses hours", () => {
      expect(Alarm.parseDuration("1h")).toBe(3_600_000)
      expect(Alarm.parseDuration("3h")).toBe(10_800_000)
      expect(Alarm.parseDuration("0.5h")).toBe(1_800_000)
    })

    it("parses compound durations", () => {
      expect(Alarm.parseDuration("1h30m")).toBe(5_400_000)
      expect(Alarm.parseDuration("2h15m30s")).toBe(8_130_000)
      expect(Alarm.parseDuration("1m30s")).toBe(90_000)
    })

    it("parses plain numbers as minutes", () => {
      expect(Alarm.parseDuration("5")).toBe(300_000)
      expect(Alarm.parseDuration("30")).toBe(1_800_000)
      expect(Alarm.parseDuration("1.5")).toBe(90_000)
    })

    it("handles whitespace", () => {
      expect(Alarm.parseDuration("  5m  ")).toBe(300_000)
      expect(Alarm.parseDuration(" 1H30M ")).toBe(5_400_000)
    })

    it("is case-insensitive", () => {
      expect(Alarm.parseDuration("5M")).toBe(300_000)
      expect(Alarm.parseDuration("1H")).toBe(3_600_000)
      expect(Alarm.parseDuration("30S")).toBe(30_000)
    })

    it("throws on invalid format", () => {
      expect(() => Alarm.parseDuration("abc")).toThrow("Invalid duration format")
      expect(() => Alarm.parseDuration("")).toThrow("Invalid duration format")
      expect(() => Alarm.parseDuration("5x")).toThrow("Invalid duration format")
    })
  })

  describe("set", () => {
    it("creates a pending alarm", () => {
      const alarm = Alarm.set("test alarm", 60_000)
      expect(alarm.id).toMatch(/^alarm_\d+$/)
      expect(alarm.label).toBe("test alarm")
      expect(alarm.durationMs).toBe(60_000)
      expect(alarm.status).toBe("pending")
      expect(alarm.consumed).toBe(false)
      expect(alarm.firesAt).toBeGreaterThan(Date.now())
    })

    it("creates alarm with a check command", () => {
      const alarm = Alarm.set("build check", 60_000, "tail -5 build.log", "/tmp")
      expect(alarm.command).toBe("tail -5 build.log")
      expect(alarm.cwd).toBe("/tmp")
    })

    it("generates unique IDs", () => {
      const a1 = Alarm.set("first", 60_000)
      const a2 = Alarm.set("second", 60_000)
      expect(a1.id).not.toBe(a2.id)
    })
  })

  describe("list", () => {
    it("returns empty array when no alarms", () => {
      expect(Alarm.list()).toEqual([])
    })

    it("returns all alarms", () => {
      Alarm.set("alarm 1", 60_000)
      Alarm.set("alarm 2", 120_000)
      const all = Alarm.list()
      expect(all.length).toBe(2)
      expect(all[0].label).toBe("alarm 1")
      expect(all[1].label).toBe("alarm 2")
    })
  })

  describe("get", () => {
    it("returns alarm by ID", () => {
      const created = Alarm.set("find me", 60_000)
      const found = Alarm.get(created.id)
      expect(found).toBeDefined()
      expect(found!.label).toBe("find me")
    })

    it("returns undefined for unknown ID", () => {
      expect(Alarm.get("alarm_999")).toBeUndefined()
    })
  })

  describe("cancel", () => {
    it("cancels a pending alarm", () => {
      const alarm = Alarm.set("cancel me", 60_000)
      const result = Alarm.cancel(alarm.id)
      expect(result).toBe(true)
      expect(Alarm.get(alarm.id)!.status).toBe("cancelled")
    })

    it("returns false for unknown ID", () => {
      expect(Alarm.cancel("alarm_999")).toBe(false)
    })
  })

  describe("remove", () => {
    it("removes an alarm from the registry", () => {
      const alarm = Alarm.set("remove me", 60_000)
      Alarm.cancel(alarm.id)
      const result = Alarm.remove(alarm.id)
      expect(result).toBe(true)
      expect(Alarm.get(alarm.id)).toBeUndefined()
    })

    it("removes pending alarm (cancels timer)", () => {
      const alarm = Alarm.set("remove pending", 60_000)
      const result = Alarm.remove(alarm.id)
      expect(result).toBe(true)
      expect(Alarm.list().length).toBe(0)
    })

    it("returns false for unknown ID", () => {
      expect(Alarm.remove("alarm_999")).toBe(false)
    })
  })

  describe("clear", () => {
    it("removes all alarms", () => {
      Alarm.set("a1", 60_000)
      Alarm.set("a2", 120_000)
      Alarm.set("a3", 180_000)
      expect(Alarm.list().length).toBe(3)
      Alarm.clear()
      expect(Alarm.list().length).toBe(0)
    })
  })

  describe("fire and consume", () => {
    it("fires alarm after duration", async () => {
      const alarm = Alarm.set("quick alarm", 50) // 50ms
      expect(alarm.status).toBe("pending")

      await new Promise((resolve) => setTimeout(resolve, 150))

      const fired = Alarm.get(alarm.id)
      expect(fired!.status).toBe("fired")
      expect(fired!.firedAt).toBeDefined()
    })

    it("fires alarm with check command", async () => {
      const alarm = Alarm.set("cmd alarm", 50, "echo hello-from-alarm")

      await new Promise((resolve) => setTimeout(resolve, 500))

      const fired = Alarm.get(alarm.id)
      expect(fired!.status).toBe("fired")
      expect(fired!.commandOutput).toContain("hello-from-alarm")
      expect(fired!.commandExitCode).toBe(0)
    })

    it("pending returns unconsumed fired alarms", async () => {
      Alarm.set("fire me", 50)
      Alarm.set("not yet", 999_999)

      await new Promise((resolve) => setTimeout(resolve, 150))

      const pending = Alarm.pending()
      expect(pending.length).toBe(1)
      expect(pending[0].label).toBe("fire me")
    })

    it("consume marks alarm as consumed", async () => {
      const alarm = Alarm.set("consume me", 50)

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(Alarm.pending().length).toBe(1)
      Alarm.consume(alarm.id)
      expect(Alarm.pending().length).toBe(0)
    })

    it("calls onFire callback when alarm fires", async () => {
      let firedLabel: string | undefined
      Alarm.onFire((alarm) => {
        firedLabel = alarm.label
      })

      Alarm.set("callback test", 50)

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(firedLabel).toBe("callback test")
    })
  })

  describe("formatRemaining", () => {
    it("formats hours and minutes", () => {
      expect(Alarm.formatRemaining(7_200_000)).toBe("2h")
      expect(Alarm.formatRemaining(5_400_000)).toBe("1h 30m")
      expect(Alarm.formatRemaining(3_661_000)).toBe("1h 1m")
    })

    it("formats minutes and seconds", () => {
      expect(Alarm.formatRemaining(300_000)).toBe("5m")
      expect(Alarm.formatRemaining(90_000)).toBe("1m 30s")
      expect(Alarm.formatRemaining(65_000)).toBe("1m 5s")
    })

    it("formats seconds", () => {
      expect(Alarm.formatRemaining(5_000)).toBe("5s")
      expect(Alarm.formatRemaining(1_000)).toBe("1s")
    })

    it("formats zero or negative as now", () => {
      expect(Alarm.formatRemaining(0)).toBe("now")
      expect(Alarm.formatRemaining(-100)).toBe("now")
    })
  })
})
