export const ExitCode = { ok: 0, input: 1, denied: 2, connection: 3, internal: 9 } as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** 사용자에게 보이는 오류. 문장은 i18n 키로만 가진다 (NFR-UX-02, NFR-UX-03). */
export class BlertError extends Error {
  constructor(
    readonly messageKey: string,
    readonly params: Record<string, string | number> = {},
    readonly exitCode: ExitCodeValue = ExitCode.input,
  ) {
    super(messageKey);
    this.name = 'BlertError';
  }
}
