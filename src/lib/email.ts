/**
 * email.ts — Resend email fallback for contact form
 *
 * Sends an email to ahkedia@gmail.com when a visitor submits
 * the "Ask Akash directly" contact form.
 *
 * Free tier: 100 emails/day via Resend.
 */

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY ?? '');

const AKASH_EMAIL = 'nayankawalkar07@gmail.com';
const FROM_ADDRESS = 'AskAkash <onboarding@resend.dev>'; // Resend sandbox default

export interface ContactEmailPayload {
  visitorName: string;
  visitorEmail: string;
  message: string;
  /** Optional: the question that triggered the fallback */
  originalQuestion?: string;
  sessionId?: string;
}

/**
 * Send a contact-form email to Akash via Resend.
 * Returns the Resend email ID on success, or throws on failure.
 */
export async function sendContactEmail(
  payload: ContactEmailPayload
): Promise<string> {
  const subject = payload.originalQuestion
    ? `AskAkash: "${payload.originalQuestion.slice(0, 60)}…"`
    : `AskAkash: Message from ${payload.visitorName}`;

  const htmlBody = `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a; border-bottom: 2px solid #e5e5e5; padding-bottom: 8px;">
        New message from Ask Akash
      </h2>

      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; font-weight: 600; color: #666; width: 120px;">From</td>
          <td style="padding: 8px 12px;">${escapeHtml(payload.visitorName)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; font-weight: 600; color: #666;">Email</td>
          <td style="padding: 8px 12px;">
            <a href="mailto:${escapeHtml(payload.visitorEmail)}">${escapeHtml(payload.visitorEmail)}</a>
          </td>
        </tr>
        ${payload.originalQuestion
      ? `<tr>
                <td style="padding: 8px 12px; font-weight: 600; color: #666;">Original Q</td>
                <td style="padding: 8px 12px; font-style: italic; color: #444;">
                  "${escapeHtml(payload.originalQuestion)}"
                </td>
              </tr>`
      : ''
    }
        ${payload.sessionId
      ? `<tr>
                <td style="padding: 8px 12px; font-weight: 600; color: #666;">Session</td>
                <td style="padding: 8px 12px; font-family: monospace; font-size: 12px; color: #999;">
                  ${escapeHtml(payload.sessionId)}
                </td>
              </tr>`
      : ''
    }
      </table>

      <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(payload.message)}</p>
      </div>

      <p style="color: #999; font-size: 12px; margin-top: 24px;">
        Sent via AskAkash contact form
      </p>
    </div>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: AKASH_EMAIL,
    replyTo: payload.visitorEmail,
    subject,
    html: htmlBody,
  });

  if (error) {
    console.error('Resend email error:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data?.id ?? 'unknown';
}

/**
 * Check if Resend is configured.
 */
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

// ── Helpers ──────────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
