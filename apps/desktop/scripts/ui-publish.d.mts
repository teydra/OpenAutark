// Types of scripts/ui-publish.mjs (publishing the phone apps' interface file by file into a versioned release).

export const REPOSITORY: string;
export function versionTag(tag: unknown): boolean;
export function publishPlan(
  files: Record<string, { sha256: string; bytes: number }>,
  assetNames: string[],
): { upload: Array<{ sha256: string; file: string }>; remove: string[] };
