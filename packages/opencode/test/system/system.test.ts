import { describe, test, expect } from "bun:test"
import { System } from "../../src/system"

describe("System", () => {
  describe("info", () => {
    test("returns system information with all fields", () => {
      const info = System.info()
      expect(info.os).toBeTruthy()
      expect(info.arch).toBeTruthy()
      expect(info.hostname).toBeTruthy()
      expect(info.kernel).toBeTruthy()
      expect(info.shell).toBeTruthy()
      expect(typeof info.uptime).toBe("number")
      expect(info.uptime).toBeGreaterThan(0)
      expect(info.uptimeHuman).toMatch(/\d+h \d+m/)
    })

    test("os includes platform name", () => {
      const info = System.info()
      expect(info.os).toContain("linux")
    })
  })

  describe("runtimes", () => {
    test("detects at least one runtime", () => {
      const rts = System.runtimes()
      expect(rts.length).toBeGreaterThan(0)
    })

    test("detects node runtime", () => {
      const rts = System.runtimes()
      const node = rts.find((r) => r.name === "node")
      // Node should be available since we're running via bun/node
      expect(node || rts.find((r) => r.name === "bun")).toBeTruthy()
    })

    test("runtime entries have version and path", () => {
      const rts = System.runtimes()
      for (const rt of rts) {
        expect(rt.name).toBeTruthy()
        expect(rt.version).toBeTruthy()
        // path may be empty if 'which' fails but version should exist
      }
    })

    test("detects git", () => {
      const rts = System.runtimes()
      const git = rts.find((r) => r.name === "git")
      expect(git).toBeTruthy()
      expect(git!.version).toMatch(/\d+\.\d+/)
    })
  })

  describe("resources", () => {
    test("returns memory info", () => {
      const res = System.resources()
      expect(res.memory.total).toBeGreaterThan(0)
      expect(res.memory.free).toBeGreaterThanOrEqual(0)
      expect(res.memory.used).toBeGreaterThan(0)
      expect(res.memory.usedPercent).toBeGreaterThan(0)
      expect(res.memory.usedPercent).toBeLessThanOrEqual(100)
    })

    test("returns CPU info", () => {
      const res = System.resources()
      expect(res.cpu.cores).toBeGreaterThan(0)
      expect(res.cpu.model).toBeTruthy()
      expect(Array.isArray(res.cpu.loadAvg)).toBe(true)
      expect(res.cpu.loadAvg.length).toBe(3)
    })

    test("returns disk info", () => {
      const res = System.resources()
      expect(Array.isArray(res.disk)).toBe(true)
      // On most systems we should have at least one disk
      if (res.disk.length > 0) {
        const d = res.disk[0]
        expect(d.filesystem).toBeTruthy()
        expect(d.mountpoint).toBeTruthy()
      }
    })
  })

  describe("ports", () => {
    test("returns an array", () => {
      const pts = System.ports()
      expect(Array.isArray(pts)).toBe(true)
    })

    test("port entries have required fields", () => {
      const pts = System.ports()
      for (const p of pts) {
        expect(typeof p.port).toBe("number")
        expect(p.port).toBeGreaterThan(0)
        expect(p.protocol).toBeTruthy()
        expect(p.address).toBeTruthy()
      }
    })
  })

  describe("env", () => {
    test("returns environment variables", () => {
      const vars = System.env()
      expect(vars.length).toBeGreaterThan(0)
    })

    test("filters by prefix", () => {
      const vars = System.env("PATH")
      expect(vars.length).toBeGreaterThanOrEqual(1)
      for (const v of vars) {
        expect(v.name.toLowerCase().startsWith("path")).toBe(true)
      }
    })

    test("masks secret values", () => {
      // Set a test env var with SECRET in the name
      process.env.TEST_SECRET_KEY = "supersecretvalue123"
      const vars = System.env("TEST_SECRET")
      const found = vars.find((v) => v.name === "TEST_SECRET_KEY")
      expect(found).toBeTruthy()
      expect(found!.value).not.toBe("supersecretvalue123")
      expect(found!.value).toContain("****")
      delete process.env.TEST_SECRET_KEY
    })

    test("returns sorted results", () => {
      const vars = System.env()
      for (let i = 1; i < vars.length; i++) {
        expect(vars[i].name.localeCompare(vars[i - 1].name)).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe("formatInfo", () => {
    test("returns formatted string with OS and hostname", () => {
      const formatted = System.formatInfo()
      expect(formatted).toContain("OS:")
      expect(formatted).toContain("Hostname:")
      expect(formatted).toContain("Shell:")
      expect(formatted).toContain("Uptime:")
    })
  })

  describe("formatRuntimes", () => {
    test("returns formatted runtime list", () => {
      const formatted = System.formatRuntimes()
      expect(formatted).toBeTruthy()
      // Should contain at least one runtime name
      expect(formatted).not.toBe("No runtimes detected.")
    })
  })

  describe("formatResources", () => {
    test("returns formatted resource summary", () => {
      const formatted = System.formatResources()
      expect(formatted).toContain("Memory:")
      expect(formatted).toContain("CPU:")
      expect(formatted).toContain("Load:")
    })
  })
})
