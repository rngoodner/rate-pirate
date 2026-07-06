import { describe, expect, it } from 'vitest';
import { parseRecipients, isEmail } from '@rate-pirate/shared';
import { createEmailSender } from '../alerts/email.js';
import { loadConfig } from '../config.js';

describe('parseRecipients', () => {
  it('splits on comma/semicolon/space/newline and trims', () => {
    expect(parseRecipients('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
    expect(parseRecipients('a@x.com;b@y.com')).toEqual(['a@x.com', 'b@y.com']);
    expect(parseRecipients(' a@x.com \n b@y.com ')).toEqual(['a@x.com', 'b@y.com']);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients('  ')).toEqual([]);
  });
});

describe('isEmail', () => {
  it('accepts plausible addresses and rejects junk', () => {
    expect(isEmail('a@x.com')).toBe(true);
    expect(isEmail('ryan.goodner+deals@proton.me')).toBe(true);
    expect(isEmail('nope')).toBe(false);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('a @x.com')).toBe(false);
  });
});

describe('createEmailSender precedence', () => {
  it('prefers SMTP when SMTP_HOST is set', () => {
    const sender = createEmailSender(
      loadConfig({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', RESEND_API_KEY: 're_x' }),
    );
    expect(sender.name).toBe('smtp');
  });

  it('falls back to Resend when only the key is set', () => {
    expect(createEmailSender(loadConfig({ RESEND_API_KEY: 're_x' })).name).toBe('resend');
  });

  it('falls back to console when nothing is configured', () => {
    expect(createEmailSender(loadConfig({})).name).toBe('console');
  });
});
