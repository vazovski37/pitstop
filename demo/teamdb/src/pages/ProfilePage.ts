import { findUser } from "../models/user.js";

/** The signed-in user's own profile page. Showing when they were last seen is TeamDB issue #61. */
export function renderProfile(userId: string): string {
  const user = findUser(userId);
  if (!user) return "<p>No such user</p>";
  return `<h1>${user.name}</h1>\n<p>${user.email}</p>`;
}
