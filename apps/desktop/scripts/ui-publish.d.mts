// Types of scripts/ui-publish.mjs (publishing the phone apps' interface file by file).

export const REPOSITORY: string;
export const TAG: string;
export function publishPlan(
  files: Record<string, { sha256: string; bytes: number }>,
  assetNames: string[],
): { upload: Array<{ sha256: string; file: string }>; remove: string[] };
