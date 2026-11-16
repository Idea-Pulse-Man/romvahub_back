import { z } from 'zod';
import { ResumePayloadSchema } from '../resume/resume.schemas.js';

/**
 * One turn of the conversation held beside an application.
 *
 * `assistant` rather than a second field on a question, because the drawer this
 * feeds is a conversation and not a form: an answer can be followed up, argued
 * with, and asked again in a different tone, and none of that fits a
 * `{ question, answer }` pair. The transcript is what is worth keeping — an
 * answer read a week later without the question above it is not much use.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1, 'A message cannot be blank.').max(20_000),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * A whole conversation, as it is stored on a bid and sent back to the client.
 *
 * Capped at the same length a request may carry, so a stored transcript can
 * always be continued — a column that could hold more history than the chat
 * endpoint accepts would be a record the app could not act on.
 */
export const ChatTranscriptSchema = z.array(ChatMessageSchema).max(100);

/**
 * What the drawer sends to continue a conversation.
 *
 * The application travels with **every** message rather than being established
 * once, because nothing about the conversation is held on the server: there is
 * no session, no thread id, and no stored context. The client owns the
 * transcript — which is also what lets the drawer work on an application that
 * has not been saved yet, and what lets the Resume change mid-conversation
 * without anything to invalidate.
 *
 * `document` is the Resume on screen, generated or pasted, saved or not.
 * Optional, because the questions can reasonably be asked before it exists.
 */
export const ChatSchema = z.object({
  company: z.string().trim().min(1, 'Company is required.').max(200),
  role: z.string().trim().min(1, 'Role is required.').max(200),
  jobDescription: z
    .string()
    .trim()
    .min(1, 'A job description is required.')
    .max(50_000, 'That job description is too long to hold a conversation about.'),
  document: ResumePayloadSchema.optional(),
  /**
   * The conversation so far, oldest first, ending with the message being asked.
   * A hundred turns is far past any application's worth of questions and well
   * inside what a context window will hold with a job description above it.
   */
  messages: z.array(ChatMessageSchema).min(1, 'Say something first.').max(100),
});

export type ChatInput = z.infer<typeof ChatSchema>;
