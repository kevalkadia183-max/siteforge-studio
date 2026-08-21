import OpenAI from "openai";
import type { Receptionist } from "@workspace/db";

// Instantiate fresh per call — no caching
function makeOpenAIClient(): OpenAI {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("OpenAI integration env vars not set");
  }
  return new OpenAI({ baseURL, apiKey });
}

export interface ChatTurn {
  role: "user" | "assistant" | "owner";
  content: string;
}

export interface AiReplyResult {
  reply: string;
  escalate: boolean;
}

const greetingPattern =
  /^\s*(?:good (?:morning|afternoon|evening)|hello|hey|hi|thank you|thanks)[!.?\s]*$/i;

type SafeIntent = "greeting" | "hours" | "service_area" | "contact" | "services";

const highRiskPatterns = [
  /\b(911|ambulance|emergency|fire|flood(?:ed|ing)?|gas leak|immediate danger|police|smoke)\b/i,
  /\b(allerg(?:y|ic)|doctor|health|hospital|injur(?:y|ed)|medical|medication|poison|sick)\b/i,
  /\b(attorney|contract dispute|court|lawsuit|lawyer|legal|liability|regulation|sue|tribunal)\b/i,
  /\b(bank|bill(?:ing)?|charge(?:d|back)?|credit card|deposit|e-?transfer|financ(?:e|ing)|invoice|money|pay(?:ment)?|refund|reimburse)\b/i,
  /\b(complain(?:t|ed)?|damaged|dissatisfied|grievance|manager|poor service|supervisor|unhappy)\b/i,
  /\b(asap|immediately|right away|time[- ]sensitive|urgent|without delay)\b/i,
  /\b(i do not know|i don't know|not certain|not sure|uncertain|unsure)\b/i,
  /[$€£]|\b(amount|ballpark|budget|call[- ]?out|charg\w*|cost\w*|deposit\w*|discount\w*|estimate\w*|fee\w*|financ\w*|gst|hst|how much|installment\w*|payment\w*|pric\w*|quot\w*|rate\w*|tax(?:es)?|total|vat)\b|\b(run me|rough (?:figure|idea)|what(?:'s| is| would be)? the damage)\b/i,
  /\binsurance\b|\bclaims?\b/i,
  /\b(appointment|booking|calendar|reschedul\w*|schedul\w*|time slot|visit)\b/i,
  /\b(today|tomorrow|tonight)\b|\b(?:this|next)\s+(?:morning|afternoon|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(book|cancel|change|confirm|reschedule|schedule)\b.{0,30}\b(appointment|booking|job|service|visit)\b/i,
  /\b(arrange|reserve|set (?:me )?up|sign me up|fit me in|pencil me in|put me down)\b/i,
  /\b(can|could|will|would)\s+you\s+(?:come|send|visit|arrive|get someone out)\b/i,
  /\b(send someone|come by|get someone out)\b.{0,24}\b(today|tomorrow|this week|next week)\b/i,
  /\b(dispatch|send)\b.{0,24}\b(crew|someone|team|technician|worker)\b/i,
  /\b(hire|engage|retain|contract)\b/i,
  /\b(accept|activate|apply|approve|authorize|buy|deactivate|decline|enroll|file|issue|order|process|purchas\w*|register|reject|renew|submit|subscribe)\w*\b/i,
  /\b(can|could|may|would)\s+i\s+(?:get|have|obtain|receive)\b/i,
  /\b(?:i|we)\s+(?:need|want|would like|'d like)\b/i,
  /\bsign (?:me )?up\b/i,
  /\b(begin|order|request|start)\b.{0,24}\b(job|maintenance|repair|service|work)\b/i,
  /\b(cancel|change|modify|update)\b.{0,24}\b(account|address|appointment|booking|contact|email|job|order|phone|service|visit)\b/i,
  /\b(deliver|forward|send)\b.{0,30}\b(details|email|information|message)\b/i,
  /\b(available|availability|opening)\b.{0,25}\b(today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(call|email|text)\s+me\b|\bsend me\b/i,
  /\b(accept|authorize|charge|collect|process|send)\b.{0,30}\b(deposit|money|order|payment|refund)\b/i,
  /\b(commit|for sure|guarantee|promise|warrant(?:y|ies)|will definitely)\b/i,
  /\b(bypass|disregard|forget|ignore|override|reveal|repeat|show|tell|waive)\b.{0,50}\b(direction|guideline|instruction|policy|prompt|restriction|rule|safeguard|system message)\w*\b/i,
  /\b(act as|do anything now|jailbreak|developer message|hidden prompt|no restrictions|prompt injection|unrestricted|without restrictions|you are now)\b/i,
];
const knowledgeStopWords = new Set([
  "about",
  "also",
  "and",
  "are",
  "business",
  "can",
  "company",
  "could",
  "does",
  "for",
  "from",
  "have",
  "help",
  "how",
  "information",
  "need",
  "offer",
  "provide",
  "service",
  "services",
  "that",
  "the",
  "their",
  "this",
  "what",
  "what's",
  "whats",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);
const safeServiceQuestionTokens = new Set([
  "available",
  "availability",
  "detail",
  "describe",
  "explain",
  "general",
  "information",
  "inquiry",
  "interested",
  "kind",
  "know",
  "looking",
  "more",
  "question",
  "tell",
  "type",
]);

function normalizeCommonIntentTypos(message: string): string {
  return message.replace(
    /\b(?:serice|serices|servce|servces|servic|servics|servie|servies|serivce|serivces)\b/gi,
    "services",
  );
}

const safeIntentDefinitions: Record<
  Exclude<SafeIntent, "greeting">,
  { label: string; configuredBy: RegExp; requestedBy: RegExp }
> = {
  hours: {
    label: "business hours",
    configuredBy: /\b(hours?|availability|opening times?)\b/i,
    requestedBy: /\b(hours?|open|opening|close|closing|weekend)\b/i,
  },
  service_area: {
    label: "service area",
    configuredBy: /\b(service areas?|areas? served|coverage|location)\b/i,
    requestedBy:
      /\b(address|area|cover(?:age|ed|ing)?|located|location|serve|service area)\b/i,
  },
  contact: {
    label: "contact information",
    configuredBy: /\b(contact|email|phone|reach)\b/i,
    requestedBy: /\b(contact|email|phone|reach)\b/i,
  },
  services: {
    label: "general services",
    configuredBy:
      /\b(general (?:business )?info(?:rmation)?|general services?|services?|offerings?|faqs?|frequently asked questions?)\b/i,
    requestedBy:
      /\b(what do you do|what services (?:are available|do you (?:offer|provide))|how can you help|tell me about (?:the business|your services)|describe your services|general (?:business )?information)\b/i,
  },
};

const prohibitedPolicyDefinitions = [
  {
    label: "prices, quotes, or estimates",
    configuredBy:
      /\b(amount|call[- ]?out|charg\w*|cost\w*|estimate\w*|fee\w*|pric\w*|quot\w*|rate\w*)\b/i,
    requestedBy:
      /[$€£]|\b(amount|ballpark|budget|call[- ]?out|charg\w*|cost\w*|estimate\w*|fee\w*|how much|pric\w*|quot\w*|rate\w*|total)\b/i,
  },
  {
    label: "payments, deposits, or refunds",
    configuredBy:
      /\b(bill\w*|charg\w*|deposit\w*|invoic\w*|money|payment\w*|refund\w*|reimburs\w*)\b/i,
    requestedBy:
      /\b(bill|charge|deposit|invoice|money|pay|payment|refund|reimburse)\b/i,
  },
  {
    label: "booking or scheduling",
    configuredBy:
      /\b(appointment\w*|book\w*|calendar\w*|reschedul\w*|schedul\w*)\b/i,
    requestedBy:
      /\b(appointment|book|booking|calendar|reschedule|schedule|slot|visit)\b/i,
  },
  {
    label: "promises, guarantees, or warranties",
    configuredBy:
      /\b(commit\w*|guarantee\w*|promis\w*|warrant(?:y|ies))\b/i,
    requestedBy:
      /\b(commit\w*|definitely|guarantee\w*|promis\w*|warrant(?:y|ies)|assur\w*)\b/i,
  },
  {
    label: "cancellations or order changes",
    configuredBy: /\b(cancel|cancellation|change order|modify order)\b/i,
    requestedBy: /\b(cancel|cancellation|change|modify)\b.{0,24}\b(job|order|service|visit)\b/i,
  },
  {
    label: "legal matters",
    configuredBy: /\b(attorney|court|law|lawsuit|lawyer|legal|liability)\b/i,
    requestedBy: /\b(attorney|court|law|lawsuit|lawyer|legal|liability|sue)\b/i,
  },
  {
    label: "medical or safety advice",
    configuredBy: /\b(emergency|health|medical|safety)\b/i,
    requestedBy:
      /\b(allerg|danger|doctor|emergency|health|injur|medical|safety|unsafe)\w*\b|\bis (?:it|this|that) safe\b/i,
  },
  {
    label: "complaints or disputes",
    configuredBy:
      /\b(complain\w*|disput\w*|grievance\w*|manager|poor service|supervisor)\b/i,
    requestedBy:
      /\b(complain|dispute|grievance|manager|poor service|supervisor|unhappy)\w*\b/i,
  },
  {
    label: "discounts or promotions",
    configuredBy: /\b(coupon|deal|discount|promotion|special offer)\b/i,
    requestedBy: /\b(coupon|deal|discount|promotion|special offer)\b/i,
  },
  {
    label: "competitors",
    configuredBy: /\b(compete|competitor|other compan|rival)\w*\b/i,
    requestedBy: /\b(compare|compete|competitor|other compan|rival)\w*\b/i,
  },
  {
    label: "personal or private data",
    configuredBy:
      /\b(account|personal data|personal information|private|privacy)\b/i,
    requestedBy:
      /\b(account|credit card|personal data|personal information|private|password|sin number|social insurance)\b/i,
  },
] as const;

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/(?:ing|ed|es|s)$/i, "")
    .replace(/[^a-z0-9'-]/g, "");
}

function splitConfiguredItems(value: string): string[] {
  return value
    .split(/[,\n;]+|\s+\b(?:and|or)\b\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredProhibitionPolicy(
  prohibitedActions: string | null,
): { labels: string[]; hasUnknownRule: boolean } {
  if (!prohibitedActions?.trim()) {
    return { labels: [], hasUnknownRule: false };
  }

  const labels = new Set<string>();
  let hasUnknownRule = false;
  for (const item of splitConfiguredItems(prohibitedActions)) {
    const matches = prohibitedPolicyDefinitions.filter((definition) =>
      definition.configuredBy.test(item),
    );
    if (matches.length === 0) {
      hasUnknownRule = true;
      continue;
    }
    for (const match of matches) labels.add(match.label);
  }
  return { labels: [...labels], hasUnknownRule };
}

function matchesConfiguredProhibition(
  prohibitedActions: string | null,
  userMessage: string,
): boolean {
  if (!prohibitedActions?.trim()) return false;

  const configuredItems = splitConfiguredItems(prohibitedActions);
  let hasUnknownRule = false;
  for (const item of configuredItems) {
    const definitions = prohibitedPolicyDefinitions.filter((definition) =>
      definition.configuredBy.test(item),
    );
    if (definitions.length === 0) {
      hasUnknownRule = true;
      continue;
    }
    if (definitions.some((definition) => definition.requestedBy.test(userMessage))) {
      return true;
    }
  }
  // Unknown custom prohibitions fail closed instead of relying on fuzzy word overlap.
  return hasUnknownRule && !greetingPattern.test(userMessage);
}

function escalationHandoff(receptionist: Receptionist): AiReplyResult {
  const contact =
    receptionist.escalationContact ??
    receptionist.businessEmail ??
    "a team member";
  return {
    reply: `I want to make sure this is handled correctly. Please contact ${contact} so a team member can help you directly.`,
    escalate: true,
  };
}

function getAllowedSafeIntents(receptionist: Receptionist): Set<SafeIntent> {
  const allowed = new Set<SafeIntent>(["greeting"]);
  const configured = receptionist.safeAutoReplyCategories ?? "";
  for (const [intent, definition] of Object.entries(safeIntentDefinitions) as Array<
    [Exclude<SafeIntent, "greeting">, (typeof safeIntentDefinitions)[Exclude<SafeIntent, "greeting">]]
  >) {
    if (definition.configuredBy.test(configured)) allowed.add(intent);
  }
  return allowed;
}

function getMeaningfulRequestTokens(message: string): string[] {
  return (message.match(/[a-z0-9'-]{3,}/gi) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => !knowledgeStopWords.has(token))
    .map(normalizeToken)
    .filter(
      (token) =>
        Boolean(token) &&
        !safeServiceQuestionTokens.has(token),
    );
}

function hasOnlyGroundedRequestTokens(
  receptionist: Receptionist,
  message: string,
  intents: Set<SafeIntent>,
): boolean {
  const intentContext: string[] = [receptionist.businessName];
  const allowedIntentTokens = new Set<string>();
  if (intents.has("hours")) {
    intentContext.push(receptionist.hours ?? "");
    [
      "hour",
      "open",
      "opening",
      "close",
      "closing",
      "time",
      "weekday",
      "weekend",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ].forEach((token) => allowedIntentTokens.add(normalizeToken(token)));
  }
  if (intents.has("service_area")) {
    intentContext.push(receptionist.serviceArea ?? "");
    [
      "address",
      "area",
      "coverage",
      "cover",
      "located",
      "location",
      "near",
      "region",
      "serve",
      "town",
      "within",
    ].forEach((token) => allowedIntentTokens.add(normalizeToken(token)));
  }
  if (intents.has("contact")) {
    intentContext.push(
      receptionist.businessEmail ?? "",
      receptionist.escalationContact ?? "",
    );
    [
      "address",
      "contact",
      "email",
      "person",
      "phone",
      "reach",
      "speak",
      "team",
    ].forEach((token) => allowedIntentTokens.add(normalizeToken(token)));
  }
  if (intents.has("services")) {
    [
      "business",
      "describe",
      "general",
      "information",
      "offer",
      "offering",
      "provide",
      "service",
    ].forEach((token) => allowedIntentTokens.add(normalizeToken(token)));
  }

  const groundedTokens = new Set(
    (intentContext.join(" ").match(/[a-z0-9'-]{3,}/gi) ?? [])
      .map(normalizeToken)
      .filter(Boolean),
  );
  return getMeaningfulRequestTokens(message).every(
    (token) => groundedTokens.has(token) || allowedIntentTokens.has(token),
  );
}

function buildSafeKnowledgeFacts(receptionist: Receptionist): string[] {
  const source = [receptionist.knowledge, receptionist.faqs]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const facts = source
    .split(/\n+|(?<=[.!?])\s+/)
    .map((fact) => fact.trim())
    .filter((fact) => fact.length >= 3 && fact.length <= 320)
    .filter(
      (fact) =>
        !highRiskPatterns.some((pattern) => pattern.test(fact)) &&
        !matchesConfiguredProhibition(receptionist.prohibitedActions, fact),
    );
  return [...new Set(facts)].slice(0, 20);
}

type SafePolicyDecision =
  | { allowed: true; intents: SafeIntent[]; facts: string[] }
  | { allowed: false };

function evaluateSafeRequest(
  receptionist: Receptionist,
  userMessage: string,
): SafePolicyDecision {
  if (
    highRiskPatterns.some((pattern) => pattern.test(userMessage)) ||
    matchesConfiguredProhibition(receptionist.prohibitedActions, userMessage)
  ) {
    return { allowed: false };
  }
  if (greetingPattern.test(userMessage)) {
    return { allowed: true, intents: ["greeting"], facts: [] };
  }

  const normalizedUserMessage = normalizeCommonIntentTypos(userMessage);
  const intents = new Set<SafeIntent>();
  for (const [intent, definition] of Object.entries(safeIntentDefinitions) as Array<
    [Exclude<SafeIntent, "greeting">, (typeof safeIntentDefinitions)[Exclude<SafeIntent, "greeting">]]
  >) {
    if (definition.requestedBy.test(normalizedUserMessage)) intents.add(intent);
  }

  const allowed = getAllowedSafeIntents(receptionist);
  if (intents.size === 0 || [...intents].some((intent) => !allowed.has(intent))) {
    return { allowed: false };
  }
  if (intents.has("hours") && !receptionist.hours?.trim()) {
    return { allowed: false };
  }
  if (
    intents.has("service_area") &&
    !receptionist.serviceArea?.trim()
  ) {
    return { allowed: false };
  }
  if (
    intents.has("contact") &&
    !receptionist.businessEmail?.trim() &&
    !receptionist.escalationContact?.trim()
  ) {
    return { allowed: false };
  }

  const facts = intents.has("services")
    ? buildSafeKnowledgeFacts(receptionist)
    : [];
  if (intents.has("services")) {
    if (facts.length === 0) {
      return { allowed: false };
    }
  }
  if (!hasOnlyGroundedRequestTokens(receptionist, normalizedUserMessage, intents)) {
    return { allowed: false };
  }

  return { allowed: true, intents: [...intents], facts };
}

async function selectRelevantFacts(
  receptionist: Receptionist,
  userMessage: string,
  facts: string[],
): Promise<string[]> {
  if (facts.length <= 3) return facts;

  const client = makeOpenAIClient();
  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    max_completion_tokens: 60,
    messages: [
      {
        role: "system",
        content:
          "Select up to three fact numbers that directly answer the request. Return only comma-separated numbers. Never return prose.",
      },
      {
        role: "user",
        content: JSON.stringify({
          request: userMessage,
          facts: facts.map((fact, index) => `${index + 1}. ${fact}`),
        }),
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  const selectedIndexes = [
    ...new Set(
      (raw.match(/\d+/g) ?? [])
        .map((value) => Number(value) - 1)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < facts.length),
    ),
  ].slice(0, 3);
  if (selectedIndexes.length === 0) {
    throw new Error("OpenAI returned no valid safe fact selections");
  }
  return selectedIndexes.map((index) => facts[index]!);
}

async function buildAllowedReply(
  receptionist: Receptionist,
  userMessage: string,
  decision: Extract<SafePolicyDecision, { allowed: true }>,
): Promise<string> {
  const sections: string[] = [];
  if (decision.intents.includes("greeting")) {
    sections.push(
      receptionist.greeting?.trim() ||
        `Hello! Thank you for contacting ${receptionist.businessName}. How can I help?`,
    );
  }
  if (decision.intents.includes("hours")) {
    sections.push(`Our business hours are: ${receptionist.hours!.trim()}`);
  }
  if (decision.intents.includes("service_area")) {
    sections.push(`Our service area is: ${receptionist.serviceArea!.trim()}`);
  }
  if (decision.intents.includes("contact")) {
    sections.push(
      `You can contact our team at ${(
        receptionist.escalationContact ??
        receptionist.businessEmail!
      ).trim()}.`,
    );
  }
  if (decision.intents.includes("services")) {
    const selectedFacts = await selectRelevantFacts(
      receptionist,
      userMessage,
      decision.facts,
    );
    sections.push(selectedFacts.join(" "));
  }
  return sections.join("\n\n");
}

export async function generateReceptionistReply(
  receptionist: Receptionist,
  history: ChatTurn[],
  userMessage: string,
): Promise<AiReplyResult> {
  const decision = evaluateSafeRequest(receptionist, userMessage);
  if (!decision.allowed) {
    return escalationHandoff(receptionist);
  }
  void history;
  const reply = await buildAllowedReply(
    receptionist,
    userMessage,
    decision,
  );
  return { reply, escalate: false };
}

export async function generateEmailReplySuggestion(
  receptionist: Receptionist,
  inboundSummary: string,
): Promise<string> {
  const policyMessage = inboundSummary
    .split("\n")
    .filter((line) => !/^\s*from\s*:/i.test(line))
    .map((line) => line.replace(/^\s*(?:subject|snippet)\s*:\s*/i, ""))
    .join("\n")
    .trim();
  const decision = evaluateSafeRequest(receptionist, policyMessage);
  if (!decision.allowed) {
    const handoff = escalationHandoff(receptionist);
    return `${handoff.reply}\n\n${receptionist.assistantName} / ${receptionist.businessName}`;
  }
  const safeReply = await buildAllowedReply(
    receptionist,
    policyMessage,
    decision,
  );
  return `Hello,\n\n${safeReply}\n\n${receptionist.assistantName} / ${receptionist.businessName}`;
}

