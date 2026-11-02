<!--
  source_url : https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/src/admission.ts
  fetched_at : 2026-11-02T18:5x+08:00 (Asia/Shanghai) / 2026-11-02T10:5xZ  [curl.exe -L, raw.githubusercontent.com, branch=main]
  sha256     : 62f54fe63762a347e54cec2aed098e1b28a0a547a4133b5e3fc2e91a10b94afd
  bytes      : 1066
  note       : 以下为逐字原文，未改写、未截断；行号以本文件为基准（含上面 7 行头部偏移）。
-->
/**
 * Per-scope admission matrix classifying incoming messages as explicit requests, inferred candidates, or ignored.
 * A listed sender who addresses the agent always makes an explicit request (no table cell); an unaddressed message cannot be explicit.
 */
import type { AdmissionCell } from './core/model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = { listedUnaddressed: ['inferred', 'ignore'], unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'] } as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
