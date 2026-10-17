import { findUser, type User } from "../models/user.js";

/** The signed-in user plus what only the session layer knows. */
export interface SessionUser extends User {
  /** When this user was last seen before the current session began. */
  lastSeenAt: Date;
}

interface Session {
  user: SessionUser;
  expiresAt: Date;
}

const SESSION_TTL_MS = 60 * 60 * 1000;

// Last activity per user id, across sessions. A table in TeamDB.
const lastSeen = new Map<string, Date>();
let current: Session | undefined;

/** Starts a session for `userId`. Throws when the user does not exist. */
export function signIn(userId: string, now = new Date()): SessionUser {
  const user = findUser(userId);
  if (!user) throw new Error(`no user ${userId}`);
  const sessionUser: SessionUser = { ...user, lastSeenAt: lastSeen.get(userId) ?? now };
  lastSeen.set(userId, now);
  current = { user: sessionUser, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) };
  return sessionUser;
}

export function signOut(): void {
  current = undefined;
}

/**
 * The signed-in user. Throws when nobody is signed in.
 *
 * Known bug (TeamDB issue #58): a session past `expiresAt` still returns its user.
 * `now` is accepted so the check can be tested, but it is not used yet.
 */
export function getCurrentUser(now = new Date()): SessionUser {
  if (!current) throw new Error("not signed in");
  return current.user;
}
