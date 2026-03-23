import { Log } from "@/util/log"

/**
 * Query expansion for RAG search.
 *
 * Extracts structured entities (CVE IDs, MITRE ATT&CK IDs, protocols, etc.)
 * from user queries and generates additional search terms to improve recall.
 * This ensures exact string matches aren't missed by embedding similarity alone.
 */
export namespace QueryExpand {
  const log = Log.create({ service: "embedding.query-expand" })

  /** Entities extracted from a user query. */
  export interface ExtractedEntities {
    /** CVE identifiers (e.g. CVE-2024-1234). */
    cves: string[]
    /** MITRE ATT&CK technique IDs (e.g. T1059.001). */
    attackIDs: string[]
    /** IP addresses with optional CIDR. */
    ips: string[]
    /** MD5/SHA1/SHA256 hashes. */
    hashes: string[]
    /** Known security tool names. */
    tools: string[]
    /** Network protocol names. */
    protocols: string[]
    /** Port numbers. */
    ports: string[]
  }

  /** Common security tools — lowercase for matching. */
  const TOOL_NAMES = new Set([
    "nmap", "burp", "metasploit", "msfconsole", "wireshark", "tcpdump",
    "suricata", "snort", "zeek", "bro", "yara", "sigma", "osquery",
    "nuclei", "nikto", "gobuster", "ffuf", "dirb", "sqlmap", "hydra",
    "hashcat", "john", "mimikatz", "bloodhound", "cobalt", "empire",
    "responder", "impacket", "crackmapexec", "nessus", "openvas",
    "volatility", "autopsy", "ghidra", "ida", "radare2", "gdb",
    "strace", "ltrace", "frida", "objection", "drozer",
    "aircrack", "reaver", "wifite", "ettercap", "bettercap",
    "masscan", "zmap", "shodan", "censys", "maltego",
    "theharvester", "recon-ng", "amass", "subfinder",
    "burpsuite", "zap", "owasp", "semgrep", "bandit", "sonarqube",
    "velociraptor", "wazuh", "splunk", "elastic", "kibana",
  ])

  /** Network protocols — lowercase for matching. */
  const PROTOCOLS = new Set([
    "http", "https", "ftp", "ssh", "telnet", "smtp", "imap", "pop3",
    "dns", "dhcp", "snmp", "ldap", "rdp", "smb", "nfs", "kerberos",
    "tls", "ssl", "tcp", "udp", "icmp", "arp", "bgp", "ospf",
    "sip", "rtsp", "mqtt", "amqp", "grpc", "websocket",
    "modbus", "dnp3", "bacnet", "opcua", "s7comm",
  ])

  /** Regex patterns for entity extraction. */
  const PATTERNS = {
    cve: /CVE-\d{4}-\d{4,}/gi,
    attackID: /\bT\d{4}(?:\.\d{3})?\b/g,
    ip: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/g,
    md5: /\b[a-fA-F0-9]{32}\b/g,
    sha1: /\b[a-fA-F0-9]{40}\b/g,
    sha256: /\b[a-fA-F0-9]{64}\b/g,
    port: /\bport\s+(\d+)\b/gi,
    portColon: /\b:(\d{2,5})\b/g,
  }

  /**
   * Extract structured entities from a query string.
   *
   * @param query - User's natural language query
   * @returns Extracted entities by type
   */
  export function extractEntities(query: string): ExtractedEntities {
    const result: ExtractedEntities = {
      cves: [],
      attackIDs: [],
      ips: [],
      hashes: [],
      tools: [],
      protocols: [],
      ports: [],
    }

    // CVE IDs
    const cveMatches = query.match(PATTERNS.cve)
    if (cveMatches) {
      result.cves = [...new Set(cveMatches.map((m) => m.toUpperCase()))]
    }

    // MITRE ATT&CK IDs
    const attackMatches = query.match(PATTERNS.attackID)
    if (attackMatches) {
      result.attackIDs = [...new Set(attackMatches)]
    }

    // IP addresses
    const ipMatches = query.match(PATTERNS.ip)
    if (ipMatches) {
      result.ips = [...new Set(ipMatches)]
    }

    // Hashes (check for longer ones first to avoid substring matches)
    const sha256 = query.match(PATTERNS.sha256) ?? []
    const sha256Set = new Set(sha256)
    const sha1 = (query.match(PATTERNS.sha1) ?? []).filter((h) => !sha256Set.has(h))
    const sha1Set = new Set([...sha256Set, ...sha1])
    const md5 = (query.match(PATTERNS.md5) ?? []).filter((h) => !sha1Set.has(h))
    result.hashes = [...new Set([...sha256, ...sha1, ...md5])]

    // Tool names and protocols from individual words
    const words = query.toLowerCase().split(/[\s,;:'"()\[\]{}]+/)
    for (const word of words) {
      const clean = word.replace(/[^a-z0-9-]/g, "")
      if (clean.length < 2) continue
      if (TOOL_NAMES.has(clean)) result.tools.push(clean)
      if (PROTOCOLS.has(clean)) result.protocols.push(clean)
    }
    result.tools = [...new Set(result.tools)]
    result.protocols = [...new Set(result.protocols)]

    // Port numbers
    let portMatch: RegExpExecArray | null
    PATTERNS.port.lastIndex = 0
    while ((portMatch = PATTERNS.port.exec(query)) !== null) {
      result.ports.push(portMatch[1])
    }
    result.ports = [...new Set(result.ports)]

    return result
  }

  /**
   * Expand a query into multiple search terms.
   *
   * Returns the original query plus individual entity-based queries
   * that can be searched separately for better recall.
   *
   * @param query - Original user query
   * @returns Array of search strings (original first, then expansions)
   */
  export function expandQuery(query: string): string[] {
    const entities = extractEntities(query)
    const queries = [query]

    // CVE IDs get their own searches — these are the most important for security research
    for (const cve of entities.cves) {
      queries.push(cve)
      // Also search for the CVE with context terms
      queries.push(`${cve} vulnerability exploit`)
      queries.push(`${cve} detection rule`)
    }

    // ATT&CK IDs
    for (const tid of entities.attackIDs) {
      queries.push(`MITRE ATT&CK ${tid}`)
    }

    // Tool-specific queries
    if (entities.tools.length > 0) {
      queries.push(entities.tools.join(" ") + " " + query.replace(/\b\w+\b/g, (w) =>
        TOOL_NAMES.has(w.toLowerCase()) ? "" : w).trim())
    }

    log.info("query expanded", {
      original: query.slice(0, 80),
      entities: {
        cves: entities.cves.length,
        attackIDs: entities.attackIDs.length,
        tools: entities.tools.length,
        protocols: entities.protocols.length,
      },
      expandedCount: queries.length,
    })

    return queries
  }

  /**
   * Check if a query contains any extractable security entities.
   *
   * @param query - Query to check
   * @returns True if entities were found
   */
  export function hasEntities(query: string): boolean {
    const entities = extractEntities(query)
    return (
      entities.cves.length > 0 ||
      entities.attackIDs.length > 0 ||
      entities.tools.length > 0 ||
      entities.protocols.length > 0
    )
  }
}
