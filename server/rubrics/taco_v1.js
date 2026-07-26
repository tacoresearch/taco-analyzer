/**
 * Taco rubric, version 1. Mirrors TacoResearch_RubricV1.md.
 *
 * This file is the single source of truth for the survey: the form renderer,
 * the server-side validator, the scoring math, and the dashboard labels all
 * read from it. Nothing about the rubric is hardcoded anywhere else.
 *
 * Adding a future rubric (business, non-taco items) means adding a sibling
 * module with this same shape and registering it in ./index.js. It does not
 * mean a database migration.
 *
 * Section scope:
 *   'visit' — answered once per survey (per trip to the venue)
 *   'item'  — answered once per menu item being scored
 *
 * `scored: true` marks the sections whose metrics average into the headline
 * taste score. Everything else is recorded but deliberately kept out of it.
 */

/** @type {import('./index.js').Rubric} */
export const tacoV1 = {
  key: 'taco_v1',
  version: 1,
  label: 'Taco Rubric v1',
  itemNoun: 'taco',
  itemNounPlural: 'tacos',
  blurb:
    'Score the taco as food first. Temperature and value are recorded alongside the ' +
    'taste score, never inside it, so a great recipe served cold still reports its true quality.',

  /** Fields describing the visit itself. Stored as columns on `surveys`. */
  visitFields: [
    {
      key: 'business_name',
      column: 'business_name',
      label: 'Business or location name',
      type: 'text',
      required: true,
      maxLength: 160,
      autocomplete: 'organization',
      hint: 'The name on the sign. Truck, stand, restaurant, or stall.',
    },
    {
      key: 'state',
      column: 'state',
      label: 'State',
      type: 'state',
      required: true,
      hint: null,
    },
    {
      key: 'town',
      column: 'town',
      label: 'Town or city',
      type: 'text',
      required: true,
      maxLength: 120,
      autocomplete: 'address-level2',
      hint: null,
    },
    {
      key: 'visited_on',
      column: 'visited_on',
      label: 'Date of visit',
      type: 'date',
      required: true,
      hint: 'Defaults to today.',
    },
  ],

  /** Fields describing the specific menu item. Stored as columns on `survey_items`. */
  itemFields: [
    {
      key: 'item_name',
      column: 'item_name',
      label: 'Menu item name',
      type: 'text',
      required: true,
      maxLength: 160,
      hint: 'Exactly as the menu writes it, e.g. "Taco de Carne Asada".',
    },
    {
      key: 'price_cents',
      column: 'price_cents',
      label: 'Menu price',
      type: 'money',
      required: true,
      min: 0,
      max: 100000, // $1,000.00 — a generous ceiling that still catches typos
      hint: 'The listed price, before tax and tip.',
    },
    {
      key: 'qty',
      column: 'qty',
      label: 'Tacos included at that price',
      type: 'integer',
      required: true,
      min: 1,
      max: 100,
      hint: 'How many tacos that price buys. Enter 1 for a single taco.',
    },
  ],

  sections: [
    {
      key: 'taste',
      scope: 'item',
      scored: true,
      label: 'Taco Taste Score',
      blurb:
        'Six core metrics judging the taco as food. Nothing about price or temperature ' +
        'touches this score.',
      scale: { min: 1, max: 5, step: 0.5 },
      metrics: [
        {
          key: 'filling_flavor',
          label: 'Filling flavor',
          anchors: {
            1: 'Bland, off, or poor-quality protein/main. Little going on.',
            3: 'Tasty, competently cooked, recognizable and satisfying.',
            5: 'Distinct, memorable, clearly excellent sourcing or technique.',
          },
        },
        {
          key: 'seasoning_balance',
          label: 'Seasoning balance',
          anchors: {
            1: 'Under- or over-salted; flat, or one note dominates harshly.',
            3: 'Well-balanced salt, acid, heat, and fat; nothing off.',
            5: 'Precise balance that makes the whole bite sing.',
          },
        },
        {
          key: 'salsa_sauce',
          label: 'Salsa / sauce',
          anchors: {
            1: 'Missing when needed, watery, or clashes with the taco.',
            3: 'Good salsa that complements the build.',
            5: 'Standout sauce that elevates the entire taco.',
          },
        },
        {
          key: 'texture',
          label: 'Texture',
          anchors: {
            1: 'Soggy, mushy, or one-note; no contrast.',
            3: 'Pleasant mix of textures; nothing unpleasant.',
            5: 'Excellent contrast; every bite has structure and interest.',
          },
        },
        {
          key: 'tortilla',
          label: 'Tortilla',
          anchors: {
            1: 'Stale, gummy, or falls apart immediately.',
            3: 'Fresh, holds together, good flavor.',
            5: 'Exceptional; fresh-made character, structurally perfect.',
          },
        },
        {
          key: 'harmony',
          label: 'Harmony',
          anchors: {
            1: 'Feels like separate parts; nothing coheres.',
            3: 'Works as one unified bite.',
            5: 'Greater than the sum of parts; a complete idea.',
          },
        },
      ],
    },

    {
      key: 'context',
      scope: 'item',
      scored: false,
      label: 'Context factors',
      blurb:
        'Recorded and displayed as their own stats. Serving temp is an execution variable; ' +
        'value is an economics variable. Neither enters the taste score.',
      scale: { min: 1, max: 5, step: 0.5 },
      metrics: [
        {
          key: 'serving_temp',
          label: 'Serving temp',
          anchors: {
            1: 'Cold or lukewarm when it should be hot; execution failure.',
            3: 'Served at a good, appropriate temperature.',
            5: 'Perfect temperature, clearly fresh off the line.',
          },
        },
        {
          key: 'value',
          label: 'Value',
          anchors: {
            1: 'Overpriced for the quality and portion given.',
            3: 'Fair price for what you get.',
            5: 'Excellent quality-to-price; a genuine deal.',
          },
        },
      ],
    },

    {
      key: 'observer',
      scope: 'visit',
      scored: false,
      label: 'Observer variables',
      blurb:
        'These describe the reviewer, not the taco. Logged as calibration data to detect ' +
        'and correct bias. They never enter the score.',
      scale: { min: 1, max: 5, step: 1 },
      metrics: [
        {
          key: 'hunger',
          label: 'Hunger',
          anchors: {
            1: "Not really hungry; just something to do.",
            2: 'Snackish.',
            3: 'I could eat.',
            4: 'Hungry enough to eat a horse.',
            5: 'So hungry it hurts.',
          },
        },
        {
          key: 'emotional_state',
          label: 'Emotional state',
          anchors: {
            1: 'Not great.',
            2: 'Been better.',
            3: "It's fine.",
            4: "It's a good day.",
            5: 'Having my best day.',
          },
        },
        {
          key: 'distance_from_home',
          label: 'Distance from home',
          anchors: {
            1: "Nowhere I'll be again soon.",
            2: 'Far from home, but a familiar area.',
            3: 'In the area occasionally.',
            4: 'I pass through frequently.',
            5: 'I live here.',
          },
        },
      ],
    },
  ],

  /** Free-text tail, optional by design: everything else on the form is required. */
  notesField: {
    key: 'notes',
    column: 'notes',
    label: 'Notes',
    type: 'textarea',
    required: false,
    maxLength: 4000,
    hint: 'Anything the rubric does not capture. Optional.',
  },
};

export default tacoV1;
