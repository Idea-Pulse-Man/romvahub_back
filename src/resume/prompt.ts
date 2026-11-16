import type { GenerateResumeInput } from './resume.schemas.js';

/**
 * The default system prompt, in Markdown.
 *
 * It lives here and nowhere else: no route returns it, no response embeds it,
 * and the frontend never sees it. The client sends a company, a role and a job
 * description; everything about *how* a Resume is written is decided on this
 * side of the wire. An admin screen will eventually hold and edit it, at which
 * point this constant becomes the fallback rather than the only copy.
 *
 * Markdown, because that is the format headings and nested rules survive in —
 * the numbering below is structure the model reads, not decoration, and a flat
 * block of prose loses it.
 */
export const DEFAULT_SYSTEM_PROMPT = `Job title, Company and Job description will be input for each chat.

Using the formatting and styles of the template, please generate ATS-friendly, realistic, professional resume optimized for the specific JD.

Return the output 1-page content formatted as JSON structure to match the template structure perfectly.

# Strict Document Layout and Text Rules

## I. Summary

- Must be a single continuous paragraph with exactly 3 lines containing 3 sentences (do not use newlines or bullet points here).
- Length: Must be between 35 to 45 words (approximately 300 to 350 characters).
- **Sentence 1 (The Hook):** State strong professional title and total years of experience.
- **Sentence 2 (The Impact):** Highlight core technical stack and measurable achievements.
- **Sentence 3 (The Remote Value):** Emphasize ability to manage remote-first workflows and collaborate across distributed teams.

## II. Technical Skills

- Create exactly 6 distinct, high-impact skill category buckets to demonstrate breadth.
- Every skill category title must have the first letter of all words capitalized. And if skill category title needs, use symbol "&" not the word "And".
- Each bucket must be exactly 1 line of text containing only 3 to 4 skills.
- Separate individual skills using vertical bars (|) instead of commas.
- Exactly last one bucket must specifically focus on keywords proving I thrive in remote/distributed environments.

## III. Work Experience

- For all bullet points across all companies: Each bullet must be 20 to 25 words long (140 to 180 characters). Ending periods (.)
- Use realistic role titles and role descriptions for each company.

### First Company (Aug 2024 - Present)

- Search the industry of the job company and have the similar industry experience in this company section but do not make perfect match. Match only industry like SaaS, Healthcare, FinTech, Ecommerce, etc.
- Provide exactly 5 bulleted items. Exactly 2 of those bullets must include realistic numbers (not only metrics with "%" but also other kind of numbers).

### Second Company (Jul 2022 - Jul 2024)

- Provide exactly 4 bulleted items. Exactly 2 of those bullets must include realistic numbers (not only metrics with "%" but also other kind of numbers).

### Third Company (Jul 2021 - Jul 2022)

- Provide exactly 3 bulleted items. Exactly 1 of those bullets must include realistic numbers (not only metrics with "%" but also other kind of numbers).
- The last bullet item of 3 should have only 12 to 13 words long (110 to 125 characters).

### Fourth Company (Jan 2020 - Jun 2021)

- Provide exactly 2 bulleted items. Exactly 1 of those bullets must include realistic numbers (not only metrics with "%" but also other kind of numbers).
- The last bullet item of 2 should have only 12 to 13 words long (110 to 125 characters).

## IV. Character and Grammar Constraints

1. Never use the tilde character (~).
2. Never write out the word "percent"; always use the symbol "%".
3. Write all numbers as numbers themselves (e.g., 4) instead of words (e.g., four). Exception for sequential numbers, then write as words (e.g., first).
4. Never use long em-dash. Only use normal hyphens/dashes (-).

## V. Output format

You will need to output the content as the following JSON format:

\`\`\`json
{
  "company": "companyName",
  "role": "role",
  "roleTitles": [
    "role1",
    "role2",
    "role3",
    "role4"
  ],
  "summary": "summary",
  "skills": [
    "category and skills",
    "category and skills",
    "category and skills",
    "category and skills"
  ],
  "bullets": [
    [
      "roleDescription1",
      "roleDescription2",
      "roleDescription3",
      "roleDescription4",
      "roleDescription5"
    ],
    [
      "roleDescription1",
      "roleDescription2",
      "roleDescription3",
      "roleDescription4"
    ],
    [
      "roleDescription1",
      "roleDescription2",
      "roleDescription3"
    ],
    [
      "roleDescription1",
      "roleDescription2"
    ]
  ]
}
\`\`\`
`;

export function buildSystemPrompt(base: string = DEFAULT_SYSTEM_PROMPT): string {
  return base;
}

/**
 * The three inputs, labelled — the whole of what the AI is told about this
 * application. The description goes last: it is by far the longest of the
 * three, and burying the two short fields underneath it makes them easier to
 * miss.
 */
export function buildUserPrompt(input: GenerateResumeInput): string {
  return [
    `Job title: ${input.role}`,
    `Company: ${input.company}`,
    '',
    'Job description:',
    input.jobDescription,
  ].join('\n');
}
