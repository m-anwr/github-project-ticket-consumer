function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const log = {
  info(scope: string, message: string): void {
    console.log(`${ts()} [${scope}] ${message}`);
  },
  warn(scope: string, message: string, err?: unknown): void {
    if (err !== undefined) {
      console.warn(`${ts()} [${scope}] ${message}`, err);
    } else {
      console.warn(`${ts()} [${scope}] ${message}`);
    }
  },
  error(scope: string, message: string, err?: unknown): void {
    if (err !== undefined) {
      console.error(`${ts()} [${scope}] ${message}`, err);
    } else {
      console.error(`${ts()} [${scope}] ${message}`);
    }
  },
};
