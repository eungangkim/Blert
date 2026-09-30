import { describe, expect, it } from 'vitest';
import { Logger, mask } from '../../src/shared/logger.js';
import { EventBus } from '../../src/shared/bus.js';

describe('shared', () => {
  it('NFR-SEC-01 키 형태 문자열은 로그에 남기지 않는다', () => {
    const lines: string[] = [];
    const log = new Logger({ write: (l) => lines.push(l) }, 'info', () => 0);
    log.info('x', 'apiKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd 실패');
    log.error('x', '-----BEGIN PRIVATE KEY-----\nMC4CAQ\n-----END PRIVATE KEY-----');
    expect(lines.join('\n')).not.toMatch(/ABCDEFGHIJ|MC4CAQ/);
    expect(mask('BTCUSDT 70000')).toBe('BTCUSDT 70000');
  });

  it('로그 레벨 미만은 기록하지 않는다', () => {
    const lines: string[] = [];
    const log = new Logger({ write: (l) => lines.push(l) }, 'info', () => 0);
    log.debug('x', 'hidden');
    log.info('x', 'shown');
    expect(lines).toHaveLength(1);
  });

  it('이벤트 버스는 타입별 구독자에게만 전달한다', () => {
    const bus = new EventBus();
    const got: number[] = [];
    bus.on('market.funding', (e) => got.push(e.rate));
    bus.emit({ type: 'market.funding', ts: 't', symbol: 'BTCUSDT', rate: 0.1, nextFundingTime: 't' });
    bus.emit({ type: 'rules.changed', ts: 't', ruleIds: [1] });
    expect(got).toEqual([0.1]);
  });
});
