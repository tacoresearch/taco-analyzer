# TacoResearch — Taco Scoring Rubric v1

*An anchored, repeatable system for scoring tacos by the scientific method.*

---

## How the score works

Every taco is evaluated across three layers, plus a set of observer variables. Each layer is kept separate on purpose: this isolates variables so a great recipe served cold, or a great taco that is overpriced, still reports its true quality instead of blending into one muddy number.

- **Layer 1 — Taco Taste Score (pure).** Six core metrics judging the taco as food. Nothing about price or temperature touches this score.
- **Layer 2 — Context factors (recorded separately).** Serving temperature and value are logged alongside the taste score, never inside it.
- **Layer 3 — Consistency modifier (activates on re-visit).** Once a taco is tasted more than once, variance across visits adjusts the final score up or down.
- **Observer variables (calibration only).** Hunger, mood, and distance from home describe the reviewer, not the taco. They are logged to detect bias and never enter the score.

All metrics use a **1–5 scale with half-points allowed** (1, 1.5, 2 … 5), giving nine effective levels: simple to score, enough resolution to rank menu items against each other.

---

## Layer 1 — Taco Taste Score

Score each of the six metrics from 1 to 5 using the anchors below. The raw taste score is the average of the six (out of 5).

| Metric | 1 — Poor | 3 — Solid | 5 — Exceptional |
|---|---|---|---|
| **Filling flavor** | Bland, off, or poor-quality protein/main. Little going on. | Tasty, competently cooked, recognizable and satisfying. | Distinct, memorable, clearly excellent sourcing or technique. |
| **Seasoning balance** | Under- or over-salted; flat, or one note dominates harshly. | Well-balanced salt, acid, heat, and fat; nothing off. | Precise balance that makes the whole bite sing. |
| **Salsa / sauce** | Missing when needed, watery, or clashes with the taco. | Good salsa that complements the build. | Standout sauce that elevates the entire taco. |
| **Texture** | Soggy, mushy, or one-note; no contrast. | Pleasant mix of textures; nothing unpleasant. | Excellent contrast; every bite has structure and interest. |
| **Tortilla** | Stale, gummy, or falls apart immediately. | Fresh, holds together, good flavor. | Exceptional; fresh-made character, structurally perfect. |
| **Harmony** | Feels like separate parts; nothing coheres. | Works as one unified bite. | Greater than the sum of parts; a complete idea. |

**Reading the anchors.** The anchors define 1, 3, and 5. Use half-points for the spaces between them: a 4 sits between "solid" and "exceptional," a 2 between "poor" and "solid." Scoring the same anchor the same way every visit is what makes the system repeatable rather than mood-driven.

---

## Layer 2 — Context factors

These are recorded and displayed on the menu-item page as their own stats. They do not enter the taste score. Serving temp is an execution variable (varies per visit); value is an economics variable (varies with pricing and budget). Keeping them separate lets readers filter by what they care about.

| Metric | 1 — Poor | 3 — Solid | 5 — Exceptional |
|---|---|---|---|
| **Serving temp** | Cold or lukewarm when it should be hot; execution failure. | Served at a good, appropriate temperature. | Perfect temperature, clearly fresh off the line. |
| **Value** | Overpriced for the quality and portion given. | Fair price for what you get. | Excellent quality-to-price; a genuine deal. |

---

## Observer variables

These describe the reviewer, not the taco. Hunger, mood, and distance from home all quietly push taste scores around: food tastes better when you are starving, when you are having a great day, or when you are somewhere new and novel. They are logged as calibration data to detect and correct that bias, not to reward or penalize the taco. **They never enter the score.**

Recorded per visit on the same 1–5 scale:

| Variable | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| **Hunger** | Not really hungry; just something to do. | Snackish. | I could eat. | Hungry enough to eat a horse. | So hungry it hurts. |
| **Emotional state** | Not great. | Been better. | It's fine. | It's a good day. | Having my best day. |
| **Distance from home** | Nowhere I'll be again soon. | Far from home, but a familiar area. | In the area occasionally. | I pass through frequently. | I live here. |

*How to use them:* once enough reviews exist, check whether your taste scores correlate with these variables. If tacos eaten at hunger 5 consistently outscore the rest, that is a bias to correct for, not a fact about the tacos. Distance is especially useful paired with consistency: a taco you rate highly but scored at distance 1 (nowhere you will return) is a flag that the novelty of the trip may be inflating it.

---

## Layer 3 — Consistency modifier

Consistency rewards replication, the core of the scientific method. It stays dormant until a taco has been tasted at least twice, then adjusts the final score based on how stable the taste score is across visits.

- **Visit 1:** no consistency data. The taste score stands alone.
- **Visit 2+:** compare taste scores across visits. Low variance (reliably good) grants a small bonus; high variance (a gamble) applies a small penalty.
- **Suggested cap:** up to ±5% of the taste score, scaled by number of visits, so trust is earned over time.

This gives a concrete reason to re-visit and makes "consistently excellent" score higher than "great once, unknown since."

---

## The final Taco Research Score

For any menu item, the displayed profile is:

- **Taco Taste Score** (out of 5) — the pure six-metric average.
- **Serving Temp** (out of 5) — recorded separately.
- **Value** (out of 5) — recorded separately.
- **Consistency modifier** — applied once re-visited.

The exact weighting that combines these into the single headline Taco Research Score is intentionally left open until real data exists across enough tacos. Lock the weights in once you can see how the metrics actually spread, rather than guessing up front. Publishing the weights (and letting readers recompute with their own priorities) keeps the whole system transparent and honest about where judgment enters.

---

## Scientific-method checklist

- Fixed rubric with anchored descriptions per metric — makes scores repeatable.
- Re-visits report a mean and note variance — replication built in via the consistency modifier.
- Isolate variables — taste, execution (temp), and economics (value) never blend.
- Control for the observer — hunger, mood, and distance are logged to catch bias in the instrument (you).
- Transparent weights — readers can recompute the headline score themselves.
- Optional benchmark control — order the same base taco (e.g. a plain carne asada) across places as a calibration point for your palate.
