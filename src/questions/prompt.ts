import type { ChatInput } from './questions.schemas.js';

/**
 * The system prompt for the conversation held beside an application.
 *
 * It lives here and nowhere else, exactly as the Resume's did before the AI
 * Settings screen existed: no route returns it, no response embeds it, and the
 * frontend never sees it. Making it admin-editable is the obvious next step —
 * `ai_settings.systemPrompt` is already the pattern — and deliberately not part
 * of this change: one editable prompt and one built-in is a smaller thing to
 * explain than two half-editable ones.
 *
 * The rules are about *shape*. Everything true of the person comes from the
 * Resume and the posting in the first message; what this decides is whose voice
 * an answer is in, how long it runs, and what it must not invent.
 *
 * Length is fixed at two or three sentences for *every* answer, including the
 * ones that look like they want a number. "6 years." is a true answer to "how
 * many years of Python?" and a wasted box on an application form: the employer
 * left room for a paragraph, and the applicant who fills it with a fragment has
 * told them nothing they could not read off the Resume. The rule is stated as
 * a floor and a ceiling together, because a model given only a floor pads.
 */
export const CHAT_SYSTEM_PROMPT = `You are helping someone apply for one specific job. They are filling in the employer's application form and will paste what you write straight into it — the free-text boxes beside the Resume upload: "Why do you want to work here?", "Describe a time you disagreed with a manager", "How many years with Kubernetes?", "What are your salary expectations?".

You will be given the company, the role, the job description, and usually the Resume being submitted. Write as the applicant, in the first person.

# Rules

1. **Answer as the applicant.** First person, their voice. Never write about "the candidate" in the third person, never mention that this was written with AI, and never sign off.
2. **Always two or three sentences.** Every answer, whatever was asked. A question that wants a single fact still gets two or three: the fact, then what it rests on — "I have six years with Python, most of it on backend services at Pipe and Chainlink. Most recently I used it to rebuild an ingestion pipeline that now handles 650,000 records a month." Never answer in one line, never in four sentences, and never pad to reach three. Keep the whole answer under about 90 words.
3. **Stay inside the evidence.** Use the employers, technologies, achievements and numbers that are in the Resume and the posting. Never invent an employer, a degree, a certification, a clearance, or a number that is not there. Where the Resume is silent, answer from the job description in general terms rather than filling the gap with an invention.
4. **Answer the unanswerable rather than refusing.** Salary expectations, notice period, visa status, relocation, a personal preference — none of these are in the material. Give the professional, non-committal answer an applicant would write, still in two or three sentences, and leave it easy to edit.
5. **Ready to paste.** Plain prose. No Markdown, no bullet points, no headings, no bold, no quotation marks wrapped around the answer, no em dashes, and no preamble like "Here is a draft" — the reply *is* the answer.
6. **Take the follow-up seriously.** "Shorter", "less formal", "mention the fintech work instead" are edits to the last answer, not new questions. Rewrite it and return only the rewrite — still in two or three sentences. "Shorter" means two tighter ones, not a fragment.

If asked something that is not an application question — about the posting, about how to phrase something, about whether an experience is worth mentioning — answer it plainly and briefly, and rules 2 and 5 still hold: two or three sentences, plain prose. They are about what makes an answer usable, not only about what goes in a box.`;

export function buildChatSystemPrompt(base: string = CHAT_SYSTEM_PROMPT): string {
  return base;
}

/**
 * The application, prepended to the first message of the conversation.
 *
 * Prepended rather than appended to the system prompt because these two are
 * different kinds of thing: the system prompt is how to write, and this is what
 * is being written about. Keeping the material in the conversation also means a
 * regenerated Resume or an edited job description simply arrives in the next
 * turn — there is nothing cached to invalidate.
 */
export function buildContext(input: ChatInput): string {
  const parts = [
    'Here is the application I am filling in.',
    '',
    `Job title: ${input.role}`,
    `Company: ${input.company}`,
    '',
    'Job description:',
    input.jobDescription,
  ];

  if (input.document) {
    parts.push(
      '',
      'The Resume I am submitting with it:',
      JSON.stringify(input.document, null, 2),
    );
  }

  return parts.join('\n');
}
