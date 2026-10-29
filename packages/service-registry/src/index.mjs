import { validateServiceDefinition } from "@ayzen/platform-governance";

export function createServiceRegistry(definitions = []) {
  const services = new Map();
  for (const definition of definitions) register(definition);
  function register(definition) {
    const service = validateServiceDefinition(definition);
    if (services.has(service.id)) throw new Error(`Service already registered: ${service.id}`);
    services.set(service.id, service);
    return service;
  }
  function resolve(id) {
    const service = services.get(id);
    if (!service) throw new Error(`Unknown service: ${id}`);
    return service;
  }
  return Object.freeze({
    register,
    resolve,
    list: () => [...services.values()],
    dependenciesOf: (id) => resolve(id).dependencies.map((dependency) => resolve(dependency)),
  });
}