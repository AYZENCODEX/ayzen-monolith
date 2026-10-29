export function createNotificationPolicy({ preferences = {}, quotas = {} } = {}) {
  const valueFor = (source, key) => source instanceof Map ? source.get(key) : source[key];
  return Object.freeze({
    allows({ recipient, channel }) {
      const disabled = valueFor(preferences, recipient)?.disabledChannels ?? [];
      return !disabled.includes(channel);
    },
    quotaFor({ app, channel }) {
      return valueFor(quotas, `${app}:${channel}`) ?? valueFor(quotas, app) ?? { limit: 1000, windowMs: 86_400_000 };
    },
  });
}