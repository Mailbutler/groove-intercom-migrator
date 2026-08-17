import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        "grooveApiToken",
        "intercomAccessToken",
        "*.authorization",
        "*.Authorization",
      ],
      remove: true,
    },
  });
}
