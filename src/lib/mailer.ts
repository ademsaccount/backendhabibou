import { env } from '../config/env';
import { logger } from './logger';

/**
 * Envoi d'emails transactionnels via l'API HTTP Brevo
 * (POST https://api.brevo.com/v3/smtp/email).
 *
 * L'API HTTP remplace SMTP : les services Render (plan gratuit) bloquent les
 * ports sortants 25/465/587. Aucune dependance externe (fetch natif).
 *
 * Deux emails partagent le meme gabarit « code a 6 chiffres » :
 * reinitialisation de mot de passe et verification d'inscription.
 *
 * La configuration est optionnelle : si elle est absente, les routes
 * renvoient le code uniquement en developpement (jamais en production).
 * Aucune cle API, aucun code ni mot de passe n'est journalise.
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
/** Ne jamais bloquer une requete HTTP trop longtemps sur une API lente. */
const SEND_TIMEOUT_MS = 10_000;

type MailLocale = 'fr' | 'en' | 'aeb';

type MailCopy = {
  subject: string;
  intro: string;
  codeLabel: string;
  expiry: (minutes: number) => string;
  ignore: string;
  signature: string;
};

const COPY_RESET: Record<MailLocale, MailCopy> = {
  fr: {
    subject: 'Habichou — Code de réinitialisation',
    intro: 'Voici ton code pour réinitialiser ton mot de passe Habichou :',
    codeLabel: 'Code de réinitialisation',
    expiry: (minutes) => `Ce code expire dans ${minutes} minutes.`,
    ignore: "Si tu n'es pas à l'origine de cette demande, ignore simplement cet email.",
    signature: "L'équipe Habichou",
  },
  en: {
    subject: 'Habichou — Password reset code',
    intro: 'Here is your code to reset your Habichou password:',
    codeLabel: 'Reset code',
    expiry: (minutes) => `This code expires in ${minutes} minutes.`,
    ignore: "If you didn't request this, you can safely ignore this email.",
    signature: 'The Habichou team',
  },
  aeb: {
    subject: 'Habichou — كود تعويض كلمة السرّ',
    intro: 'هذا هو الكود باش تعوّض كلمة السرّ متاع Habichou:',
    codeLabel: 'كود التعويض',
    expiry: (minutes) => `الكود هذا ينتهي بعد ${minutes} دقيقة.`,
    ignore: 'إذا ما طلبتش هذا، تجاهل الإيميل هذا برك.',
    signature: 'فريق Habichou',
  },
};

const COPY_VERIFY: Record<MailLocale, MailCopy> = {
  fr: {
    subject: 'Habichou — Code de vérification',
    intro: 'Voici ton code pour vérifier ton adresse email Habichou :',
    codeLabel: 'Code de vérification',
    expiry: (minutes) => `Ce code expire dans ${minutes} minutes.`,
    ignore: "Si tu n'es pas à l'origine de cette demande, ignore simplement cet email.",
    signature: "L'équipe Habichou",
  },
  en: {
    subject: 'Habichou — Verification code',
    intro: 'Here is your code to verify your Habichou email address:',
    codeLabel: 'Verification code',
    expiry: (minutes) => `This code expires in ${minutes} minutes.`,
    ignore: "If you didn't request this, you can safely ignore this email.",
    signature: 'The Habichou team',
  },
  aeb: {
    subject: 'Habichou — كود تأكيد الإيميل',
    intro: 'هذا هو الكود باش تأكّد من الإيميل متاعك في Habichou:',
    codeLabel: 'كود التأكيد',
    expiry: (minutes) => `الكود هذا ينتهي بعد ${minutes} دقيقة.`,
    ignore: 'إذا ما طلبتش هذا، تجاهل الإيميل هذا برك.',
    signature: 'فريق Habichou',
  },
};

function normalizeLocale(locale?: string | null): MailLocale {
  return locale === 'en' || locale === 'aeb' ? locale : 'fr';
}

