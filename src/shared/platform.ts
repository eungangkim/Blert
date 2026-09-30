export type PlatformGroup = 'win32' | 'darwin' | 'linux';

/** 안내 문구를 고르기 위한 OS 분류. 알 수 없는 OS는 linux로 본다. */
export function platformGroup(platform: NodeJS.Platform = process.platform): PlatformGroup {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}
