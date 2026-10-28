export type Lang = 'en' | 'fr' | 'ar';
export const LANGS: Lang[] = ['en', 'fr', 'ar'];
export type Vars = Record<string, string | number>;

export function isLang(x: unknown): x is Lang {
  return typeof x === 'string' && (LANGS as string[]).includes(x);
}

/**
 * Messages the box sends to the partner (Telegram / webhook) and writes to the activity log.
 * Placeholders look like {name}. Every key must exist in every language (enforced by a test).
 * The French and Arabic texts were written by an AI: please have a native speaker review them.
 */
export const MESSAGES: Record<Lang, Record<string, string>> = {
  en: {
    req_pause: 'Someone asked to pause ALL protection. It starts in {delay} (at {time}) unless you cancel.{durNote}',
    req_exempt: 'Someone asked to stop filtering the device {device}. It starts in {delay} (at {time}) unless you cancel.{durNote}',
    dur_note: 'Requested duration: {dur}.',
    applied_pause: 'Protection is now PAUSED for all devices.{untilNote}',
    applied_exempt: 'The device {device} is no longer filtered.{untilNote}',
    until_note: 'Resumes automatically at {time}.',
    expired: 'The approved change has ended. Protection is back on.',
    cancelled: 'Cancelled: {what}. Protection is on.',
    what_pause: 'pause all protection',
    what_exempt: 'stop filtering {device}',
    tamper_off: 'TAMPER: protection was switched off outside an approved window. It was switched back on.',
    repaused: 'Protection was re-paused to match an approved window.',
    tamper_exempt: 'TAMPER: an unapproved exemption for {device} was removed.',
    new_device: 'New device on the network: {device}. It is filtered by default.',
    restored: 'Protection restored manually.',
    setup_done: 'Setup finished. Protection is active.',
    restarted: 'The box just (re)started.',
    key_msg: 'Your partner key: {key}\nKeep it safe and do NOT share it with the person being protected. You need it to approve early or to change settings.',
    test_alert: 'Test alert: your partner notifications are working.',
    btn_cancel: 'Cancel request',
    btn_restore: 'Restore protection now',
    state_on: 'ON',
    state_paused: 'PAUSED',
    bot_status: 'Protection is {state}.',
    no_changes: 'No pending or active changes.',
    ch_pending: '{what} — starts at {time}',
    ch_active: '{what} — active now',
    bot_cancelled: 'Cancelled.',
    bot_not_found: 'Nothing to cancel (already ended?).',
    bot_help: 'Commands: /status, /restore',
  },
  fr: {
    req_pause: "Quelqu'un a demandé de suspendre TOUTE la protection. Elle démarre dans {delay} (à {time}) sauf si vous annulez.{durNote}",
    req_exempt: "Quelqu'un a demandé d'arrêter le filtrage de l'appareil {device}. Cela démarre dans {delay} (à {time}) sauf si vous annulez.{durNote}",
    dur_note: 'Durée demandée : {dur}.',
    applied_pause: 'La protection est maintenant SUSPENDUE pour tous les appareils.{untilNote}',
    applied_exempt: "L'appareil {device} n'est plus filtré.{untilNote}",
    until_note: 'Reprise automatique à {time}.',
    expired: 'Le changement approuvé est terminé. La protection est de nouveau active.',
    cancelled: 'Annulé : {what}. La protection est active.',
    what_pause: 'suspendre toute la protection',
    what_exempt: 'arrêter le filtrage de {device}',
    tamper_off: "SABOTAGE : la protection a été désactivée en dehors d'une période approuvée. Elle a été réactivée.",
    repaused: "La protection a été remise en pause pour correspondre à une période approuvée.",
    tamper_exempt: "SABOTAGE : une exemption non approuvée pour {device} a été supprimée.",
    new_device: 'Nouvel appareil sur le réseau : {device}. Il est filtré par défaut.',
    restored: 'Protection rétablie manuellement.',
    setup_done: 'Configuration terminée. La protection est active.',
    restarted: 'Le boîtier vient de (re)démarrer.',
    key_msg: 'Votre clé partenaire : {key}\nGardez-la en lieu sûr et ne la partagez PAS avec la personne protégée. Elle sert à approuver plus tôt ou à modifier les réglages.',
    test_alert: 'Alerte de test : vos notifications partenaire fonctionnent.',
    btn_cancel: 'Annuler la demande',
    btn_restore: 'Rétablir la protection',
    state_on: 'ACTIVE',
    state_paused: 'SUSPENDUE',
    bot_status: 'La protection est {state}.',
    no_changes: 'Aucun changement en attente ou actif.',
    ch_pending: '{what} — démarre à {time}',
    ch_active: '{what} — actif maintenant',
    bot_cancelled: 'Annulé.',
    bot_not_found: 'Rien à annuler (déjà terminé ?).',
    bot_help: 'Commandes : /status, /restore',
  },
  ar: {
    req_pause: 'طلب شخص ما إيقاف الحماية عن جميع الأجهزة. سيبدأ خلال {delay} (عند {time}) ما لم تقم بالإلغاء.{durNote}',
    req_exempt: 'طلب شخص ما إيقاف الفلترة عن الجهاز {device}. سيبدأ خلال {delay} (عند {time}) ما لم تقم بالإلغاء.{durNote}',
    dur_note: 'المدة المطلوبة: {dur}.',
    applied_pause: 'تم إيقاف الحماية مؤقتًا عن جميع الأجهزة.{untilNote}',
    applied_exempt: 'الجهاز {device} لم يعد مفلترًا.{untilNote}',
    until_note: 'ستُستأنف تلقائيًا عند {time}.',
    expired: 'انتهى التغيير المعتمد. عادت الحماية للعمل.',
    cancelled: 'تم الإلغاء: {what}. الحماية تعمل.',
    what_pause: 'إيقاف الحماية عن الجميع',
    what_exempt: 'إيقاف الفلترة عن {device}',
    tamper_off: 'تلاعب: تم إيقاف الحماية خارج فترة معتمدة. تمت إعادة تشغيلها.',
    repaused: 'أُعيد إيقاف الحماية لتطابق فترة معتمدة.',
    tamper_exempt: 'تلاعب: تمت إزالة استثناء غير معتمد للجهاز {device}.',
    new_device: 'جهاز جديد على الشبكة: {device}. يتم فلترته افتراضيًا.',
    restored: 'تمت استعادة الحماية يدويًا.',
    setup_done: 'اكتمل الإعداد. الحماية مفعّلة.',
    restarted: 'تم تشغيل الجهاز (أو إعادة تشغيله) للتو.',
    key_msg: 'مفتاح الشريك الخاص بك: {key}\nاحتفظ به في مكان آمن ولا تشاركه مع الشخص الذي تتم حمايته. تحتاجه للموافقة المبكرة أو لتغيير الإعدادات.',
    test_alert: 'تنبيه تجريبي: إشعارات الشريك تعمل.',
    btn_cancel: 'إلغاء الطلب',
    btn_restore: 'استعادة الحماية الآن',
    state_on: 'مفعّلة',
    state_paused: 'متوقفة مؤقتًا',
    bot_status: 'الحماية {state}.',
    no_changes: 'لا توجد تغييرات معلّقة أو نشطة.',
    ch_pending: '{what} — يبدأ عند {time}',
    ch_active: '{what} — نشط الآن',
    bot_cancelled: 'تم الإلغاء.',
    bot_not_found: 'لا شيء للإلغاء (انتهى بالفعل؟).',
    bot_help: 'الأوامر: /status و /restore',
  },
};

export function t(lang: Lang, key: string, vars: Vars = {}): string {
  const tpl = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function fmtDuration(lang: Lang, minutes: number): string {
  const units = { en: ['minute', 'hour', 'day'], fr: ['minute', 'heure', 'jour'], ar: ['دقيقة', 'ساعة', 'يوم'] }[lang];
  const [n, i] = minutes % 1440 === 0 ? [minutes / 1440, 2] : minutes % 60 === 0 ? [minutes / 60, 1] : [minutes, 0];
  const plural = lang !== 'ar' && n > 1 ? 's' : '';
  return `${n} ${units[i]}${plural}`;
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR', ar: 'ar-DZ' };

/** Local time for humans, e.g. "28 Oct, 16:13". Uses the TZ environment variable (set in docker-compose). */
export function fmtTime(ms: number, lang: Lang, tz: string | undefined = process.env.TZ): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat(LOCALES[lang], { ...opts, timeZone: tz || 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(LOCALES[lang], { ...opts, timeZone: 'UTC' }).format(ms);
  }
}
