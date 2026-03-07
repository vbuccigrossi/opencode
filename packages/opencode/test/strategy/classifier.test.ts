import { describe, expect, test } from "bun:test"
import { TaskClassifier } from "../../src/strategy/classifier"
import { Strategies } from "../../src/strategy/strategies"
import { Strategy } from "../../src/strategy"

describe("TaskClassifier", () => {
  describe("classify", () => {
    test("classifies bug fix requests", () => {
      expect(TaskClassifier.classify("fix the login error")).toBe("bug_fix")
      expect(TaskClassifier.classify("The authentication is broken, please debug it")).toBe("bug_fix")
      expect(TaskClassifier.classify("There's a crash when I click submit")).toBe("bug_fix")
    })

    test("classifies simple edits", () => {
      expect(TaskClassifier.classify("rename the variable to camelCase")).toBe("simple_edit")
      expect(TaskClassifier.classify("change the color to blue")).toBe("simple_edit")
      expect(TaskClassifier.classify("fix the typo in the header")).toBe("simple_edit")
    })

    test("classifies feature requests", () => {
      expect(TaskClassifier.classify("add a dark mode toggle")).toBe("feature")
      expect(TaskClassifier.classify("implement user authentication with OAuth")).toBe("feature")
      expect(TaskClassifier.classify("create a new API endpoint for user profiles")).toBe("feature")
    })

    test("classifies refactoring tasks", () => {
      expect(TaskClassifier.classify("refactor the auth module to use dependency injection")).toBe("refactor")
      expect(TaskClassifier.classify("extract the validation logic into a separate module")).toBe("refactor")
      expect(TaskClassifier.classify("simplify and deduplicate the database logic")).toBe("refactor")
    })

    test("classifies exploration questions", () => {
      expect(TaskClassifier.classify("how does the authentication flow work?")).toBe("exploration")
      expect(TaskClassifier.classify("explain the middleware chain")).toBe("exploration")
      expect(TaskClassifier.classify("what is the purpose of this module?")).toBe("exploration")
    })

    test("classifies test tasks", () => {
      expect(TaskClassifier.classify("write tests for the auth module")).toBe("test")
      expect(TaskClassifier.classify("fix the failing test in user.spec.ts")).toBe("test")
      expect(TaskClassifier.classify("add test coverage for edge cases")).toBe("test")
    })

    test("classifies review tasks", () => {
      expect(TaskClassifier.classify("review this code for security vulnerabilities")).toBe("review")
      expect(TaskClassifier.classify("audit the authentication module")).toBe("review")
    })

    test("defaults to feature for ambiguous messages", () => {
      expect(TaskClassifier.classify("make it better")).toBe("feature")
    })

    test("defaults to exploration for bare questions", () => {
      expect(TaskClassifier.classify("what does this do?")).toBe("exploration")
    })
  })

  describe("confidence", () => {
    test("high confidence for clear bug fix", () => {
      const conf = TaskClassifier.confidence("fix the broken login error")
      expect(conf).toBeGreaterThan(0.3)
    })

    test("lower confidence for ambiguous messages", () => {
      const conf = TaskClassifier.confidence("do something with the code")
      expect(conf).toBeLessThan(0.5)
    })

    test("zero confidence for no keyword matches", () => {
      const conf = TaskClassifier.confidence("hello world")
      expect(conf).toBe(0)
    })
  })
})

describe("Strategies", () => {
  test("get returns strategy for each task type", () => {
    const types: TaskClassifier.TaskType[] = [
      "simple_edit", "bug_fix", "feature", "refactor", "exploration", "test", "review",
    ]
    for (const type of types) {
      const strategy = Strategies.get(type)
      expect(strategy.type).toBe(type)
      expect(strategy.name).toBeTruthy()
      expect(strategy.guidance).toBeTruthy()
    }
  })

  test("all returns all strategies", () => {
    const all = Strategies.all()
    expect(all).toHaveLength(7)
  })

  test("format produces XML block", () => {
    const strategy = Strategies.get("bug_fix")
    const output = Strategies.format(strategy)
    expect(output).toContain("<strategy>")
    expect(output).toContain("</strategy>")
    expect(output).toContain("Bug Fix")
    expect(output).toContain("Think before acting: yes")
  })

  test("simple_edit strategy does not think first", () => {
    const strategy = Strategies.get("simple_edit")
    expect(strategy.thinkFirst).toBe(false)
    const output = Strategies.format(strategy)
    expect(output).not.toContain("Think before acting")
  })

  test("refactor strategy always checkpoints", () => {
    const strategy = Strategies.get("refactor")
    expect(strategy.checkpointPolicy).toBe("always")
    expect(strategy.editMode).toBe("cautious")
  })
})

describe("Strategy (public API)", () => {
  const sessionID = "test-session-strategy"

  test("select classifies and returns strategy", () => {
    const strategy = Strategy.select(sessionID, "fix the broken login")
    expect(strategy.type).toBe("bug_fix")
  })

  test("active returns selected strategy", () => {
    Strategy.select(sessionID, "refactor the auth module")
    const active = Strategy.active(sessionID)
    expect(active).toBeDefined()
    expect(active!.type).toBe("refactor")
  })

  test("switchStrategy changes active strategy", () => {
    Strategy.select(sessionID, "fix the bug")
    Strategy.switchStrategy(sessionID, "refactor")
    const active = Strategy.active(sessionID)
    expect(active!.type).toBe("refactor")
  })

  test("getInjection returns formatted block", () => {
    Strategy.select(sessionID, "add a new feature")
    const injection = Strategy.getInjection(sessionID)
    expect(injection).toContain("<strategy>")
  })

  test("getInjection returns empty before classification", () => {
    Strategy.clear(sessionID)
    expect(Strategy.getInjection(sessionID)).toBe("")
  })

  test("clear removes active strategy", () => {
    Strategy.select(sessionID, "fix bug")
    Strategy.clear(sessionID)
    expect(Strategy.active(sessionID)).toBeUndefined()
  })
})
