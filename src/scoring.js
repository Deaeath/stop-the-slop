/* Stop The Slop - scoring. Pure functions, no I/O. */
globalThis.STS = globalThis.STS || {};
(function (STS) {
  'use strict';

  const DEFAULTS = {
    slopAt: 65,          // score >= this -> "SLOP"
    suspectAt: 40,       // score >= this -> "SUSPECT"
    minViews: 1200,      // below this, the ratio signal is noise
    // Expected comment ratio falls as an audience grows: a 3k-view video from a
    // real creator gets ~1.5% comments, a 5M-view one ~0.15%. Measured against
    // Veritasium / MKBHD / Lofi Girl. Scoring the raw ratio against one flat
    // threshold cannot separate slop from legit - the distributions overlap.
    baseRatio: 0.015,    // expected comments/views at baseViews
    baseViews: 3000,
    ratioDecay: 0.31,    // how fast expectation decays with audience size
    deficitClean: 2,     // up to 2x below expectation is normal -> 0 points
    deficitSlop: 20,     // 20x below expectation -> 100 points
    commentSample: 40,   // how many comments to read per video
    reinforce: 0.3,      // how much the weaker signal adds to the stronger one
    disabledScore: 60,   // comments turned off entirely (suspect, not damning on its own)
    topicGuard: 0.3,     // multiplier when the video is *about* AI
    scanDepth: 6,        // videos per channel scan
    scanFeed: true,      // score every channel that scrolls into view
    scanShorts: false,   // Shorts ratios aren't comparable to long-form
    maxFeedScans: 60,    // per page load, so a long scroll can't hammer youtube
    scanDelayMs: 500,    // gap between feed scans
    highlightLinks: true,// paint channel links wherever they appear
    colorTitles: true,   // tint the title of a flagged video (never dim it)
    autoScan: true,
    autoUpdateCheck: true,  // poll GitHub releases every 6h
    extraStrong: []
  };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /**
   * Comment-to-view ratio -> 0..100 slop points, log-interpolated.
   * Returns null when there isn't enough data to say anything.
   */
  /** What a real channel of this size would get. */
  function expectedRatio(views, s) {
    return s.baseRatio * Math.pow(Math.max(views, 1) / s.baseViews, -s.ratioDecay);
  }

  /** How many times below expectation this video's comment ratio sits. */
  function deficit(comments, views, s) {
    const actual = comments / views;
    if (!(actual > 0)) return Infinity;
    return expectedRatio(views, s) / actual;
  }

  function ratioPoints(comments, views, s) {
    if (!Number.isFinite(views) || views < s.minViews) return null;
    if (!Number.isFinite(comments)) return null;
    const d = deficit(comments, views, s);
    if (d <= s.deficitClean) return 0;
    if (d >= s.deficitSlop) return 100;
    const t = (Math.log(d) - Math.log(s.deficitClean)) /
              (Math.log(s.deficitSlop) - Math.log(s.deficitClean));
    return Math.round(clamp(t, 0, 1) * 100);
  }

  /**
   * What the commenters are saying -> 0..100 slop points.
   */
  function commentPoints(comments, aiTopic, s) {
    const n = comments.length;
    if (!n) return { points: null, strong: 0, weak: 0, evidence: [] };

    let strong = 0, weak = 0;
    const evidence = [];
    for (const c of comments) {
      const r = STS.patterns.analyze(c, s.extraStrong);
      if (r.strong) {
        strong++;
        if (evidence.length < 5) {
          evidence.push({ hit: r.hit, text: String(c).slice(0, 180) });
        }
      } else if (r.weak) {
        weak++;
      }
    }

    // 25% of sampled comments openly calling it AI = maxed out.
    let points = (strong / n) * 400 + (weak / n) * 35;
    if (aiTopic) points *= s.topicGuard;
    return { points: Math.round(clamp(points, 0, 100)), strong, weak, evidence };
  }

  function verdictFor(total, s) {
    if (total == null) return 'unknown';
    if (total >= s.slopAt) return 'slop';
    if (total >= s.suspectAt) return 'suspect';
    return 'ok';
  }

  /**
   * Score a single video.
   * data: {views, commentCount, commentsDisabled, comments:[string], title, description, channelName}
   */
  function scoreVideo(data, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const notes = [];

    const aiTopic = STS.patterns.isAiTopic(
      [data.title, data.description, data.channelName].filter(Boolean).join(' \n ')
    );

    let rPts;
    if (data.commentsDisabled) {
      rPts = s.disabledScore;
      notes.push('Comments are turned off.');
    } else {
      rPts = ratioPoints(data.commentCount, data.views, s);
      if (rPts == null) {
        notes.push(
          Number.isFinite(data.views) && data.views < s.minViews
            ? `Only ${fmt(data.views)} views - too few to judge the ratio.`
            : 'Could not read view/comment counts.'
        );
      } else {
        const pct = (data.commentCount / data.views) * 100;
        const exp = expectedRatio(data.views, s) * 100;
        const d = deficit(data.commentCount, data.views, s);
        notes.push(
          `${fmt(data.commentCount)} comments on ${fmt(data.views)} views (${pct.toFixed(3)}%).`
        );
        notes.push(
          d >= s.deficitClean
            ? `A real channel this size averages about ${exp.toFixed(2)}% - this sits ${d.toFixed(1)}x below.`
            : `Normal for this size (about ${exp.toFixed(2)}% expected).`
        );
      }
    }

    const cm = commentPoints(data.comments || [], aiTopic, s);
    cm.sampled = (data.comments || []).length;
    if (cm.points == null) {
      notes.push('No comments were readable.');
    } else {
      notes.push(
        `${cm.strong} of ${(data.comments || []).length} sampled comments call it AI-made.`
      );
      if (aiTopic) notes.push('Video is about AI, so AI mentions are discounted.');
    }

    // Neither signal is symmetric: a dead comment section is damning on its own,
    // and so is a chorus of "this is AI" - but the ABSENCE of either proves nothing.
    // Most people watching slop never comment to say so. So the stronger signal
    // sets the score and the weaker one reinforces it, rather than averaging the
    // two and letting a quiet comment section wash out a damning ratio.
    const present = [rPts, cm.points].filter((v) => v != null);

    // Don't declare anything - clean OR slop - on near-zero evidence.
    const enoughEvidence = rPts != null || cm.sampled >= 8;

    let total = null;
    if (present.length && enoughEvidence) {
      const strongest = Math.max.apply(null, present);
      const weakest = present.length > 1 ? Math.min.apply(null, present) : 0;
      total = Math.round(clamp(strongest + s.reinforce * weakest, 0, 100));
      if (present.length > 1 && strongest >= 50 && weakest >= 30) {
        notes.push('Both signals agree - dead comment section AND people calling it AI.');
      }
    }

    return {
      total,
      verdict: verdictFor(total, s),
      ratioPoints: rPts,
      commentPoints: cm.points,
      strong: cm.strong,
      weak: cm.weak,
      sampled: (data.comments || []).length,
      aiTopic,
      evidence: cm.evidence,
      notes
    };
  }

  /**
   * Roll several per-video scores into one channel verdict.
   * videos: [{total, strong, evidence, ...}]
   */
  function aggregate(videos, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const scored = (videos || []).filter((v) => v && Number.isFinite(v.total));
    if (!scored.length) return { total: null, verdict: 'unknown', n: 0, evidence: [] };

    // The worst video, not the mean. Averaging let a channel with one blatant
    // 98 read as "suspect" because its other uploads were quieter - which is
    // exactly backwards: a channel that ships slop is a slop channel.
    const total = Math.max.apply(null, scored.map((v) => v.total));
    const evidence = [];
    for (const v of scored) {
      for (const e of v.evidence || []) {
        if (evidence.length < 6 && !evidence.some((x) => x.text === e.text)) evidence.push(e);
      }
    }
    return {
      total,
      verdict: verdictFor(total, s),
      n: scored.length,
      worst: Math.max(...scored.map((v) => v.total)),
      evidence
    };
  }

  function fmt(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  STS.score = { DEFAULTS, scoreVideo, aggregate, verdictFor, ratioPoints,
                commentPoints, expectedRatio, deficit, fmt };
})(globalThis.STS);
