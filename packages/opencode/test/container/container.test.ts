import { describe, test, expect, mock } from "bun:test"
import { Container } from "../../src/container"

/**
 * Container module tests — focused on output parsing and command building.
 * Most tests don't require Docker to be running.
 */
describe("Container", () => {
  describe("isAvailable", () => {
    test("returns a boolean", () => {
      const result = Container.isAvailable()
      expect(typeof result).toBe("boolean")
    })
  })

  describe("formatPs", () => {
    test("formats empty container list", () => {
      const result = Container.formatPs([])
      expect(result).toBe("No containers running.")
    })

    test("formats single container", () => {
      const result = Container.formatPs([
        {
          id: "abc123def456",
          name: "web-app",
          image: "nginx:latest",
          status: "Up 2 hours",
          state: "running",
          ports: "0.0.0.0:80->80/tcp",
          created: "2026-03-07",
        },
      ])
      expect(result).toContain("1 container(s)")
      expect(result).toContain("web-app")
      expect(result).toContain("nginx:latest")
      expect(result).toContain("running")
      expect(result).toContain("0.0.0.0:80->80/tcp")
    })

    test("formats multiple containers", () => {
      const result = Container.formatPs([
        {
          id: "abc123",
          name: "web",
          image: "nginx",
          status: "Up 1 hour",
          state: "running",
          ports: "80/tcp",
          created: "2026-03-07",
        },
        {
          id: "def456",
          name: "db",
          image: "postgres:15",
          status: "Exited (0) 30 minutes ago",
          state: "exited",
          ports: "",
          created: "2026-03-07",
        },
      ])
      expect(result).toContain("2 container(s)")
      expect(result).toContain("web")
      expect(result).toContain("db")
    })

    test("omits ports when empty", () => {
      const result = Container.formatPs([
        {
          id: "abc123",
          name: "worker",
          image: "myapp",
          status: "Up 5 minutes",
          state: "running",
          ports: "",
          created: "2026-03-07",
        },
      ])
      expect(result).not.toContain("[")
    })
  })

  describe("ContainerInfo interface", () => {
    test("supports all container states", () => {
      const states: Container.ContainerInfo["state"][] = [
        "running",
        "exited",
        "paused",
        "restarting",
        "dead",
        "created",
      ]
      for (const state of states) {
        const info: Container.ContainerInfo = {
          id: "test",
          name: "test",
          image: "test",
          status: "test",
          state,
          ports: "",
          created: "2026-03-07",
        }
        expect(info.state).toBe(state)
      }
    })
  })

  describe("ImageInfo interface", () => {
    test("holds image metadata", () => {
      const img: Container.ImageInfo = {
        id: "sha256:abc123",
        repository: "nginx",
        tag: "latest",
        size: "142MB",
        created: "2 weeks ago",
      }
      expect(img.repository).toBe("nginx")
      expect(img.tag).toBe("latest")
    })
  })

  describe("InspectResult interface", () => {
    test("holds detailed container info", () => {
      const info: Container.InspectResult = {
        id: "abc123def456",
        name: "web-app",
        image: "nginx:latest",
        state: "running",
        env: ["NODE_ENV=production", "PORT=3000"],
        mounts: [{ source: "/data", destination: "/app/data", mode: "rw" }],
        ports: { "80/tcp": "0.0.0.0:8080" },
        networkMode: "bridge",
        restartPolicy: "always",
        health: "healthy",
      }
      expect(info.env.length).toBe(2)
      expect(info.mounts.length).toBe(1)
      expect(info.ports["80/tcp"]).toBe("0.0.0.0:8080")
      expect(info.health).toBe("healthy")
    })
  })

  describe("ComposeService interface", () => {
    test("holds compose service status", () => {
      const svc: Container.ComposeService = {
        name: "api",
        status: "running",
        ports: "0.0.0.0:3000->3000/tcp",
      }
      expect(svc.name).toBe("api")
      expect(svc.status).toBe("running")
    })
  })

  describe("ps with Docker available", () => {
    test("returns array of containers when docker is available", () => {
      if (!Container.isAvailable()) return // skip if no docker
      const containers = Container.ps()
      expect(Array.isArray(containers)).toBe(true)
    })

    test("all flag includes stopped containers", () => {
      if (!Container.isAvailable()) return
      const running = Container.ps(false)
      const all = Container.ps(true)
      expect(all.length).toBeGreaterThanOrEqual(running.length)
    })
  })

  describe("images with Docker available", () => {
    test("returns array of images when docker is available", () => {
      if (!Container.isAvailable()) return
      const imgs = Container.images()
      expect(Array.isArray(imgs)).toBe(true)
    })
  })
})
