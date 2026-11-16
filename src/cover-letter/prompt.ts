import type { GenerateCoverLetterInput } from './cover-letter.schemas.js';

/**
 * The default system prompt for the cover letter, in Markdown.
 *
 * Its own prompt rather than a second half of the Resume's. The two documents
 * are written to different rules — a Resume is bullets held to word counts, a
 * letter is four paragraphs held to a structure — and one prompt serving both
 * would be edited for one and quietly change the other. They are also generated
 * at different moments: the letter is written *from* a Resume that already
 * exists, so it is a second call with the first one's answer in its input.
 *
 * Like the Resume's, it lives on this side of the wire: no route returns it and
 * the client never sees it. An admin edits it on the AI Settings screen, which
 * makes this constant the fallback rather than the only copy.
 *
 * The file name in the first line is written with placeholders rather than a
 * person's name, because the name is not the model's to decide: it is built by
 * `resumeFileName` from the candidate's own profile, whoever the letter is for.
 * The line stays because it tells the model what kind of document it is
 * writing — but a real name there would be a rule about one candidate sitting
 * in a deployment-wide setting.
 */
export const DEFAULT_COVER_LETTER_PROMPT = `Based on my resume, also create a cover letter and the file name should be \`[First name] [Last name].docx\`.

And follow these rules:

# Focus on Remote-First Competencies

- **Autonomy:** Detail my ability to deliver high-quality result with minimal oversight.
- **Communication:** Highlight mastery of asynchronous communication tools like Slack, Jira and Notion.
- **Time Management:** State how I manage time zones and structure my workday independently.
- **Trustworthiness:** Emphasize my proven track record of meeting sprint goals contextually.

# Structure Cover Letter

## 1. The Hook (Introduction)

- State the target role clearly.
- Mention my x years of expertise.
- Express enthusiasm for their specific remote culture.

## 2. The Core Value Proposition (Body Paragraph 1)

- Showcase senior-level technical leadership.
- Quantify engineering achievements using data.
- Example: "Led a team migrating monolithic architecture to microservices, reducing latency by 30%"

## 3. The Remote Proof (Body Paragraph 2)

- Connect technical skills to remote execution.
- Explain how I mentor junior developers across time zones.
- Highlight experience documentation practices that prevent communication bottlenecks.

## 4. The Call to Action (Conclusion)

- Reiterate alignment with the company mission.
- Propose a meeting to discuss their engineering pipeline.
- Keep it brief, confident and professional.

# Critical Tips

- The whole cover letter should be 250 to 350 words (1500 to 2500 characters).
- Don't use "~".
- Don't use "percent" but use "%".
- Don't write numbers as text but as number itself. (e.g., 4 instead of four). But only if the numbers are sequential ones, then write as text. (like first instead of 1st).
- Don't use special long-dash (—) but only use normal-dash.
- Make important text bold but less than 5%. Use this as markdown format.

# Output format

You will need to output the content as the following JSON format. Exactly 4 paragraphs, in the order of the structure above — the Hook, the Core Value Proposition, the Remote Proof and the Call to Action. Each paragraph is one continuous paragraph of plain text with no newlines and no bullet points; the only markup allowed inside it is \`**bold**\` for the few important phrases.

The header, the contact line, the date and the signature are added when the letter is laid out — do not write them into the paragraphs.

\`\`\`json
{
  "company": "companyName",
  "role": "role",
  "greeting": "Dear Hiring Manager,",
  "paragraphs": [
    "The Hook",
    "The Core Value Proposition",
    "The Remote Proof",
    "The Call to Action"
  ],
  "closing": "Sincerely,"
}
\`\`\`
`;

export function buildCoverLetterSystemPrompt(base: string = DEFAULT_COVER_LETTER_PROMPT): string {
  return base;
}

/**
 * The application, and the Resume the letter must be based on.
 *
 * The Resume goes in as the JSON the model itself just wrote, rather than as
 * prose describing it. "Based on my resume" is the first line of the prompt, so
 * the Resume has to actually be in the input — and the structured form is the
 * one the model can read fields out of without being told which sentence is
 * which. It goes above the description because it is the shorter of the two and
 * the one being written *from*.
 */
export function buildCoverLetterUserPrompt(input: GenerateCoverLetterInput): string {
  return [
    `Job title: ${input.role}`,
    `Company: ${input.company}`,
    '',
    'My resume:',
    '```json',
    JSON.stringify(input.resume, null, 2),
    '```',
    '',
    'Job description:',
    input.jobDescription,
  ].join('\n');
}
