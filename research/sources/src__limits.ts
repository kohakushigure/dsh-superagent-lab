<!--
  source_url : https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/src/limits.ts
  fetched_at : 2026-11-02T18:5x+08:00 (Asia/Shanghai) / 2026-11-02T10:5xZ  [curl.exe -L, raw.githubusercontent.com, branch=main]
  sha256     : 78e4171e6624580038996e3931888cd1cdbefa5c0e1035235c4dffdbb4af236f
  bytes      : 415
  note       : 以下为逐字原文，未改写、未截断；行号以本文件为基准（含上面 7 行头部偏移）。
-->
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
} as const
