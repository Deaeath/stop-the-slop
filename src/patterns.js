/* Stop The Slop - comment language patterns. */
globalThis.STS = globalThis.STS || {};
(function (STS) {
  'use strict';

  // STRONG: a commenter is actually accusing the video of being machine-made.
  // These carry almost all of the weight.
  const STRONG = [
    /\bai[\s-]?(?:generated|generation|gen(?:ned)?|made|slop)\b/,
    /\b(?:generated|made|created|written|narrated|voiced|drawn|animated|produced)\s+(?:by|with|using)\s+(?:an?\s+)?ai\b/,
    /\bai\s+(?:slop|garbage|trash|crap|shit|spam|bot|voice(?:over)?|narrat\w+|script|art|image|images|photo|photos|video|videos|content|channel|junk|nonsense|bro|farm)\b/,
    /\b(?:this|it|that|the video|the script)\s+(?:is|was)\s+(?:so\s+|clearly\s+|obviously\s+|just\s+|100%\s+|totally\s+)?ai\b/,
    /\b(?:is|are)\s+(?:this|these|that|you)\s+(?:an?\s+)?(?:ai|bot|chat\s?gpt)\b/,
    /\bsounds?\s+like\s+(?:an?\s+)?(?:ai|robot|bot|tts|computer)\b/,
    /\blooks?\s+like\s+(?:an?\s+)?ai\b/,
    /\bai\s+(?:wrote|made|did|read|narrated)\b/,
    /\bchat\s?gpt\s+(?:wrote|made|script|generated|slop)\b/,
    /\b(?:eleven\s?labs|midjourney|stable\s?diffusion|dall[\s-]?e|runway\s?ml|heygen|synthesia|invideo|pictory|kling\s?ai)\b/,
    /\b(?:tts|text[\s-]?to[\s-]?speech)\b/,
    /\brobot(?:ic)?\s+voice\b/,
    /\b(?:fake|synthetic|artificial|computer)\s+(?:voice|narrator|narration)\b/,
    /\bnot\s+(?:a\s+)?real\s+(?:voice|person|human|narrator)\b/,
    /\bslop\b/,
    /\bsix\s+fingers?\b/,
    /\bhands? (?:are|look) (?:wrong|melted|messed up)\b/
  ];

  // WEAK: suggestive, but innocent on its own. Contributes a fraction of a strong hit.
  const WEAK = [
    /\bai\b/,
    /\bchat\s?gpt\b/,
    /\bbot\b/,
    /\bgenerated\b/,
    /\bsoulless\b/,
    /\bmispronounc\w+/,
    /\bstock footage\b/,
    /\bwho (?:is|are) watching this\b/
  ];

  // The video is legitimately ABOUT AI, so commenters will say "AI" constantly.
  // When this fires, AI-mention scoring is heavily discounted.
  const TOPIC = [
    /\bai\b/, /\ba\.i\.\b/, /\bartificial intelligence\b/, /\bchat\s?gpt\b/,
    /\bllm\b/, /\bmachine learning\b/, /\bneural net/, /\bgpt-?\d/,
    /\bmidjourney\b/, /\bstable diffusion\b/, /\bcopilot\b/, /\bclaude\b/,
    /\bgemini\b/, /\bopenai\b/, /\banthropic\b/, /\bdeep\s?learning\b/,
    /\bprompt engineer/, /\bstable ?diffusion\b/, /\bsora\b/, /\bveo ?\d\b/
  ];

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compileExtra(sources) {
    const out = [];
    for (const raw of sources || []) {
      const s = String(raw || '').trim();
      if (!s) continue;
      try { out.push(new RegExp(s, 'i')); } catch (_) { /* user typo, ignore */ }
    }
    return out;
  }

  /**
   * Classify one comment.
   * @returns {{strong:boolean, weak:boolean, hit:string|null}}
   */
  function analyze(text, extraStrong) {
    const t = norm(text);
    if (!t) return { strong: false, weak: false, hit: null };
    const strongList = extraStrong && extraStrong.length
      ? STRONG.concat(compileExtra(extraStrong))
      : STRONG;
    for (const re of strongList) {
      const m = t.match(re);
      if (m) return { strong: true, weak: true, hit: m[0] };
    }
    for (const re of WEAK) {
      const m = t.match(re);
      if (m) return { strong: false, weak: true, hit: m[0] };
    }
    return { strong: false, weak: false, hit: null };
  }

  /** Is the video itself about AI? (suppresses false positives) */
  function isAiTopic(text) {
    const t = norm(text);
    if (!t) return false;
    return TOPIC.some((re) => re.test(t));
  }

  STS.patterns = { analyze, isAiTopic, norm, STRONG, WEAK, TOPIC };
})(globalThis.STS);
