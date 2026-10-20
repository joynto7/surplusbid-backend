import { env } from '../../config/env';

/**
 * SurplusBid's rules, written once and used twice: as the assistant's system
 * prompt (so Claude answers from policy, not guesses) and as the answer bank
 * for the built-in assistant when no model is configured.
 */
export interface KnowledgeEntry {
  id: string;
  title: string;
  /** Lower-case phrases that signal this topic in a question. */
  keywords: string[];
  answer: string;
  link?: { label: string; href: string };
}

export const KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'deposit',
    title: 'Deposit holds',
    keywords: ['deposit', 'hold', 'authorize', 'authorise', 'pre-auth', 'card hold', 'refundable'],
    answer: `Before your first bid on a lot you authorize a refundable deposit hold of ${env.depositPercent}% of that lot's starting price. It's an authorization on your card, not a charge. If you don't win, the hold is released automatically when the lot closes. If you win, it's captured and applied to your total.`,
    link: { label: 'Deposit FAQ', href: '/faq' },
  },
  {
    id: 'anti-sniping',
    title: 'Anti-sniping',
    keywords: ['snip', 'extend', 'extension', 'last minute', 'final minutes', 'closing time', 'clock'],
    answer:
      'Every lot has anti-sniping protection: a bid placed in the final two minutes pushes the closing time back by two minutes. Bidding only ends after two quiet minutes, so nobody wins by bidding in the last second.',
    link: { label: 'How it works', href: '/how-it-works' },
  },
  {
    id: 'bidding',
    title: 'Placing bids',
    keywords: ['how to bid', 'place a bid', 'minimum bid', 'increment', 'outbid', 'bid amount', 'bidding'],
    answer:
      "The minimum next bid is the current highest bid (or the starting price if there are no bids yet) plus the lot's bid increment. Bids are binding. If someone outbids you, the lot shows up as \"Outbid\" in My bids so you can respond.",
    link: { label: 'Browse live auctions', href: '/lots' },
  },
  {
    id: 'reserve',
    title: 'Reserve prices',
    keywords: ['reserve', 'minimum price', 'hidden price'],
    answer:
      "A reserve is the seller's private minimum. Only the seller sees the amount and whether bidding has reached it.",
  },
  {
    id: 'payment',
    title: 'Paying for a win',
    keywords: ['pay', 'payment', 'balance', 'invoice', 'checkout', 'stripe', 'won', 'win', 'deadline', 'due'],
    answer: `When you win, your deposit is applied and you pay the remaining balance by card through Stripe within ${env.paymentDeadlineHours} hours of the close. Miss the deadline and the deposit is forfeited and the lot passes to the next-highest bidder. Card details go straight to Stripe and never touch SurplusBid's servers.`,
    link: { label: 'Payments in your dashboard', href: '/buyer/payments' },
  },
  {
    id: 'verification',
    title: 'Business verification',
    keywords: ['verify', 'verification', 'verified', 'document', 'registration', 'approve', 'approval'],
    answer:
      "SurplusBid is business-to-business only. After you register, upload a business registration document (PDF, JPG, PNG or WebP, up to 5 MB). An admin usually reviews it within one business day, and you can follow it on the verification status page.",
    link: { label: 'Verification status', href: '/verification-status' },
  },
  {
    id: 'selling',
    title: 'Selling a lot',
    keywords: ['sell', 'list', 'listing', 'seller', 'create lot', 'publish', 'consign', 'liquidate'],
    answer:
      "Verified sellers create a lot in four steps: details, up to five photos, then pricing and schedule (starting price, private reserve, bid increment, open and close times), then review. Drafts can be edited until you publish. The AI listing assistant can draft the description and suggest a starting price from comparable sales.",
    link: { label: 'Register as a seller', href: '/register?role=SELLER' },
  },
  {
    id: 'account',
    title: 'Accounts and sign-in',
    keywords: ['register', 'sign up', 'signup', 'account', 'login', 'log in', 'sign in', 'google', 'password'],
    answer:
      'Create a buyer or seller account with your work email, or continue with Google. Verification comes next. The login page also has one-click demo accounts for an admin, a buyer and a seller.',
    link: { label: 'Create an account', href: '/register' },
  },
  {
    id: 'disputes',
    title: 'Disputes',
    keywords: ['dispute', 'problem', 'not as described', 'damaged', 'refund', 'complaint', 'issue'],
    answer:
      'If something is wrong with a lot you won, open a dispute from your dashboard. Only the winning buyer and the seller can raise one. An admin reviews it and records a resolution.',
    link: { label: 'Help & FAQ', href: '/faq' },
  },
  {
    id: 'shipping',
    title: 'Pickup and shipping',
    keywords: ['ship', 'shipping', 'freight', 'pickup', 'pick up', 'collect', 'collection', 'delivery', 'rigging', 'location'],
    answer:
      "Every lot lists its pickup location. Unless the listing says otherwise, the buyer arranges collection or freight once the balance is paid. For heavy equipment, plan rigging and removal before you bid, and check the seller's notes on loading.",
    link: { label: 'Shipping heavy equipment', href: '/blog/shipping-heavy-equipment-after-you-win' },
  },
  {
    id: 'fees',
    title: 'Fees',
    keywords: ['fee', 'fees', 'commission', 'premium', 'cost to', 'charge', 'pricing'],
    answer:
      "Buyers pay the winning bid. The deposit is part of it, not an extra charge. There's no fee to register, browse or bid.",
  },
  {
    id: 'contact',
    title: 'Contact and support',
    keywords: ['contact', 'support', 'help', 'human', 'email', 'phone', 'talk to'],
    answer:
      'You can reach the SurplusBid team through the contact form or at support@surplusbid.com. We reply within one business day, Monday to Friday.',
    link: { label: 'Contact us', href: '/contact' },
  },
];

export function knowledgeAsPrompt() {
  return KNOWLEDGE.map((k) => `## ${k.title}\n${k.answer}${k.link ? ` (More: ${k.link.href})` : ''}`).join('\n\n');
}

/** Best matching entries for a question, by keyword hits. */
export function matchKnowledge(question: string, max = 2) {
  const text = question.toLowerCase();
  return KNOWLEDGE.map((entry) => ({
    entry,
    score: entry.keywords.reduce((s, k) => s + (text.includes(k) ? k.split(' ').length + 1 : 0), 0),
  }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((m) => m.entry);
}
