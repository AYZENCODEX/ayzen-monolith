export function createConfigControl({ schemas = {}, values = {}, audit = () => {} } = {}) {
  const versions = new Map();
  function validate(namespace, input) {
    const schema = schemas[namespace] ?? {};
    for (const key of schema.required ?? []) if (input?.[key] === undefined) throw new Error(`${namespace}.${key} is required`);
    if (schema.allowed) for (const key of Object.keys(input ?? {})) if (!schema.allowed.includes(key)) throw new Error(`${namespace}.${key} is not allowed`);
    return true;
  }
  function publish(namespace, input, { version = (versions.get(namespace) ?? 0) + 1, actor = "config-control" } = {}) {
    validate(namespace, input);
    versions.set(namespace, version);
    values[namespace] = { ...input, version };
    audit({ action: "config.published", namespace, version, actor });
    return values[namespace];
  }
  function rotate(namespace, input, options = {}) {
    const current = values[namespace];
    const nextVersion = options.version ?? (current?.version ?? 0) + 1;
    const published = publish(namespace, input, { ...options, version: nextVersion });
    audit({ action: "config.rotated", namespace, version: nextVersion, actor: options.actor ?? "config-control" });
    return published;
  }
  function drift(observed = {}) {
    return Object.keys(values).filter((namespace) => JSON.stringify(values[namespace]) !== JSON.stringify(observed[namespace])).map((namespace) => ({ namespace, expected: values[namespace]?.version, observed: observed[namespace]?.version }));
  }
  return Object.freeze({ validate, publish, rotate, drift, get: (namespace) => values[namespace], versions: () => new Map(versions) });
}