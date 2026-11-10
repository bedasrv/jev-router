// UP-16 (warslop SPEC; owner delegation 2026-11-07, board task router-free-pool-no-jev): a free turn is served
// without asking Jev, and the UP-2a word lists may still lower its effort. The app decides UP-2a from the guest's
// own words before the call (warslop src/easy.ts), but the router cannot read that code, so the small-talk list is
// ported here: greetings, thanks, acknowledgements and "who are you", plus the filler words people add.
//
// Only the small-talk half is ported. UP-2a's other half routes a summary of pasted text to the free model, but a
// summary is real work over up to 24,000 characters: on the free pool it keeps the default item's thinking instead
// of the lighter item's. The list is deliberately conservative, like the app's: when unsure it says no and the
// default applies, so a wrong guess costs one default free turn (which is free), never a bad answer to a hard ask.
const CHAT = [
  "h+a+l+o+", "h+a+i+", "h+i+", "h+e+l+l+o+", "h+e+y+", "h+e+i+", "p+", "permisi", "selamat (?:pagi|siang|sore|malam)", "pagi", "siang", "sore", "malam", "assalamu'?alaikum", "salam",
  "apa kabar", "gimana kabar(?:mu|nya)?", "bagaimana kabar(?:mu|nya)?", "how are you", "lagi apa", "lagi ngapain", "ada orang", "tes+t?", "ping",
  "makasih", "terima kasih", "thanks?", "thank you", "thx", "trims", "oke+", "ok+", "okay", "sip", "siap", "mantap", "keren", "bagus", "nice", "wk(?:wk)+", "ha(?:ha)+", "he(?:he)+", "lol",
  "bye", "dadah", "sampai jumpa", "sampai nanti", "siapa kamu", "kamu siapa", "kamu bisa apa", "namamu siapa", "who are you", "what can you do",
].join("|");
const FILLER = "(?:kak|kakak|ya+|dong|nih|deh|sih|bos|bro|sis|min|admin|bot|ai|ku|mu|banget|banyak|sekali)";
const WORD = `(?:${CHAT}|${FILLER})`;
const SMALL_TALK = new RegExp(`^${WORD}(?: ${WORD})*$`);

const strip = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\p{Extended_Pictographic}/gu, " ").replace(/\s+/g, " ").trim();

/** UP-2a's small-talk arm: a short message that is only greetings, thanks, an acknowledgement or "who are you". */
export function isSmallTalk(text) {
  const t = strip(text);
  if (!t || t.length > 60) return false;
  const parts = t.split(/[.,!?;:…\n]+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.length <= 4 && parts.every((p) => SMALL_TALK.test(p));
}
