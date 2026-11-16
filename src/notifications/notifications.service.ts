import { prisma } from '../prisma.js';
import { isAdmin, type Actor } from '../auth/actor.js';
import { formatInstant } from '../domain/dates.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../http/errors.js';
import type { CreateNotificationInput } from './notifications.schemas.js';

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  link?: string;
  readAt?: string;
  createdAt: string;
  sender: { id: string; email: string } | null;
}

function toItem(row: {
  id: string;
  title: string;
  message: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
  sender: { id: string; email: string } | null;
}): NotificationItem {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    ...(row.link ? { link: row.link } : {}),
    ...(row.readAt ? { readAt: formatInstant(row.readAt) } : {}),
    createdAt: formatInstant(row.createdAt),
    sender: row.sender,
  };
}

export async function list(recipientId: string): Promise<{
  items: NotificationItem[];
  unreadCount: number;
}> {
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { sender: { select: { id: true, email: true } } },
    }),
    prisma.notification.count({ where: { recipientId, readAt: null } }),
  ]);

  return { items: rows.map(toItem), unreadCount };
}

export async function create(
  actor: Actor,
  input: CreateNotificationInput,
): Promise<{ delivered: number }> {
  let recipientIds: string[];

  if (!isAdmin(actor)) {
    if (!input.toAdmins || input.broadcast || input.recipientIds.length > 0) {
      throw new ForbiddenError('Users may send notifications only to administrators.');
    }
    const recipients = await prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    recipientIds = recipients.map(user => user.id);
  } else if (input.toAdmins) {
    throw new BadRequestError('Administrators should choose users as recipients.');
  } else if (input.broadcast) {
    const recipients = await prisma.user.findMany({
      where: { role: 'USER', status: 'ACTIVE' },
      select: { id: true },
    });
    recipientIds = recipients.map(user => user.id);
  } else {
    recipientIds = [...new Set(input.recipientIds)];
    const recipients = await prisma.user.findMany({
      where: {
        id: { in: recipientIds },
        role: 'USER',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (recipients.length !== recipientIds.length) {
      throw new BadRequestError('One or more recipients are missing, suspended, or not users.');
    }
  }

  if (recipientIds.length === 0) {
    throw new BadRequestError('There are no active users to notify.');
  }

  const result = await prisma.notification.createMany({
    data: recipientIds.map(recipientId => ({
      recipientId,
      senderId: actor.id,
      title: input.title,
      message: input.message,
      link: input.link || null,
    })),
  });
  return { delivered: result.count };
}

export async function markRead(recipientId: string, id: string): Promise<void> {
  const result = await prisma.notification.updateMany({
    where: { id, recipientId },
    data: { readAt: new Date() },
  });
  if (result.count === 0) throw new NotFoundError('Notification not found.');
}

export async function markAllRead(recipientId: string): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { recipientId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}
