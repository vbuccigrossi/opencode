import { describe, expect, test } from "bun:test"
import { Extractor } from "../../src/graph/extractor"
import { GraphParser } from "../../src/graph/parser"

describe("graph.extractor", () => {
  describe("typescript", () => {
    test("extracts function declarations", async () => {
      const source = `
function greet(name: string): string {
  return "Hello, " + name
}

const add = (a: number, b: number) => a + b
`
      const tree = await GraphParser.parse("test.ts", source)
      expect(tree).toBeDefined()
      const result = Extractor.extract(tree!, "typescript", source)

      const funcNames = result.nodes.map((n) => n.name)
      expect(funcNames).toContain("greet")
      expect(funcNames).toContain("add")

      const greet = result.nodes.find((n) => n.name === "greet")
      expect(greet?.kind).toBe("function")
      expect(greet?.startLine).toBe(2)
      expect(greet?.signature).toContain("function greet")
    })

    test("extracts class declarations with inheritance", async () => {
      const source = `
class Animal {
  name: string
  constructor(name: string) {
    this.name = name
  }
  speak(): string {
    return this.name
  }
}

class Dog extends Animal {
  bark() {
    return "woof"
  }
}
`
      const tree = await GraphParser.parse("test.ts", source)
      const result = Extractor.extract(tree!, "typescript", source)

      const classNames = result.nodes.filter((n) => n.kind === "class").map((n) => n.name)
      expect(classNames).toContain("Animal")
      expect(classNames).toContain("Dog")

      const extendsEdge = result.edges.find((e) => e.kind === "extends")
      expect(extendsEdge).toBeDefined()
      expect(extendsEdge?.sourceNodeName).toBe("Dog")
      expect(extendsEdge?.targetName).toBe("Animal")
    })

    test("extracts interface and type declarations", async () => {
      const source = `
interface User {
  id: string
  name: string
}

type Status = "active" | "inactive"

enum Color {
  Red,
  Green,
  Blue,
}
`
      const tree = await GraphParser.parse("test.ts", source)
      const result = Extractor.extract(tree!, "typescript", source)

      const iface = result.nodes.find((n) => n.name === "User")
      expect(iface?.kind).toBe("interface")

      const typeAlias = result.nodes.find((n) => n.name === "Status")
      expect(typeAlias?.kind).toBe("type")

      const enumNode = result.nodes.find((n) => n.name === "Color")
      expect(enumNode?.kind).toBe("enum")
    })

    test("extracts call edges", async () => {
      const source = `
function validate(input: string): boolean {
  return input.length > 0
}

function process(data: string) {
  if (validate(data)) {
    console.log(data)
  }
}
`
      const tree = await GraphParser.parse("test.ts", source)
      const result = Extractor.extract(tree!, "typescript", source)

      const callEdges = result.edges.filter((e) => e.kind === "calls")
      const processCallsValidate = callEdges.find(
        (e) => e.sourceNodeName === "process" && e.targetName === "validate",
      )
      expect(processCallsValidate).toBeDefined()
    })

    test("extracts method definitions", async () => {
      const source = `
class Service {
  async fetch(url: string): Promise<Response> {
    return fetch(url)
  }

  parse(data: string) {
    return JSON.parse(data)
  }
}
`
      const tree = await GraphParser.parse("test.ts", source)
      const result = Extractor.extract(tree!, "typescript", source)

      const methods = result.nodes.filter((n) => n.kind === "method")
      const methodNames = methods.map((n) => n.name)
      expect(methodNames).toContain("fetch")
      expect(methodNames).toContain("parse")
    })

    test("handles export statements", async () => {
      const source = `
export function exported() {
  return true
}

export const value = 42
`
      const tree = await GraphParser.parse("test.ts", source)
      const result = Extractor.extract(tree!, "typescript", source)

      const exportEdges = result.edges.filter((e) => e.kind === "exports")
      expect(exportEdges.length).toBeGreaterThan(0)
    })
  })

  describe("python", () => {
    test("extracts function and class definitions", async () => {
      const source = `
def greet(name: str) -> str:
    return f"Hello, {name}"

class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self) -> str:
        return self.name

class Dog(Animal):
    def bark(self):
        return "woof"
`
      const tree = await GraphParser.parse("test.py", source)
      expect(tree).toBeDefined()
      const result = Extractor.extract(tree!, "python", source)

      const funcNames = result.nodes.filter((n) => n.kind === "function").map((n) => n.name)
      expect(funcNames).toContain("greet")
      expect(funcNames).toContain("__init__")
      expect(funcNames).toContain("speak")
      expect(funcNames).toContain("bark")

      const classNames = result.nodes.filter((n) => n.kind === "class").map((n) => n.name)
      expect(classNames).toContain("Animal")
      expect(classNames).toContain("Dog")

      const extendsEdge = result.edges.find((e) => e.kind === "extends")
      expect(extendsEdge).toBeDefined()
      expect(extendsEdge?.sourceNodeName).toBe("Dog")
      expect(extendsEdge?.targetName).toBe("Animal")
    })

    test("extracts function signatures", async () => {
      const source = `
def calculate(x: int, y: int) -> float:
    return x / y
`
      const tree = await GraphParser.parse("test.py", source)
      const result = Extractor.extract(tree!, "python", source)

      const func = result.nodes.find((n) => n.name === "calculate")
      expect(func?.signature).toContain("def calculate")
      expect(func?.signature).toContain("x: int, y: int")
    })
  })

  describe("go", () => {
    test("extracts functions and type declarations", async () => {
      const source = `
package main

type User struct {
    Name string
    Age  int
}

type Greeter interface {
    Greet() string
}

func NewUser(name string, age int) *User {
    return &User{Name: name, Age: age}
}

func (u *User) Greet() string {
    return "Hello, " + u.Name
}
`
      const tree = await GraphParser.parse("test.go", source)
      expect(tree).toBeDefined()
      const result = Extractor.extract(tree!, "go", source)

      const funcNames = result.nodes
        .filter((n) => n.kind === "function" || n.kind === "method")
        .map((n) => n.name)
      expect(funcNames).toContain("NewUser")
      expect(funcNames).toContain("Greet")

      const structNode = result.nodes.find((n) => n.name === "User")
      expect(structNode?.kind).toBe("class")

      const ifaceNode = result.nodes.find((n) => n.name === "Greeter")
      expect(ifaceNode?.kind).toBe("interface")
    })
  })

  describe("rust", () => {
    test("extracts functions, structs, and traits", async () => {
      const source = `
struct Point {
    x: f64,
    y: f64,
}

trait Drawable {
    fn draw(&self);
}

impl Drawable for Point {
    fn draw(&self) {
        println!("({}, {})", self.x, self.y);
    }
}

fn distance(a: &Point, b: &Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
}
`
      const tree = await GraphParser.parse("test.rs", source)
      expect(tree).toBeDefined()
      const result = Extractor.extract(tree!, "rust", source)

      const structNode = result.nodes.find((n) => n.name === "Point")
      expect(structNode?.kind).toBe("class")

      const traitNode = result.nodes.find((n) => n.name === "Drawable")
      expect(traitNode?.kind).toBe("interface")

      const enumNode = result.nodes.find((n) => n.name === "Shape")
      expect(enumNode?.kind).toBe("enum")

      const funcNode = result.nodes.find((n) => n.name === "distance")
      expect(funcNode?.kind).toBe("function")

      const implEdge = result.edges.find((e) => e.kind === "implements")
      expect(implEdge).toBeDefined()
      expect(implEdge?.sourceNodeName).toBe("Point")
      expect(implEdge?.targetName).toBe("Drawable")
    })
  })
})
