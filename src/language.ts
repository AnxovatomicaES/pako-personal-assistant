// Which language the owner writes in, guessed from the small words every sentence carries (articles, pronouns, prepositions, a few chat
// words). The chat itself needs no guess: Claude answers each message in its own language. The guess is for what Pako writes when the owner
// has not just written (the summary of an email or a meeting), so it only counts when it is clear: a short message, a mix of languages or
// one with too few of those words says nothing, and the language known before stays. A line that leans to another language however little
// (a "¿Me lo traduces?" over a pasted English text) makes a mix; and the door keeps a new language only once two clear messages say it.
//
// A word shared by several languages ("de", "la", "que") counts for each of them by a share (a half, a third...), so the words only one
// language has decide.

/** The languages it can tell apart. Anything else is never guessed. */
const DETECTED = ["es", "en", "ca", "fr", "de", "it", "pt", "nl"] as const;
type Code = (typeof DETECTED)[number];

const WORDS: Record<Code, string> = {
  es: "el la los las lo un una unos unas y o pero que qué de del al a en con por para sin sobre entre hasta desde es son está esta están "
    + "estás estas estoy estamos soy eres somos fue era ser estar hay he has ha hemos han había me te se nos os le les mi mis tu tus su sus yo tú "
    + "él ella ellos ellas nosotros vosotros usted ustedes este esto estos ese eso esa esos aquí ahí allí muy más mas también tambien pues porque "
    + "cuando cuándo como cómo donde dónde quién quien cuál ya sí si no nada algo todo todos toda todas otro otra mismo hoy mañana ayer ahora "
    + "luego después despues antes bien mal vale gracias hola claro bueno buena mucho mucha muchos muchas poco tengo tienes tiene tenemos puedo "
    + "puedes puede quiero quieres voy vas va vamos van hace hacer haces dime dile oye mira da dos ver ir sé día algún alguna alguien favor "
    + "noche cosa solo tanto mes aqui ahi alli lunes martes miércoles jueves viernes sábado domingo",
  en: "the a an and or but of to in on at for with from by about as into than then is are was were be been being am do does did have has had "
    + "will would can could should may might must i you he she it we they me him her us them my your his its our their this that these those "
    + "there here what when where who why how which not no yes so if just also too very all some any more much many get got go going know think "
    + "want need please thanks thank hello hi hey today tomorrow yesterday now don't can't won't i'm it's that's what's you're i've i'll let's "
    + "isn't doesn't didn't there's we're they're he's she's i'd you'll we'll wasn't aren't couldn't wouldn't haven't sorry "
    + "monday tuesday wednesday thursday friday saturday sunday",
  ca: "el la els les l' un una uns unes i o però que què de d' del dels al als a en amb per sense sobre entre fins des és són està estàs estic "
    + "estem estan sóc soc ets som sou era ser fer fa faig fas he has ha hem heu han hi ho em et es ens us li m' t' s' n' meu meva teu teva seu "
    + "seva nostre nostra jo tu ell ella ells elles nosaltres vosaltres aquest aquesta aquests aquestes això aixo aquí allà molt molta molts "
    + "moltes més també "
    + "tambe perquè perque quan com on qui quin quina ja sí si no res gens tot tots tota totes altre altra avui demà dema ahir ara després abans "
    + "bé doncs gràcies hola vull vols vol puc pots pot tinc tens té tenim vaig vas va anem van digues mira bon bona cap mai sempre sé cosa "
    + "dilluns dimarts dimecres dijous divendres dissabte diumenge",
  fr: "le la les l' un une des du de d' au aux et ou où mais donc car que qu' qui quoi ce c' cet cette ces à a en dans sur sous avec pour par "
    + "sans chez entre est sont suis es êtes sommes était être ai as avons avez ont avoir fait faire je j' tu il elle on nous vous ils elles me "
    + "m' te t' se s' lui leur mon ma mes ton ta tes son sa ses notre votre ça cela ici là très plus aussi bien ne n' pas non oui si rien tout "
    + "tous toute toutes aujourd'hui demain hier maintenant après avant merci bonjour salut peux peut veux veut vais va allons dis alors encore "
    + "déjà comme comment quand pourquoi y c'est j'ai lundi mardi mercredi jeudi vendredi samedi dimanche",
  de: "der die das den dem des ein eine einen einem einer und oder aber dass daß nicht kein keine ist sind bin bist war waren sein habe hast "
    + "hat haben hatte wird werden kann kannst können muss musst will willst soll ich du er sie es wir ihr mich dich mir dir uns euch ihm ihn "
    + "ihnen mein meine dein deine seine unser mit von zu zum zur bei nach aus auf für über um an am im in ins vom auch noch schon sehr nur mal "
    + "jetzt heute morgen gestern hier da dort was wer wie wo warum wann ja nein doch alles danke dank vielen bitte hallo gut so dann wenn weil "
    + "also diese dieser dieses diesem meinem meinen meiner viel montag dienstag mittwoch donnerstag freitag samstag sonntag",
  it: "il lo la i gli le l' un uno una un' e ed o ma che di del dello della dei degli delle a al allo alla ai agli alle da dal dalla in nel "
    + "nello nella nei nelle con su sul sulla per tra fra è sono sei siamo siete era essere ho hai ha abbiamo avete hanno mi ti si ci vi ne me "
    + "te lui lei noi voi loro io tu mio mia tuo tua suo sua nostro nostra questo questa questi queste quello quella qui qua là molto più anche "
    + "perché perche quando come dove chi cosa già ancora sì no non niente tutto tutti oggi domani ieri adesso ora poi dopo prima bene grazie "
    + "ciao voglio vuoi posso puoi può devo fare fa faccio vado andiamo dimmi allora però solo tanto c' c'è dell' all' nell' sull' dall' "
    + "lunedì martedì mercoledì giovedì venerdì sabato domenica lunedi martedi mercoledi giovedi venerdi",
  pt: "o a os as um uma uns umas e ou mas que de do da dos das em no na nos nas ao aos à às pelo pela pelos pelas com por para sem sobre "
    + "entre até é são está estão estou estás estamos sou somos era foi ser estar tenho tem tens temos têm ter há vai vou vamos me te se lhe "
    + "eu tu você voce vocês ele ela eles elas meu minha teu tua seu sua nosso nossa este esta isto esse essa isso aquilo aqui ali muito "
    + "muita mais também porque quando como onde quem qual já ainda sim não nao sei nada tudo hoje amanhã ontem agora depois antes bem "
    + "obrigado obrigada olá oi pode posso quero fazer faz então entao",
  nl: "de het een en of maar dat die dit deze van voor met op in aan bij uit naar over om tot door is zijn ben bent was waren wordt worden "
    + "heb hebt heeft hebben had kan kun kunt kunnen wil wilt willen moet moeten zal zou ik je jij u hij zij ze wij we jullie mij me mijn jouw "
    + "jou haar ons onze hun hem er hier daar niet geen ook nog al wel heel erg meer veel wat wie waar wanneer waarom hoe ja nee alles niets "
    + "iets vandaag morgen gisteren nu dan als toen dank bedankt hallo hoi graag even "
    + "maandag dinsdag woensdag donderdag vrijdag zaterdag zondag",
};

