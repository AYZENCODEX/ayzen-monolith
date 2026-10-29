export const LOCAL_SENSITIVE_FIELDS = [
  "password",
  "recovery_email_password",
  "backup_codes",
  "twofa",
  "recovery_email_twofa",
] as const;

export const DEFAULT_LOCAL_ACCOUNT_CATEGORIES = [
  { id: "facebook", name: "Facebook", color: "#1877F2", icon: "facebook" },
  { id: "github", name: "GitHub", color: "#24292e", icon: "github" },
  { id: "google", name: "Google", color: "#EA4335", icon: "google" },
  { id: "twitter", name: "Twitter", color: "#1DA1F2", icon: "twitter" },
  { id: "discord", name: "Discord", color: "#5865F2", icon: "discord" },
] as const;
