import { BlertError, ExitCode } from '../shared/errors.js';
import { t } from '../i18n/index.js';
import { askYesNo } from './init.js';
import type { Command, Ctx, ServicePort } from './types.js';

/** 작업 스케줄러 작업 이름과 로그인 후 시작 지연 (D-64, D-67) */
export const TASK_NAME = 'blert';
export const LOGON_DELAY_SECONDS = 30;

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const quote = (s: string): string => `"${s}"`;

/** 작업이 실행할 인자: `"<index.js>" start --service` (D-65, D-67) */
export const taskArguments = (scriptPath: string): string => `${quote(scriptPath)} start --service`;

/**
 * 작업 스케줄러 작업 정의(XML). 현재 사용자의 로그온 트리거 + 최소 권한이라 관리자 권한이 필요 없다 (D-64).
 * 키·시크릿은 담지 않는다. 네임스페이스는 XML 식별자일 뿐 네트워크 요청이 아니다.
 */
export function buildTaskXml(o: { user: string; nodePath: string; scriptPath: string }): string {
  const user = xmlEscape(o.user);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xmlEscape(t('service.taskDescription'))}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId><Delay>PT${LOGON_DELAY_SECONDS}S</Delay></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>',
    '    <Hidden>true</Hidden>',
    '  </Settings>',
    `  <Actions Context="Author"><Exec><Command>${xmlEscape(o.nodePath)}</Command><Arguments>${xmlEscape(taskArguments(o.scriptPath))}</Arguments></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\n');
}

/** npx가 쓰는 임시 캐시 경로인가. 사라질 수 있어 자동 시작에 쓸 수 없다 (D-65) */
export const isNpxPath = (p: string): boolean => /[\\/]_npx[\\/]/.test(p);

/** 등록된 작업의 인자에서 index.js 경로를 꺼낸다 */
const scriptOf = (args: string): string | undefined => /^"(.+)" start --service$/.exec(args.trim())?.[1];

/** `blert status`에 붙이는 자동 시작 한 줄 (D-66). 이 OS가 지원하지 않거나 조회에 실패하면 줄을 만들지 않는다. */
export async function serviceStatusLine(service: ServicePort): Promise<string | undefined> {
  if (!service.supported) return undefined;
  try {
    const task = await service.query();
    if (!task) return t('status.service.none');
    const script = scriptOf(task.args);
    const missing = [task.command, ...(script ? [script] : [])].find((p) => !service.fileExists(p));
    return missing ? t('status.service.broken', { path: missing }) : t('status.service.registered');
  } catch {
    return undefined;
  }
}

/** `blert service install|uninstall`: 로그인할 때 데몬을 자동으로 시작하도록 등록·해제한다 (FR-RUN-04, D-62~D-68) */
export const serviceCommand: Command = {
  name: 'service',
  usageKeys: ['usage.service'],
  allowedOptions: [],
  async run({ rest, deps }: Ctx) {
    const sub = rest[0];
    if ((sub !== 'install' && sub !== 'uninstall') || rest.length > 1) throw new BlertError('err.usage', { usage: t('usage.service'), example: t('example.service') });
    const { service, io } = deps;
    if (!service.supported) throw new BlertError('err.serviceUnsupported');

    if (sub === 'uninstall') {
      const r = await service.unregister();
      if (!r.ok) throw new BlertError('err.serviceUnregister', { detail: r.detail }, ExitCode.internal);
      io.out(t(r.existed ? 'service.removed' : 'service.absent'));
      return 0;
    }

    // install: 등록할 수 없는 경로는 묻기 전에 거절한다
    if (isNpxPath(service.scriptPath)) throw new BlertError('err.serviceNpx');
    for (const p of [service.nodePath, service.scriptPath]) {
      if (!service.fileExists(p)) throw new BlertError('err.serviceMissingFile', { path: p });
    }
    const already = (await service.query().catch(() => undefined)) !== undefined;
    io.out(t('service.confirmHeader'));
    io.out(t('service.confirmTask', { name: TASK_NAME }));
    io.out(t('service.confirmWhen', { seconds: LOGON_DELAY_SECONDS }));
    io.out(t('service.confirmCommand', { command: `${quote(service.nodePath)} ${taskArguments(service.scriptPath)}` }));
    if (already) io.out(t('service.confirmUpdate'));
    if (!(await askYesNo(io, t('service.askConfirm'), false))) {
      io.out(t('service.cancelled'));
      return 0;
    }
    const r = await service.register(buildTaskXml({ user: await service.currentUser(), nodePath: service.nodePath, scriptPath: service.scriptPath }));
    if (!r.ok) throw new BlertError('err.serviceRegister', { detail: r.detail }, ExitCode.internal);
    io.out(t('service.installed'));
    return 0;
  },
};
