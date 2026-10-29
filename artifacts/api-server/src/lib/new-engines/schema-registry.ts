import { iso, type InMemoryNewEngineStore } from "./store";
import type { CompatibilityReport, JsonObject, SchemaField, SchemaVersion } from "./types";

export class SchemaRegistryEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  register(input: Omit<SchemaVersion, "createdAt"> & { createdAt?: string }): { schema: SchemaVersion; compatibility: CompatibilityReport } {
    const versions = this.store.schemas.get(input.name) ?? [];
    if (versions.some((version) => version.version === input.version)) throw new Error(`Schema ${input.name} v${input.version} already exists`);
    const previous = versions.at(-1);
    const compatibility = previous ? this.checkCompatibility(previous, input) : { compatible: true, breakingChanges: [], warnings: [] };
    const schema = { ...input, createdAt: input.createdAt ?? iso() };
    versions.push(schema);
    versions.sort((a, b) => a.version - b.version);
    this.store.schemas.set(input.name, versions);
    return { schema, compatibility };
  }

  get(name: string, version?: number): SchemaVersion {
    const versions = this.store.schemas.get(name) ?? [];
    const schema = version === undefined ? versions.at(-1) : versions.find((item) => item.version === version);
    if (!schema) throw new Error(`Schema ${name}${version === undefined ? "" : ` v${version}`} not found`);
    return schema;
  }

  list(name?: string): SchemaVersion[] {
    return [...this.store.schemas.entries()].filter(([key]) => !name || key === name).flatMap(([, versions]) => versions);
  }

  deprecate(name: string, version: number): SchemaVersion {
    const schema = this.get(name, version);
    schema.deprecatedAt = iso();
    return schema;
  }

  checkCompatibility(previous: SchemaVersion, next: Pick<SchemaVersion, "fields">): CompatibilityReport {
    const breakingChanges: string[] = [];
    const warnings: string[] = [];
    for (const [field, oldDefinition] of Object.entries(previous.fields)) {
      const nextDefinition = next.fields[field];
      if (!nextDefinition) {
        breakingChanges.push(`Field removed: ${field}`);
      } else if (nextDefinition.type !== oldDefinition.type) {
        breakingChanges.push(`Field type changed: ${field} (${oldDefinition.type} -> ${nextDefinition.type})`);
      } else if (oldDefinition.required && !nextDefinition.required) {
        warnings.push(`Field became optional: ${field}`);
      }
    }
    for (const [field, definition] of Object.entries(next.fields)) {
      if (!previous.fields[field] && definition.required) breakingChanges.push(`Required field added: ${field}`);
    }
    return { compatible: breakingChanges.length === 0, breakingChanges, warnings };
  }

  validate(name: string, value: JsonObject, version?: number): { valid: true; schema: SchemaVersion } {
    const schema = this.get(name, version);
    for (const [field, definition] of Object.entries(schema.fields)) {
      const item = value[field];
      if (item === undefined || item === null) {
        if (item === null && definition.nullable) continue;
        if (definition.required) throw new Error(`Missing required field: ${field}`);
        continue;
      }
      if (!this.matchesType(item, definition)) throw new Error(`Invalid type for field: ${field}`);
    }
    return { valid: true, schema };
  }

  private matchesType(value: unknown, definition: SchemaField): boolean {
    if (definition.type === "array") return Array.isArray(value);
    if (definition.type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
    if (definition.type === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === definition.type;
  }
}