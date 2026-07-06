import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import type { Config } from '../config.js';

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
}

export interface EmailSender {
  readonly name: 'smtp' | 'resend' | 'console';
  send(msg: EmailMessage): Promise<void>;
}

/** Precedence: SMTP (e.g. Proton Bridge) → Resend → console (dev log). */
export function createEmailSender(config: Config): EmailSender {
  if (config.SMTP_HOST) return smtpSender(config);
  if (config.RESEND_API_KEY) return resendSender(config);
  return {
    name: 'console',
    async send(msg) {
      console.log(`[email:console] to=${msg.to.join(', ')} subject=${msg.subject}`);
    },
  };
}

function smtpSender(config: Config): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? (config.SMTP_SECURE ? 465 : 587),
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE, // STARTTLS when not implicit-TLS
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined,
    tls: config.SMTP_ALLOW_INVALID_CERT ? { rejectUnauthorized: false } : undefined,
    // Proton Bridge's failure mode is hung-but-accepting-connections; nodemailer's
    // defaults (up to 10 min socket timeout) would stall the scan batch that
    // awaits each alert send. Fail fast instead — sends retry on later scans.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    name: 'smtp',
    async send(msg) {
      // One message per recipient: addresses stay private from each other, and
      // one rejected address can't sink delivery to the rest.
      const failures: string[] = [];
      for (const to of msg.to) {
        const mail = {
          from: `Rate Pirate <${config.ALERT_EMAIL_FROM}>`,
          to,
          subject: msg.subject,
          html: msg.html,
        };
        try {
          await transport.sendMail(mail);
        } catch {
          // One quick retry covers Bridge's transient post-idle hiccups.
          await new Promise((r) => setTimeout(r, 5_000));
          try {
            await transport.sendMail(mail);
          } catch (err) {
            failures.push(`${to}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (failures.length === msg.to.length) {
        throw new Error(`smtp: all sends failed — ${failures.join('; ')}`);
      }
      if (failures.length > 0) console.error(`smtp: partial send failure — ${failures.join('; ')}`);
    },
  };
}

function resendSender(config: Config): EmailSender {
  const resend = new Resend(config.RESEND_API_KEY);
  return {
    name: 'resend',
    async send(msg) {
      const failures: string[] = [];
      for (const to of msg.to) {
        const { error } = await resend.emails.send({
          from: `Rate Pirate <${config.ALERT_EMAIL_FROM}>`,
          to,
          subject: msg.subject,
          html: msg.html,
        });
        if (error) failures.push(`${to}: ${error.name} ${error.message}`);
      }
      if (failures.length === msg.to.length && msg.to.length > 0) {
        throw new Error(`resend: all sends failed — ${failures.join('; ')}`);
      }
      if (failures.length > 0) console.error(`resend: partial send failure — ${failures.join('; ')}`);
    },
  };
}
