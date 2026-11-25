// The anonymous usage count (owner 25.11.2026): what one count is, as pure functions. One count = one Firestore
// REST commit that raises `n` of the document use/<UTC day>-<platform>-<UTC hour> by 1 and, on the first count of a UTC
// day, `dev` by 1 – nothing else. The rules (resources/feedback/firestore.rules) accept no other field, no value but +1
// and no other day or hour than the one the request arrives in. The interface is written down in README › What Autark
// counts; this file is the whole of what is built into a request.
// Owns: the hour key, the platform word, the request body. Never: reads settings, files or the network.

/** The platforms the rules know; a build on another one (a BSD, a server) counts nothing. */
export type CountPlatform = 'windows' | 'mac' | 'linux';

export function platformOf(platform: string): CountPlatform | undefined {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return undefined;
}

/** The UTC hour of a time as 'YYYY-MM-DDTHH' – the only state that is kept (and, by its first ten characters, the day). */
export function hourKey(at: number): string {
  return new Date(at).toISOString().slice(0, 13);
}

/** The Firestore document of a count: 'use/<day>-<platform>-<HH>'. */
export function documentId(hour: string, platform: CountPlatform): string {
  return `${hour.slice(0, 10)}-${platform}-${hour.slice(11, 13)}`;
}

/** Whether `hour` is the first count of its UTC day on this install, given the last hour that was counted. */
export function firstOfDay(hour: string, lastHour: string | undefined): boolean {
  return lastHour === undefined || lastHour.slice(0, 10) !== hour.slice(0, 10);
}

/** The Firestore commit body: the increment of `n`, and of `dev` on the first count of the day. These two fields are all there is. */
export function commitBody(project: string, hour: string, platform: CountPlatform, first: boolean): string {
  const fieldTransforms = [
    { fieldPath: 'n', increment: { integerValue: '1' } },
    ...(first ? [{ fieldPath: 'dev', increment: { integerValue: '1' } }] : []),
  ];
  return JSON.stringify({ writes: [{ transform: {
    document: `projects/${project}/databases/(default)/documents/use/${documentId(hour, platform)}`,
    fieldTransforms,
  } }] });
}

/** A stored hour that has the shape of hourKey, else undefined (a damaged file counts as "nothing counted yet"). */
export function readHour(text: string): string | undefined {
  const hour = text.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour) ? hour : undefined;
}