/** true si les variables Brevo necessaires sont presentes. */
export function isMailConfigured(): boolean {
  return Boolean(env.BREVO_API_KEY && env.MAIL_FROM_EMAIL);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Message d'erreur Brevo (code + message), jamais la cle ni le corps envoye. */
function brevoErrorMessage(status: number, body: unknown): string {
  let detail = '';
  if (body && typeof body === 'object') {
    const record = body as { code?: unknown; message?: unknown };
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message : '';
    detail = [code, message].filter(Boolean).join(' ');
  }
  return detail ? `brevo ${status}: ${detail}` : `brevo ${status}`;
}

/** Gabarit commun des emails « code a 6 chiffres » (HTML + texte brut). */
function renderCodeEmail(
  copy: MailCopy,
  code: string,
  minutes: number,
): { subject: string; textContent: string; htmlContent: string } {
  const safeCode = escapeHtml(code);

  const textContent = [
    copy.intro,
    '',
    `${copy.codeLabel}: ${code}`,
    '',
    copy.expiry(minutes),
    copy.ignore,
    '',
    copy.signature,
  ].join('\n');

  const htmlContent = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1E1E1E">
      <h1 style="font-size:20px;margin:0 0 16px">Habichou</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px">${escapeHtml(copy.intro)}</p>
      <div style="background:#F9C211;border-radius:16px;padding:20px;text-align:center">
        <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1E1E1E">${escapeHtml(copy.codeLabel)}</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:8px;margin-top:8px;color:#1E1E1E">${safeCode}</div>
      </div>
      <p style="font-size:13px;line-height:1.5;margin:20px 0 0;color:#6B6B6B">${escapeHtml(copy.expiry(minutes))}</p>
      <p style="font-size:13px;line-height:1.5;margin:8px 0 0;color:#6B6B6B">${escapeHtml(copy.ignore)}</p>
      <p style="font-size:13px;line-height:1.5;margin:24px 0 0;color:#6B6B6B">${escapeHtml(copy.signature)}</p>
    </div>
  `;

  return { subject: copy.subject, textContent, htmlContent };
}

/**
 * POST vers l'API Brevo. Lance une erreur si le statut est hors 2xx ou si la
 * requete echoue / depasse le delai : l'appelant transforme cela en
 * MAIL_UNAVAILABLE (ou en fallback dev). Journalise le statut et le message
 * d'erreur Brevo — jamais la cle, jamais le code.
 */
async function sendBrevoMail(opts: {
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.MAIL_FROM_NAME, email: env.MAIL_FROM_EMAIL },
        to: [{ email: opts.to }],
        subject: opts.subject,
        htmlContent: opts.htmlContent,
        textContent: opts.textContent,
      }),
      signal: controller.signal,
    });

    // Reponse lue pour le diagnostic uniquement : ni la cle ni le code n'y
    // figurent, mais on ne logge que le statut et le message d'erreur Brevo.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const detail = brevoErrorMessage(response.status, body);
      logger.error('mail', `echec d'envoi ${detail}`);
      throw new Error(detail);
    }

    logger.info('mail', `email sent status=${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error('mail', `echec d'envoi timeout=${SEND_TIMEOUT_MS}ms`);
      throw new Error(`brevo timeout apres ${SEND_TIMEOUT_MS}ms`);
    }
    // Relance telle quelle (le message ne contient jamais la cle ni le code).
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envoie le code de reinitialisation. Le code n'apparait que dans l'email :
 * ni dans les logs, ni dans la reponse HTTP (sauf fallback dev sans Brevo).
 */
export async function sendPasswordResetCode(
  to: string,
  code: string,
  locale?: string | null,
): Promise<void> {
  const mail = renderCodeEmail(COPY_RESET[normalizeLocale(locale)], code, env.PASSWORD_RESET_TTL_MIN);
  await sendBrevoMail({ to, ...mail });
}

/**
 * Envoie le code de verification d'inscription. Meme regles que le
 * reinitialisation : le code n'apparait que dans l'email.
 */
export async function sendEmailVerificationCode(
  to: string,
  code: string,
  locale?: string | null,
): Promise<void> {
  const mail = renderCodeEmail(
    COPY_VERIFY[normalizeLocale(locale)],
    code,
    env.EMAIL_VERIFICATION_TTL_MIN,
  );
  await sendBrevoMail({ to, ...mail });
}
