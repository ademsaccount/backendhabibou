import { env } from '../config/env';
import { logger } from './logger';

/**
 * Envoi d'emails transactionnels via l'API HTTP Mailjet Send v3.1
 * (POST https://api.mailjet.com/v3.1/send).
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

const MAILJET_API_URL = 'https://api.mailjet.com/v3.1/send';
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

/** Variables Mailjet manquantes (noms uniquement, jamais les valeurs). */
function missingMailjetVariables(): string[] {
  return [
    { key: 'MAILJET_API_KEY', value: env.MAILJET_API_KEY },
    { key: 'MAILJET_SECRET_KEY', value: env.MAILJET_SECRET_KEY },
    { key: 'MAILJET_SENDER_EMAIL', value: env.MAILJET_SENDER_EMAIL },
    { key: 'MAILJET_SENDER_NAME', value: env.MAILJET_SENDER_NAME },
  ]
    .filter((entry) => !entry.value.trim())
    .map((entry) => entry.key);
}

/** true si les quatre variables Mailjet necessaires sont presentes. */
export function isMailConfigured(): boolean {
  return missingMailjetVariables().length === 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Message d'erreur Mailjet (code + message), jamais la cle ni le corps envoye. */
function mailjetErrorDetail(body: unknown): string {
  const details: string[] = [];

  const push = (code: unknown, message: unknown) => {
    const safeCode = typeof code === 'string' ? code : '';
    const safeMessage = typeof message === 'string' ? message : '';
    const detail = [safeCode, safeMessage].filter(Boolean).join(' ');
    if (detail) details.push(detail);
  };

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    push(record.ErrorCode, record.ErrorMessage);

    if (Array.isArray(record.Errors)) {
      for (const item of record.Errors) {
        if (item && typeof item === 'object') {
          const error = item as Record<string, unknown>;
          push(error.ErrorCode, error.ErrorMessage);
        }
      }
    }
  }

  return details.join('; ');
}

function mailjetErrorMessage(
  status: number,
  body: unknown,
  messageStatus?: string,
): string {
  const detail = mailjetErrorDetail(body);
  const parts = [
    messageStatus ? `status=${messageStatus}` : '',
    detail,
  ].filter(Boolean);
  return parts.length ? `mailjet ${status}: ${parts.join(' ')}` : `mailjet ${status}`;
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
 * POST vers l'API Mailjet. Lance une erreur si le statut HTTP est hors 2xx,
 * si Mailjet renvoie un statut de message autre que « success », ou si la
 * requete echoue / depasse le delai : l'appelant transforme cela en
 * MAIL_UNAVAILABLE (ou en fallback dev). Journalise le statut et le message
 * d'erreur Mailjet — jamais la cle, jamais le code.
 */
async function sendMailjetMail(opts: {
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
}): Promise<void> {
  const missing = missingMailjetVariables();
  if (missing.length > 0) {
    throw new Error(`mailjet non configure: variables manquantes ${missing.join(', ')}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    // Basic auth : MAILJET_API_KEY (public) en utilisateur, MAILJET_SECRET_KEY
    // (privee) en mot de passe. Le header n'est jamais journalise.
    const authorization = Buffer.from(
      `${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`,
      'utf8',
    ).toString('base64');

    const response = await fetch(MAILJET_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${authorization}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: {
              Email: env.MAILJET_SENDER_EMAIL,
              Name: env.MAILJET_SENDER_NAME,
            },
            To: [{ Email: opts.to }],
            Subject: opts.subject,
            TextPart: opts.textContent,
            HTMLPart: opts.htmlContent,
          },
        ],
      }),
      signal: controller.signal,
    });

    // Reponse lue pour le diagnostic uniquement : ni la cle ni le code n'y
    // figurent, mais on ne logge que le statut et le message d'erreur Mailjet.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const messages =
      body && typeof body === 'object'
        ? (body as { Messages?: unknown }).Messages
        : undefined;
    const firstMessage = Array.isArray(messages) ? messages[0] : undefined;
    const messageStatus =
      firstMessage && typeof firstMessage === 'object'
        ? (firstMessage as { Status?: unknown }).Status
        : undefined;
    const safeMessageStatus =
      typeof messageStatus === 'string' ? messageStatus : undefined;

    if (!response.ok) {
      const detail = mailjetErrorMessage(response.status, body, safeMessageStatus);
      logger.error('mail', `echec d'envoi ${detail}`);
      throw new Error(detail);
    }

    // Mailjet peut repondre 200 avec un statut d'erreur par message.
    if (safeMessageStatus !== 'success') {
      const detail = mailjetErrorMessage(
        response.status,
        body,
        safeMessageStatus ?? 'invalid response',
      );
      logger.error('mail', `echec d'envoi ${detail}`);
      throw new Error(detail);
    }

    logger.info('mail', `email sent status=${response.status}`);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { name?: unknown }).name === 'AbortError'
    ) {
      logger.error('mail', `echec d'envoi timeout=${SEND_TIMEOUT_MS}ms`);
      throw new Error(`mailjet timeout apres ${SEND_TIMEOUT_MS}ms`);
    }
    // Relance telle quelle (le message ne contient jamais la cle ni le code).
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envoie le code de reinitialisation. Le code n'apparait que dans l'email :
 * ni dans les logs, ni dans la reponse HTTP (sauf fallback dev sans Mailjet).
 */
export async function sendPasswordResetCode(
  to: string,
  code: string,
  locale?: string | null,
): Promise<void> {
  const mail = renderCodeEmail(COPY_RESET[normalizeLocale(locale)], code, env.PASSWORD_RESET_TTL_MIN);
  await sendMailjetMail({ to, ...mail });
}

/**
 * Envoie le code de verification d'inscription. Meme regles que la
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
  await sendMailjetMail({ to, ...mail });
}
