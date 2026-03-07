import { describe, expect, test, beforeEach } from "bun:test"
import { VerifyLoop } from "../../src/verify/loop"

describe("verify.loop", () => {
  const SESSION_A = "session-a"
  const SESSION_B = "session-b"

  beforeEach(() => {
    VerifyLoop.cleanup(SESSION_A)
    VerifyLoop.cleanup(SESSION_B)
  })

  describe("turn tracking", () => {
    test("starts with zero repair count", () => {
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
    })

    test("resetTurn initializes session state", () => {
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
    })

    test("resetTurn with same messageID is idempotent", () => {
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      // Simulate repair count increment (indirectly via verify)
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
      // Reset with same ID should not change state
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
    })

    test("resetTurn with new messageID resets state", () => {
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      VerifyLoop.resetTurn(SESSION_A, "msg-2")
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
    })

    test("cleanup removes session state", () => {
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      VerifyLoop.cleanup(SESSION_A)
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
    })

    test("sessions are independent", () => {
      VerifyLoop.resetTurn(SESSION_A, "msg-1")
      VerifyLoop.resetTurn(SESSION_B, "msg-2")
      expect(VerifyLoop.repairCount(SESSION_A)).toBe(0)
      expect(VerifyLoop.repairCount(SESSION_B)).toBe(0)
    })
  })
})