/** Letters only one of these languages writes: a word that has one counts for it (a name like Begoña too, which the thresholds absorb). */
const MARKS: [RegExp, Code][] = [[/ñ/, "es"], [/[ãõ]/, "pt"], [/ß/, "de"], [/l·l/, "ca"], [/œ/, "fr"]];

const LANGS_OF = new Map<string, Code[]>();
for (const code of DETECTED) for (const w of WORDS[code].split(" ")) LANGS_OF.set(w, [...(LANGS_OF.get(w) ?? []), code]);

/** A word, apostrophes inside it included: "c'est", "don't", "l'home" and "dell'anno" are looked at whole first. */
const WORD = /[\p{L}\p{M}·]+(?:'[\p{L}\p{M}·]+)*/gu;
/**
 * A message says something only with three words or more ("ok", "vale gracias" say nothing), with evidence worth about two words only its
 * language has, and with at least twice the evidence of the next language (less is a mix).
 */
const MIN_WORDS = 3;
const MIN_SCORE = 1.5;
const MARGIN = 2;
/** The least evidence a line needs to lean to a language (half a word only its language has): enough to make a mix, never to decide. */
const LEAN = 0.5;

const languagesOf = (word: string): Code[] => {
  const found = new Set(LANGS_OF.get(word) ?? []);
  for (const [re, code] of MARKS) if (re.test(word)) found.add(code);
  return [...found];
};

/** "l'home" → "l'" and "home"; "c'est" (a whole word of its own) stays as it is. */
const pieces = (token: string): string[] => {
  const cut = token.indexOf("'");
  return cut < 0 || LANGS_OF.has(token) ? [token] : [token.slice(0, cut + 1), token.slice(cut + 1)];
};

type Tally = { words: number; score: Record<Code, number> };

const tally = (part: string): Tally => {
  const score = Object.fromEntries(DETECTED.map((c) => [c, 0])) as Record<Code, number>;
  const tokens = part.match(WORD) ?? [];
  for (const token of tokens) {
    for (const piece of pieces(token)) {
      const langs = languagesOf(piece);
      for (const code of langs) score[code] += 1 / langs.length;
    }
  }
  // ¿ and ¡ open a question or an exclamation only in Spanish.
  if (/[¿¡]/.test(part)) score.es += 1;
  return { words: tokens.length, score };
};

const decide = (t: Tally): Code | null => {
  if (t.words < MIN_WORDS) return null;
  const [first, second] = DETECTED.map((code) => ({ code, score: t.score[code] })).sort((a, b) => b.score - a.score);
  return first!.score >= MIN_SCORE && first!.score >= MARGIN * second!.score ? first!.code : null;
};

/** The language a tally has the most evidence for, however little, when one leads; null with none, or a tie. */
const leanOf = (t: Tally): Code | null => {
  const [first, second] = DETECTED.map((code) => ({ code, score: t.score[code] })).sort((a, b) => b.score - a.score);
  return first!.score >= LEAN && first!.score > second!.score + 1e-9 ? first!.code : null;
};

/**
 * The language of a message the owner wrote, as an ISO 639-1 code, or null when it is not clear (`clear`); and the one it leans to, however
 * little, when one leads (`lean`: a "gracias" leans to Spanish, and says nothing more). Words in quotes are someone else's (single quotes too,
 * when they open and close at a word's edge: "don't" and "l'home" stay), and a link, an address, an @name or a #tag is no language. Each line
 * and sentence is weighed on its own too: one that leans to another language than the whole, even a short one with a shared word or two (a
 * "Me lo traduces?" over a pasted English line), makes the message a mix, and a mix says nothing.
 */
export function readLanguage(text: string): { clear: string | null; lean: string | null } {
  const own = text
    .slice(0, 4000)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/«[^»]*»|"[^"\n]*"|“[^”\n]*”/g, " ")
    .replace(/(^|[\s(\[¿¡])'[^'\n]+'(?=$|[\s)\].,;:!?])/g, "$1 ")
    .replace(/\S+/g, (w) => (/@|:\/\/|^www\.|^#/.test(w) ? " " : w));
  const whole: Tally = { words: 0, score: Object.fromEntries(DETECTED.map((c) => [c, 0])) as Record<Code, number> };
  const parts: Tally[] = [];
  for (const part of own.split(/[\n.!?;:]+/)) {
    const t = tally(part);
    parts.push(t);
    whole.words += t.words;
    for (const code of DETECTED) whole.score[code] += t.score[code];
  }
  const best = decide(whole);
  const leansAway = (t: Tally, code: Code): boolean => {
    const top = Math.max(...DETECTED.map((c) => t.score[c]));
    return top >= LEAN && t.score[code] < top - 1e-9;
  };
  return { clear: best && !parts.some((t) => leansAway(t, best)) ? best : null, lean: leanOf(whole) };
}

/**
 * The language of a message Pako passes on to someone else, Spanish or English: the voice a friend's call is made in. The message is the
 * owner's own words, so it keeps its language even though Pako's fixed texts are English: it is Spanish only when it shows it, with more
 * of Spanish's small words than of English's or, with as many of each (none, usually), a letter or mark Spanish writes ("llegaré tarde";
 * "the café is closed" stays English). Anything else is English. `_ui`, the language of Pako's texts, is always English now; it stays so
 * the callers did not have to change.
 */
export function passedOnLanguage(text: string, _ui: string = "en"): "es" | "en" {
  if (/^[\x00-\x7f]*$/.test(text) && /\b(the|you|and|is|are|to)\b/i.test(text)) return "en";
  const lower = text.normalize("NFC").toLowerCase();
  const { score } = tally(lower.replace(/[’‘`´]/g, "'"));
  if (Math.abs(score.es - score.en) > 1e-9) return score.es > score.en ? "es" : "en";
  return /[áéíóúüñ¿¡]/.test(lower) ? "es" : "en";
}

/** The language of a message the owner wrote (readLanguage's `clear`): an ISO 639-1 code, or null when it is not clear. */
export function detectLanguage(text: string): string | null {
  return readLanguage(text).clear;
}
