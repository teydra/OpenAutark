// Types of scripts/ui-list.mjs (the phone apps' list of their interface and its signature).

export interface UiList {
  n: number;
  shell: number;
  needs: string;
  files: Record<string, { sha256: string; bytes: number }>;
}

export const LIST: 'ui.json';
export const SIGNATURE: 'ui.json.sig';
export function listFiles(dir: string): Promise<string[]>;
export function pageNumbers(base?: string): Promise<{ shell: number; needs: string }>;
export function uiList(dir: string, options?: { n?: number; shell?: number; needs?: string }): Promise<UiList>;
export function listBytes(list: UiList): Buffer;
export function privateKey(text: string): import('node:crypto').KeyObject;
export function signList(bytes: Uint8Array, text: string): Buffer;
export function writeUiList(dir: string, options?: { key?: string; keyText?: string; n?: number; shell?: number; needs?: string }): Promise<{ list: UiList; bytes: Buffer; signed: boolean }>;
export function keyOptions(args: string[], env?: Record<string, string | undefined>): { key?: string; keyText?: string; taken: number[] };
