// The door's WhatsApp configuration: read from the environment, checked, and turned off with a reason when something is missing.



export interface WhatsappConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  bridgeToken: string;
  /** The owner's number, digits only (WhatsApp's own form, no plus). */
  ownerDigits: string;
  /**
   * The owner's business-scoped user id, when known (WHATSAPP_OWNER_BSUID). WhatsApp leaves the phone number out of a message from someone who has
   * adopted a username and identifies them by this id only; it is also learned by itself from a message that carries both.
   */
  ownerBsuid: string;
  graphVersion: string;
  /** An approved message template (two text variables: the owner's name, the message) for starting a conversation with a friend; "" = none. */
  templateName: string;
  templateLang: string;
  /**
   * Messages to friends from the assistant's own number (the `<send>` tag). Off unless WHATSAPP_FRIEND_MESSAGES=1: WhatsApp's business terms
   * say the Business Platform is for business use and not personal use, and since 2026-01-15 they bar general-purpose AI assistants from it.
   * Off, a request to send becomes a link the owner sends from their own WhatsApp.
   */
  friendMessages: boolean;
  /** An approved template with one text variable (the reminder), for a reminder due when the 24-hour window is closed; "" = none (it waits for the owner's next message). */
  reminderTemplate: string;
}

export const BSUID = /^[A-Za-z0-9.]{8,64}$/;

/** null = off. `problems` says why when the feature was asked for (an access token) but is not complete. */
export function loadWhatsappConfig(env: Record<string, string | undefined>, ownerNumber: string): { config: WhatsappConfig | null; problems: string[] } {
  const accessToken = (env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
  if (!accessToken) return { config: null, problems: [] };
  const problems: string[] = [];
  const need = (key: string, re: RegExp, hint: string): string => {
    const v = (env[key] ?? "").trim();
    if (!re.test(v)) problems.push(`${key} ${hint}`);
    return v;
  };
  const phoneNumberId = need("WHATSAPP_PHONE_NUMBER_ID", /^\d{6,20}$/, "must be the numeric phone number id from the Meta dashboard");
  const appSecret = need("WHATSAPP_APP_SECRET", /^[A-Za-z0-9]{16,64}$/, "must be the app secret from the Meta dashboard (letters and digits)");
  const verifyToken = need("WHATSAPP_VERIFY_TOKEN", /^[A-Za-z0-9_-]{16,}$/, "must be 16+ letters, digits, - or _ (the same text you give Meta as the verify token)");
  const bridgeToken = need("ASSISTANT_BRIDGE_TOKEN", /^[A-Za-z0-9_-]{32,}$/, "must be 32+ letters, digits, - or _ (openssl rand -hex 24)");
  const ownerDigits = (env.WHATSAPP_OWNER_NUMBER ?? ownerNumber).replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(ownerDigits)) problems.push("the owner's number is missing (PERSONAL_OWNER_NUMBER or WHATSAPP_OWNER_NUMBER)");
  const ownerBsuid = (env.WHATSAPP_OWNER_BSUID ?? "").trim();
  if (ownerBsuid && !BSUID.test(ownerBsuid)) problems.push("WHATSAPP_OWNER_BSUID must look like the user id in Meta's webhook (for example US.13491208655302741918)");
  // The version in Meta's current getting-started guide; WHATSAPP_GRAPH_VERSION moves it when Meta retires it.
  const graphVersion = (env.WHATSAPP_GRAPH_VERSION ?? "v23.0").trim();
  if (!/^v\d{1,2}\.\d$/.test(graphVersion)) problems.push("WHATSAPP_GRAPH_VERSION must look like v23.0");
  const templateName = (env.WHATSAPP_TEMPLATE_NAME ?? "").trim();
  if (templateName && !/^[a-z0-9_]{1,200}$/.test(templateName)) problems.push("WHATSAPP_TEMPLATE_NAME must be the template's name in WhatsApp Manager (lowercase letters, digits and _)");
  // The language Meta approved the templates in (both the notice and the friend template use it). English by default, like the template
  // the guide suggests (pako_notice); a template approved in another language works by naming it here (a Spanish one: es).
  const templateLang = (env.WHATSAPP_TEMPLATE_LANG ?? "en").trim();
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLang)) problems.push("WHATSAPP_TEMPLATE_LANG must look like en or en_US");
  const friendMessages = (env.WHATSAPP_FRIEND_MESSAGES ?? "").trim() === "1";
  const reminderTemplate = (env.WHATSAPP_REMINDER_TEMPLATE ?? "").trim();
  if (reminderTemplate && !/^[a-z0-9_]{1,200}$/.test(reminderTemplate)) problems.push("WHATSAPP_REMINDER_TEMPLATE must be the template's name in WhatsApp Manager (lowercase letters, digits and _)");
  if (problems.length) return { config: null, problems };
  return { config: { accessToken, phoneNumberId, appSecret, verifyToken, bridgeToken, ownerDigits, ownerBsuid, graphVersion, templateName, templateLang, friendMessages, reminderTemplate }, problems };
}
