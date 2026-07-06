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
  });
  return {
    name: 'smtp',
    async send(msg) {
      await transport.sendMail({
        from: `Rate Pirate <${config.ALERT_EMAIL_FROM}>`,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
    },
  };
}

function resendSender(config: Config): EmailSender {
  const resend = new Resend(config.RESEND_API_KEY);
  return {
    name: 'resend',
    async send(msg) {
      const { error } = await resend.emails.send({
        from: `Rate Pirate <${config.ALERT_EMAIL_FROM}>`,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
      if (error) throw new Error(`resend: ${error.name} ${error.message}`);
    },
  };
}
