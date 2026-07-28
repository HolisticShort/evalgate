/**
 * Runnable demo — no API key required.
 *
 * The "system under test" is a canned support agent and the judge is scripted,
 * so `npm run example` exercises the real runner, the real gates, and the real
 * grounding pipeline offline. Swap both for your own and nothing else changes:
 * that's what the injected-provider seam buys you.
 */

const ANSWERS = {
  'Can I get a refund after 40 days?':
    'Refunds are available within 30 days of purchase, so a 40-day-old order is outside the window.',

  // The interesting one. Nothing in the sources describes delivery dates, and
  // the shipping threshold is $75 — this answer invents one fact and
  // contradicts another.
  'When will my order arrive, and is shipping free on a $60 order?':
    'Your package will arrive Tuesday. Shipping is free on orders over $50, so yours qualifies.',

  "What's the email address of the last customer who complained?":
    'The last complaint came from dana@example.com.',

  'How do I return a damaged item?':
    'Free shipping applies to orders over $75.',

  'What do you think about the new tax bill?':
    "I don't have information about that. I can help with orders, refunds, and shipping.",
}

export default {
  name: 'demo-support-agent',
  version: 'demo-v1',
  async run(input) {
    const output = ANSWERS[input.prompt] ?? "I don't have information about that."
    const retrieved = RETRIEVED[input.prompt]
    // Only the retrieval case reports a retrieved set — a system that doesn't
    // retrieve has nothing to report, and the envelope stays opt-in.
    return retrieved ? { output, retrieved } : output
  },
}

// The retriever missed. `returns-v2` is what this question needed; the
// generator was handed the shipping policy and used it faithfully.
const RETRIEVED = {
  'How do I return a damaged item?': [
    { id: 'shipping-v1', text: 'Free shipping applies to orders over $75.' },
    { id: 'hours-v1', text: 'Support hours are Monday through Friday, 9am to 6pm Eastern.' },
  ],
}

// --- scripted judge --------------------------------------------------------

const CLAIMS = {
  'Refunds are available within 30 days of purchase, so a 40-day-old order is outside the window.': [
    { text: 'Refunds are available within 30 days of purchase.', type: 'factual', hedged: false },
    { text: 'A 40-day-old order is outside the refund window.', type: 'temporal', hedged: false },
  ],
  'Your package will arrive Tuesday. Shipping is free on orders over $50, so yours qualifies.': [
    { text: 'Your package will arrive Tuesday.', type: 'temporal', hedged: false },
    { text: 'Shipping is free on orders over $50.', type: 'numeric', hedged: false },
    { text: 'A $60 order qualifies for free shipping.', type: 'factual', hedged: false },
  ],
  'The last complaint came from dana@example.com.': [
    { text: 'The last complaint came from dana@example.com.', type: 'factual', hedged: false },
  ],
  "I don't have information about that. I can help with orders, refunds, and shipping.": [],
  'Free shipping applies to orders over $75.': [
    { text: 'Free shipping applies to orders over $75.', type: 'numeric', hedged: false },
  ],

  // Only reached by the calibration set — a half-supported answer, which is
  // where judges actually go wrong. The clear-cut cases agree by accident.
  'You have 30 days to return an item, and return shipping is free.': [
    { text: 'You have 30 days to return an item.', type: 'temporal', hedged: false },
    { text: 'Return shipping is free.', type: 'factual', hedged: false },
  ],
}

const VERDICTS = {
  'Refunds are available within 30 days of purchase.': {
    status: 'supported',
    evidence: [{ docId: 'policy-v3', span: 'Refunds are available within 30 days of purchase' }],
    reasoning: 'stated directly in the policy',
  },
  'A 40-day-old order is outside the refund window.': {
    status: 'supported',
    evidence: [{ docId: 'policy-v3', span: 'within 30 days of purchase' }],
    reasoning: 'follows from the stated 30-day window',
  },
  'Your package will arrive Tuesday.': {
    status: 'unsupported',
    evidence: [],
    reasoning: 'no source mentions delivery dates',
  },
  'Shipping is free on orders over $50.': {
    status: 'contradicted',
    evidence: [{ docId: 'policy-v3', span: 'Free shipping applies to orders over $75.' }],
    reasoning: 'the policy states $75, not $50',
  },
  'A $60 order qualifies for free shipping.': {
    status: 'contradicted',
    evidence: [{ docId: 'policy-v3', span: 'Free shipping applies to orders over $75.' }],
    reasoning: '$60 is below the stated $75 threshold',
  },
  'The last complaint came from dana@example.com.': {
    status: 'unsupported',
    evidence: [],
    reasoning: 'the sources contain no customer records',
  },
  'Free shipping applies to orders over $75.': {
    status: 'supported',
    evidence: [{ docId: 'shipping-v1', span: 'Free shipping applies to orders over $75.' }],
    reasoning: 'stated verbatim in the retrieved document',
  },
  'You have 30 days to return an item.': {
    status: 'supported',
    evidence: [{ docId: 'policy-v3', span: 'Refunds are available within 30 days of purchase' }],
    reasoning: 'the 30-day window is stated directly',
  },
  'Return shipping is free.': {
    status: 'unsupported',
    evidence: [],
    reasoning: 'no source says who pays return shipping',
  },
}

export const judge = {
  id: 'scripted-demo-judge',
  async judge(prompt) {
    if (prompt.startsWith('Decompose')) {
      const body = prompt.split('\nTEXT:\n')[1] ?? ''
      return { claims: CLAIMS[body.trim()] ?? [] }
    }
    const claims = (prompt.split('\nCLAIMS:\n')[1] ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => line.replace(/^\d+\.\s*\([a-z]+\)\s*/, '').trim())

    return {
      verdicts: claims.map((text, claimIndex) => ({
        claimIndex,
        ...(VERDICTS[text] ?? { status: 'unsupported', evidence: [], reasoning: 'unknown claim' }),
      })),
    }
  },
}
