import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Require a zero-argument object input before binding an MCP identity operation. */
export function hasNoArgumentObjectInput(definition: ToolDefinition): boolean {
  const properties = definition.parameters.properties
  const required = definition.parameters.required
  return (
    definition.parameters.type === 'object' &&
    isRecord(properties) &&
    (required === undefined || (Array.isArray(required) && required.length === 0))
  )
}

/** Check the top-level shape used by a pinned MCP operation contract. */
export function hasInputShape(
  definition: ToolDefinition,
  requiredNames: readonly string[],
  propertyTypes: Readonly<Record<string, string>>,
): boolean {
  const required = definition.parameters.required
  return (
    definition.parameters.type === 'object' &&
    Array.isArray(required) &&
    requiredNames.every((name) => required.includes(name)) &&
    isRecord(definition.parameters.properties) &&
    Object.entries(propertyTypes).every(([name, type]) => property(definition, name)?.type === type)
  )
}

export function propertyEnumIncludes(definition: ToolDefinition, name: string, value: string): boolean {
  const values = property(definition, name)?.enum
  return Array.isArray(values) && values.includes(value)
}

export function arrayItemsAreStrings(definition: ToolDefinition, name: string): boolean {
  return arrayItems(definition, name)?.type === 'string'
}

export function arrayItemEnumIncludes(definition: ToolDefinition, name: string, value: string): boolean {
  const values = arrayItems(definition, name)?.enum
  return Array.isArray(values) && values.includes(value)
}

function arrayItems(definition: ToolDefinition, name: string): Record<string, unknown> | undefined {
  const items = property(definition, name)?.items
  return isRecord(items) ? items : undefined
}

function property(definition: ToolDefinition, name: string): Record<string, unknown> | undefined {
  const properties = definition.parameters.properties
  if (!isRecord(properties)) return undefined
  const value = properties[name]
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
