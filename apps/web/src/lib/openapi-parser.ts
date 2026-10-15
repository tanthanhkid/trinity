export interface ParsedEndpoint {
  path: string
  method: string
  summary: string
  tag: string
}

export interface ParsedSpec {
  title: string
  version: string
  description: string
  endpoints: ParsedEndpoint[]
}

function parseInfo(lines: string[]): { title: string; version: string; description: string } {
  let title = "Trinity CRM API"
  let version = "1.0.0"
  let description = ""
  let inInfo = false
  let inInfoIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = line.search(/\S/)
    if (trimmed === "info:") { inInfo = true; inInfoIndent = indent; continue }
    if (trimmed === "paths:" || trimmed === "components:" || trimmed === "servers:") { inInfo = false; continue }
    if (inInfo) {
      if (indent <= inInfoIndent && trimmed) { inInfo = false; continue }
      const m = trimmed.match(/^(title|version|description):\s*(.+)$/)
      if (m) {
        const val = m[2].replace(/^['"]|['"]$/g, "")
        if (m[1] === "title") title = val
        else if (m[1] === "version") version = val
        else if (m[1] === "description") description = val.split("\\n")[0]
      }
    }
  }
  return { title, version, description }
}

function extractMethodDetails(lines: string[], startIdx: number): { summary: string; tag: string } {
  let summary = ""
  let tag = ""
  for (let j = startIdx + 1; j < Math.min(startIdx + 15, lines.length); j++) {
    const next = lines[j]
    const nextTrimmed = next.trim()
    const summaryM = nextTrimmed.match(/^summary:\s*(.+)$/)
    if (summaryM) { summary = summaryM[1].replace(/^['"]|['"]$/g, ""); break }
    if (next.match(/^    (get|post|put|delete|patch|options|head):/)) break
    if (next.match(/^  \//)) break
    const tagsLineM = next.match(/^      - (.+)$/)
    if (tagsLineM && !tag) tag = tagsLineM[1].trim()
  }
  return { summary, tag }
}

function parsePaths(lines: string[]): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = []
  let currentPath = ""
  let inPaths = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (trimmed === "paths:") { inPaths = true; continue }
    if (trimmed === "components:" || trimmed === "servers:" || trimmed === "info:") { inPaths = false; continue }
    if (!inPaths) continue
    const pathMatch = line.match(/^  (\/[^:]+):/)
    if (pathMatch) { currentPath = pathMatch[1].trim(); continue }
    const methodMatch = line.match(/^    (get|post|put|delete|patch|options|head):\s*$/)
    if (methodMatch && currentPath) {
      const method = methodMatch[1].toUpperCase()
      const { summary, tag } = extractMethodDetails(lines, i)
      endpoints.push({ path: currentPath, method, summary, tag })
    }
  }
  return endpoints
}

export function parseOpenApiYaml(yaml: string): ParsedSpec {
  const lines = yaml.split("\n")
  return { ...parseInfo(lines), endpoints: parsePaths(lines) }
}

export function groupByTag(endpoints: ParsedEndpoint[]): Record<string, ParsedEndpoint[]> {
  return endpoints.reduce<Record<string, ParsedEndpoint[]>>((acc, ep) => {
    const tag = ep.tag || "Other"
    if (!acc[tag]) acc[tag] = []
    acc[tag].push(ep)
    return acc
  }, {})
}
