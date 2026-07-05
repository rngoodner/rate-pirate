import { Resend } from 'resend';
import type { Config } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailSender {
  readonly name: 'resend' | 'console';
  send(msg: EmailMessage): Promise<void>;
}

export function createEmailSender(config: Config): EmailSender {
  if (config.RESEND_API_KEY) {
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
  // Dev fallback: log instead of sending.
  return {
    name: 'console',
    async send(msg) {
      console.log(`[email:console] to=${msg.to} subject=${msg.subject}`);
    },
  };
}
