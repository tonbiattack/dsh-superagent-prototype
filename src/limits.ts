/** Validation bounds shared between host schemas and management panel forms. */
export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  autopilotPollSeconds: { min: 30, max: 3600 },
  autopilotMaxConcurrentGlobal: { min: 1, max: 16 },
  autopilotMaxConcurrentPerRepo: { min: 1, max: 16 },
  autopilotMaxFixAttempts: { min: 1, max: 10 },
  autopilotLabel: 50,
  autopilotRepositories: 20,
  autopilotValidationCommand: 2000,
  autopilotValidationTimeoutSeconds: { min: 30, max: 3600 },
} as const
