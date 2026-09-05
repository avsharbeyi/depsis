import { describe, expect, it } from 'vitest';

import { endOfEvent, endedTitle } from './Console.js';

/**
 * Konsol oturumunun neden bittiği.
 *
 * BU TESTİN VAR OLMA NEDENİ tek bir cümle: ekran her kapanışa "Oturum kapandı (boşta kalma
 * süresi)" diyordu. `exit` yazıp kabuğu kendi kapatan yönetici de, konsol servisi bir hata
 * bildirdiğinde de aynı cümleyi okuyor; birincisi kendi yaptığı şeyi zaman aşımı sanıyor,
 * ikincisi sunucunun yazdığı sebebi hiç görmüyordu.
 */
describe('endOfEvent', () => {
  it('reads the shell exit code out of the server event', () => {
    expect(endOfEvent('exit', '{"code":0}')).toEqual({ reason: 'exit', code: 0 });
    expect(endOfEvent('exit', '{"code":130}')).toEqual({ reason: 'exit', code: 130 });
  });

  it('keeps "the shell closed" even when the body cannot be read', () => {
    // Çıkış kodu ayrıntı; kabuğun kapandığı bilgisi ayrıntı değil.
    expect(endOfEvent('exit', 'bozuk gövde')).toEqual({ reason: 'exit', code: null });
    expect(endOfEvent('exit', undefined)).toEqual({ reason: 'exit', code: null });
  });

  it('carries the message the console service sent', () => {
    expect(endOfEvent('error', '{"message":"kabuk başlatılamadı"}')).toEqual({
      reason: 'error',
      message: 'kabuk başlatılamadı',
    });
  });

  it('never leaves an error without a sentence', () => {
    expect(endOfEvent('error', '{}')).toEqual({
      reason: 'error',
      message: 'Konsol servisi oturumu sonlandırdı.',
    });
  });
});

describe('endedTitle', () => {
  it('does not call a shell the user closed an idle timeout', () => {
    expect(endedTitle({ reason: 'exit', code: 0 })).toBe('Kabuk kapandı');
    expect(endedTitle({ reason: 'exit', code: null })).toBe('Kabuk kapandı');
  });

  it('shows a non-zero exit code, which is the reason someone reads this line', () => {
    expect(endedTitle({ reason: 'exit', code: 130 })).toBe('Kabuk kapandı (çıkış kodu 130)');
  });

  it('keeps the idle sentence for a stream that just stopped answering', () => {
    // Sebep gerçekten bilinmiyorsa boşta kalma süresi hâlâ en olası açıklama.
    expect(endedTitle({ reason: 'lost' })).toBe('Oturum kapandı (boşta kalma süresi)');
  });

  it('separates a service fault from both', () => {
    expect(endedTitle({ reason: 'error', message: 'kabuk başlatılamadı' })).toBe('Oturum kesildi');
  });
});
