import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import fs from "fs/promises"
import { existsSync, openSync, writeSync, closeSync } from "fs"
import { Filesystem } from "../../../../util/filesystem"
import { Process } from "../../../../util/process"
import { which } from "../../../../util/which"
import { Global } from "../../../../global"

/**
 * Auto-detect DISPLAY when not set (e.g. SSH into a graphical machine).
 * Checks /tmp/.X11-unix/ for active X sockets and returns the first match.
 */
function detectDisplay(): string | undefined {
  if (process.env["DISPLAY"]) return process.env["DISPLAY"]
  try {
    const sockets = ["/tmp/.X11-unix/X0", "/tmp/.X11-unix/X1"]
    for (const sock of sockets) {
      if (existsSync(sock)) return `:${sock.slice(-1)}`
    }
  } catch {}
  return undefined
}

/**
 * Test whether an X display actually responds to connections.
 * Many headless/SSH setups have stale X sockets that hang forever.
 * Returns true if we can connect and get a response within the timeout.
 */
async function testXDisplay(display: string): Promise<boolean> {
  try {
    const result = await Promise.race([
      Process.run(["xdpyinfo", "-display", display], { nothrow: true }),
      new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: -1 }), 1500)),
    ])
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 *
 * Writes directly to /dev/tty to bypass any stdout interception
 * by the TUI renderer (alternate screen buffer, etc).
 */
function writeOsc52(text: string): void {
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52

  // Try multiple paths to reach the actual terminal:
  // 1. /dev/tty — the controlling terminal
  // 2. SSH_TTY — the SSH pseudo-terminal
  // 3. stdout — last resort if it's a TTY
  const targets = ["/dev/tty", process.env["SSH_TTY"]].filter(Boolean) as string[]
  for (const target of targets) {
    try {
      const fd = openSync(target, "w")
      writeSync(fd, sequence)
      closeSync(fd)
      return
    } catch {}
  }
  if (process.stdout.isTTY) process.stdout.write(sequence)
}

/**
 * File-based clipboard fallback for environments where no clipboard
 * mechanism works (SSH without OSC52 support, no X display, etc).
 * Writes to a known location so the user can retrieve it.
 */
const CLIPBOARD_FILE = path.join(Global.Path.data, "clipboard.txt")

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "cortex-clipboard.png")
      try {
        await Process.run(
          [
            "osascript",
            "-e",
            'set imageData to the clipboard as "PNGf"',
            "-e",
            `set fileRef to open for access POSIX file "${tmpfile}" with write permission`,
            "-e",
            "set eof fileRef to 0",
            "-e",
            "write imageData to fileRef",
            "-e",
            "close access fileRef",
          ],
          { nothrow: true },
        )
        const buffer = await Filesystem.readBytes(tmpfile)
        return { data: buffer.toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await fs.rm(tmpfile, { force: true }).catch(() => {})
      }
    }

    if (os === "win32" || release().includes("WSL")) {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
      const base64 = await Process.text(["powershell.exe", "-NonInteractive", "-NoProfile", "-command", script], {
        nothrow: true,
      })
      if (base64.text) {
        const imageBuffer = Buffer.from(base64.text.trim(), "base64")
        if (imageBuffer.length > 0) {
          return { data: imageBuffer.toString("base64"), mime: "image/png" }
        }
      }
    }

    if (os === "linux") {
      const wayland = await Process.run(["wl-paste", "-t", "image/png"], { nothrow: true })
      if (wayland.stdout.byteLength > 0) {
        return { data: Buffer.from(wayland.stdout).toString("base64"), mime: "image/png" }
      }
      // Only try xclip if X display is actually reachable
      if (xDisplayReachable && which("xclip")) {
        const display = detectDisplay()!
        const x11 = await Process.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], {
          nothrow: true,
          env: { DISPLAY: display },
        })
        if (x11.stdout.byteLength > 0) {
          return { data: Buffer.from(x11.stdout).toString("base64"), mime: "image/png" }
        }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }

    // File-based fallback — read from clipboard file
    try {
      const text = await Filesystem.readText(CLIPBOARD_FILE)
      if (text) return { data: text, mime: "text/plain" }
    } catch {}
  }

  // Cache the X display reachability test result
  let xDisplayReachable: boolean | null = null

  const getCopyMethod = lazy(async () => {
    const os = platform()

    if (os === "darwin" && which("osascript")) {
      console.log("clipboard: using osascript")
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await Process.run(["osascript", "-e", `set the clipboard to "${escaped}"`], { nothrow: true })
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && which("wl-copy")) {
        console.log("clipboard: using wl-copy")
        return async (text: string) => {
          const proc = Process.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }

      const display = detectDisplay()
      if (display && which("xclip")) {
        // Test if X display actually responds — stale sockets hang forever
        const reachable = await testXDisplay(display)
        xDisplayReachable = reachable
        if (reachable) {
          console.log(`clipboard: using xclip (DISPLAY=${display})`)
          return async (text: string) => {
            const proc = Process.spawn(["xclip", "-selection", "clipboard"], {
              stdin: "pipe",
              stdout: "ignore",
              stderr: "ignore",
              env: { DISPLAY: display },
            })
            if (!proc.stdin) return
            proc.stdin.write(text)
            proc.stdin.end()
            // xclip forks to hold the X selection until another copy replaces it.
            // Don't await — let it live in the background.
            proc.unref()
          }
        }
        console.log(`clipboard: X display ${display} not responding, skipping xclip`)
      }

      if (display && which("xsel")) {
        console.log(`clipboard: using xsel (DISPLAY=${display})`)
        return async (text: string) => {
          const proc = Process.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            env: { DISPLAY: display },
          })
          if (!proc.stdin) return
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      console.log("clipboard: using powershell")
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Process.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }

    // File-based fallback — always works regardless of display server
    console.log(`clipboard: using file fallback (${CLIPBOARD_FILE})`)
    return async (text: string) => {
      await Filesystem.write(CLIPBOARD_FILE, text)
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    const method = await getCopyMethod()
    await method(text)
  }
}
